// Where installed recipe sets live, and what is there. `serpcast
// install-recipes` (install-recipes.ts) puts each set in its own directory
// under `recipesDir()`, with a `.source.json` recording where it came from.
// Nothing here loads a recipe or looks anywhere on its own (ADR 0002): the
// caller (webveil, or `serpcast recipes list`) asks for the base directory and
// decides which set to load.

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {dataDir} from './libcurl.js';

/** The file install writes beside the recipes of a set; never a recipe itself. */
export const SOURCE_FILE = '.source.json';

/** What install records in a set's `.source.json`. */
export interface RecipeSetSource {
	/** The URL or file path given to install. */
	source: string;
	/** The URL the archive came from after redirects, for a URL source. */
	url?: string;
	/** The archive's sha256, as pinned with `--sha256`. */
	sha256: string;
	/** The archive's `manifest.json` name and version, when it had one. */
	manifest?: {name?: string; version?: string};
	/** Each installed file (all at the set's top level), with its sha256. */
	files: Record<string, string>;
	installedAt: string;
}

export interface RecipeSet {
	name: string;
	dir: string;
	/** The set's files (`.source.json` excluded). */
	files: string[];
	/** Undefined when `.source.json` is missing or unreadable. */
	source?: RecipeSetSource;
}

/**
 * The base directory of installed recipe sets: `recipes/` in the data
 * directory (`$XDG_DATA_HOME/serpcast`, default `~/.local/share/serpcast`).
 * Each set is a directory in it. Nothing is created.
 */
export function recipesDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataDir(env), 'recipes');
}

/** The sets installed in `base` (skipping install's temporary entries), by name. */
export function listRecipeSets(base: string): RecipeSet[] {
	if (!existsSync(base)) return [];
	return readdirSync(base)
		.filter((name) => !name.startsWith('.'))
		.filter((name) => statSync(join(base, name)).isDirectory())
		.sort()
		.map((name) => {
			const dir = join(base, name);
			let source: RecipeSetSource | undefined;
			try {
				source = JSON.parse(readFileSync(join(dir, SOURCE_FILE), 'utf8'));
			} catch {
				source = undefined;
			}
			const files = readdirSync(dir, {withFileTypes: true})
				.filter((entry) => entry.isFile() && entry.name !== SOURCE_FILE)
				.map((entry) => entry.name)
				.sort();
			return {name, dir, files, source};
		});
}

/** `serpcast recipes list` output for `sets` found in `base`. */
export function formatRecipeSets(base: string, sets: RecipeSet[]): string {
	if (!sets.length) return `no recipe sets installed in ${base}`;
	const lines = [`recipe sets in ${base}:`];
	for (const set of sets) {
		const {manifest, source, url, sha256, files, installedAt} =
			set.source ?? ({} as Partial<RecipeSetSource>);
		const version = manifest?.version ? ` ${manifest.version}` : '';
		const named =
			manifest?.name && manifest.name !== set.name
				? ` (manifest: ${manifest.name}${version})`
				: version;
		lines.push('', `${set.name}${named}`, `  dir:       ${set.dir}`);
		if (!set.source)
			lines.push(`  source:    unknown (no readable ${SOURCE_FILE})`);
		else {
			lines.push(`  source:    ${source}`);
			if (url && url !== source) lines.push(`  from:      ${url}`);
			lines.push(`  sha256:    ${sha256}`, `  installed: ${installedAt}`);
		}
		for (const file of set.files) {
			lines.push(`  ${file}${files?.[file] ? `  sha256 ${files[file]}` : ''}`);
		}
	}
	return lines.join('\n');
}
