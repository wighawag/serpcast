// serpcast's library entry: the engine chain (`createSerpcast`), the state
// store, the transport layer, the declarative and code recipe runners and
// browser engines (searchcast). Nothing here imports `searchcast` itself: it
// is loaded only when a library-mode browser engine runs.

export {
	SerpcastError,
	type EngineFailure,
	type SerpcastErrorKind,
} from './errors.js';
export {
	DEFAULT_COOLDOWN_MS,
	DEFAULT_SESSION_IDLE_MS,
	createSerpcast,
	type ChainTransport,
	type DecoyGuard,
	type Engine,
	type SearchOptions,
	type SearchResponse,
	type Serpcast,
	type SerpcastOptions,
} from './serpcast.js';
export {DEFAULT_DECOY_RULE, isDecoy, type DecoyRule} from './decoy.js';
export {
	createMemoryStore,
	type JsonValue,
	type MemoryStoreOptions,
	type StateStore,
} from './store.js';
export {
	CHROME_MAJOR,
	FETCH_SITES,
	IMPERSONATE_TARGET,
	REQUEST_KINDS,
	fetchSite,
	headerTable,
	isSafelistedContentType,
	preflightTable,
	type FetchSite,
	type HeaderTable,
	type RequestKind,
	type RequestMethod,
} from './chrome.js';
export {
	runDeclarativeRecipe,
	type RecipeResponse,
	type RunRecipeOptions,
	type SearchResult,
} from './declarative.js';
export {
	isCodeRecipe,
	loadCodeRecipe,
	runCodeRecipe,
	type CodeRecipe,
	type CodeRecipeContext,
	type CodeRecipeHttp,
	type CodeRecipeSession,
	type HttpOptions,
	type HttpPostOptions,
	type RunCodeRecipeOptions,
} from './code.js';
export {
	chromiumProxy,
	isBrowserEngine,
	type BrowserEngine,
	type SearchcastLibraryOptions,
	type SearchcastModule,
} from './browser.js';
export {
	CookieStore,
	documentCookies,
	type DocumentCookies,
	type StoredCookie,
} from './cookies.js';
import {LIBCURL_IMPERSONATE} from './libcurl.js';
export {
	LIBCURL_IMPERSONATE,
	dataDir,
	libraryFileName,
	resolveLibraryPath,
} from './libcurl.js';
export {recipesDir} from './recipes.js';
export {
	MAX_REQUEST_BODY_BYTES,
	createTransport,
	type LibraryInfo,
	type PostOptions,
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
		'  install-libcurl [--proxy <url>] [--force]',
		`      Download libcurl-impersonate ${LIBCURL_IMPERSONATE.version} for this platform, verify its`,
		'      pinned sha256 and install it in the data directory. Prints the',
		'      installed path on stdout; never runs unless you type it.',
		'  install-recipes <url|path> --sha256 <hex> [--name <set>] [--dir <path>]',
		'                  [--proxy <url>] [--force]',
		'      Install a set of recipes from a .tar.gz release archive: downloaded',
		'      (a URL, through --proxy if given) or read (a path), its sha256 checked',
		'      against --sha256 BEFORE unpacking. --sha256 is required: recipes are',
		'      code with full Node access, and the pin is your trust decision.',
		"      Prints the set's directory on stdout; never runs unless you type it.",
		'  recipes list [--dir <path>]',
		'      List the installed recipe sets, their files and where they came from.',
		'  doctor [--libcurl <path>] [--proxy <url>] [--remote]',
		'      Report which library is loaded, from where, and whether',
		'      impersonation is active (exit 0) or not (exit 1). No network',
		'      request unless --remote, which asks a fingerprint echo service.',
		'',
		'Options:',
		'  --recipe <file>   The recipe JSON file',
		'  --proxy <url>     Proxy for all traffic (http://, socks5://, socks5h://)',
		'  --libcurl <path>  The libcurl-impersonate shared library',
		'  --force           Replace a differing library or recipe set already installed',
		'  --sha256 <hex>    The pinned sha256 of the recipe archive',
		'  --name <set>      The recipe set name (default: the archive manifest name)',
		'  --dir <path>      The recipe sets directory (default: <data dir>/recipes)',
		'  --remote          Check the fingerprint against an echo service',
		'  -h, --help        Show this message',
		'',
		'Exit codes: 0 success, 1 a failure, 2 a usage error.',
	].join('\n');
}
