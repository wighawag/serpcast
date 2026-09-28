// Browser engines: a recipe run by searchcast in a real browser, the chain's
// fallback when HTTP is blocked. Two modes, told apart by the engine's
// `searchcast` field:
//
// - library (`{recipe}`): serpcast imports `searchcast` (an optional peer
//   dependency, imported here only, and only when such an engine runs) and
//   starts it lazily with the caller's `searchcast` options and serpcast's
//   proxy. One browser per serpcast instance, stopped by `close()`.
// - endpoint (`{endpoint, recipe?}`): a running `searchcast serve`, over HTTP
//   or a Unix socket (`GET /search?recipe=&q=`). serpcast does not control that
//   browser's egress; the caller must.
//
// Errors (searchcast-endpoint.ts) come from searchcast's `error` field (endpoint; not the status, since
// `blocked` and `recipe` are both 502) or the thrown error's `code` (library):
// `blocked`, `recipe`, `timeout` keep their kind; `input` and `unknown-recipe`
// are `recipe` (the engine is misconfigured); anything else is `transport`.
//
// Proxy: Chromium does not accept `socks5h://` and always resolves host names
// at a SOCKS5 proxy, so `socks5h://` is passed as `socks5://` (DNS stays at the
// proxy). Profile: without the caller's `profile`, a temporary 0700 directory
// is created at first start and deleted on `close()` and on process exit, the
// one disk write serpcast makes itself (ADR 0002).
// Decisions and alternatives: work/notes/observations/searchcast-engine-decisions.md.

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Recipe} from 'serpcast-recipe';
import {untilAborted} from './code.js';
import type {SearchResult} from './declarative.js';
import {SerpcastError} from './errors.js';
import {
	searchcastError,
	searchcastResults,
	searchEndpoint,
} from './searchcast-endpoint.js';

/** An engine run by searchcast in a real browser, in-process or over its socket. */
export interface BrowserEngine {
	name: string;
	searchcast:
		| {
				/** Library mode: this recipe, in serpcast's own searchcast. */
				recipe: Recipe;
		  }
		| {
				/** Endpoint mode: a `searchcast serve` URL (`http://127.0.0.1:8931`) or Unix socket path (`/run/searchcast.sock`). */
				endpoint: string;
				/** The recipe's name on that server. Default: the engine's name. */
				recipe?: string;
				/** The whole request's time limit in ms. Default twice `DEFAULT_TIMEOUT_MS` (30 s). */
				timeoutMs?: number;
		  };
}

/** How serpcast starts searchcast for library-mode engines (named after searchcast's CLI flags). */
export interface SearchcastLibraryOptions {
	/** The Chromium or Chrome executable. Default: searchcast's `findChrome()` ($SEARCHCAST_CHROME, then PATH). */
	chrome?: string;
	/** Run the browser on a private Xvfb display started from this executable. */
	xvfb?: string;
	/** Run headless (easier for sites to detect). */
	headless?: boolean;
	/** The browser profile directory. Default: a temporary one, deleted on close and on exit. */
	profile?: string;
	/** Maximum simultaneous tabs (searchcast's default: 2). */
	concurrency?: number;
	/** Extra Chromium arguments. */
	chromeArgs?: string[];
	/** Use this module instead of importing `searchcast` (tests, or a fork). */
	module?: SearchcastModule;
}

/** The part of the `searchcast` package serpcast uses. */
export interface SearchcastModule {
	Searchcast: new (options: {
		browser: {
			executable: string;
			userDataDir: string;
			proxy?: string;
			headless?: boolean;
			extraArgs?: string[];
			env?: Record<string, string>;
		};
		concurrency?: number;
	}) => {
		search(recipe: Recipe, query: string): Promise<{results: unknown}>;
		close(): Promise<void>;
	};
	findChrome?(): string | undefined;
	startXvfb?(options: {
		executable: string;
	}): Promise<{env: Record<string, string>; close(): Promise<void>}>;
}

export interface BrowserRunner {
	run(
		engine: BrowserEngine,
		query: string,
		signal?: AbortSignal,
	): Promise<SearchResult[]>;
	/** Stop the library-mode browser (and Xvfb), delete a temporary profile. */
	close(): Promise<void>;
}

/** True when `engine` is a browser engine. */
export function isBrowserEngine(engine: object): engine is BrowserEngine {
	const field = (engine as {searchcast?: unknown}).searchcast;
	return typeof field === 'object' && field !== null;
}

/** The proxy as Chromium's `--proxy-server` accepts it: `socks5h://` becomes `socks5://`, still resolving at the proxy. */
export function chromiumProxy(proxy: string): string {
	return proxy.replace(/^socks5h:\/\//i, 'socks5://');
}

export function createBrowserRunner(
	options: {proxy?: string; searchcast?: SearchcastLibraryOptions} = {},
): BrowserRunner {
	type Started = {
		searchcast: InstanceType<SearchcastModule['Searchcast']>;
		stop(): Promise<void>;
	};
	let started: Promise<Started> | undefined;

	async function start(): Promise<Started> {
		const config = options.searchcast ?? {};
		const module = config.module ?? (await importSearchcast());
		const executable = config.chrome ?? module.findChrome?.();
		if (!executable) {
			throw new SerpcastError(
				'transport',
				'searchcast: no browser found; pass searchcast.chrome or set SEARCHCAST_CHROME',
			);
		}
		const cleanups: Array<() => unknown> = [];
		const stop = async () => {
			for (const step of cleanups.reverse()) await step();
		};
		try {
			let userDataDir = config.profile;
			if (userDataDir === undefined) {
				const dir = mkdtempSync(join(tmpdir(), 'serpcast-profile-'));
				const remove = () => rmSync(dir, {recursive: true, force: true});
				process.once('exit', remove);
				cleanups.push(() => {
					process.removeListener('exit', remove);
					remove();
				});
				userDataDir = dir;
			}
			let env: Record<string, string> | undefined;
			if (config.xvfb) {
				if (!module.startXvfb)
					throw new Error('this searchcast has no startXvfb');
				const xvfb = await module.startXvfb({executable: config.xvfb});
				cleanups.push(() => xvfb.close());
				env = xvfb.env;
			}
			const searchcast = new module.Searchcast({
				browser: {
					executable,
					userDataDir,
					...(options.proxy && {proxy: chromiumProxy(options.proxy)}),
					...(config.headless && {headless: true}),
					...(config.chromeArgs && {extraArgs: config.chromeArgs}),
					...(env && {env}),
				},
				...(config.concurrency && {concurrency: config.concurrency}),
			});
			cleanups.push(() => searchcast.close());
			return {searchcast, stop};
		} catch (error) {
			await stop();
			if (error instanceof SerpcastError) throw error;
			throw new SerpcastError(
				'transport',
				`searchcast: cannot start (${String(error)})`,
				{cause: error},
			);
		}
	}

	async function library(name: string, recipe: Recipe, query: string) {
		started ??= start().catch((error: unknown) => {
			started = undefined;
			throw error;
		});
		const {searchcast} = await started;
		let response: {results: unknown};
		try {
			response = await searchcast.search(recipe, query);
		} catch (error) {
			const {code, message} = (error ?? {}) as {
				code?: unknown;
				message?: unknown;
			};
			throw searchcastError(name, code, String(message ?? error), error);
		}
		return searchcastResults(name, response?.results);
	}

	return {
		async run(engine, query, signal) {
			signal?.throwIfAborted();
			const target = engine.searchcast;
			if ('endpoint' in target)
				return searchEndpoint(engine.name, target, query, signal);
			const answer = library(engine.name, target.recipe, query);
			return signal ? untilAborted(answer, signal) : answer;
		},
		async close() {
			const current = started;
			started = undefined;
			await (await current?.catch(() => undefined))?.stop();
		},
	};
}

async function importSearchcast(): Promise<SearchcastModule> {
	// A variable specifier, so bundlers and tsc do not resolve it: searchcast
	// is an optional peer dependency, needed only for library-mode engines.
	const name = 'searchcast';
	try {
		return (await import(name)) as SearchcastModule;
	} catch (cause) {
		throw new SerpcastError(
			'transport',
			'searchcast is not installed: library-mode browser engines need the optional peer dependency "searchcast" (npm install searchcast)',
			{cause},
		);
	}
}
