// `serpcast install-recipes`: install a set of recipes from a release archive
// (a URL or a local file), only when the user types it (ADR 0002; imported by
// cli.ts alone and not exported from the library). Code recipes are code with
// full Node access, so what gets installed must be exactly what the user chose
// to trust: the archive's sha256 is REQUIRED (for URLs and files alike) and
// checked BEFORE anything is unpacked. The download reuses install-libcurl's
// (download.ts: the caller's proxy only, proxy environment ignored, no https
// to http redirect, a size cap) and the tar reader is tar.ts.
//
// The archive format is checked as a whole first (recipe-archive.ts), then
// the set is written to a temporary directory beside its destination and
// renamed into place, with a `.source.json` recording where it came from.
//
// Decisions (task install-recipes-command, 2026-09-29):
// - `--name` wins over the manifest's name (the manifest only supplies the
//   default), so a set can be installed under another name; the manifest's
//   name stays recorded in `.source.json`. Alternative: refuse a mismatch.
// - `--proxy` with a local file is refused rather than ignored: the user
//   asked for an egress that would not be used. Alternative: ignore it.
// - A source is a URL only when it starts with `http://` or `https://`; any
//   other `scheme://` is refused; everything else is a file path.
// - Hidden files (a leading '.', such as macOS `._x.js` AppleDouble files
//   and the reserved `.source.json`) are refused like other non-recipes.
// - Size caps: 16 MiB archive, 64 MiB unpacked (recipes are small text).
// - Replacing a set with `--force` is two renames (old set aside, new set in,
//   old set deleted), so there is an instant with no set, never a mixed one.
// - `manifest.json` is installed with the set (the set is a faithful copy of
//   the archive's recipe files), so a caller loading "every *.json" of a set
//   must skip it. Alternative: keep it only in `.source.json`.
// - An identical set already installed is left alone (`unchanged`), its
//   `.source.json` included, as install-libcurl leaves an identical library.
// - Set names are `[A-Za-z0-9][A-Za-z0-9._-]*` (at most 100), for --name and
//   the manifest alike, so a name is always one safe path segment.
// - In the CLI, a missing --sha256 is a usage error (exit 2), like any other
//   missing required option; installRecipes() itself also refuses it.
// - `recipes list` is the CLI's first `<noun> <verb>` command (the others are
//   single verbs); `recipes` takes only `list` today. It and install take
//   `--dir` to name another base directory (tests, or a caller's own layout).

import {createHash} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {describeProxy, download} from './download.js';
import {InstallError} from './install.js';
import {recipesDir, SOURCE_FILE, type RecipeSetSource} from './recipes.js';
import {
	MAX_UNPACKED_BYTES,
	readManifest,
	recipeFiles,
	setName,
} from './recipe-archive.js';

export interface InstallRecipesOptions {
	/** The archive's expected sha256 (hex). Required. */
	sha256: string;
	/** The set's name; default the archive's `manifest.json` name. */
	name?: string;
	/** The base directory; default `recipesDir(env)`. */
	dir?: string;
	/** Proxy for a URL download (`http://`, `socks5://`, `socks5h://`). */
	proxy?: string;
	/** Replace a differing set already installed under the same name. */
	force?: boolean;
	/** Where `XDG_DATA_HOME` is read from. Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Progress lines (what is read from where, each file installed). */
	log?: (line: string) => void;
}

export interface InstallRecipesResult {
	/** The set's name. */
	name: string;
	/** The set's directory. */
	dir: string;
	/** Each installed file with its sha256. */
	files: Record<string, string>;
	/** `unchanged` when an identical set was already there. */
	status: 'installed' | 'replaced' | 'unchanged';
}

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
const NOTHING = 'Nothing was installed.';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export async function installRecipes(
	source: string,
	options: InstallRecipesOptions,
): Promise<InstallRecipesResult> {
	const log = options.log ?? (() => {});
	const pinned = (options.sha256 ?? '').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(pinned)) {
		throw new InstallError(
			`--sha256 <hex> is required: the archive's sha256 is the trust decision (recipes are code). ${NOTHING}`,
		);
	}
	if (options.name !== undefined) setName(options.name, '--name');
	const archive = await fetchArchive(source, options, log);
	const sha256 = hash(archive.body);
	if (sha256 !== pinned) {
		throw new InstallError(
			`checksum mismatch for ${archive.url ?? source}: got sha256 ${sha256}, pinned ${pinned}. ${NOTHING}`,
		);
	}
	log(`verified sha256 ${sha256} (pinned with --sha256)`);
	const files = recipeFiles(archive.body);
	const manifest = readManifest(files.get('manifest.json'));
	const name = options.name ?? manifest?.name;
	if (name === undefined) {
		throw new InstallError(
			`the archive has no manifest.json name; give the set a name with --name. ${NOTHING}`,
		);
	}
	const base = options.dir ?? recipesDir(options.env ?? process.env);
	const dir = join(base, name);
	const hashes = Object.fromEntries(
		[...files].map(([file, body]) => [file, hash(body)]),
	);
	const report = (status: InstallRecipesResult['status']) => {
		for (const [file, digest] of Object.entries(hashes)) {
			log(`  ${file}  sha256 ${digest}`);
		}
		return {name, dir, files: hashes, status};
	};
	const existing = existsSync(dir);
	if (existing && sameSet(dir, files)) {
		log(`already installed: ${dir}`);
		return report('unchanged');
	}
	if (existing && !options.force) {
		throw new InstallError(
			`${dir} already exists and differs from this archive; rerun with --force to replace it. ${NOTHING}`,
		);
	}
	const record: RecipeSetSource = {
		source: archive.url ? source : resolve(source),
		...(archive.url ? {url: archive.url} : {}),
		sha256,
		...(manifest ? {manifest} : {}),
		files: hashes,
		installedAt: new Date().toISOString(),
	};
	mkdirSync(base, {recursive: true});
	const temporary = join(base, `.${name}.${process.pid}.tmp`);
	const aside = join(base, `.${name}.${process.pid}.old`);
	let moved = false;
	try {
		rmSync(temporary, {recursive: true, force: true});
		mkdirSync(temporary);
		for (const [file, body] of files) {
			writeFileSync(join(temporary, file), body, {mode: 0o644});
		}
		writeFileSync(
			join(temporary, SOURCE_FILE),
			JSON.stringify(record, null, '\t') + '\n',
		);
		if (existing) {
			renameSync(dir, aside);
			moved = true;
		}
		renameSync(temporary, dir);
		moved = false;
	} catch (cause) {
		rmSync(temporary, {recursive: true, force: true});
		if (moved) renameSync(aside, dir);
		throw cause;
	}
	rmSync(aside, {recursive: true, force: true});
	log(`installed recipe set ${name} in ${dir}:`);
	return report(existing ? 'replaced' : 'installed');
}

/** The archive's bytes, and the final URL for a download. */
async function fetchArchive(
	source: string,
	options: InstallRecipesOptions,
	log: (line: string) => void,
): Promise<{body: Buffer; url?: string}> {
	if (/^https?:\/\//i.test(source)) {
		let via = '';
		try {
			if (options.proxy) via = ` via ${describeProxy(options.proxy)}`;
			log(`downloading ${source}${via}`);
			return await download(source, {
				proxy: options.proxy,
				maxBytes: MAX_ARCHIVE_BYTES,
				idleTimeoutMs: IDLE_TIMEOUT_MS,
			});
		} catch (cause) {
			throw new InstallError(
				`downloading ${source}${via} failed: ${(cause as Error).message}. ${NOTHING}`,
				{cause},
			);
		}
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
		throw new InstallError(
			`${source} is neither an http(s) URL nor a file path. ${NOTHING}`,
		);
	}
	if (options.proxy) {
		throw new InstallError(
			`--proxy applies to a download only, and ${source} is a local file. ${NOTHING}`,
		);
	}
	log(`reading ${resolve(source)}`);
	try {
		if (statSync(source).size > MAX_ARCHIVE_BYTES) {
			throw new Error(`larger than ${MAX_ARCHIVE_BYTES} bytes`);
		}
		return {body: readFileSync(source)};
	} catch (cause) {
		throw new InstallError(
			`reading ${source} failed: ${(cause as Error).message}. ${NOTHING}`,
			{cause},
		);
	}
}

/** Whether `dir` holds exactly `files` (besides `.source.json`). */
function sameSet(dir: string, files: Map<string, Buffer>): boolean {
	try {
		const present = readdirSync(dir).filter((f) => f !== SOURCE_FILE);
		return (
			present.length === files.size &&
			present.every((f) => files.get(f)?.equals(readFileSync(join(dir, f))))
		);
	} catch {
		return false;
	}
}
