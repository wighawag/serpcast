// Test helpers for `serpcast install-libcurl`: a .tar.gz builder, a local
// server standing in for the release host (with redirects, like GitHub's), and
// a pinned release pointing at it. Nothing here touches the network.

import {createHash} from 'node:crypto';
import {existsSync, statSync} from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import type {Release} from '../src/install.js';

export interface TarEntry {
	name: string;
	body?: Buffer;
	/** '0' file (default), '2' symlink, '5' directory, 'L' GNU long name. */
	type?: string;
	link?: string;
}

/** A ustar archive of `entries`, gzipped. Names longer than 100 bytes get a GNU long-name entry. */
export function tarGz(entries: TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	const header = (entry: TarEntry) => {
		const block = Buffer.alloc(512);
		const size = entry.body?.length ?? 0;
		block.write(entry.name.slice(0, 100), 0);
		block.write('0000644\0', 100);
		block.write('0000000\0', 108);
		block.write('0000000\0', 116);
		block.write(size.toString(8).padStart(11, '0') + '\0', 124);
		block.write('00000000000\0', 136);
		block.write(entry.type ?? '0', 156);
		if (entry.link) block.write(entry.link, 157);
		block.write('ustar\0' + '00', 257);
		block.fill(' ', 148, 156);
		let sum = 0;
		for (const byte of block) sum += byte;
		block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		return block;
	};
	const add = (entry: TarEntry) => {
		const body = entry.body ?? Buffer.alloc(0);
		blocks.push(header(entry), body);
		const pad = (512 - (body.length % 512)) % 512;
		blocks.push(Buffer.alloc(pad));
	};
	for (const entry of entries) {
		if (entry.name.length > 100) {
			add({
				name: '././@LongLink',
				type: 'L',
				body: Buffer.from(entry.name + '\0'),
			});
		}
		add(entry);
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks), {level: 1});
}

export const sha256 = (data: Buffer) =>
	createHash('sha256').update(data).digest('hex');

export type Route = Buffer | {status: number; location?: string};

export interface ReleaseServer {
	origin: string;
	/** Every path requested, in order. */
	hits: string[];
	close(): Promise<void>;
}

/** Serve binary files by path; a `{status, location}` route answers that instead. */
export async function startReleaseServer(
	routes: Record<string, Route>,
): Promise<ReleaseServer> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? '/');
		const route = routes[req.url ?? '/'];
		if (!route) return void res.writeHead(404).end('not found');
		if (Buffer.isBuffer(route)) {
			res.writeHead(200, {'content-type': 'application/gzip'});
			return void res.end(route);
		}
		res.writeHead(
			route.status,
			route.location ? {location: route.location} : {},
		);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export const PLATFORM = `${process.platform}-${process.arch}`;
export const LIBRARY = 'libcurl-impersonate.so.4.8.0';

/** A release whose only archive, for this platform, is `/rel/lib.tar.gz` pinned to `checksum`. */
export function release(baseUrl: string, checksum: string): Release {
	return {
		version: '9.9.9',
		baseUrl,
		assets: {
			[PLATFORM]: {archive: 'lib.tar.gz', sha256: checksum, library: LIBRARY},
		},
	};
}

/**
 * The real data directories this user has (from the environment the tests
 * started in), with their mtimes: compare before and after to show the tests
 * left them untouched.
 */
export function realDataDirs(): () => unknown[] {
	const dirs = [
		join(homedir(), '.local', 'share', 'serpcast'),
		...(process.env.XDG_DATA_HOME
			? [join(process.env.XDG_DATA_HOME, 'serpcast')]
			: []),
	];
	const files = dirs.flatMap((d) => [
		d,
		join(d, 'libcurl-impersonate.so'),
		join(d, 'recipes'),
	]);
	return () =>
		files.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 'absent'));
}
