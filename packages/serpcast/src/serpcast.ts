// The engine chain, serpcast's main entry. One search tries its engines in
// order and stops at the first answer (results, or an `empty` match): engines
// gate on request volume per exit IP, so querying all of them per search
// (SearXNG's fan-out) would spend that budget. Failures before the answer are
// reported with it; if every engine fails, the search throws `exhausted`.
//
// - `impersonation` is not an engine failure: every HTTP engine would search
//   with the wrong fingerprint, so it aborts the whole search at once.
// - `blocked` starts a cooldown: the engine is skipped (and reported as a
//   `blocked` failure saying so) until it ends.
// - The caller's abort rejects with the signal's reason and is not a failure.
// - Any other error that is not a `SerpcastError` is a bug and is rethrown.
//
// Cooldowns and sessions live in the injected state store (store.ts), keyed
// per engine name; each record carries its own time, checked with serpcast's
// clock, and a TTL so the store can drop it. A session (the engine's
// transport-session cookies, plus a code recipe's JSON state) is loaded before
// the engine runs and saved after, whatever the outcome, so challenge cookies
// survive; concurrent searches on
// one engine race and the last save wins. `serpcast/sessions` indexes the
// engines with a session, so `clearSessions()` finds them in any store.
// Browser engines (browser.ts) run in searchcast: they have no transport
// session (the browser keeps its own cookies), and `close()` stops the
// library-mode browser.
// Decisions and alternatives: work/notes/observations/engine-chain-and-state-decisions.md.

import type {Recipe} from 'serpcast-recipe';
import {
	createBrowserRunner,
	isBrowserEngine,
	type BrowserEngine,
	type SearchcastLibraryOptions,
} from './browser.js';
import {isCodeRecipe, runCodeRecipe, type CodeRecipe} from './code.js';
import type {StoredCookie} from './cookies.js';
import {runDeclarativeRecipe, type SearchResult} from './declarative.js';
import {SerpcastError, type EngineFailure} from './errors.js';
import {createMemoryStore, type JsonValue, type StateStore} from './store.js';
import {
	createTransport,
	type Transport,
	type TransportOptions,
} from './transport.js';

/** One engine of a chain, identified by its name: a declarative recipe, a code recipe or a browser engine. */
export type Engine = Recipe | CodeRecipe | BrowserEngine;

export interface SerpcastOptions extends TransportOptions {
	/** Where sessions and cooldowns live. Default: in memory, per instance. */
	store?: StateStore;
	/** How long an engine that answered `blocked` is skipped, in ms. Default 5 minutes. */
	cooldownMs?: number;
	/** An engine's session (cookies and code-recipe state) is dropped after this long unused, in ms. Default 10 minutes. */
	sessionIdleMs?: number;
	/** The clock for cooldowns and sessions (and the default store), in ms since the epoch. */
	now?: () => number;
	/** Use this transport instead of creating one from the transport options (tests, sharing). */
	transport?: Pick<Transport, 'session'>;
	/** How library-mode browser engines start searchcast (it gets `proxy` too). */
	searchcast?: SearchcastLibraryOptions;
}

export interface SearchOptions {
	/** The engine chain, tried in order. */
	engines: readonly Engine[];
	/** Cut the answer to at most this many results (each recipe's `limit` still applies). */
	maxResults?: number;
	/** Aborting rejects with the signal's reason. */
	signal?: AbortSignal;
}

export interface SearchResponse {
	results: SearchResult[];
	/** The name of the engine that answered. */
	engine: string;
	/** The engines before it that did not answer, in order. */
	failures: EngineFailure[];
}

export interface Serpcast {
	/** Run the chain for `query`; rejects with a `SerpcastError` (`exhausted`, `impersonation`). */
	search(query: string, options: SearchOptions): Promise<SearchResponse>;
	/** Drop the session of `engine` (by name), or of every engine. */
	clearSessions(engine?: string): Promise<void>;
	/** Release what the instance holds. */
	close(): Promise<void>;
}

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;

const SESSIONS_KEY = 'serpcast/sessions';
const key = (engine: string, what: 'session' | 'cooldown') =>
	`engine/${encodeURIComponent(engine)}/${what}`;

interface SessionRecord {
	cookies: StoredCookie[];
	lastUsed: number;
	/** A code recipe's `ctx.session` state. */
	state?: {[key: string]: JsonValue};
}

export function createSerpcast(options: SerpcastOptions = {}): Serpcast {
	const now = options.now ?? Date.now;
	const store = options.store ?? createMemoryStore({now});
	const transport = options.transport ?? createTransport(options);
	const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
	const browser = createBrowserRunner(options);

	async function coolingUntil(engine: string): Promise<number | undefined> {
		const record = (await store.get(key(engine, 'cooldown'))) as
			{until?: unknown} | null | undefined;
		const until = record?.until;
		return typeof until === 'number' && until > now() ? until : undefined;
	}

	async function run(
		engine: Engine,
		query: string,
		{signal, maxResults}: Omit<SearchOptions, 'engines'>,
	) {
		if (isBrowserEngine(engine)) return browser.run(engine, query, signal);
		const saved = (await store.get(key(engine.name, 'session'))) as
			Partial<SessionRecord> | null | undefined;
		const fresh =
			Array.isArray(saved?.cookies) &&
			typeof saved.lastUsed === 'number' &&
			now() - saved.lastUsed < idleMs;
		const session = transport.session(fresh ? saved!.cookies : []);
		const kept = fresh ? saved!.state : undefined;
		const state =
			typeof kept === 'object' && kept !== null && !Array.isArray(kept)
				? kept
				: {};
		try {
			const response = isCodeRecipe(engine)
				? await runCodeRecipe(engine, query, {
						session,
						state,
						signal,
						maxResults,
					})
				: await runDeclarativeRecipe(engine, query, {session, signal});
			return response.results;
		} finally {
			const record: SessionRecord = {
				cookies: session.cookies(),
				lastUsed: now(),
				...(Object.keys(state).length > 0 && {state}),
			};
			await store.set(
				key(engine.name, 'session'),
				record as unknown as JsonValue,
				{
					ttlMs: idleMs,
				},
			);
			const names = await sessionNames();
			await store.set(SESSIONS_KEY, [...new Set([...names, engine.name])], {
				ttlMs: idleMs,
			});
		}
	}

	async function sessionNames(): Promise<string[]> {
		const names = await store.get(SESSIONS_KEY);
		return Array.isArray(names)
			? names.filter((n): n is string => typeof n === 'string')
			: [];
	}

	return {
		async search(query, {engines, maxResults, signal}) {
			const failures: EngineFailure[] = [];
			for (const engine of engines) {
				signal?.throwIfAborted();
				const {name} = engine;
				const until = await coolingUntil(name);
				if (until !== undefined) {
					const message = `${name}: skipped, blocked earlier, cooling down until ${new Date(until).toISOString()}`;
					failures.push({
						engine: name,
						error: new SerpcastError('blocked', message),
					});
					continue;
				}
				try {
					const results = await run(engine, query, {signal, maxResults});
					return {
						results:
							maxResults === undefined ? results : results.slice(0, maxResults),
						engine: name,
						failures,
					};
				} catch (error) {
					if (signal?.aborted) throw signal.reason;
					if (
						!(error instanceof SerpcastError) ||
						error.kind === 'impersonation'
					)
						throw error;
					if (error.kind === 'blocked') {
						await store.set(
							key(name, 'cooldown'),
							{until: now() + cooldownMs},
							{ttlMs: cooldownMs},
						);
					}
					failures.push({engine: name, error});
				}
			}
			const detail = failures
				.map((f) => `${f.engine}: ${f.error.kind}`)
				.join(', ');
			throw new SerpcastError(
				'exhausted',
				engines.length === 0
					? 'no engines to search'
					: `every engine failed (${detail})`,
				{failures},
			);
		},
		async clearSessions(engine) {
			const names = await sessionNames();
			for (const name of engine === undefined ? names : [engine])
				await store.delete(key(name, 'session'));
			if (engine === undefined) await store.delete(SESSIONS_KEY);
			else if (names.includes(engine)) {
				await store.set(
					SESSIONS_KEY,
					names.filter((n) => n !== engine),
					{ttlMs: idleMs},
				);
			}
		},
		// HTTP engines hold no connection between requests; only a
		// library-mode browser (and its temporary profile) is released.
		async close() {
			await browser.close();
		},
	};
}
