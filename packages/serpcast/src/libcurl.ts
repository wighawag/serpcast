// Locating, loading and checking libcurl-impersonate. serpcast binds it
// directly with koffi (ADR 0001 fallback; impers is NOT used, see
// work/notes/findings/impers-fingerprint-vs-curl-cffi.md), so loading has no
// download path at all: the library is only ever loaded from an explicit path
// or the data directory (ADR 0002). The one thing that downloads it is the
// user-invoked `serpcast install-libcurl` (src/install.ts). The library is
// loaded once per process, so its path is process-global.
//
// Linux and FreeBSD load it with RTLD_DEEPBIND (koffi `deep`), so its calls to
// nghttp2 and zlib bind to its own statically linked copies instead of Node's.
// Without that, Node's newer nghttp2 drops the PRIORITY flag Chrome sets on the
// HTTP/2 HEADERS frame. Other platforms have no RTLD_DEEPBIND; the library is
// loaded plainly there and HTTP/2 HEADERS parity is NOT claimed (unmeasured).

import {existsSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {IMPERSONATE_TARGET} from './chrome.js';
import {SerpcastError} from './errors.js';

/**
 * The pinned libcurl-impersonate release and the sha256 of each platform's
 * release archive (lexiforest/curl-impersonate `libcurl-impersonate-*`
 * assets), keyed by `${process.platform}-${process.arch}`. `serpcast
 * install-libcurl` (src/install.ts; CI installs with it too) downloads from
 * here and verifies against these checksums; nothing else downloads. Checksums:
 * the `digest` field of the GitHub release API for tag v2.1.1, cross-checked
 * by downloading the linux-x64 archive (2026-09-28). Re-checked the same day
 * for `serpcast install-libcurl`: every digest matches the API again, the
 * linux-x64 download hashes to it, and `library` is a regular file (not a
 * symlink) in the linux-x64, linux-arm64, darwin-x64, darwin-arm64 and
 * win32-x64 archives.
 */
export const LIBCURL_IMPERSONATE = {
	version: '2.1.1',
	baseUrl:
		'https://github.com/lexiforest/curl-impersonate/releases/download/v2.1.1/',
	assets: {
		'linux-x64': {
			archive: 'libcurl-impersonate-v2.1.1.x86_64-linux-gnu.tar.gz',
			sha256:
				'18b22585da3d6a58926086c65b1e662a87768ccca646e8c2a6ed03137bf948f1',
			library: 'libcurl-impersonate.so.4.8.0',
		},
		'linux-arm64': {
			archive: 'libcurl-impersonate-v2.1.1.aarch64-linux-gnu.tar.gz',
			sha256:
				'db437a38f5c694f43ae08619cb53e3ad5061b05f720f9e56ee68688c91442805',
			library: 'libcurl-impersonate.so.4.8.0',
		},
		'darwin-x64': {
			archive: 'libcurl-impersonate-v2.1.1.x86_64-macos.tar.gz',
			sha256:
				'5d3e3ab29416d52292331fd830c7cb0faa570cf606f3b38900cac844d6dc4f26',
			library: 'libcurl-impersonate.4.8.0.dylib',
		},
		'darwin-arm64': {
			archive: 'libcurl-impersonate-v2.1.1.arm64-macos.tar.gz',
			sha256:
				'747ad70d1e6d302528aecd59fdf64d5c29412ec64f6217d0c7180feff1cad633',
			library: 'libcurl-impersonate.4.8.0.dylib',
		},
		'win32-x64': {
			archive: 'libcurl-impersonate-v2.1.1.x86_64-win32.tar.gz',
			sha256:
				'656ef0fe16393e2718d66112c7d0fcb230adfb4b0de42b0884ade598f6aea617',
			library: 'lib/libcurl-impersonate.dll',
		},
	},
} as const;

/** serpcast's data directory: `$XDG_DATA_HOME/serpcast`, default `~/.local/share/serpcast`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(
		env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
		'serpcast',
	);
}

/** The library's file name inside the data directory, for this platform. */
export function libraryFileName(
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'darwin') return 'libcurl-impersonate.dylib';
	if (platform === 'win32') return 'libcurl-impersonate.dll';
	return 'libcurl-impersonate.so';
}

/** Where a library path came from, in the order they are tried. */
export type LibrarySource =
	'option' | 'SERPCAST_LIBCURL_PATH' | 'LIBCURL_PATH' | 'data directory';

/** `resolveLibraryPath`, also saying which setting named the path (for `doctor`). */
export function locateLibrary(
	option?: string,
	env: NodeJS.ProcessEnv = process.env,
): {path: string; source: LibrarySource} | undefined {
	const explicit: [string | undefined, LibrarySource][] = [
		[option, 'option'],
		[env.SERPCAST_LIBCURL_PATH, 'SERPCAST_LIBCURL_PATH'],
		[env.LIBCURL_PATH, 'LIBCURL_PATH'],
	];
	for (const [path, source] of explicit) {
		if (path) return {path: resolve(path), source};
	}
	const installed = join(dataDir(env), libraryFileName());
	return existsSync(installed)
		? {path: installed, source: 'data directory'}
		: undefined;
}

/**
 * Where the library is: the explicit option, then `SERPCAST_LIBCURL_PATH`,
 * then `LIBCURL_PATH`, then the data directory. Undefined when none of these
 * names an existing file. Never searches system paths, never downloads.
 */
export function resolveLibraryPath(
	option?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return locateLibrary(option, env)?.path;
}

const HOW_TO_FIX =
	'Install it with `serpcast install-libcurl`, or set SERPCAST_LIBCURL_PATH (or the libcurlPath option) to a libcurl-impersonate shared library.';

type Fn = ((...args: any[]) => any) & {async: (...args: any[]) => void};

/** The loaded library and the functions serpcast calls. */
export interface Libcurl {
	path: string;
	koffi: typeof import('koffi').default;
	version: string;
	init: Fn;
	cleanup: Fn;
	setopt: Fn;
	perform: Fn;
	strerror: Fn;
	slistAppend: Fn;
	slistFree: Fn;
	/** Undefined when the symbol is missing (plain libcurl). */
	impersonate?: Fn;
}

let loaded: {path: string; library: Promise<Libcurl>} | undefined;

/** Load the library at `path` (once per process); an `impersonation` error otherwise. */
export function loadLibcurl(path: string | undefined): Promise<Libcurl> {
	if (!path) {
		return Promise.reject(
			new SerpcastError(
				'impersonation',
				`libcurl-impersonate not found. ${HOW_TO_FIX}`,
			),
		);
	}
	const real = existsSync(path) ? realpathSync(path) : path;
	if (loaded) {
		if (loaded.path === real) return loaded.library;
		return Promise.reject(
			new SerpcastError(
				'impersonation',
				`libcurl is already loaded from ${loaded.path} in this process; cannot also load ${real}. The library path is process-global: use one path for every serpcast instance.`,
			),
		);
	}
	// Claimed synchronously, so two concurrent first uses cannot load two libraries.
	const claim = {path: real, library: bind(real)};
	loaded = claim;
	claim.library.catch(() => {
		if (loaded === claim) loaded = undefined; // a failed load claims nothing
	});
	return claim.library;
}

async function bind(real: string): Promise<Libcurl> {
	if (!existsSync(real)) {
		throw new SerpcastError(
			'impersonation',
			`libcurl-impersonate not found at ${real}. ${HOW_TO_FIX}`,
		);
	}
	const koffi = (await import('koffi')).default;
	let lib;
	try {
		const deep = process.platform === 'linux' || process.platform === 'freebsd';
		lib = koffi.load(real, deep ? {deep: true} : {});
		pin(koffi, real);
	} catch (cause) {
		throw new SerpcastError(
			'impersonation',
			`cannot load ${real} as libcurl. ${HOW_TO_FIX}`,
			{cause},
		);
	}
	let impersonate: Fn | undefined;
	try {
		impersonate = lib.func(
			'int curl_easy_impersonate(void *curl, const char *target, int default_headers)',
		) as Fn;
	} catch {
		impersonate = undefined;
	}
	try {
		const f = (decl: string) => lib.func(decl) as Fn;
		return {
			path: real,
			koffi,
			version: f('const char *curl_version()')(),
			init: f('void *curl_easy_init()'),
			cleanup: f('void curl_easy_cleanup(void *curl)'),
			setopt: f('int curl_easy_setopt(void *curl, int option, ...)'),
			perform: f('int curl_easy_perform(void *curl)'),
			strerror: f('const char *curl_easy_strerror(int code)'),
			slistAppend: f('void *curl_slist_append(void *list, const char *value)'),
			slistFree: f('void curl_slist_free_all(void *list)'),
			impersonate,
		};
	} catch (cause) {
		throw new SerpcastError(
			'impersonation',
			`${real} is not a libcurl library. ${HOW_TO_FIX}`,
			{cause},
		);
	}
}

/**
 * Keep the library mapped until the process ends. Requests run on libuv worker
 * threads; BoringSSL leaves thread-local destructors on them, which run when
 * the workers exit at process exit, after koffi has already unloaded the
 * library: a SIGSEGV on every exit (measured on Linux). Re-opening it with
 * RTLD_NOLOAD | RTLD_NODELETE (the handle is deliberately leaked) prevents the
 * unload. Best effort, POSIX only; Windows is unmeasured.
 */
function pin(koffi: Libcurl['koffi'], path: string): void {
	const flags = {linux: 0x1006, freebsd: 0x3002, darwin: 0x92} as Partial<
		Record<NodeJS.Platform, number>
	>;
	const flag = flags[process.platform]; // RTLD_NOW | RTLD_NOLOAD | RTLD_NODELETE
	if (flag === undefined) return;
	koffi.load(null).func('void *dlopen(const char *path, int flags)')(
		path,
		flag,
	);
}

/**
 * Strict mode's check: the library exports `curl_easy_impersonate` and accepts
 * the pinned target. A plain libcurl loads silently, so loading alone proves
 * nothing. Makes no network call.
 */
export function assertImpersonation(curl: Libcurl): void {
	if (!curl.impersonate) {
		throw new SerpcastError(
			'impersonation',
			`${curl.path} is plain libcurl (${curl.version}), not libcurl-impersonate. ${HOW_TO_FIX}`,
		);
	}
	const handle = curl.init();
	try {
		const code: number = curl.impersonate(handle, IMPERSONATE_TARGET, 0);
		if (code !== 0) {
			throw new SerpcastError(
				'impersonation',
				`${curl.path} (${curl.version}) does not support the impersonation target ${IMPERSONATE_TARGET}: ${curl.strerror(code)}. Use libcurl-impersonate ${LIBCURL_IMPERSONATE.version} or later.`,
			);
		}
	} finally {
		curl.cleanup(handle);
	}
}
