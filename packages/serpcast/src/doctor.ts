// `serpcast doctor`: which library serpcast would load and from where, and
// whether impersonation is active (the strict check, which makes no network
// call). Only with `remote` does it make one request, through the transport
// (and so through the caller's proxy), to a fingerprint echo service, and
// reports the JA3/JA4/HTTP2 values the service saw. The remote request is
// skipped when impersonation is not active: it would only show a non-browser
// fingerprint, sent where the user asked for a check of a browser one.

import {SerpcastError} from './errors.js';
import {
	LIBCURL_IMPERSONATE,
	loadLibcurl,
	locateLibrary,
	type LibrarySource,
} from './libcurl.js';
import {IMPERSONATE_TARGET} from './chrome.js';
import {createTransport} from './transport.js';

/**
 * The echo service `--remote` asks: the one the fingerprint finding measured
 * against (tls.peet.ws timed out there). It answers JSON with `ja3_hash`,
 * `ja3n_hash`, `ja4`, `akamai_hash` and `akamai_text` (the HTTP/2 fingerprint).
 */
export const ECHO_URL = 'https://tls.browserleaks.com/json';

export interface DoctorOptions {
	libcurlPath?: string;
	proxy?: string;
	/** Request the echo service. Default false: no network request at all. */
	remote?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Tests only: a local echo service and its CA. */
	echoUrl?: string;
	caPath?: string;
}

export interface DoctorReport {
	pinned: string;
	target: string;
	library?: {path: string; source: LibrarySource; version?: string};
	impersonating: boolean;
	/** Why impersonation is not active. */
	problem?: string;
	remote?: {url: string; seen?: Record<string, string>; error?: string};
}

const FIELDS: [string, string][] = [
	['ja3', 'ja3_hash'],
	['ja3n', 'ja3n_hash'],
	['ja4', 'ja4'],
	['http2', 'akamai_text'],
	['http2 hash', 'akamai_hash'],
];

export async function doctor(
	options: DoctorOptions = {},
): Promise<DoctorReport> {
	const located = locateLibrary(
		options.libcurlPath,
		options.env ?? process.env,
	);
	const report: DoctorReport = {
		pinned: `libcurl-impersonate ${LIBCURL_IMPERSONATE.version}`,
		target: IMPERSONATE_TARGET,
		impersonating: false,
	};
	const transport =
		located &&
		createTransport({
			libcurlPath: located.path,
			proxy: options.proxy,
			caPath: options.caPath,
		});
	if (!located || !transport) {
		report.problem = await loadLibcurl(undefined).then(
			() => undefined,
			(error: Error) => error.message,
		);
	} else {
		const library: NonNullable<DoctorReport['library']> = {...located};
		report.library = library;
		try {
			library.version = (await transport.check()).version;
			report.impersonating = true;
		} catch (error) {
			if (!(error instanceof SerpcastError)) throw error;
			report.problem = error.message;
			const loose = createTransport({libcurlPath: located.path, strict: false});
			library.version = (await loose.check().catch(() => undefined))?.version;
		}
	}
	if (!options.remote) return report;
	const url = options.echoUrl ?? ECHO_URL;
	if (!report.impersonating || !transport) {
		report.remote = {url, error: 'skipped: impersonation is not active'};
		return report;
	}
	try {
		const response = await transport.session().request(url, {kind: 'document'});
		if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
		const body = JSON.parse(response.text()) as Record<string, unknown>;
		const seen: Record<string, string> = {};
		for (const [label, key] of FIELDS) {
			if (typeof body[key] === 'string') seen[label] = body[key];
		}
		report.remote = {url, seen};
	} catch (error) {
		const kind = error instanceof SerpcastError ? `${error.kind}: ` : '';
		report.remote = {url, error: kind + (error as Error).message};
	}
	return report;
}

/** Whether the report is all good: impersonating, and the remote check (if any) answered. */
export function healthy(report: DoctorReport): boolean {
	return report.impersonating && !report.remote?.error;
}

const SOURCE: Record<LibrarySource, string> = {
	option: '--libcurl',
	SERPCAST_LIBCURL_PATH: 'SERPCAST_LIBCURL_PATH',
	LIBCURL_PATH: 'LIBCURL_PATH',
	'data directory': 'the data directory (serpcast install-libcurl)',
};

/** The report as `name: value` lines. */
export function formatReport(report: DoctorReport, proxy?: string): string {
	const lines: [string, string][] = [];
	const {library} = report;
	lines.push(['library', library ? library.path : 'not found']);
	if (library) lines.push(['from', SOURCE[library.source]]);
	if (library?.version) lines.push(['version', library.version]);
	lines.push(['pinned', report.pinned]);
	lines.push([
		'impersonation',
		report.impersonating ? `active (${report.target})` : 'NOT active',
	]);
	if (report.problem) lines.push(['problem', report.problem]);
	if (report.remote) {
		lines.push([
			'echo',
			report.remote.url + (proxy ? ' (through the proxy)' : ''),
		]);
		if (report.remote.error) lines.push(['echo error', report.remote.error]);
		for (const [label, value] of Object.entries(report.remote.seen ?? {})) {
			lines.push([label, value]);
		}
	}
	const width = Math.max(...lines.map(([name]) => name.length)) + 2;
	return lines
		.map(([name, value]) => `${`${name}:`.padEnd(width)}${value}`)
		.join('\n');
}
