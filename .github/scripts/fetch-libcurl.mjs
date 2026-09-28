// CI only: fetch the pinned libcurl-impersonate release named by
// LIBCURL_IMPERSONATE (the same constant the install command uses), verify its
// sha256, unpack it into the given directory and print the library's path.
// Not part of any published package. Run after `pnpm build`.
//
// Usage: node .github/scripts/fetch-libcurl.mjs <dir>

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LIBCURL_IMPERSONATE} from '../../packages/serpcast/dist/libcurl.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: fetch-libcurl.mjs <dir>');
const platform = `${process.platform}-${process.arch}`;
const asset = LIBCURL_IMPERSONATE.assets[platform];
if (!asset)
	throw new Error(`no pinned libcurl-impersonate archive for ${platform}`);

const url = LIBCURL_IMPERSONATE.baseUrl + asset.archive;
const response = await fetch(url);
if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const sha256 = createHash('sha256').update(archive).digest('hex');
if (sha256 !== asset.sha256) {
	throw new Error(
		`checksum mismatch for ${asset.archive}: got ${sha256}, pinned ${asset.sha256}`,
	);
}
mkdirSync(dir, {recursive: true});
const file = join(dir, asset.archive);
writeFileSync(file, archive);
execFileSync('tar', ['-xzf', file, '-C', dir]);
console.log(join(dir, asset.library));
