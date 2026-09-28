// serpcast's library entry. The recipe runners and the engine chain arrive
// with their tasks (see work/tasks/); this exports the transport layer.

export {SerpcastError, type SerpcastErrorKind} from './errors.js';
export {
	CHROME_MAJOR,
	IMPERSONATE_TARGET,
	REQUEST_KINDS,
	headerTable,
	type HeaderTable,
	type RequestKind,
} from './chrome.js';
export {CookieStore, type StoredCookie} from './cookies.js';
export {
	LIBCURL_IMPERSONATE,
	dataDir,
	libraryFileName,
	resolveLibraryPath,
} from './libcurl.js';
export {
	createTransport,
	type LibraryInfo,
	type RequestOptions,
	type Transport,
	type TransportOptions,
	type TransportResponse,
	type TransportSession,
} from './transport.js';

/** The published name of this package. */
export const packageName = 'serpcast';

/** The CLI usage text printed by the `serpcast` bin. */
export function usage(): string {
	return [
		'Usage: serpcast <command>',
		'',
		'serpcast runs keyless search engines described by recipes over HTTP with',
		"a real browser's fingerprint. No commands are available yet.",
		'',
		'Options:',
		'  -h, --help  Show this message',
	].join('\n');
}
