// The searchcast side of browser engines (browser.ts): endpoint mode's HTTP
// client for a running `searchcast serve` (TCP URL or Unix socket path), and
// the mapping of searchcast's answers and error codes, shared with library
// mode. The endpoint request goes straight to the endpoint, never through
// serpcast's proxy: it is the caller's local service, and the browser behind
// it has its own egress, which serpcast does not control.

import {
	request as httpRequest,
	type IncomingMessage,
	type RequestOptions,
} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {DEFAULT_TIMEOUT_MS} from 'serpcast-recipe';
import {normalizeResult, type SearchResult} from './declarative.js';
import {SerpcastError} from './errors.js';
import {checkNumber} from './options.js';

/** A searchcast error code (HTTP `error` field or thrown `code`) as a serpcast error. */
export function searchcastError(
	engine: string,
	code: unknown,
	message: string,
	cause?: unknown,
): SerpcastError {
	const kind =
		code === 'blocked' || code === 'recipe' || code === 'timeout'
			? code
			: code === 'input' || code === 'unknown-recipe'
				? 'recipe'
				: 'transport';
	const label = typeof code === 'string' ? code : 'error';
	return new SerpcastError(kind, `${engine}: searchcast ${label}: ${message}`, {
		cause,
	});
}

/** Largest endpoint answer accepted by default, in bytes (the endpoint's `maxBodyBytes`). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** `GET /search?recipe=&q=` on a running `searchcast serve`, as serpcast results or a `SerpcastError`. */
export async function searchEndpoint(
	name: string,
	target: {
		endpoint: string;
		recipe?: string;
		timeoutMs?: number;
		maxBodyBytes?: number;
	},
	query: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const search = new URLSearchParams({recipe: target.recipe ?? name, q: query});
	let timeoutMs: number;
	let maxBytes: number;
	try {
		timeoutMs =
			checkNumber('timeoutMs', target.timeoutMs, {integer: true}) ??
			2 * DEFAULT_TIMEOUT_MS;
		maxBytes =
			checkNumber('maxBodyBytes', target.maxBodyBytes, {integer: true}) ??
			MAX_BODY_BYTES;
	} catch (cause) {
		// A misconfigured engine, as for an unknown recipe name.
		throw new SerpcastError(
			'recipe',
			`${name}: searchcast endpoint ${(cause as Error).message.replace(/^serpcast: /, '')}`,
			{cause},
		);
	}
	const timer = AbortSignal.timeout(timeoutMs);
	const abort = signal ? AbortSignal.any([signal, timer]) : timer;
	let answer: {status: number; body: string};
	try {
		answer = await get(target.endpoint, `/search?${search}`, abort, maxBytes);
	} catch (error) {
		if (signal?.aborted) throw signal.reason;
		if (timer.aborted)
			throw new SerpcastError(
				'timeout',
				`${name}: searchcast did not answer within ${timeoutMs} ms`,
			);
		if (error instanceof SerpcastError) throw error;
		throw new SerpcastError(
			'transport',
			`${name}: cannot reach searchcast at ${target.endpoint} (${String(error)})`,
			{cause: error},
		);
	}
	let body: {error?: unknown; message?: unknown; results?: unknown};
	try {
		body = JSON.parse(answer.body) as typeof body;
	} catch (cause) {
		throw new SerpcastError(
			'transport',
			`${name}: searchcast answered HTTP ${answer.status} with a body that is not JSON`,
			{cause},
		);
	}
	if (answer.status === 200 && body?.error === undefined)
		return searchcastResults(name, body?.results);
	throw searchcastError(
		name,
		body?.error ?? `HTTP ${answer.status}`,
		String(body?.message ?? ''),
	);
}

/** One GET to `base` (a URL, or a Unix socket path when it starts with `/`). */
function get(
	base: string,
	path: string,
	signal: AbortSignal,
	maxBytes: number,
): Promise<{status: number; body: string}> {
	let options: RequestOptions;
	let send = httpRequest;
	if (base.startsWith('/')) {
		options = {socketPath: base, path, headers: {host: 'localhost'}};
	} else {
		const url = new URL(base);
		if (url.protocol === 'https:') send = httpsRequest;
		else if (url.protocol !== 'http:')
			throw new SerpcastError(
				'recipe',
				`searchcast endpoint ${base}: not an http(s) URL or a socket path`,
			);
		options = {
			protocol: url.protocol,
			hostname: url.hostname.replace(/^\[|\]$/g, ''),
			...(url.port && {port: url.port}),
			path: url.pathname.replace(/\/$/, '') + path,
		};
	}
	return new Promise((resolve, reject) => {
		const req = send({...options, signal}, (res: IncomingMessage) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error(`answer larger than ${maxBytes} bytes`));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			res.on('error', reject);
			res.on('end', () =>
				resolve({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString('utf8'),
				}),
			);
		});
		req.on('error', reject);
		req.end();
	});
}

/** searchcast's results (library or HTTP) as serpcast results, or a `transport` error. */
export function searchcastResults(name: string, list: unknown): SearchResult[] {
	const bad = (why: string) =>
		new SerpcastError(
			'transport',
			`${name}: malformed searchcast answer, ${why}`,
		);
	if (!Array.isArray(list)) throw bad('no results array');
	return list.map((entry: unknown, i) => {
		if (typeof entry !== 'object' || entry === null)
			throw bad(`result ${i} is not an object`);
		const row: Record<string, string> = {};
		for (const [key, value] of Object.entries(entry))
			if (typeof value === 'string') row[key] = value;
		if (!row.title || !row.url) throw bad(`result ${i} has no title or url`);
		return normalizeResult(row);
	});
}
