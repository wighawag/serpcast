// POST requests: a page's `fetch()` POST (only the `fetch` kind), and the
// CORS preflight Chrome sends before one when it goes to another origin with a
// `content-type` that is not CORS-safelisted. This module checks a POST's
// options and a preflight's answer; transport.ts sends both (the preflight
// without cookies, on connections of its own, remembered per page origin and
// URL for its max-age). Header tables: chrome.ts. Measurement:
// work/notes/findings/post-requests.md. Decisions:
// work/notes/observations/2026-09-29-post-requests-decisions.md.

import {TEXT_BODY_CONTENT_TYPE, type FetchSite} from './chrome.js';
import {SerpcastError} from './errors.js';
import type {TransportResponse} from './response.js';
import type {RequestOptions} from './transport.js';

/**
 * A page's `fetch(url, {method: 'POST', body, credentials: 'include'})`.
 * `body` is a string (sent as UTF-8) or bytes, at most
 * `MAX_REQUEST_BODY_BYTES`; none sends an empty body. `contentType` defaults
 * to what `fetch()` gives the body: `text/plain;charset=UTF-8` for a string,
 * none for bytes or no body.
 */
export interface PostOptions {
	kind: 'fetch';
	method: 'POST';
	referer: string;
	fetchSite?: FetchSite;
	body?: string | Uint8Array;
	contentType?: string;
}

/** The largest request body a POST may carry, in bytes (1 MiB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Chromium's cap on a preflight's `access-control-max-age`, in seconds. */
const MAX_PREFLIGHT_AGE_S = 2 * 60 * 60;
/** The Fetch standard's default preflight cache time, in seconds (measured). */
const DEFAULT_PREFLIGHT_AGE_S = 5;

/**
 * A POST's body as bytes and its `content-type`, or `undefined` for a GET.
 * Misuse (a POST that is not `fetch`, a body that is not a string or bytes,
 * or too large, a bad `content-type`, an unknown method) is a `recipe` error:
 * a code recipe is plain JS, so the types are checked here too.
 */
export function postBody(
	request: RequestOptions,
): {body: Uint8Array; contentType?: string} | undefined {
	// Plain JS callers can pass anything: check the values, not the types.
	const {method, kind, body, contentType} = request as {
		method?: unknown;
		kind?: unknown;
		body?: unknown;
		contentType?: unknown;
	};
	if (method === undefined || method === 'GET') return undefined;
	if (method !== 'POST') {
		throw new SerpcastError(
			'recipe',
			`request method must be GET or POST, got ${JSON.stringify(method)}`,
		);
	}
	if (kind !== 'fetch') {
		throw new SerpcastError(
			'recipe',
			`a POST must be a fetch request, not ${String(kind)}`,
		);
	}
	let bytes: Uint8Array;
	if (body === undefined) bytes = new Uint8Array();
	else if (typeof body === 'string') bytes = new TextEncoder().encode(body);
	else if (body instanceof Uint8Array) bytes = body;
	else {
		throw new SerpcastError(
			'recipe',
			'a POST body must be a string or a Uint8Array',
		);
	}
	if (bytes.length > MAX_REQUEST_BODY_BYTES) {
		throw new SerpcastError(
			'recipe',
			`a POST body is limited to ${MAX_REQUEST_BODY_BYTES} bytes, got ${bytes.length}`,
		);
	}
	if (
		contentType !== undefined &&
		(typeof contentType !== 'string' || !/^[\t\x20-\x7e]+$/.test(contentType))
	) {
		throw new SerpcastError(
			'recipe',
			`contentType must be a printable ASCII string, got ${JSON.stringify(contentType)}`,
		);
	}
	return {
		body: bytes,
		contentType:
			contentType ??
			(typeof body === 'string' ? TEXT_BODY_CONTENT_TYPE : undefined),
	};
}

/**
 * Whether a credentialed POST may follow this preflight answer, as Chrome
 * decides it: an ok status (2xx), `access-control-allow-origin` equal to the
 * page's origin (a credentialed request does not accept `*`),
 * `access-control-allow-credentials: true` and `content-type` among
 * `access-control-allow-headers`. Returns how long to remember it, in
 * seconds; a refusal throws: statuses as the declarative runner maps them
 * (202/403/429 `blocked`, 404/410 `recipe`, others `transport`), CORS
 * headers that do not allow the request `recipe`.
 */
export function checkPreflight(
	response: TransportResponse,
	origin: string,
): number {
	const {status, url, headers} = response;
	if (!(status >= 200 && status <= 299) || status === 202) {
		const where = `preflight: HTTP ${status} from ${url}`;
		if (status === 202 || status === 403 || status === 429)
			throw new SerpcastError('blocked', `blocked (${where})`);
		if (status === 404 || status === 410)
			throw new SerpcastError('recipe', where);
		throw new SerpcastError('transport', where);
	}
	const allowed = (headers.get('access-control-allow-headers') ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase());
	const refused =
		headers.get('access-control-allow-origin') !== origin
			? `access-control-allow-origin is not ${origin}`
			: headers.get('access-control-allow-credentials') !== 'true'
				? 'access-control-allow-credentials is not true'
				: !allowed.includes('content-type')
					? 'content-type is not in access-control-allow-headers'
					: undefined;
	if (refused) {
		throw new SerpcastError(
			'recipe',
			`the CORS preflight to ${url} does not allow the POST from ${origin}: ${refused}`,
		);
	}
	const maxAge = headers.get('access-control-max-age');
	const age = maxAge === null ? NaN : Number(maxAge.trim());
	return Number.isInteger(age) && age >= 0
		? Math.min(age, MAX_PREFLIGHT_AGE_S)
		: DEFAULT_PREFLIGHT_AGE_S;
}
