// Code recipes: a JS module, loaded only from the path the caller gives, whose
// default export is `{name, search(query, ctx), timeoutMs?, decoyProne?}`. The context is
// the only capability serpcast hands it: `http` (GET through this engine's
// transport session, so the caller's proxy, the pinned fingerprint and the
// session cookies all apply), `session` (JSON state kept with the cookies),
// `signal`, `maxResults` and the `blocked`/`recipeError` helpers. A module can
// still import anything (it is code with full Node access), so which modules
// are loaded is the caller's trust decision (ADR 0002).
//
// - The whole search is bounded by the module's `timeoutMs` (default
//   `DEFAULT_TIMEOUT_MS`), like a declarative recipe; `ctx.signal` aborts then.
// - The output is validated: an array of `{title, url, snippet?, ...}` with
//   string values, else a `recipe` error. `[]` is the module's "no results".
// - A throw that is not a `SerpcastError` is the module's fault: `recipe`.
// - `http.text`/`http.json` map statuses as the declarative runner does
//   (202/403/429 `blocked`, 404/410 `recipe`, other non-2xx `transport`) and
//   follow no redirects; `http.get` returns the raw response.
// Decisions and alternatives: work/notes/observations/code-recipes-decisions.md.

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DEFAULT_TIMEOUT_MS} from 'serpcast-recipe';
import {REQUEST_KINDS} from './chrome.js';
import type {SearchResult} from './declarative.js';
import {SerpcastError} from './errors.js';
import type {JsonValue} from './store.js';
import type {
	RequestOptions,
	TransportResponse,
	TransportSession,
} from './transport.js';

/** A request made by a code recipe: the transport's options, without the signal (the context's). */
export type HttpOptions = RequestOptions extends infer O
	? O extends RequestOptions
		? Omit<O, 'signal'>
		: never
	: never;

/** GET through this engine's transport session (the only HTTP a code recipe is given). */
export interface CodeRecipeHttp {
	/** The raw response, whatever its status (redirects are not followed). */
	get(url: string, options: HttpOptions): Promise<TransportResponse>;
	/** The body as text; statuses are mapped to errors as for declarative recipes. */
	text(url: string, options: HttpOptions): Promise<string>;
	/** The body parsed as JSON (invalid JSON is a `recipe` error); statuses as for `text`. */
	json(url: string, options: HttpOptions): Promise<unknown>;
}

/** This engine's JSON state, kept in the state store with its cookies and dropped with them. */
export interface CodeRecipeSession {
	get(key: string): JsonValue | undefined;
	set(key: string, value: JsonValue): void;
	delete(key: string): void;
}

export interface CodeRecipeContext {
	http: CodeRecipeHttp;
	session: CodeRecipeSession;
	/** Aborts on the caller's abort or the recipe's timeout. */
	signal: AbortSignal;
	/** How many results the caller wants, when it said (the answer is cut to it anyway). */
	maxResults?: number;
	/** Throw a `blocked` error (starts the engine's cooldown). */
	blocked(message: string): never;
	/** Throw a `recipe` error (the site no longer fits the recipe). */
	recipeError(message: string): never;
}

/** A code recipe: the default export of its module. */
export interface CodeRecipe {
	name: string;
	search(
		query: string,
		ctx: CodeRecipeContext,
	): SearchResult[] | Promise<SearchResult[]>;
	/** The whole search's time limit in ms. Default `DEFAULT_TIMEOUT_MS`. */
	timeoutMs?: number;
	/** The site sometimes answers with decoy pages: the chain checks this engine's answers without it being named in `decoyGuard`. */
	decoyProne?: boolean;
}

export interface RunCodeRecipeOptions {
	/** Where requests go: a transport session (its cookies are used and kept). */
	session: Pick<TransportSession, 'request'>;
	/** The engine's JSON state, read and written in place by `ctx.session`. */
	state?: {[key: string]: JsonValue};
	signal?: AbortSignal;
	maxResults?: number;
}

/** True when `engine` is a code recipe rather than a declarative one. */
export function isCodeRecipe(engine: object): engine is CodeRecipe {
	return typeof (engine as {search?: unknown}).search === 'function';
}

/**
 * Import the ESM module at `path` (relative to the working directory) and
 * return its default export as a code recipe. Nothing is ever discovered:
 * only this path is loaded. A module that cannot be imported or does not
 * export `{name, search}` is a `recipe` error. Loading runs the module's code.
 */
export async function loadCodeRecipe(path: string): Promise<CodeRecipe> {
	let module: {default?: unknown};
	try {
		module = await import(pathToFileURL(resolve(path)).href);
	} catch (cause) {
		throw new SerpcastError('recipe', `cannot load code recipe ${path}`, {
			cause,
		});
	}
	const recipe = module.default as Partial<CodeRecipe> | undefined;
	const bad = (why: string) =>
		new SerpcastError('recipe', `code recipe ${path}: ${why}`);
	if (typeof recipe !== 'object' || recipe === null)
		throw bad('no default export object {name, search}');
	if (typeof recipe.name !== 'string' || !recipe.name)
		throw bad('"name" must be a non-empty string');
	if (typeof recipe.search !== 'function')
		throw bad('"search" must be a function');
	const {timeoutMs} = recipe;
	if (
		timeoutMs !== undefined &&
		!(typeof timeoutMs === 'number' && timeoutMs > 0)
	)
		throw bad('"timeoutMs" must be a positive number');
	const {decoyProne} = recipe;
	if (decoyProne !== undefined && typeof decoyProne !== 'boolean')
		throw bad('"decoyProne" must be a boolean');
	return {
		name: recipe.name,
		search: recipe.search.bind(recipe),
		...(timeoutMs !== undefined && {timeoutMs}),
		...(decoyProne !== undefined && {decoyProne}),
	};
}

/**
 * Run a code recipe for `query`. Resolves with its validated results or
 * rejects with a `SerpcastError`; aborting `signal` rejects with its reason.
 */
export async function runCodeRecipe(
	recipe: CodeRecipe,
	query: string,
	options: RunCodeRecipeOptions,
): Promise<{recipe: string; results: SearchResult[]}> {
	const {name} = recipe;
	options.signal?.throwIfAborted();
	const timeoutMs = recipe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = new AbortController();
	const timeout = setTimeout(
		() =>
			timer.abort(
				new SerpcastError(
					'timeout',
					`${name}: timed out after ${timeoutMs} ms`,
				),
			),
		timeoutMs,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, timer.signal])
		: timer.signal;
	const ctx: CodeRecipeContext = {
		http: http(name, options.session, signal),
		session: session(name, options.state ?? {}),
		signal,
		...(options.maxResults !== undefined && {maxResults: options.maxResults}),
		blocked(message) {
			throw new SerpcastError('blocked', `${name}: blocked (${message})`);
		},
		recipeError(message) {
			throw new SerpcastError('recipe', `${name}: ${message}`);
		},
	};
	try {
		const output = await untilAborted(
			Promise.resolve().then(() => recipe.search(query, ctx)),
			signal,
		);
		return {recipe: name, results: validate(name, output)};
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error instanceof SerpcastError) throw error;
		throw new SerpcastError('recipe', `${name}: threw ${String(error)}`, {
			cause: error,
		});
	} finally {
		clearTimeout(timeout);
	}
}

/** Statuses mapped like the declarative runner's (declarative.ts). */
function checkStatus(name: string, response: TransportResponse) {
	const {status, url} = response;
	if (status >= 200 && status <= 299 && status !== 202) return;
	const where = `HTTP ${status} from ${url}`;
	if (status === 202 || status === 403 || status === 429)
		throw new SerpcastError('blocked', `${name}: blocked (${where})`);
	if (status === 404 || status === 410)
		throw new SerpcastError('recipe', `${name}: ${where}`);
	throw new SerpcastError('transport', `${name}: ${where}`);
}

function http(
	name: string,
	session: Pick<TransportSession, 'request'>,
	signal: AbortSignal,
): CodeRecipeHttp {
	const get = async (url: string, options: HttpOptions) => {
		if (!REQUEST_KINDS.includes(options?.kind)) {
			throw new SerpcastError(
				'recipe',
				`${name}: request kind must be one of ${REQUEST_KINDS.join(', ')}`,
			);
		}
		return session.request(url, {...options, signal} as RequestOptions);
	};
	const text = async (url: string, options: HttpOptions) => {
		const response = await get(url, options);
		checkStatus(name, response);
		return response.text();
	};
	return {
		get,
		text,
		async json(url, options) {
			const body = await text(url, options);
			try {
				return JSON.parse(body) as unknown;
			} catch (cause) {
				throw new SerpcastError('recipe', `${name}: not JSON from ${url}`, {
					cause,
				});
			}
		},
	};
}

function session(
	name: string,
	state: {[key: string]: JsonValue},
): CodeRecipeSession {
	return {
		get: (key) =>
			Object.hasOwn(state, key) ? structuredClone(state[key]) : undefined,
		set(key, value) {
			if (!isJson(value)) {
				throw new SerpcastError(
					'recipe',
					`${name}: session value for "${key}" is not plain JSON`,
				);
			}
			state[key] = structuredClone(value);
		},
		delete(key) {
			delete state[key];
		},
	};
}

function isJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	if (typeof value !== 'object') return false;
	const proto = Object.getPrototypeOf(value) as unknown;
	return (
		(proto === Object.prototype || proto === null) &&
		Object.values(value).every(isJson)
	);
}

/** The module's output as normalized results, or a `recipe` error. */
function validate(name: string, output: unknown): SearchResult[] {
	const bad = (why: string) =>
		new SerpcastError('recipe', `${name}: malformed output, ${why}`);
	if (!Array.isArray(output)) throw bad('not an array of results');
	return output.map((entry: unknown, i) => {
		if (typeof entry !== 'object' || entry === null)
			throw bad(`result ${i} is not an object`);
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(entry)) {
			if (value === undefined) continue;
			if (typeof value !== 'string')
				throw bad(`result ${i} field "${key}" is not a string`);
			result[key] = value;
		}
		if (!result.title) throw bad(`result ${i} has no title`);
		if (!result.url) throw bad(`result ${i} has no url`);
		return result as SearchResult;
	});
}

/**
 * `promise`, or the signal's reason as soon as it aborts. The handlers are
 * attached to `promise` before anything else, so a rejection after the abort
 * is never unhandled.
 */
export function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort);
		});
		if (signal.aborted) return onAbort();
		signal.addEventListener('abort', onAbort, {once: true});
	});
}
