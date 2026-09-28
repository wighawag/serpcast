// Turning what libcurl received into a response: the status and headers of
// the LAST header block (a proxy's CONNECT answer and 1xx blocks come first),
// and the body decoded per content-encoding. libcurl is never asked to decode
// (CURLOPT_ACCEPT_ENCODING would add its own accept-encoding header), and
// Chrome advertises zstd, so all four codings are decoded here, each capped at
// the body limit (no decompression bomb).

import * as zlib from 'node:zlib';
import {SerpcastError} from './errors.js';

export interface TransportResponse {
	/** The URL requested (redirects are not followed; see `status` and `location`). */
	url: string;
	status: number;
	headers: Headers;
	/** The decoded body. */
	body: Uint8Array;
	/** The body as text, in the charset of `content-type` (UTF-8 by default). */
	text(): string;
}

export function respond(
	url: string,
	lines: string[],
	raw: Buffer,
	max: number,
): TransportResponse {
	const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines[0] ?? '')?.[1]);
	if (!status)
		throw new SerpcastError('transport', `no HTTP status from ${url}`);
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		try {
			headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		} catch {
			// a header Headers rejects (invalid bytes) is dropped
		}
	}
	const body = decode(raw, headers.get('content-encoding'), max, url);
	const charset = /charset=["']?([\w-]+)/i.exec(
		headers.get('content-type') ?? '',
	)?.[1];
	return {
		url,
		status,
		headers,
		body,
		text() {
			try {
				return new TextDecoder(charset ?? 'utf-8').decode(body);
			} catch {
				return new TextDecoder().decode(body);
			}
		},
	};
}

function decode(
	raw: Buffer,
	encoding: string | null,
	max: number,
	url: string,
): Uint8Array {
	const opts = {maxOutputLength: max};
	let body = raw;
	const codings = (encoding ?? '')
		.split(',')
		.map((c) => c.trim().toLowerCase())
		.filter(Boolean);
	try {
		for (const coding of codings.reverse()) {
			if (coding === 'gzip' || coding === 'x-gzip')
				body = zlib.gunzipSync(body, opts);
			else if (coding === 'br') body = zlib.brotliDecompressSync(body, opts);
			else if (coding === 'zstd') body = zlib.zstdDecompressSync(body, opts);
			else if (coding === 'deflate') body = inflate(body, opts);
			else if (coding !== 'identity')
				throw new Error(`unsupported content-encoding ${coding}`);
		}
	} catch (cause) {
		throw new SerpcastError(
			'transport',
			`cannot decode the response from ${url}`,
			{cause},
		);
	}
	return body;
}

function inflate(body: Buffer, opts: zlib.ZlibOptions): Buffer {
	try {
		return zlib.inflateSync(body, opts);
	} catch {
		return zlib.inflateRawSync(body, opts);
	}
}
