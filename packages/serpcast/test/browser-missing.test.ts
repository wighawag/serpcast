// Without searchcast installed, a library-mode browser engine fails with an
// error naming the package; HTTP engines never need it. searchcast is an
// optional peer that pnpm installs in this workspace, so the import is made
// to fail the way Node fails for a missing package.

import {vi, describe, expect, it} from 'vitest';

vi.mock('searchcast', () => {
	throw Object.assign(new Error("Cannot find package 'searchcast'"), {
		code: 'ERR_MODULE_NOT_FOUND',
	});
});

const {createSerpcast, SerpcastError} = await import('../src/index.js');
const {engine, fakeTransport, pages} = await import('./engines.js');

describe('without searchcast installed', () => {
	it('library mode fails naming the package to install; HTTP engines still answer', async () => {
		const {transport} = fakeTransport({a: () => pages.results('A')});
		const serpcast = createSerpcast({transport});
		const browser = {
			name: 'browser',
			searchcast: {recipe: engine('browser')},
		};
		const error = await serpcast
			.search('q', {engines: [browser]})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SerpcastError);
		const [failure] = (error as InstanceType<typeof SerpcastError>).failures!;
		expect(failure!.error.kind).toBe('transport');
		expect(failure!.error.message).toContain('npm install searchcast');

		const answer = await serpcast.search('q', {
			engines: [engine('a'), browser],
		});
		expect(answer.engine).toBe('a');
		await serpcast.close();
	});
});
