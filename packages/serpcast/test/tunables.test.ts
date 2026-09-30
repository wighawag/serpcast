// The tuning options and off switches (task tunables-and-install-api), without
// the native library: each option's default is unchanged, a set value takes
// effect, and an invalid value fails loud where it is given. The transport's
// own options (reuseConnections, idlePollMs, maxRequestBodyBytes,
// preflightCache, maxPreflightAgeS) take effect in tunables-native.test.ts.

import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	createSerpcast,
	createTransport,
	DEFAULT_DECOY_RULE,
	isDecoy,
	runDeclarativeRecipe,
	SerpcastError,
	type ChainTransport,
	type Engine,
	type SearchResult,
	type SerpcastOptions,
} from '../src/index.js';
import {installLibcurl} from '../src/install.js';
import {installRecipes} from '../src/install-recipes.js';
import {engine, fakeTransport, pages} from './engines.js';
import {
	fakeSession,
	recipe,
	resultsPage,
	item,
	startPageServer,
} from './pages.js';
import {
	LIBRARY,
	release,
	sha256,
	startReleaseServer,
	tarGz,
} from './release.js';

/** What `fn` throws (it must throw synchronously or reject). */
async function thrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	throw new Error('did not throw');
}

describe('invalid options fail loud at construction (RangeError naming the option)', () => {
	const bad: Array<[keyof SerpcastOptions, unknown[]]> = [
		['timeoutMs', [0, -1, NaN, Infinity, 1.5, '10']],
		['maxBodyBytes', [0, -1, NaN, 0.5]],
		['idlePollMs', [0, -5, NaN, Infinity]],
		['maxRequestBodyBytes', [0, -1, 1.5]],
		['maxPreflightAgeS', [0, -1, NaN]],
		['reuseConnections', ['no', 0]],
		['preflightCache', ['yes', 1]],
		['cooldownMs', [-1, NaN, Infinity]],
		['sessionIdleMs', [0, -1, NaN]],
		['maxRedirects', [-1, 1.5, NaN]],
		['keepSessions', ['false']],
		['decoyGuard', ['bing', [1], {exclude: 'bing'}, {include: [2]}, null]],
		[
			'decoyRule',
			[{top: 0}, {maxRelevant: -1}, {prefix: 2.5}, {top: NaN}, 'strict'],
		],
	];
	for (const [option, values] of bad) {
		it(`createSerpcast refuses a bad ${option}`, () => {
			for (const value of values) {
				expect(
					() => createSerpcast({[option]: value} as SerpcastOptions),
					`${option}: ${String(value)}`,
				).toThrow(new RegExp(`serpcast: ${option}`));
				expect(() =>
					createSerpcast({[option]: value} as SerpcastOptions),
				).toThrow(RangeError);
			}
		});
	}

	it('createTransport refuses its own bad options too, and checks them even with an injected transport', () => {
		expect(() => createTransport({idlePollMs: 0})).toThrow(
			/idlePollMs must be a positive finite number, got 0/,
		);
		expect(() => createTransport({maxPreflightAgeS: -1})).toThrow(RangeError);
		const {transport} = fakeTransport({});
		expect(() => createSerpcast({transport, idlePollMs: -1})).toThrow(
			/idlePollMs/,
		);
	});

	it('accepts zero where it means off: cooldownMs and maxRedirects', () => {
		expect(() =>
			createSerpcast({cooldownMs: 0, maxRedirects: 0}),
		).not.toThrow();
	});

	it('accepts every option at a valid value (defaults unchanged when unset)', () => {
		expect(() =>
			createSerpcast({
				timeoutMs: 1000,
				maxBodyBytes: 1024,
				reuseConnections: false,
				idlePollMs: 2.5,
				maxRequestBodyBytes: 10,
				preflightCache: false,
				maxPreflightAgeS: 60,
				cooldownMs: 1,
				sessionIdleMs: 1,
				maxRedirects: 3,
				keepSessions: false,
				decoyGuard: {include: ['a'], exclude: ['b']},
				decoyRule: {top: 10, maxRelevant: 2, prefix: 4},
			}),
		).not.toThrow();
	});
});

describe('decoyGuard: the object form and its off switch', () => {
	const query = 'debian bookworm backports kernel install';
	const decoy = () => pages.results('RuneScape', 'Kernel', 'Install', 'Wiki');
	const answers = {a: decoy, x: decoy, next: () => pages.results('Next')};
	const next = engine('next');
	const run = async (engines: Engine[], options: SerpcastOptions) => {
		const serpcast = createSerpcast({
			transport: fakeTransport(answers).transport,
			...options,
		});
		const response = await serpcast.search(query, {engines});
		return {
			engine: response.engine,
			failures: response.failures.map((f) => [f.engine, f.error.kind]),
		};
	};
	const prone = (name: string) => ({...engine(name), decoyProne: true});

	it('exclude switches the guard off for a decoyProne recipe', async () => {
		expect(
			await run([prone('x'), next], {decoyGuard: {exclude: ['x']}}),
		).toEqual({
			engine: 'x',
			failures: [],
		});
		// The default (no decoyGuard) still guards it.
		expect((await run([prone('x'), next], {})).engine).toBe('next');
	});

	it('exclude wins over include, and excludes only the engines it names', async () => {
		const options = {decoyGuard: {include: ['a', 'x'], exclude: ['x']}};
		expect((await run([engine('x'), next], options)).engine).toBe('x');
		expect(await run([engine('a'), next], options)).toEqual({
			engine: 'next',
			failures: [['a', 'decoy']],
		});
		expect(
			(await run([prone('a'), next], {decoyGuard: {exclude: ['x']}})).engine,
		).toBe('next');
	});

	it('include is the array form; the array form is unchanged', async () => {
		for (const decoyGuard of [['a'], {include: ['a']}])
			expect((await run([engine('a'), next], {decoyGuard})).engine).toBe(
				'next',
			);
		expect((await run([engine('a'), next], {decoyGuard: {}})).engine).toBe('a');
	});
});

describe('decoyRule', () => {
	const query = 'postgres logical replication slot lag';
	const on = (title: string): SearchResult => ({title, url: 'https://x.test/'});
	const relevant = on('postgres replication slots');
	const noise = (i: number) => on(`unrelated ${i}`);
	// Two relevant results in the top five: not a decoy by default.
	const page = [relevant, relevant, noise(1), noise(2), noise(3)];

	it('defaults to the measured thresholds', () => {
		expect(DEFAULT_DECOY_RULE).toEqual({top: 5, maxRelevant: 1, prefix: 5});
		expect(isDecoy(query, page)).toBe(false);
		expect(isDecoy(query, page, DEFAULT_DECOY_RULE)).toBe(false);
	});

	it('each threshold takes effect', () => {
		expect(isDecoy(query, page, {maxRelevant: 2})).toBe(true);
		// Only the three noise results judged: no relevant one.
		expect(
			isDecoy(query, [...page.slice(2), relevant, relevant], {top: 3}),
		).toBe(true);
		// "replicas" matches "replication" by 5 characters, not by 8.
		const stem = on('postgres replicas');
		const stems = [stem, stem, noise(1), noise(2), noise(3)];
		expect(isDecoy(query, stems)).toBe(false);
		expect(isDecoy(query, stems, {prefix: 8})).toBe(true);
	});

	it('the chain applies it to guarded engines', async () => {
		const answers = {
			a: () =>
				pages.results(
					'postgres replication',
					'postgres replication',
					'x one',
					'x two',
				),
			next: () => pages.results('Next'),
		};
		const search = (options: SerpcastOptions) =>
			createSerpcast({
				transport: fakeTransport(answers).transport,
				...options,
			}).search(query, {engines: [engine('a'), engine('next')]});
		expect((await search({decoyGuard: ['a']})).engine).toBe('a');
		expect(
			(await search({decoyGuard: ['a'], decoyRule: {maxRelevant: 2}})).engine,
		).toBe('next');
	});

	it('isDecoy refuses a bad rule', () => {
		expect(() => isDecoy(query, page, {top: 0})).toThrow(RangeError);
	});
});

describe('keepSessions', () => {
	/** A fake transport whose sessions count their close() calls. */
	function counting() {
		const fake = fakeTransport({
			a: (request) => ({
				...(pages.results('A') as {body: string}),
				setCookie: request.cookie ? [] : ['sid=a; Path=/'],
			}),
		});
		const sessions: {closed: number}[] = [];
		const transport: ChainTransport = {
			session(saved) {
				const inner = fake.transport.session(saved);
				const record = {closed: 0};
				sessions.push(record);
				return {...inner, close: () => void record.closed++};
			},
		};
		return {...fake, transport, sessions};
	}

	it('by default one session is kept between searches', async () => {
		const {transport, sessions} = counting();
		const serpcast = createSerpcast({transport});
		for (let i = 0; i < 3; i++)
			await serpcast.search('q', {engines: [engine('a')]});
		expect(sessions.map((s) => s.closed)).toEqual([0]);
	});

	it('false: a new session per search, closed after it; cookies still go through the store', async () => {
		const {transport, sessions, requests} = counting();
		const serpcast = createSerpcast({transport, keepSessions: false});
		for (let i = 0; i < 3; i++)
			await serpcast.search('q', {engines: [engine('a')]});
		expect(sessions.map((s) => s.closed)).toEqual([1, 1, 1]);
		expect(requests.map((r) => r.cookie ?? '-')).toEqual([
			'-',
			'sid=a',
			'sid=a',
		]);
		await serpcast.close();
		expect(sessions.map((s) => s.closed)).toEqual([1, 1, 1]);
	});
});

describe('maxRedirects (declarative runner and chain)', () => {
	let server: Awaited<ReturnType<typeof startPageServer>>;
	beforeAll(async () => {
		const hop = (n: number) => ({
			status: 302,
			headers: {location: `/hop/${n}`},
		});
		server = await startPageServer({
			'/search': hop(1),
			'/hop/1': hop(2),
			'/hop/2': hop(3),
			'/hop/3': {body: resultsPage(item('A', '/a'))},
		});
	});
	afterAll(() => server.close());

	const run = (maxRedirects?: number) =>
		runDeclarativeRecipe(recipe(server.origin), 'q', {
			session: fakeSession(),
			...(maxRedirects !== undefined && {maxRedirects}),
		});

	it('defaults to 20 and follows 3 hops', async () => {
		expect((await run()).results).toHaveLength(1);
		expect((await run(3)).results).toHaveLength(1);
	});

	it('a lower value is a transport error; 0 follows none', async () => {
		await expect(run(2)).rejects.toMatchObject({
			kind: 'transport',
			message: expect.stringContaining('more than 2 redirects'),
		});
		await expect(run(0)).rejects.toMatchObject({kind: 'transport'});
		await expect(run(-1)).rejects.toThrow(RangeError);
	});

	it('the chain passes it to declarative recipes', async () => {
		const redirecting = {
			a: () => ({
				status: 302,
				body: '',
				headers: {location: 'https://a.test/again'},
			}),
		};
		const error = await thrown(() =>
			createSerpcast({
				transport: fakeTransport(redirecting).transport,
				maxRedirects: 1,
			}).search('q', {engines: [engine('a')]}),
		);
		expect((error as SerpcastError).failures![0]!.error.message).toMatch(
			/more than 1 redirects/,
		);
	});
});

describe('browser endpoint maxBodyBytes', () => {
	let server: http.Server;
	let base: string;
	const big = JSON.stringify({
		results: [{title: 'T', url: 'https://t.test/', pad: 'x'.repeat(4000)}],
	});
	beforeAll(async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(200, {'content-type': 'application/json'});
			res.end(big);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, '127.0.0.1', resolve),
		);
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	const failure = async (maxBodyBytes: number) => {
		const error = await thrown(() =>
			createSerpcast({transport: fakeTransport({}).transport}).search('q', {
				engines: [{name: 'b', searchcast: {endpoint: base, maxBodyBytes}}],
			}),
		);
		return (error as SerpcastError).failures![0]!.error;
	};

	it('defaults to 16 MiB (a 4 KB answer passes)', async () => {
		const answer = await createSerpcast({
			transport: fakeTransport({}).transport,
		}).search('q', {
			engines: [{name: 'b', searchcast: {endpoint: base}}],
		});
		expect(answer.results).toHaveLength(1);
	});

	it('a lower value refuses a larger answer (transport)', async () => {
		const error = await failure(1000);
		expect(error.kind).toBe('transport');
		expect(error.message).toMatch(/larger than 1000 bytes/);
	});

	it('an invalid value is a recipe error (a misconfigured engine)', async () => {
		for (const value of [0, -1, NaN]) {
			const error = await failure(value);
			expect(error.kind).toBe('recipe');
			expect(error.message).toMatch(/maxBodyBytes/);
		}
	});
});

describe('installer size caps may be lowered, never raised', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'serpcast-tunables-'));
	afterAll(() => rmSync(tmp, {recursive: true, force: true}));
	const archive = tarGz([
		{name: 'web.json', body: Buffer.from('{"name":"web"}\n'.repeat(200))},
	]);
	const path = join(tmp, 'set.tar.gz');
	writeFileSync(path, archive);
	const install = (options: object) =>
		installRecipes(path, {
			sha256: sha256(archive),
			name: 'set',
			dir: join(tmp, 'recipes'),
			force: true,
			...options,
		});

	it('installRecipes: the defaults install; a lower maxArchiveBytes or maxUnpackedBytes refuses', async () => {
		expect((await install({})).status).toMatch(/installed|unchanged/);
		await expect(
			install({maxArchiveBytes: archive.length - 1}),
		).rejects.toThrow(/larger than/);
		await expect(install({maxUnpackedBytes: 1000})).rejects.toThrow(
			/unpacks to more than 1000 bytes/,
		);
	});

	it('installLibcurl: the defaults install; a lower maxArchiveBytes or maxUnpackedBytes refuses, installing nothing', async () => {
		const lib = tarGz([{name: LIBRARY, body: Buffer.alloc(4000, 1)}]);
		const server = await startReleaseServer({'/rel/lib.tar.gz': lib});
		try {
			const pinned = release(`${server.origin}/rel/`, sha256(lib));
			const env = {XDG_DATA_HOME: join(tmp, 'lib-data')};
			await expect(
				installLibcurl({release: pinned, env, maxArchiveBytes: lib.length - 1}),
			).rejects.toThrow(/larger than/);
			await expect(
				installLibcurl({release: pinned, env, maxUnpackedBytes: 2000}),
			).rejects.toThrow(/unpacks to more than 2000 bytes/);
			expect((await installLibcurl({release: pinned, env})).status).toBe(
				'installed',
			);
		} finally {
			await server.close();
		}
	});

	it('installRecipes and installLibcurl refuse a raised or invalid cap, before any request', async () => {
		for (const options of [
			{maxArchiveBytes: 16 * 1024 * 1024 + 1},
			{maxUnpackedBytes: 64 * 1024 * 1024 + 1},
			{maxArchiveBytes: 0},
		])
			await expect(install(options)).rejects.toThrow(RangeError);
		const nowhere = release('http://127.0.0.1:9/', 'x'.repeat(64));
		for (const options of [
			{maxArchiveBytes: 128 * 1024 * 1024 + 1},
			{maxUnpackedBytes: 512 * 1024 * 1024 + 1},
			{maxUnpackedBytes: -1},
		])
			await expect(
				installLibcurl({
					release: nowhere,
					env: {XDG_DATA_HOME: tmp},
					...options,
				}),
			).rejects.toThrow(/at most|positive/);
	});
});
