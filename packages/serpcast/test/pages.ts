// Test helpers for the declarative runner: a local HTTP server serving HTML
// fixtures by path, and a fake transport session that fetches from it with
// Node's own HTTP client (so the runner tests need no native library).

import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {parseRecipe, type Recipe} from 'serpcast-recipe';
import type {RequestOptions, TransportResponse} from '../src/index.js';

export interface Route {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	/** Never answer (a slow page). */
	hang?: boolean;
}

export interface PageServer {
	origin: string;
	/** Every path requested, in order. */
	hits: string[];
	close(): Promise<void>;
}

/** Serve `routes` by path (the query string is part of the key when present there). */
export async function startPageServer(
	routes: Record<string, Route>,
): Promise<PageServer> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		const path = req.url ?? '/';
		hits.push(path);
		const route = routes[path] ?? routes[path.split('?')[0]!];
		if (!route) {
			res.writeHead(500).end('no route');
			return;
		}
		if (route.hang) return;
		res.writeHead(route.status ?? 200, {
			'content-type': 'text/html; charset=utf-8',
			...route.headers,
		});
		res.end(route.body ?? '');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** A fake transport session over Node's HTTP client; records each request. */
export function fakeSession() {
	const requests: {url: string; options: RequestOptions}[] = [];
	return {
		requests,
		request(url: string, options: RequestOptions): Promise<TransportResponse> {
			requests.push({url, options});
			return new Promise((resolve, reject) => {
				const req = http.get(url, {signal: options.signal}, (res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('error', reject);
					res.on('end', () => {
						const body = Buffer.concat(chunks);
						const headers = new Headers();
						for (const [name, value] of Object.entries(res.headers)) {
							for (const v of [value ?? []].flat()) headers.append(name, v);
						}
						resolve({
							url,
							status: res.statusCode!,
							headers,
							body,
							text: () => body.toString('utf8'),
						});
					});
				});
				req.on('error', (error) =>
					reject(options.signal?.aborted ? options.signal.reason : error),
				);
			});
		},
	};
}

/** A recipe for `origin`, over `/search?q={query}`, with overrides. */
export function recipe(origin: string, overrides: object = {}): Recipe {
	return parseRecipe({
		name: 'test',
		navigate: {url: `${origin}/search?q={query}`},
		ready: '#results',
		empty: '.no-results',
		blocked: ['#captcha'],
		blockedUrl: ['/challenge'],
		results: {
			item: '.result',
			fields: {
				title: {selector: 'a.title'},
				url: {selector: 'a.title', attr: 'href'},
				content: {selector: '.snippet'},
			},
		},
		...overrides,
	});
}

/** A results page with the given items (each an HTML fragment). */
export const resultsPage = (...items: string[]) =>
	`<html><body><div id="results">${items.join('')}</div></body></html>`;

/** A well-formed result item. */
export const item = (title: string, href: string, snippet?: string) =>
	`<div class="result"><a class="title" href="${href}">${title}</a>${
		snippet === undefined ? '' : `<p class="snippet">${snippet}</p>`
	}</div>`;
