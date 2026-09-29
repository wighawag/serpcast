// The recipe release archive format, checked as a whole before
// `serpcast install-recipes` (install-recipes.ts) writes anything: regular
// `*.mjs`, `*.js` and `*.json` files, all at the archive's root or all under
// ONE top-level directory, with an optional `manifest.json` `{name, version}`.
// Anything else (a link, a nested directory, another file type, a hidden
// file, an absolute or `..` path) is an InstallError naming the entry. Pure:
// bytes in, file names and bytes out.

import {InstallError} from './install.js';
import {SOURCE_FILE} from './recipes.js';
import {readTarGz, type TarEntry} from './tar.js';

export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const RECIPE_FILE = /\.(?:mjs|js|json)$/;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NOTHING = 'Nothing was installed.';

/** The archive's recipe files by name, or an InstallError naming the first entry that is not one. */
export function recipeFiles(archive: Buffer): Map<string, Buffer> {
	let entries: TarEntry[];
	try {
		entries = readTarGz(archive, MAX_UNPACKED_BYTES);
	} catch (cause) {
		throw new InstallError(`${(cause as Error).message}. ${NOTHING}`, {
			cause,
		});
	}
	const refuse = (entry: TarEntry, why: string): never => {
		throw new InstallError(
			`the archive entry ${JSON.stringify(entry.path)} ${why}. ${NOTHING}`,
		);
	};
	const tops = new Set<string>();
	const found: {top?: string; file: string; body: Buffer}[] = [];
	for (const entry of entries) {
		if (entry.type === 'g') continue; // pax global header (git archive's commit id)
		let path = entry.path.replace(/^(?:\.\/)+/, '');
		if (/^[/\\]|^[A-Za-z]:|\\/.test(path)) refuse(entry, 'is an absolute path');
		if (entry.type === '5') path = path.replace(/\/$/, '');
		if (entry.type === '5' && (path === '' || path === '.')) continue; // the root
		const parts = path.split('/');
		if (parts.includes('..')) refuse(entry, 'leaves the archive (..)');
		if (parts.some((part) => part === '' || part === '.')) {
			refuse(entry, 'has an empty path segment');
		}
		if (entry.type === '5') {
			if (parts.length > 1) refuse(entry, 'is a nested directory');
			tops.add(parts[0]!);
			continue;
		}
		if (entry.type === '1' || entry.type === '2') refuse(entry, 'is a link');
		if (entry.type !== '0') {
			refuse(entry, `is not a regular file (type ${entry.type})`);
		}
		if (parts.length > 2) refuse(entry, 'is in a nested directory');
		const file = parts.at(-1)!;
		if (file.startsWith('.')) refuse(entry, 'is a hidden file');
		if (!RECIPE_FILE.test(file)) {
			refuse(entry, 'is not a *.mjs, *.js or *.json file');
		}
		const top = parts.length === 2 ? parts[0] : undefined;
		if (top !== undefined) tops.add(top);
		found.push({top, file, body: entry.body});
	}
	if (!found.length) {
		throw new InstallError(`the archive has no recipe files. ${NOTHING}`);
	}
	const atRoot = found.some((f) => f.top === undefined);
	if (tops.size > 1 || (atRoot && tops.size)) {
		throw new InstallError(
			`the archive's files must all be at its root or all under one top-level directory (found ${[...tops].map((t) => `${t}/`).join(', ')}${atRoot ? ' and root files' : ''}). ${NOTHING}`,
		);
	}
	const files = new Map<string, Buffer>();
	for (const {file, body} of found) {
		if (files.has(file)) {
			throw new InstallError(`the archive has ${file} twice. ${NOTHING}`);
		}
		files.set(file, body);
	}
	return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function readManifest(
	body: Buffer | undefined,
): {name?: string; version?: string} | undefined {
	if (!body) return undefined;
	let manifest: unknown;
	try {
		manifest = JSON.parse(body.toString('utf8'));
	} catch {
		throw new InstallError(
			`the archive's manifest.json is not JSON. ${NOTHING}`,
		);
	}
	if (typeof manifest !== 'object' || Array.isArray(manifest) || !manifest) {
		throw new InstallError(
			`the archive's manifest.json is not an object. ${NOTHING}`,
		);
	}
	const {name, version} = manifest as Record<string, unknown>;
	if (version !== undefined && typeof version !== 'string') {
		throw new InstallError(
			`the manifest.json version is not a string. ${NOTHING}`,
		);
	}
	if (name !== undefined) setName(name, 'the manifest.json name');
	return {
		...(name !== undefined ? {name: name as string} : {}),
		...(version !== undefined ? {version} : {}),
	};
}

export function setName(name: unknown, what: string): asserts name is string {
	if (typeof name !== 'string' || !SET_NAME.test(name)) {
		throw new InstallError(
			`${what} ${JSON.stringify(name)} is not a set name (letters, digits, '.', '_', '-', not starting with '.', '_' or '-'). ${NOTHING}`,
		);
	}
}
