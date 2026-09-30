// Running one declarative recipe over HTTP: the same recipe searchcast runs in
// a real browser, with searchcast's semantics (searchcast@0.1.1
// `src/searchcast.ts` and `src/probe.ts`) except that no script runs.
//
// One page, one decision, in this order:
//   1. HTTP 202/403/429, a `blockedUrl` match on the final URL, or a `blocked`
//      selector match: `blocked`.
//   2. Any other non-2xx: 404/410 are `recipe` (the URL template is wrong),
//      everything else is `transport`.
//   3. `ready` present: the results, cut to `limit`; no item with both a
//      `title` and a `url` is a `recipe` error, never an empty list.
//   4. `empty` present: [] (the only way to get an empty list).
//   5. Nothing matched: `recipe`.
// `ready` is checked before `empty`, as in searchcast's probe, so a page on
// which both match gives the same answer in both runners. Where searchcast
// keeps polling a live page and ends in `timeout` (nothing matched, or `ready`
// matched with no usable item), this runner answers `recipe` at once: a static
// HTML response will not change. Decisions and alternatives:
// work/notes/observations/declarative-http-runner-decisions.md.

import {
	DEFAULT_LIMIT,
	DEFAULT_TIMEOUT_MS,
	requiresBrowser,
	type Recipe,
} from 'serpcast-recipe';
import {untilAborted} from './code.js';
import {SerpcastError} from './errors.js';
import {parsePage} from './html.js';
import {checkNumber} from './options.js';
import type {TransportResponse, TransportSession} from './transport.js';

/** One normalized search result; extra recipe fields pass through as strings. */
export type SearchResult = {title: string; url: string; snippet?: string} & {
	[field: string]: string | undefined;
};

export interface RecipeResponse {
	/** The name of the recipe that answered. */
	recipe: string;
	results: SearchResult[];
}

export interface RunRecipeOptions {
	/** Where requests go: a transport session (its cookies are used and kept). */
	session: Pick<TransportSession, 'request'>;
	/** Aborting rejects with the signal's reason. */
	signal?: AbortSignal;
	/** How many redirects are followed; one more is a `transport` error. Default 20 (Chrome's); 0 follows none. */
	maxRedirects?: number;
}

/** Statuses a site answers with when it refuses or challenges the request. */
const BLOCKED_STATUS = new Set([202, 403, 429]);
/** Statuses that mean the URL does not exist: the recipe's URL template is wrong. */
const MISSING_STATUS = new Set([404, 410]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** Chrome's limit (net::URLRequest kMaxRedirects): the default `maxRedirects`. */
export const MAX_REDIRECTS = 20;
/** Where the snippet comes from, first present wins. */
const SNIPPET_FIELDS = ['content', 'snippet', 'description'];

/**
 * Run a declarative recipe for `query` over HTTP. Resolves with the results
 * (empty only when the recipe's `empty` selector matched) or rejects with a
 * `SerpcastError`. The whole call, redirects included, is bounded by the
 * recipe's `timeoutMs`.
 */
export async function runDeclarativeRecipe(
	recipe: Recipe,
	query: string,
	options: RunRecipeOptions,
): Promise<RecipeResponse> {
	const {name} = recipe;
	if (requiresBrowser(recipe) || !recipe.navigate) {
		throw new SerpcastError(
			'recipe',
			`${name}: uses "form", which needs a real browser: run it through searchcast`,
		);
	}
	const maxRedirects =
		checkNumber('maxRedirects', options.maxRedirects, {
			integer: true,
			zero: true,
		}) ?? MAX_REDIRECTS;
	options.signal?.throwIfAborted();
	const timeoutMs = recipe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
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
	try {
		let url = recipe.navigate.url.replaceAll(
			'{query}',
			encodeURIComponent(query),
		);
		for (let redirects = 0; ; redirects++) {
			const response = await untilAborted(
				options.session.request(url, {
					kind: 'document',
					signal,
					timeoutMs: Math.max(1, deadline - Date.now()),
				}),
				signal,
			);
			const location = response.headers.get('location');
			if (!REDIRECT_STATUS.has(response.status) || location === null) {
				return {recipe: name, results: decide(recipe, response)};
			}
			if (redirects >= maxRedirects) {
				throw new SerpcastError(
					'transport',
					`${name}: more than ${maxRedirects} redirects from ${url}`,
				);
			}
			url = resolveLocation(location, response.url, name);
		}
	} finally {
		clearTimeout(timeout);
	}
}

function decide(recipe: Recipe, response: TransportResponse): SearchResult[] {
	const {name} = recipe;
	const {status, url} = response;
	const blocked = (reason: string) =>
		new SerpcastError('blocked', `${name}: blocked (${reason})`);
	if (BLOCKED_STATUS.has(status)) throw blocked(`HTTP ${status} from ${url}`);
	for (const pattern of recipe.blockedUrl ?? []) {
		if (new RegExp(pattern).test(url)) throw blocked(`url matched ${pattern}`);
	}
	const page = parsePage(response.text(), url, name);
	for (const selector of recipe.blocked ?? []) {
		if (page.has(selector)) throw blocked(`found ${selector}`);
	}
	if (status < 200 || status > 299) {
		throw MISSING_STATUS.has(status)
			? new SerpcastError(
					'recipe',
					`${name}: HTTP ${status} from ${url} (is navigate.url right?)`,
				)
			: new SerpcastError('transport', `${name}: HTTP ${status} from ${url}`);
	}
	if (page.has(recipe.ready)) {
		const limit = recipe.limit ?? DEFAULT_LIMIT;
		const results: SearchResult[] = [];
		for (const item of page.all(recipe.results.item)) {
			const row: Record<string, string> = {};
			for (const [key, field] of Object.entries(recipe.results.fields)) {
				const value = page.read(item, field);
				if (value !== undefined) row[key] = value;
			}
			if (row.title && row.url) results.push(normalizeResult(row));
			if (results.length >= limit) break;
		}
		if (results.length > 0) return results;
		throw new SerpcastError(
			'recipe',
			`${name}: ready but no result had both a title and a url`,
		);
	}
	if (recipe.empty && page.has(recipe.empty)) return [];
	throw new SerpcastError(
		'recipe',
		`${name}: the page from ${url} matches none of ready (${recipe.ready}), empty or blocked`,
	);
}

/** A row of recipe fields as a result: `snippet` from the first of `content`, `snippet`, `description`. */
export function normalizeResult(row: Record<string, string>): SearchResult {
	const snippet = SNIPPET_FIELDS.map((key) => row[key]).find(Boolean);
	const {title, url, ...extra} = row;
	return {title: title!, url: url!, ...extra, ...(snippet && {snippet})};
}

function resolveLocation(location: string, from: string, name: string) {
	try {
		return new URL(location, from).href;
	} catch (cause) {
		throw new SerpcastError(
			'transport',
			`${name}: bad redirect location ${location} from ${from}`,
			{cause},
		);
	}
}
