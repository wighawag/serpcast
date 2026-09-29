// The engine chain keeps each engine's transport session (its connections)
// between searches and closes it when the engine's session is dropped. Over a
// fake transport (test/engines.ts) whose sessions count their `close()` calls.

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	createMemoryStore,
	createSerpcast,
	type ChainTransport,
	type SerpcastOptions,
} from '../src/index.js';
import {
	clock,
	engine,
	fakeTransport,
	pages,
	type Answer,
	type FakeRequest,
} from './engines.js';

const [a, b] = [engine('a'), engine('b')];

const withCookie = (name: string) => (request: FakeRequest) => ({
	...(pages.results(name) as {body: string}),
	setCookie: request.cookie ? [] : [`sid=${name}; Path=/`],
});

/** Wrap the fake transport: every session it made, and how often each was closed. */
function counting(answers: Record<string, (request: FakeRequest) => Answer>) {
	const fake = fakeTransport(answers);
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

function setup(
	answers: Record<string, (request: FakeRequest) => Answer>,
	options: SerpcastOptions = {},
) {
	const time = clock();
	const fake = counting(answers);
	const serpcast = createSerpcast({
		now: time.now,
		transport: fake.transport,
		...options,
	});
	return {...fake, time, serpcast};
}

const closed = (sessions: {closed: number}[]) => sessions.map((s) => s.closed);

describe('createSerpcast: engine connections', () => {
	afterEach(() => void vi.useRealTimers());

	it('reuses one transport session per engine across searches, never one for two engines', async () => {
		const {serpcast, sessions, requests} = setup({
			a: withCookie('a'),
			b: withCookie('b'),
		});
		for (let i = 0; i < 3; i++) {
			await serpcast.search('q', {engines: [a]});
			await serpcast.search('q', {engines: [b]});
		}
		expect(sessions).toHaveLength(2);
		expect(closed(sessions)).toEqual([0, 0]);
		expect(requests.map((r) => `${r.engine}:${r.cookie ?? '-'}`)).toEqual([
			'a:-',
			'b:-',
			'a:sid=a',
			'b:sid=b',
			'a:sid=a',
			'b:sid=b',
		]);
	});

	it('closes the session when it idles out, and starts a new one', async () => {
		const {serpcast, sessions, time} = setup(
			{a: withCookie('a')},
			{sessionIdleMs: 60_000},
		);
		await serpcast.search('q', {engines: [a]});
		time.advance(59_999);
		await serpcast.search('q', {engines: [a]});
		expect(sessions).toHaveLength(1);
		time.advance(60_000);
		await serpcast.search('q', {engines: [a]});
		expect(closed(sessions)).toEqual([1, 0]);
	});

	it('closes an idle-expired session even when it holds no cookies', async () => {
		const {serpcast, sessions, time} = setup(
			{a: () => pages.results('A')},
			{sessionIdleMs: 1000},
		);
		await serpcast.search('q', {engines: [a]});
		time.advance(1000);
		await serpcast.search('q', {engines: [a]});
		expect(closed(sessions)).toEqual([1, 0]);
	});

	it('closes the session on its own after sessionIdleMs unused (an unref timer)', async () => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
		const {serpcast, sessions} = setup(
			{a: withCookie('a')},
			{sessionIdleMs: 1000},
		);
		await serpcast.search('q', {engines: [a]});
		vi.advanceTimersByTime(999);
		expect(closed(sessions)).toEqual([0]);
		vi.advanceTimersByTime(1);
		expect(closed(sessions)).toEqual([1]);
	});

	it('clearSessions(engine) closes that engine only; clearSessions() and close() close every one', async () => {
		const {serpcast, sessions} = setup({
			a: withCookie('a'),
			b: withCookie('b'),
		});
		const both = async () => {
			await serpcast.search('q', {engines: [a]});
			await serpcast.search('q', {engines: [b]});
		};
		await both();
		await serpcast.clearSessions('a');
		expect(closed(sessions)).toEqual([1, 0]);
		await both();
		await serpcast.clearSessions();
		expect(closed(sessions)).toEqual([1, 1, 1]);
		await both();
		await serpcast.close();
		expect(closed(sessions)).toEqual([1, 1, 1, 1, 1]);
	});

	it('starts a new session when the store holds other cookies (another instance saved them)', async () => {
		const time = clock();
		const store = createMemoryStore({now: time.now});
		let n = 0;
		const fake = counting({
			a: () => ({
				...(pages.results('A') as {body: string}),
				setCookie: [`n=${n++}`],
			}),
		});
		const options = {store, now: time.now, transport: fake.transport};
		const [one, two] = [createSerpcast(options), createSerpcast(options)];
		await one.search('q', {engines: [a]});
		await two.search('q', {engines: [a]}); // saves n=1
		await one.search('q', {engines: [a]});
		expect(fake.hits('a').map((r) => r.cookie)).toEqual([
			undefined,
			'n=0',
			'n=1',
		]);
		expect(fake.sessions).toHaveLength(3);
		expect(closed(fake.sessions)).toEqual([1, 0, 0]);
	});

	it('gives a concurrent search on the same engine its own session, closed after', async () => {
		// Each request in its own millisecond, so the two sessions stamp the
		// same cookie with different `created` times (as on a slow machine):
		// the engine's kept session is still reused after the concurrent
		// search saved its copy last.
		vi.useFakeTimers({toFake: ['Date']});
		const {serpcast, sessions} = setup({
			a: (request) => {
				vi.advanceTimersByTime(1);
				return withCookie('a')(request);
			},
		});
		await Promise.all([
			serpcast.search('q', {engines: [a]}),
			serpcast.search('q', {engines: [a]}),
		]);
		expect(closed(sessions)).toEqual([0, 1]);
		await serpcast.search('q', {engines: [a]});
		expect(sessions).toHaveLength(2);
		expect(closed(sessions)).toEqual([0, 1]);
	});

	it('starts a new session when a concurrent search saved different cookies last', async () => {
		let n = 0;
		const {serpcast, sessions, hits} = setup({
			a: (request) => ({
				...(pages.results('A') as {body: string}),
				setCookie: request.cookie ? [] : [`sid=${n++}; Path=/`],
			}),
		});
		await Promise.all([
			serpcast.search('q', {engines: [a]}),
			serpcast.search('q', {engines: [a]}),
		]);
		await serpcast.search('q', {engines: [a]});
		expect(hits('a').map((r) => r.cookie)).toEqual([
			undefined,
			undefined,
			'sid=1',
		]);
		expect(sessions).toHaveLength(3);
		expect(closed(sessions)).toEqual([1, 1, 0]);
	});

	it('closes a session dropped while a search runs on it once that search ends', async () => {
		let clear: () => Promise<void> = async () => {};
		const {serpcast, sessions} = setup({
			a: () => {
				void clear();
				return pages.results('A');
			},
		});
		clear = () => serpcast.clearSessions('a');
		await serpcast.search('q', {engines: [a]});
		expect(closed(sessions)).toEqual([2]); // dropped, then closed again after its last request
	});

	it('works with an injected transport whose sessions have no close()', async () => {
		const fake = fakeTransport({a: withCookie('a')});
		const serpcast = createSerpcast({transport: fake.transport});
		await serpcast.search('q', {engines: [a]});
		await serpcast.clearSessions();
		await expect(serpcast.close()).resolves.toBeUndefined();
	});
});
