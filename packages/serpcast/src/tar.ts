// The in-process .tar.gz reader the two install commands share (install.ts,
// install-recipes.ts): no `tar` binary, no writing. It lists every entry with
// its path (GNU long names and pax `path` records applied), its type flag and,
// for a regular file, its bytes. Deciding which entries are acceptable is the
// caller's job.

import {gunzipSync} from 'node:zlib';

export interface TarEntry {
	/** The entry's path as stored (not normalized). */
	path: string;
	/** The ustar type flag: '0' regular file, '5' directory, '2' symlink, ... */
	type: string;
	/** The entry's data (empty for anything but a regular file). */
	body: Buffer;
}

/** Every entry of a .tar.gz; throws when it is not one, or unpacks past `maxUnpackedBytes`. */
export function readTarGz(targz: Buffer, maxUnpackedBytes: number): TarEntry[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(targz, {maxOutputLength: maxUnpackedBytes});
	} catch (cause) {
		throw new Error('the archive is not a readable .tar.gz', {cause});
	}
	const text = (start: number, length: number, from = tar) =>
		from
			.subarray(start, start + length)
			.toString('utf8')
			.replace(/\0.*$/s, '');
	const entries: TarEntry[] = [];
	let longName: string | undefined;
	for (let offset = 0; offset + 512 <= tar.length;) {
		if (tar.subarray(offset, offset + 512).every((b) => b === 0)) break;
		const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
		const type = text(offset + 156, 1) || '0';
		const prefix = text(offset + 345, 155);
		const path = longName ?? (prefix ? `${prefix}/` : '') + text(offset, 100);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		longName = undefined;
		if (type === 'L') longName = text(0, size, body);
		else if (type === 'x')
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
		else entries.push({path, type, body: Buffer.from(body)});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}
