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
// - A guarded engine whose answer is a decoy (decoy.ts) is a `decoy` failure
//   and the chain moves on. No cooldown: a decoy is a property of (engine,
//   query, moment), so cooling the engine would drop its good answers to
//   other queries. The whole answer is judged, before the `maxResults` cut.
//   An engine is guarded when it is named in `decoyGuard` (its array form, or
//   `include`) OR its recipe declares `decoyProne: true` (a library-mode
//   browser engine: its recipe's), and not named in `decoyGuard.exclude`,
//   which wins over both: the caller's off switch for a decoy-prone recipe.
//   `decoyRule` overrides the rule's thresholds (the defaults are measured).
//   Decisions: work/notes/observations/2026-09-29-decoy-prone-recipes-decisions.md
//   and work/notes/observations/2026-09-30-tunables-and-install-api-decisions.md.
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
//
// Connections: the instance keeps each HTTP engine's transport session (and so
// its open connections) in memory between searches, so the next search reuses
// them. It is reused only while the stored session is fresh AND its cookies
// are still the stored ones (a store shared with another instance may have
// moved on), and not by two searches at once; otherwise a new one is made from
// the store. Its connections are closed when the engine's session is dropped:
// idle expiry (checked at the next search, and by an unref'd timer after
// `sessionIdleMs` without use), `clearSessions()`, or `close()`. The store
// stays the only source of cookies and state. Connections are never shared
// between engines (a transport session never shares them). With
// `keepSessions: false` nothing is kept: each search runs on a new transport
// session made from the store's cookies, closed when the engine is done.
// Decisions: work/notes/observations/session-connection-reuse-decisions.md.
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
import {decoyRule, decoyTerms, isDecoy, type DecoyRule} from './decoy.js';
import {runDeclarativeRecipe, type SearchResult} from './declarative.js';
import {SerpcastError, type EngineFailure} from './errors.js';
import {checkBoolean, checkNames, checkNumber} from './options.js';
import {createMemoryStore, type JsonValue, type StateStore} from './store.js';
import {
	checkTransportOptions,
	createTransport,
	type TransportOptions,
	type TransportSession,
} from './transport.js';

/** One engine of a chain, identified by its name: a declarative recipe, a code recipe or a browser engine. */
export type Engine = Recipe | CodeRecipe | BrowserEngine;

/**
 * What the chain needs of a transport. `close` and `documentCookies` on a
 * session are optional so a transport injected before sessions had them keeps
 * working: without `close` the chain just drops the session; without
 * `documentCookies` a code recipe's `ctx.cookies` is a `recipe` error.
 */
export interface ChainTransport {
	session(
		cookies?: readonly StoredCookie[],
	): Omit<TransportSession, 'close' | 'documentCookies'> &
		Partial<Pick<TransportSession, 'close' | 'documentCookies'>>;
}

export interface SerpcastOptions extends TransportOptions {
	/** Where sessions and cooldowns live. Default: in memory, per instance. */
	store?: StateStore;
	/** How long an engine that answered `blocked` is skipped, in ms. Default 5 minutes; 0: no cooldown. */
	cooldownMs?: number;
	/** An engine's session (cookies and code-recipe state) is dropped after this long unused, in ms. Default 10 minutes. */
	sessionIdleMs?: number;
	/** The clock for cooldowns and sessions (and the default store), in ms since the epoch. */
	now?: () => number;
	/** Use this transport instead of creating one from the transport options (tests, sharing). */
	transport?: ChainTransport;
	/** How library-mode browser engines start searchcast (it gets `proxy` too). */
	searchcast?: SearchcastLibraryOptions;
	/**
	 * The engines (by name) whose answers are checked with `isDecoy`: a decoy
	 * page is a `decoy` failure and the next engine is tried (no cooldown).
	 * Engines whose recipe declares `decoyProne: true` are checked too, named
	 * here or not. The object form adds `exclude`: engines never checked, even
	 * when their recipe declares `decoyProne` or `include` names them (exclude
	 * wins). An array is the same as `{include: array}`. Default: none.
	 */
	decoyGuard?: readonly string[] | DecoyGuard;
	/** The decoy rule's thresholds (`isDecoy`). Default `DEFAULT_DECOY_RULE`, the measured values; others are at the caller's risk. */
	decoyRule?: Partial<DecoyRule>;
	/**
	 * Keep each HTTP engine's transport session (its open connections) in
	 * memory between searches. Default true. False: every search opens new
	 * connections and closes them after; cookies and state still go through
	 * the store.
	 */
	keepSessions?: boolean;
	/** How many redirects a declarative recipe follows. Default 20 (Chrome's); 0 follows none. */
	maxRedirects?: number;
}

/** `decoyGuard`'s object form: engines to check (`include`) and never to check (`exclude`, which wins). */
export interface DecoyGuard {
	include?: readonly string[];
	exclude?: readonly string[];
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
	/** Release what the instance holds: every engine's connections, and the library-mode browser. */
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

/**
 * Whether two cookie lists hold the same cookies: every field but `created`
 * (the time a jar took the cookie in), in any order. Two sessions that got the
 * same `Set-Cookie` a millisecond apart hold the same cookies, so the live
 * session is reused after a concurrent search saved its copy (decision 13 in
 * work/notes/observations/session-connection-reuse-decisions.md).
 */
function sameCookies(
	a: readonly StoredCookie[],
	b: readonly StoredCookie[],
): boolean {
	const canonical = (cookies: readonly StoredCookie[]) =>
		JSON.stringify(
			cookies
				.map((c) =>
					JSON.stringify([
						c.name,
						c.value,
						c.domain,
						c.hostOnly,
						c.path,
						c.secure,
						c.httpOnly,
						c.expires ?? null,
					]),
				)
				.sort(),
		);
	return canonical(a) === canonical(b);
}

/** Whether the engine's recipe declares `decoyProne: true` (a browser engine: its library-mode recipe; an endpoint has none here). */
function decoyProne(engine: Engine): boolean {
	if (!isBrowserEngine(engine)) return engine.decoyProne === true;
	const target = engine.searchcast;
	return 'recipe' in target && typeof target.recipe === 'object'
		? target.recipe.decoyProne === true
		: false;
}

/** `decoyGuard` in its object form, checked (a RangeError when malformed). */
function decoyGuard(guard: SerpcastOptions['decoyGuard']): {
	include: Set<string>;
	exclude: Set<string>;
} {
	const object: DecoyGuard =
		guard === undefined || Array.isArray(guard)
			? {include: guard as readonly string[] | undefined}
			: (guard as DecoyGuard);
	if (typeof object !== 'object' || object === null)
		throw new RangeError(
			'serpcast: decoyGuard must be an array of engine names or {include?, exclude?}',
		);
	const include = checkNames('decoyGuard.include', object.include);
	const exclude = checkNames('decoyGuard.exclude', object.exclude);
	return {include: new Set(include), exclude: new Set(exclude)};
}

export function createSerpcast(options: SerpcastOptions = {}): Serpcast {
	checkTransportOptions(options); // even when a transport is injected: fail loud
	checkNumber('cooldownMs', options.cooldownMs, {zero: true});
	checkNumber('sessionIdleMs', options.sessionIdleMs);
	checkNumber('maxRedirects', options.maxRedirects, {
		integer: true,
		zero: true,
	});
	checkBoolean('keepSessions', options.keepSessions);
	const rule = decoyRule(options.decoyRule);
	const now = options.now ?? Date.now;
	const store = options.store ?? createMemoryStore({now});
	const transport = options.transport ?? createTransport(options);
	const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
	const keepSessions = options.keepSessions ?? true;
	const browser = createBrowserRunner(options);
	const {include, exclude} = decoyGuard(options.decoyGuard);
	const guarded = (engine: Engine) =>
		!exclude.has(engine.name) &&
		(include.has(engine.name) || decoyProne(engine));

	type Session = ReturnType<ChainTransport['session']>;
	/** Each HTTP engine's live transport session, kept for its connections; `uses` counts searches running on it. */
	const live = new Map<
		string,
		{session: Session; uses: number; timer?: NodeJS.Timeout}
	>();
	const drop = (name: string) => {
		const entry = live.get(name);
		if (!entry) return;
		live.delete(name);
		clearTimeout(entry.timer);
		entry.session.close?.();
	};
	/**
	 * Start using the engine's live session if it still holds exactly
	 * `cookies`, else a new one made from them. A search that starts while
	 * another runs on the same engine gets a session of its own (closed after),
	 * so concurrent searches keep their own cookies, as before.
	 */
	const acquire = (name: string, cookies: readonly StoredCookie[]) => {
		if (!keepSessions) return transport.session(cookies); // closed by release
		let entry = live.get(name);
		if (entry && entry.uses > 0) return transport.session(cookies);
		if (!entry || !sameCookies(entry.session.cookies(), cookies)) {
			drop(name);
			entry = {session: transport.session(cookies), uses: 0};
			live.set(name, entry);
		}
		clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.uses++;
		return entry.session;
	};
	/** Stop using `session`: close it if it was dropped meanwhile, else start its idle timer once unused. */
	const release = (name: string, session: Session) => {
		const entry = live.get(name);
		if (entry?.session !== session) {
			// A concurrent search's own session, or one dropped while in use
			// (its last requests may have reopened connections).
			session.close?.();
			return;
		}
		if (--entry.uses > 0) return;
		entry.timer = setTimeout(() => {
			if (live.get(name) === entry) drop(name);
		}, idleMs);
		entry.timer.unref(); // an idle engine session never keeps the process alive
	};

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
		// Idle-expired or cleared elsewhere: a new session, so new connections
		// (unless a concurrent search is using it; this one gets its own).
		if (!fresh && !live.get(engine.name)?.uses) drop(engine.name);
		const session = acquire(engine.name, fresh ? saved!.cookies! : []);
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
				: await runDeclarativeRecipe(engine, query, {
						session,
						signal,
						maxRedirects: options.maxRedirects,
					});
			return response.results;
		} finally {
			release(engine.name, session);
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
					if (guarded(engine) && isDecoy(query, results, rule)) {
						const titles = results
							.slice(0, rule.top)
							.map((r) => JSON.stringify(r.title))
							.join(', ');
						const message = `${name}: decoy page, unrelated to the query terms ${decoyTerms(query).join(' ')} (top results: ${titles})`;
						failures.push({
							engine: name,
							error: new SerpcastError('decoy', message),
						});
						continue;
					}
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
			for (const name of engine === undefined ? [...live.keys()] : [engine])
				drop(name);
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
		// Every HTTP engine's connections, and a library-mode browser (and
		// its temporary profile). Sessions stay in the store.
		async close() {
			for (const name of [...live.keys()]) drop(name);
			await browser.close();
		},
	};
}
