// Test helpers for the engine chain: fake engines (declarative recipes for
// `https://<name>.test/`) served by a fake transport that answers from a
// per-engine handler, keeps cookies with the real CookieStore, and records
// every request. No network, no native library.

import {parseRecipe, type Recipe} from 'serpcast-recipe';
import {
	CookieStore,
	type ChainTransport,
	createMemoryStore,
	type JsonValue,
	type RequestOptions,
	type StateStore,
	type StoredCookie,
	type TransportResponse,
} from '../src/index.js';
import {item, resultsPage} from './pages.js';

/** What a fake engine answers: a page, or a thrown error. */
export type Answer =
	| {
			status?: number;
			body: string;
			setCookie?: string[];
			headers?: Record<string, string>;
	  }
	| {throw: unknown};

export interface FakeRequest {
	engine: string;
	url: string;
	/** The `cookie` header the transport would have sent. */
	cookie?: string;
	/** The request kind (selects the header table) and its referer. */
	kind: RequestOptions['kind'];
	referer?: string;
	/** Only for a POST: the method, its body (as text) and content type. */
	method?: 'POST';
	body?: string;
	contentType?: string;
	/** The fake transport's proxy: every request of one transport carries it. */
	proxy?: string;
}

/** A declarative recipe for the fake engine `name`. */
export const engine = (name: string): Recipe =>
	parseRecipe({
		name,
		navigate: {url: `https://${name}.test/search?q={query}`},
		ready: '#results',
		empty: '.no-results',
		blocked: ['#captcha'],
		results: {
			item: '.result',
			fields: {
				title: {selector: 'a.title'},
				url: {selector: 'a.title', attr: 'href'},
			},
		},
	});

export const pages = {
	results: (...titles: string[]): Answer => ({
		body: resultsPage(...titles.map((t) => item(t, `/${t}`))),
	}),
	empty: (): Answer => ({body: '<p class="no-results">none</p>'}),
	blocked: (): Answer => ({status: 403, body: ''}),
	broken: (): Answer => ({body: '<p>not what the recipe expects</p>'}),
};

/** A fake transport; `answers[engine]` decides each engine's reply. */
export function fakeTransport(
	answers: Record<string, (request: FakeRequest) => Answer>,
	{proxy}: {proxy?: string} = {},
) {
	const requests: FakeRequest[] = [];
	const transport: ChainTransport = {
		session(saved?: readonly StoredCookie[]) {
			const jar = new CookieStore(saved);
			return {
				cookies: () => jar.list(),
				clearCookies: () => jar.clear(),
				async request(
					url: string,
					options: RequestOptions,
				): Promise<TransportResponse> {
					await Promise.resolve(); // answer asynchronously, like a real transport
					options.signal?.throwIfAborted();
					const target = new URL(url);
					const name = target.hostname.replace(/\.test$/, '');
					const request: FakeRequest = {
						engine: name,
						url,
						cookie: jar.header(target),
						kind: options.kind,
						...(options.referer && {referer: options.referer}),
						...(options.method === 'POST' && {
							method: 'POST' as const,
							body:
								typeof options.body === 'string'
									? options.body
									: new TextDecoder().decode(options.body),
							...(options.contentType !== undefined && {
								contentType: options.contentType,
							}),
						}),
						...(proxy && {proxy}),
					};
					requests.push(request);
					const answer = answers[name]?.(request) ?? pages.broken();
					if ('throw' in answer) throw answer.throw;
					const headers = new Headers(answer.headers);
					for (const c of answer.setCookie ?? [])
						headers.append('set-cookie', c);
					jar.store(target, answer.setCookie ?? []);
					const body = new TextEncoder().encode(answer.body);
					return {
						url,
						status: answer.status ?? 200,
						headers,
						body,
						text: () => answer.body,
					};
				},
			};
		},
	};
	const hits = (name: string) => requests.filter((r) => r.engine === name);
	return {transport, requests, hits};
}

/** A settable clock. */
export function clock(start = Date.UTC(2026, 8, 28)) {
	let t = start;
	return {now: () => t, advance: (ms: number) => void (t += ms)};
}

/** A state store that records every call, over a memory store. */
export function recordingStore(now: () => number) {
	const inner = createMemoryStore({now});
	const calls: {op: 'get' | 'set' | 'delete'; key: string}[] = [];
	const store: StateStore = {
		get: (key) => (calls.push({op: 'get', key}), inner.get(key)),
		set: (key, value: JsonValue, options) => (
			calls.push({op: 'set', key}),
			inner.set(key, value, options)
		),
		delete: (key) => (calls.push({op: 'delete', key}), inner.delete(key)),
	};
	return {store, calls};
}
