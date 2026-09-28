// With the default state store, a search (cooldown, session, clearSessions)
// writes nothing to disk: every write-side function of node:fs is spied on.

import {vi, describe, expect, it} from 'vitest';

const writes = vi.hoisted(() => [] as string[]);
const WRITE =
	/^(write|append|mkdir|mkdtemp|rename|copy|cp|symlink|link|truncate|createWriteStream|rm|unlink)/;

function spied<T extends object>(mod: T): T {
	const out: Record<string, unknown> = {...(mod as Record<string, unknown>)};
	for (const [name, fn] of Object.entries(mod)) {
		if (typeof fn === 'function' && WRITE.test(name)) {
			out[name] = (...args: unknown[]) => {
				writes.push(name);
				return (fn as (...a: unknown[]) => unknown)(...args);
			};
		}
	}
	return out as T;
}

vi.mock('node:fs', async (original) => {
	const mod = spied(await original<typeof import('node:fs')>());
	return {...mod, default: mod};
});
vi.mock('node:fs/promises', async (original) => {
	const mod = spied(await original<typeof import('node:fs/promises')>());
	return {...mod, default: mod};
});

const {createSerpcast} = await import('../src/index.js');
const {engine, fakeTransport, pages} = await import('./engines.js');

describe('the default state store', () => {
	it('writes nothing to disk', async () => {
		const fs = await import('node:fs');
		fs.writeFileSync('/dev/null', ''); // the spy works
		expect(writes).toEqual(['writeFileSync']);
		writes.length = 0;

		const {transport} = fakeTransport({
			a: pages.blocked,
			b: () => ({
				...(pages.results('B') as {body: string}),
				setCookie: ['s=1'],
			}),
		});
		const serpcast = createSerpcast({transport});
		const chain = {engines: [engine('a'), engine('b')]};
		await serpcast.search('q', chain);
		await serpcast.search('q', chain);
		await serpcast.clearSessions();
		await serpcast.close();
		expect(writes).toEqual([]);
	});
});
