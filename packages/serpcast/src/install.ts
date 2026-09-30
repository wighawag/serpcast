// `serpcast install-libcurl`: the ONLY code in serpcast that downloads the
// native library, and it runs only when the user invokes that command or an
// embedder calls `installLibcurl` from `serpcast/install` (ADR 0002; imported
// by cli.ts and install-api.ts, never reachable from the main entry). It
// fetches the archive LIBCURL_IMPERSONATE pins for this platform (the same
// constant CI installs from), through the caller's proxy only, verifies its
// sha256 BEFORE writing anything, takes the one library file out of the
// archive and puts it in the data directory under `libraryFileName()`, where
// `resolveLibraryPath` finds it. A file already there is left alone when it is
// identical, and replaced only with `force` when it differs. The write is a
// rename of a temporary file in the same directory, so a failure leaves either
// the old file or nothing, never a partial library.
//
// The size caps (MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES) are safety ceilings:
// an embedder may LOWER them (`maxArchiveBytes`, `maxUnpackedBytes`), never
// raise them. The idle timeout stays internal. Exported to embedders through
// `serpcast/install` (install-api.ts), never from the main entry.

import {createHash} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {describeProxy, download} from './download.js';
import {dataDir, LIBCURL_IMPERSONATE, libraryFileName} from './libcurl.js';
import {checkNumber} from './options.js';
import {readTarGz, type TarEntry} from './tar.js';

/** A pinned release: the shape of `LIBCURL_IMPERSONATE`. */
export interface Release {
	version: string;
	baseUrl: string;
	assets: Readonly<
		Record<string, {archive: string; sha256: string; library: string}>
	>;
}

export interface InstallOptions {
	/** Proxy for the download (`http://`, `socks5://`, `socks5h://`). */
	proxy?: string;
	/** Replace a differing library already in the data directory. */
	force?: boolean;
	/** Where `XDG_DATA_HOME` is read from. Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The release to install. Default `LIBCURL_IMPERSONATE` (tests pass a local one). */
	release?: Release;
	/** Progress lines (what is downloaded from where, where it went). */
	log?: (line: string) => void;
	/** Largest archive downloaded, in bytes. Default and ceiling `MAX_ARCHIVE_BYTES` (128 MiB): may only be lowered. */
	maxArchiveBytes?: number;
	/** Largest unpacked archive, in bytes. Default and ceiling `MAX_UNPACKED_BYTES` (512 MiB): may only be lowered. */
	maxUnpackedBytes?: number;
}

export interface InstallResult {
	/** The installed library. */
	path: string;
	/** Where the archive was downloaded from (after redirects). */
	url: string;
	/** `unchanged` when an identical file was already there. */
	status: 'installed' | 'replaced' | 'unchanged';
}

/** An install that did not happen; nothing was written. */
export class InstallError extends Error {
	override name = 'InstallError';
}

/** The ceiling (and default) of `installLibcurl`'s `maxArchiveBytes`. */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** The ceiling (and default) of `installLibcurl`'s `maxUnpackedBytes`. */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60_000;

export async function installLibcurl(
	options: InstallOptions = {},
): Promise<InstallResult> {
	const maxArchiveBytes =
		checkNumber('maxArchiveBytes', options.maxArchiveBytes, {
			integer: true,
			max: MAX_ARCHIVE_BYTES,
		}) ?? MAX_ARCHIVE_BYTES;
	const maxUnpackedBytes =
		checkNumber('maxUnpackedBytes', options.maxUnpackedBytes, {
			integer: true,
			max: MAX_UNPACKED_BYTES,
		}) ?? MAX_UNPACKED_BYTES;
	const release: Release = options.release ?? LIBCURL_IMPERSONATE;
	const log = options.log ?? (() => {});
	const platform = `${process.platform}-${process.arch}`;
	const asset = release.assets[platform];
	if (!asset) {
		throw new InstallError(
			`no pinned libcurl-impersonate ${release.version} archive for ${platform} (pinned: ${Object.keys(release.assets).join(', ')}). Install libcurl-impersonate yourself and set SERPCAST_LIBCURL_PATH to it.`,
		);
	}
	const url = release.baseUrl + asset.archive;
	let via = '';
	let archive: {url: string; body: Buffer};
	try {
		if (options.proxy) via = ` via ${describeProxy(options.proxy)}`;
		log(`downloading ${url}${via}`);
		archive = await download(url, {
			proxy: options.proxy,
			maxBytes: maxArchiveBytes,
			idleTimeoutMs: IDLE_TIMEOUT_MS,
		});
	} catch (cause) {
		throw new InstallError(
			`downloading ${url}${via} failed: ${(cause as Error).message}. Nothing was installed.`,
			{cause},
		);
	}
	const sha256 = createHash('sha256').update(archive.body).digest('hex');
	if (sha256 !== asset.sha256) {
		throw new InstallError(
			`checksum mismatch for ${asset.archive} (from ${archive.url}): got sha256 ${sha256}, pinned ${asset.sha256}. Nothing was installed.`,
		);
	}
	log(
		`verified sha256 ${sha256} (pinned for libcurl-impersonate ${release.version} ${platform})`,
	);
	const library = extract(archive.body, asset.library, maxUnpackedBytes);
	if (!library) {
		throw new InstallError(
			`${asset.archive} has no file ${asset.library}. Nothing was installed.`,
		);
	}
	const dir = dataDir(options.env ?? process.env);
	const path = join(dir, libraryFileName());
	const existing = existsSync(path) ? readFileSync(path) : undefined;
	if (existing?.equals(library)) {
		log(`already installed: ${path}`);
		return {path, url: archive.url, status: 'unchanged'};
	}
	if (existing && !options.force) {
		throw new InstallError(
			`${path} already exists and differs from libcurl-impersonate ${release.version}; rerun with --force to replace it. Nothing was installed.`,
		);
	}
	mkdirSync(dir, {recursive: true});
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, library, {mode: 0o644});
		renameSync(temporary, path);
	} catch (cause) {
		rmSync(temporary, {force: true});
		throw cause;
	}
	log(`installed ${path}`);
	return {path, url: archive.url, status: existing ? 'replaced' : 'installed'};
}

/** The regular file `name` in a .tar.gz, or undefined. */
export function extract(
	targz: Buffer,
	name: string,
	maxUnpackedBytes = MAX_UNPACKED_BYTES,
): Buffer | undefined {
	let entries: TarEntry[];
	try {
		entries = readTarGz(targz, maxUnpackedBytes);
	} catch (cause) {
		throw new InstallError((cause as Error).message, {cause});
	}
	return entries.find(
		(entry) => entry.type === '0' && entry.path.replace(/^\.\//, '') === name,
	)?.body;
}
