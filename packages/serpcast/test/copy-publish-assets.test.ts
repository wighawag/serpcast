// scripts/copy-publish-assets.mjs (the `serpcast` package's `prepack`): copies
// the root README.md and LICENSE into the package so its npm tarball carries
// them, rewriting README links to files that do not ship into pinned GitHub
// URLs. Every write goes to a throwaway repo under the OS temp dir.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
// @ts-expect-error - plain .mjs script, no types
import {
	copyPublishAssets,
	GITHUB_REPO,
	PUBLISH_ASSETS,
	repoRoot,
	resolvePinRef,
	rewriteReadmeLinks,
} from '../../../scripts/copy-publish-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A throwaway "repo" with a root README.md + LICENSE and a package dir inside
// it, so the real repo and anything global are never touched.
let fakeRepo: string;

beforeEach(() => {
	fakeRepo = mkdtempSync(join(tmpdir(), 'serpcast-copy-'));
	writeFileSync(
		join(fakeRepo, 'README.md'),
		'See [a note](work/notes/x.md), [ADR](docs/adr/0001.md) and [the license](LICENSE).',
		'utf8',
	);
	writeFileSync(join(fakeRepo, 'LICENSE'), 'license text', 'utf8');
});

afterEach(() => {
	rmSync(fakeRepo, {recursive: true, force: true});
});

describe('copyPublishAssets', () => {
	it('copies README.md and LICENSE into the package dir', () => {
		const pkg = join(fakeRepo, 'packages', 'serpcast');
		mkdirSync(pkg, {recursive: true});

		const written = copyPublishAssets({packageDir: pkg, root: fakeRepo});

		expect(PUBLISH_ASSETS).toEqual(['README.md', 'LICENSE']);
		expect([...written].sort()).toEqual(
			[join(pkg, 'LICENSE'), join(pkg, 'README.md')].sort(),
		);
		// LICENSE is copied verbatim; the README has its non-shipped links
		// rewritten (no package.json here, so the pin ref falls back to GITHUB_SHA,
		// git HEAD or 'main') and keeps the shipped LICENSE link relative.
		expect(readFileSync(join(pkg, 'LICENSE'), 'utf8')).toBe('license text');
		const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
		expect(readme).toContain(`](https://github.com/${GITHUB_REPO}/blob/`);
		expect(readme).toContain('/work/notes/x.md)');
		expect(readme).not.toContain('](work/notes/x.md)');
		expect(readme).toContain('[the license](LICENSE)');
	});

	it('pins links to `${name}@${version}`, the tag changesets pushes', () => {
		const pkg = join(fakeRepo, 'packages', 'serpcast');
		mkdirSync(pkg, {recursive: true});
		writeFileSync(
			join(pkg, 'package.json'),
			JSON.stringify({name: 'serpcast', version: '9.9.9'}),
			'utf8',
		);

		copyPublishAssets({packageDir: pkg, root: fakeRepo});

		const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
		expect(readme).toContain(
			`](https://github.com/${GITHUB_REPO}/blob/serpcast@9.9.9/work/notes/x.md)`,
		);
		expect(readme).toContain(
			`](https://github.com/${GITHUB_REPO}/blob/serpcast@9.9.9/docs/adr/0001.md)`,
		);
	});

	it('refuses to write outside the repo root', () => {
		const outside = mkdtempSync(join(tmpdir(), 'serpcast-outside-'));
		try {
			expect(() =>
				copyPublishAssets({packageDir: outside, root: fakeRepo}),
			).toThrow(/outside the repo/);
			expect(existsSync(join(outside, 'README.md'))).toBe(false);
		} finally {
			rmSync(outside, {recursive: true, force: true});
		}
	});

	it('fails loud (without writing) when a source asset is missing', () => {
		const emptyRepo = mkdtempSync(join(tmpdir(), 'serpcast-empty-'));
		const pkg = join(emptyRepo, 'packages', 'serpcast');
		mkdirSync(pkg, {recursive: true});
		try {
			expect(() =>
				copyPublishAssets({packageDir: pkg, root: emptyRepo}),
			).toThrow(/source asset not found/);
			expect(existsSync(join(pkg, 'README.md'))).toBe(false);
		} finally {
			rmSync(emptyRepo, {recursive: true, force: true});
		}
	});

	it('resolves the real repo root, which holds the README and LICENSE', () => {
		const root = repoRoot();
		expect(resolve(root)).toBe(resolve(here, '..', '..', '..'));
		expect(existsSync(join(root, 'README.md'))).toBe(true);
		expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain(
			'GNU AFFERO GENERAL PUBLIC LICENSE',
		);
	});
});

describe('package wiring', () => {
	const manifest = (name: string) =>
		JSON.parse(
			readFileSync(resolve(here, '..', '..', name, 'package.json'), 'utf8'),
		);

	it('serpcast runs the script on prepack and is AGPL', () => {
		const pkg = manifest('serpcast');
		expect(pkg.scripts.prepack).toBe(
			'node ../../scripts/copy-publish-assets.mjs',
		);
		expect(pkg.license).toBe('AGPL-3.0-only');
	});

	it('serpcast-recipe keeps its own README and MIT LICENSE', () => {
		const pkg = manifest('serpcast-recipe');
		expect(pkg.scripts.prepack).toBeUndefined();
		expect(pkg.license).toBe('MIT');
	});
});

describe('rewriteReadmeLinks', () => {
	const ref = 'serpcast@1.2.3';
	const base = `https://github.com/${GITHUB_REPO}/blob/${ref}`;

	it('rewrites non-shipped repo-relative links to pinned GitHub URLs', () => {
		expect(rewriteReadmeLinks('[x](work/notes/a.md)', {ref})).toBe(
			`[x](${base}/work/notes/a.md)`,
		);
		expect(rewriteReadmeLinks('[x](docs/adr/0001.md)', {ref})).toBe(
			`[x](${base}/docs/adr/0001.md)`,
		);
		expect(rewriteReadmeLinks('[x](packages/serpcast-recipe)', {ref})).toBe(
			`[x](${base}/packages/serpcast-recipe)`,
		);
		expect(
			rewriteReadmeLinks('[x](packages/serpcast-recipe/LICENSE)', {ref}),
		).toBe(`[x](${base}/packages/serpcast-recipe/LICENSE)`);
		expect(rewriteReadmeLinks('[x](CONTEXT.md)', {ref})).toBe(
			`[x](${base}/CONTEXT.md)`,
		);
	});

	it('preserves an in-file anchor on a rewritten link', () => {
		expect(rewriteReadmeLinks('[x](docs/adr/0001.md#context)', {ref})).toBe(
			`[x](${base}/docs/adr/0001.md#context)`,
		);
	});

	it('leaves shipped assets, absolute URLs, and anchors untouched', () => {
		for (const link of [
			'[x](LICENSE)',
			'[x](README.md)',
			'[x](https://example.com/a)',
			'[x](http://example.com)',
			'[x](#an-anchor)',
			'[x](mailto:a@b.c)',
		]) {
			expect(rewriteReadmeLinks(link, {ref})).toBe(link);
		}
	});

	it('throws without a ref', () => {
		expect(() => rewriteReadmeLinks('[x](work/a.md)', {})).toThrow(/ref/);
	});
});

describe('resolvePinRef', () => {
	it('prefers `${name}@${version}` from the package.json', () => {
		const dir = mkdtempSync(join(tmpdir(), 'serpcast-pin-'));
		try {
			writeFileSync(
				join(dir, 'package.json'),
				JSON.stringify({name: 'serpcast', version: '0.2.1'}),
				'utf8',
			);
			expect(resolvePinRef({packageDir: dir, env: {GITHUB_SHA: 'abc'}})).toBe(
				'serpcast@0.2.1',
			);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('falls back to GITHUB_SHA when no package version is available', () => {
		const dir = mkdtempSync(join(tmpdir(), 'serpcast-pin-'));
		try {
			expect(
				resolvePinRef({packageDir: dir, env: {GITHUB_SHA: 'deadbeef'}}),
			).toBe('deadbeef');
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
