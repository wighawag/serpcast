// The engine chain with fake engines over a fake transport (test/engines.ts).

import {describe, expect, it} from 'vitest';
import {
	createMemoryStore,
	createSerpcast,
	DEFAULT_COOLDOWN_MS,
	SerpcastError,
	type SerpcastOptions,
} from '../src/index.js';
import {
	clock,
	engine,
	fakeTransport,
	pages,
	recordingStore,
	type Answer,
	type FakeRequest,
} from './engines.js';

const [a, b, c] = [engine('a'), engine('b'), engine('c')];

function setup(
	answers: Record<string, (request: FakeRequest) => Answer>,
	options: SerpcastOptions = {},
) {
	const time = clock();
	const fake = fakeTransport(answers);
	const serpcast = createSerpcast({
		now: time.now,
		transport: fake.transport,
		...options,
	});
	return {...fake, time, serpcast};
}

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => expect.fail('expected a failure'),
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(SerpcastError);
	return error as SerpcastError;
};
const kinds = (failures: {engine: string; error: SerpcastError}[] = []) =>
	failures.map((f) => [f.engine, f.error.kind]);

describe('createSerpcast: the chain', () => {
	it('returns the first answer, reports earlier failures, calls no later engine', async () => {
		const {serpcast, hits} = setup({
			a: pages.broken,
			b: () => pages.results('B1', 'B2'),
			c: () => pages.results('C1'),
		});
		const response = await serpcast.search('q', {engines: [a, b, c]});
		expect(response.engine).toBe('b');
		expect(response.results.map((r) => r.title)).toEqual(['B1', 'B2']);
		expect(response.results[0]!.url).toBe('https://b.test/B1');
		expect(kinds(response.failures)).toEqual([['a', 'recipe']]);
		expect(hits('a')).toHaveLength(1);
		expect(hits('c')).toHaveLength(0);
	});

	it('treats an empty match as the answer', async () => {
		const {serpcast, hits} = setup({
			a: pages.empty,
			b: () => pages.results('B'),
		});
		const response = await serpcast.search('q', {engines: [a, b]});
		expect(response).toEqual({results: [], engine: 'a', failures: []});
		expect(hits('b')).toHaveLength(0);
	});

	it('cuts the answer to maxResults', async () => {
		const {serpcast} = setup({a: () => pages.results('1', '2', '3')});
		const {results} = await serpcast.search('q', {engines: [a], maxResults: 2});
		expect(results.map((r) => r.title)).toEqual(['1', '2']);
	});

	it('throws exhausted with every failure when all engines fail, never []', async () => {
		const timeout = new SerpcastError('timeout', 'slow');
		const {serpcast} = setup({
			a: pages.broken,
			b: pages.blocked,
			c: () => ({throw: timeout}),
		});
		const error = await failure(serpcast.search('q', {engines: [a, b, c]}));
		expect(error.kind).toBe('exhausted');
		expect(kinds(error.failures)).toEqual([
			['a', 'recipe'],
			['b', 'blocked'],
			['c', 'timeout'],
		]);
		expect(error.failures![2]!.error).toBe(timeout);
	});

	it('throws exhausted for an empty chain', async () => {
		const {serpcast} = setup({});
		const error = await failure(serpcast.search('q', {engines: []}));
		expect(error.kind).toBe('exhausted');
		expect(error.failures).toEqual([]);
	});

	it('aborts the whole search on an impersonation error', async () => {
		const {serpcast, hits} = setup({
			a: pages.broken,
			b: () => ({throw: new SerpcastError('impersonation', 'no library')}),
			c: () => pages.results('C'),
		});
		const error = await failure(serpcast.search('q', {engines: [a, b, c]}));
		expect(error.kind).toBe('impersonation');
		expect(hits('c')).toHaveLength(0);
	});

	it("rejects with the signal's reason when aborted, calling no later engine", async () => {
		const controller = new AbortController();
		const reason = new Error('stop');
		const {serpcast, hits} = setup({
			a: () => {
				controller.abort(reason);
				return {throw: reason};
			},
			b: () => pages.results('B'),
		});
		await expect(
			serpcast.search('q', {engines: [a, b], signal: controller.signal}),
		).rejects.toBe(reason);
		expect(hits('b')).toHaveLength(0);
	});

	it('rethrows an error that is not a SerpcastError (a bug, not an engine failure)', async () => {
		const bug = new TypeError('bug');
		const {serpcast} = setup({
			a: () => ({throw: bug}),
			b: () => pages.results('B'),
		});
		await expect(serpcast.search('q', {engines: [a, b]})).rejects.toBe(bug);
	});
});

describe('createSerpcast: cooldowns', () => {
	it('skips a blocked engine during its cooldown and tries it again after', async () => {
		const {serpcast, hits, time} = setup({
			a: pages.blocked,
			b: () => pages.results('B'),
		});
		const first = await serpcast.search('q', {engines: [a, b]});
		expect(kinds(first.failures)).toEqual([['a', 'blocked']]);
		expect(hits('a')).toHaveLength(1);

		time.advance(DEFAULT_COOLDOWN_MS - 1);
		const second = await serpcast.search('q', {engines: [a, b]});
		expect(hits('a')).toHaveLength(1); // skipped
		expect(second.engine).toBe('b');
		expect(kinds(second.failures)).toEqual([['a', 'blocked']]);
		expect(second.failures[0]!.error.message).toMatch(/cooling down until/);

		time.advance(1);
		await serpcast.search('q', {engines: [a, b]});
		expect(hits('a')).toHaveLength(2); // tried again
	});

	it('uses the configured cooldown, and only blocked starts one', async () => {
		const {serpcast, hits, time} = setup(
			{a: pages.blocked, b: pages.broken, c: () => pages.results('C')},
			{cooldownMs: 1000},
		);
		await serpcast.search('q', {engines: [a, b, c]});
		await serpcast.search('q', {engines: [a, b, c]});
		expect(hits('a')).toHaveLength(1);
		expect(hits('b')).toHaveLength(2); // a recipe failure starts no cooldown
		time.advance(1000);
		await serpcast.search('q', {engines: [a, b, c]});
		expect(hits('a')).toHaveLength(2);
	});
});

describe('createSerpcast: decoyGuard', () => {
	const query = 'debian bookworm backports kernel install';
	const decoy = () => pages.results('RuneScape', 'Kernel', 'Install', 'Wiki');
	const genuine = () =>
		pages.results('Debian-backports', 'Debian-kernel', 'Other', 'Else');

	it('turns a decoy answer of a guarded engine into a decoy failure and tries the next engine', async () => {
		const {serpcast, hits} = setup(
			{a: decoy, b: () => pages.results('B')},
			{decoyGuard: ['a']},
		);
		const response = await serpcast.search(query, {engines: [a, b]});
		expect(response.engine).toBe('b');
		expect(kinds(response.failures)).toEqual([['a', 'decoy']]);
		const {message} = response.failures[0]!.error;
		expect(message).toContain('backports bookworm debian install kernel');
		expect(message).toContain('"RuneScape", "Kernel", "Install", "Wiki"');
		expect(hits('a')).toHaveLength(1);
	});

	it('judges the whole answer, before the maxResults cut', async () => {
		const {serpcast} = setup(
			{a: decoy, b: () => pages.results('B')},
			{decoyGuard: ['a']},
		);
		const response = await serpcast.search(query, {
			engines: [a, b],
			maxResults: 1,
		});
		expect(kinds(response.failures)).toEqual([['a', 'decoy']]);
	});

	it('passes a relevant answer of a guarded engine', async () => {
		const {serpcast} = setup({a: genuine}, {decoyGuard: ['a']});
		const response = await serpcast.search(query, {engines: [a]});
		expect(response.engine).toBe('a');
		expect(response.failures).toEqual([]);
	});

	it('never judges an unguarded engine, and is off by default', async () => {
		const guarded = setup({a: decoy, b: decoy}, {decoyGuard: ['b']});
		const response = await guarded.serpcast.search(query, {engines: [a, b]});
		expect(response.engine).toBe('a');
		expect(response.results.map((r) => r.title)[0]).toBe('RuneScape');

		const plain = setup({a: decoy});
		expect((await plain.serpcast.search(query, {engines: [a]})).engine).toBe(
			'a',
		);
	});

	it('starts no cooldown: the engine is tried again at once, and answers another query', async () => {
		const {serpcast, hits, time} = setup(
			{
				a: (request) =>
					request.url.includes('debian') ? decoy() : pages.results('A'),
				b: () => pages.results('B'),
			},
			{decoyGuard: ['a']},
		);
		await serpcast.search(query, {engines: [a, b]});
		time.advance(1);
		const again = await serpcast.search(query, {engines: [a, b]});
		expect(hits('a')).toHaveLength(2); // not skipped
		expect(kinds(again.failures)).toEqual([['a', 'decoy']]);
		const other = await serpcast.search('q', {engines: [a, b]});
		expect(other.engine).toBe('a');
	});

	it('lists a decoy in exhausted like any failure', async () => {
		const {serpcast} = setup({a: decoy, b: pages.broken}, {decoyGuard: ['a']});
		const error = await failure(serpcast.search(query, {engines: [a, b]}));
		expect(error.kind).toBe('exhausted');
		expect(kinds(error.failures)).toEqual([
			['a', 'decoy'],
			['b', 'recipe'],
		]);
	});

	it('applies to code recipes too', async () => {
		const code = {
			name: 'code',
			search: () =>
				['Why', 'WHY meaning', 'why - Wiktionary'].map((title, i) => ({
					title,
					url: `https://dictionary.test/${i}`,
				})),
		};
		const {serpcast} = setup(
			{b: () => pages.results('B')},
			{decoyGuard: ['code']},
		);
		const response = await serpcast.search('why does git rebase rewrite', {
			engines: [code, b],
		});
		expect(kinds(response.failures)).toEqual([['code', 'decoy']]);
	});
});

describe('createSerpcast: sessions', () => {
	const withCookie = (name: string) => (request: FakeRequest) => ({
		...(pages.results(name) as {body: string}),
		setCookie: request.cookie ? [] : [`sid=${name}; Path=/`],
	});

	it('keeps cookies across searches until the idle time passes', async () => {
		const {serpcast, requests, time} = setup(
			{a: withCookie('a')},
			{sessionIdleMs: 60_000},
		);
		await serpcast.search('q', {engines: [a]});
		time.advance(59_999);
		await serpcast.search('q', {engines: [a]});
		time.advance(59_999); // counted from the last use: still alive
		await serpcast.search('q', {engines: [a]});
		time.advance(60_000);
		await serpcast.search('q', {engines: [a]});
		expect(requests.map((r) => r.cookie)).toEqual([
			undefined,
			'sid=a',
			'sid=a',
			undefined,
		]);
	});

	it('clearSessions drops one engine or every engine', async () => {
		const {serpcast, requests} = setup({
			a: withCookie('a'),
			b: withCookie('b'),
		});
		const both = async () => {
			await serpcast.search('q', {engines: [a]});
			await serpcast.search('q', {engines: [b]});
		};
		await both();
		await serpcast.clearSessions('a');
		await both();
		await serpcast.clearSessions();
		await both();
		expect(requests.map((r) => `${r.engine}:${r.cookie ?? '-'}`)).toEqual([
			'a:-',
			'b:-',
			'a:-',
			'b:sid=b',
			'a:-',
			'b:-',
		]);
	});

	it('keeps the cookies of a failed attempt (a challenge may set them)', async () => {
		let n = 0;
		const {serpcast, requests, time} = setup({
			a: () =>
				n++ === 0
					? {status: 403, body: '', setCookie: ['challenge=ok']}
					: pages.results('A'),
			b: () => pages.results('B'),
		});
		await serpcast.search('q', {engines: [a, b]});
		time.advance(DEFAULT_COOLDOWN_MS);
		await serpcast.search('q', {engines: [a, b]});
		expect(
			requests.filter((r) => r.engine === 'a').map((r) => r.cookie),
		).toEqual([undefined, 'challenge=ok']);
	});
});

describe('createSerpcast: the state store', () => {
	it('sends every read and write to a caller-supplied store', async () => {
		const time = clock();
		const {store, calls} = recordingStore(time.now);
		const {serpcast} = setup(
			{a: pages.blocked, b: () => pages.results('B')},
			{store},
		);
		await serpcast.search('q', {engines: [a, b]});
		await serpcast.clearSessions();
		const keys = new Set(calls.map((c) => `${c.op} ${c.key}`));
		expect([...keys].sort()).toEqual([
			'delete engine/a/session',
			'delete engine/b/session',
			'delete serpcast/sessions',
			'get engine/a/cooldown',
			'get engine/a/session',
			'get engine/b/cooldown',
			'get engine/b/session',
			'get serpcast/sessions',
			'set engine/a/cooldown',
			'set engine/a/session',
			'set engine/b/session',
			'set serpcast/sessions',
		]);
	});

	it('holds all state in the store: a second instance on it sees cookies and cooldowns', async () => {
		const time = clock();
		const store = createMemoryStore({now: time.now});
		const fake = fakeTransport({
			a: pages.blocked,
			b: () => ({
				...(pages.results('B') as {body: string}),
				setCookie: ['s=1'],
			}),
		});
		const options = {store, now: time.now, transport: fake.transport};
		await createSerpcast(options).search('q', {engines: [a, b]});
		await createSerpcast(options).search('q', {engines: [a, b]});
		expect(fake.hits('a')).toHaveLength(1);
		expect(fake.hits('b').map((r) => r.cookie)).toEqual([undefined, 's=1']);
	});

	it('namespaces keys per engine name', async () => {
		const time = clock();
		const {store, calls} = recordingStore(time.now);
		const {serpcast} = setup({'a-b': () => pages.results('X')}, {store});
		await serpcast.search('q', {engines: [engine('a-b')]});
		expect(calls.some((c) => c.key === 'engine/a-b/session')).toBe(true);
	});

	it('close() resolves', async () => {
		const {serpcast} = setup({});
		await expect(serpcast.close()).resolves.toBeUndefined();
	});
});

describe('createMemoryStore', () => {
	it('expires keys after their ttl, by its clock, and copies values', async () => {
		const time = clock();
		const store = createMemoryStore({now: time.now});
		const value = {list: [1]};
		await store.set('k', value, {ttlMs: 10});
		await store.set('forever', 1);
		value.list.push(2);
		const got = (await store.get('k')) as {list: number[]};
		expect(got).toEqual({list: [1]});
		got.list.push(3);
		expect(await store.get('k')).toEqual({list: [1]});
		time.advance(10);
		expect(await store.get('k')).toBeUndefined();
		expect(await store.get('forever')).toBe(1);
		await store.delete('forever');
		expect(await store.get('forever')).toBeUndefined();
	});
});
