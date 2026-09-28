// serpcast's library entry: the transport layer and the declarative recipe
// runner. The engine chain and code recipes arrive with their tasks (see
// work/tasks/).

export {SerpcastError, type SerpcastErrorKind} from './errors.js';
export {
	CHROME_MAJOR,
	IMPERSONATE_TARGET,
	REQUEST_KINDS,
	headerTable,
	type HeaderTable,
	type RequestKind,
} from './chrome.js';
export {
	runDeclarativeRecipe,
	type RecipeResponse,
	type RunRecipeOptions,
	type SearchResult,
} from './declarative.js';
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
		'Usage: serpcast <command> [options]',
		'',
		'serpcast runs keyless search engines described by recipes over HTTP with',
		"a real browser's fingerprint.",
		'',
		'Commands:',
		'  query --recipe <file> [--proxy <url>] [--libcurl <path>] <query...>',
		'      Run one declarative recipe once. Prints {recipe, results} as JSON on',
		'      stdout (exit 0), or "serpcast: <kind>: <message>" on stderr (exit 1).',
		'',
		'Options:',
		'  --recipe <file>   The recipe JSON file',
		'  --proxy <url>     Proxy for all traffic (http://, socks5://, socks5h://)',
		'  --libcurl <path>  The libcurl-impersonate shared library',
		'  -h, --help        Show this message',
		'',
		'Exit codes: 0 results (possibly empty), 1 a search failure, 2 a usage error.',
	].join('\n');
}
