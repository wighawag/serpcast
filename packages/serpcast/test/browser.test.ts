// Browser engines: endpoint mode against fake `searchcast serve` servers (TCP
// and Unix socket), library mode with an injected fake searchcast module, the
// temporary profile (also on process exit, in a child process) and the proxy
// translation. No browser, no network.

import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseRecipe, type Recipe} from 'serpcast-recipe';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {
	chromiumProxy,
	createSerpcast,
	isBrowserEngine,
	SerpcastError,
	type BrowserEngine,
	type SearchcastModule,
	type SerpcastOptions,
} from '../src/index.js';
import {engine, fakeTransport, pages} from './engines.js';

const dir = mkdtempSync(join(tmpdir(), 'serpcast-browser-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));

/** What the fake server answers for one `recipe` query parameter. */
type Reply = {status: number; body: string};
const json = (status: number, value: unknown): Reply => ({
	status,
	body: JSON.stringify(value),
});
const failure = (status: number, error: string): Reply =>
	json(status, {error, message: `${error} happened`});

// searchcast's HTTP API (its src/server.ts): recipe name to reply.
const replies: Record<string, Reply> = {
	web: json(200, {
		recipe: 'web',
		query: 'q',
		results: [
			{title: 'A', url: 'https://a.test/', content: 'about A'},
			{title: 'B', url: 'https://b.test/', extra: 'x'},
		],
		elapsedMs: 5,
	}),
	none: json(200, {recipe: 'none', query: 'q', results: [], elapsedMs: 1}),
	blocked: failure(502, 'blocked'),
	recipe: failure(502, 'recipe'),
	timeout: failure(504, 'timeout'),
	browser: failure(503, 'browser'),
	internal: failure(500, 'internal'),
	method: failure(405, 'method'),
	'not-found': failure(404, 'not-found'),
	input: failure(400, 'input'),
	'unknown-recipe': failure(404, 'unknown-recipe'),
	'not-json': {status: 502, body: '<html>Bad gateway</html>'},
	'no-results': json(200, {recipe: 'x'}),
};

const requests: string[] = [];
function fakeSearchcast(): Server {
	return createServer((req, res) => {
		requests.push(req.url ?? '');
		const url = new URL(req.url ?? '/', 'http://localhost');
		const name = url.searchParams.get('recipe') ?? '';
		if (name === 'slow') return; // never answers
		const reply =
			url.pathname === '/search'
				? (replies[name] ?? failure(404, 'unknown-recipe'))
				: failure(404, 'not-found');
		res.writeHead(reply.status, {'content-type': 'application/json'});
		res.end(reply.body);
	});
}

const tcp = fakeSearchcast();
const unix = fakeSearchcast();
const socketPath = join(dir, 'searchcast.sock');
let base = '';
beforeAll(async () => {
	await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(tcp.address() as {port: number}).port}`;
	await new Promise<void>((r) => unix.listen(socketPath, r));
});
afterAll(() => {
	tcp.closeAllConnections();
	unix.closeAllConnections();
	tcp.close();
	unix.close();
});

const at = (
	endpoint: string,
	name: string,
	extra: {recipe?: string; timeoutMs?: number} = {},
): BrowserEngine => ({name, searchcast: {endpoint, ...extra}});

/** Every instance is closed after its test, so no temporary profile is left. */
const open: Array<{close(): Promise<void>}> = [];
afterEach(async () => {
	for (const instance of open.splice(0)) await instance.close();
});
function serpcast(options: SerpcastOptions = {}) {
	const instance = createSerpcast({
		transport: fakeTransport({}).transport,
		...options,
	});
	open.push(instance);
	return instance;
}

/** The error one engine fails with, alone in a chain. */
async function failureOf(target: BrowserEngine, options?: SerpcastOptions) {
	const error = await serpcast(options)
		.search('q', {engines: [target]})
		.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(SerpcastError);
	const [first] = (error as SerpcastError).failures!;
	return first!.error;
}

const errorTable: Array<[string, string]> = [
	['blocked', 'blocked'],
	['recipe', 'recipe'],
	['timeout', 'timeout'],
	['browser', 'transport'],
	['internal', 'transport'],
	['method', 'transport'],
	['not-found', 'transport'],
	['input', 'recipe'],
	['unknown-recipe', 'recipe'],
	['not-json', 'transport'],
	['no-results', 'transport'],
];

for (const [where, endpoint] of [
	['HTTP', () => base],
	['a Unix socket', () => socketPath],
] as const) {
	describe(`endpoint mode over ${where}`, () => {
		it('maps the results (snippet from content, extra fields kept)', async () => {
			requests.length = 0;
			const answer = await serpcast().search('some query', {
				engines: [at(endpoint(), 'web')],
			});
			expect(answer).toEqual({
				engine: 'web',
				failures: [],
				results: [
					{
						title: 'A',
						url: 'https://a.test/',
						content: 'about A',
						snippet: 'about A',
					},
					{title: 'B', url: 'https://b.test/', extra: 'x'},
				],
			});
			expect(requests).toEqual(['/search?recipe=web&q=some+query']);
		});

		it('asks for the recipe by the given name, else the engine name', async () => {
			requests.length = 0;
			const answer = await serpcast().search('q', {
				engines: [at(endpoint(), 'my-browser', {recipe: 'none'})],
			});
			expect(answer.results).toEqual([]);
			expect(answer.engine).toBe('my-browser');
			expect(requests).toEqual(['/search?recipe=none&q=q']);
		});

		for (const [code, kind] of errorTable) {
			it(`maps "${code}" (HTTP ${replies[code]!.status}) to ${kind}`, async () => {
				const error = await failureOf(at(endpoint(), code));
				expect(error.kind).toBe(kind);
			});
		}
	});
}

describe('endpoint mode', () => {
	it('tells blocked from recipe although both are HTTP 502, and only blocked cools down', async () => {
		const s = serpcast();
		const chain = {
			engines: [at(base, 'blocked'), at(base, 'recipe'), at(base, 'web')],
		};
		const first = await s.search('q', chain);
		expect(first.failures.map((f) => [f.engine, f.error.kind])).toEqual([
			['blocked', 'blocked'],
			['recipe', 'recipe'],
		]);
		requests.length = 0;
		await s.search('q', chain);
		expect(
			requests.map((r) => new URL(r, base).searchParams.get('recipe')),
		).toEqual(['recipe', 'web']);
	});

	it('is the fallback after blocked HTTP engines', async () => {
		const {transport} = fakeTransport({a: pages.blocked});
		const answer = await createSerpcast({transport}).search('q', {
			engines: [engine('a'), at(base, 'web')],
		});
		expect(answer.engine).toBe('web');
		expect(answer.failures.map((f) => f.error.kind)).toEqual(['blocked']);
	});

	it('times out after timeoutMs', async () => {
		const error = await failureOf(at(base, 'slow', {timeoutMs: 100}));
		expect(error.kind).toBe('timeout');
	});

	it('rejects with the signal reason on abort', async () => {
		const controller = new AbortController();
		const search = serpcast().search('q', {
			engines: [at(base, 'slow')],
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error('stop')), 20);
		await expect(search).rejects.toThrow('stop');
	});

	it('is transport when nothing listens', async () => {
		const error = await failureOf(at(join(dir, 'nobody.sock'), 'web'));
		expect(error.kind).toBe('transport');
	});
});

describe('chromiumProxy', () => {
	it('passes socks5h:// as socks5://, which Chromium resolves at the proxy', () => {
		expect(chromiumProxy('socks5h://127.0.0.1:9050')).toBe(
			'socks5://127.0.0.1:9050',
		);
		expect(chromiumProxy('SOCKS5H://proxy.test:1080')).toBe(
			'socks5://proxy.test:1080',
		);
	});
	it('leaves other schemes alone', () => {
		for (const proxy of ['socks5://127.0.0.1:1080', 'http://proxy.test:8080'])
			expect(chromiumProxy(proxy)).toBe(proxy);
	});
});

const recipe: Recipe = parseRecipe({
	name: 'web',
	navigate: {url: 'https://search.test/?q={query}'},
	ready: '.r',
	results: {
		item: '.r',
		fields: {title: {}, url: {selector: 'a', attr: 'href'}},
	},
});
const inBrowser = (name = 'web'): BrowserEngine => ({
	name,
	searchcast: {recipe},
});

/** A fake searchcast module recording what serpcast does with it. */
function fakeModule(
	answer: (query: string) => unknown = () => ({
		results: [{title: 'T', url: 'https://t.test/'}],
	}),
) {
	const log = {
		created: [] as Array<
			ConstructorParameters<SearchcastModule['Searchcast']>[0]
		>,
		searches: [] as string[],
		closed: 0,
		xvfb: [] as string[],
		profiles: [] as Array<{path: string; mode: number}>,
	};
	const module: SearchcastModule = {
		Searchcast: class {
			constructor(
				options: ConstructorParameters<SearchcastModule['Searchcast']>[0],
			) {
				log.created.push(options);
				const path = options.browser.userDataDir;
				log.profiles.push({
					path,
					mode: existsSync(path) ? statSync(path).mode & 0o777 : -1,
				});
			}
			async search(_: Recipe, query: string) {
				log.searches.push(query);
				const out = answer(query);
				if (out instanceof Error) throw out;
				return out as {results: unknown};
			}
			async close() {
				log.closed++;
			}
		},
		findChrome: () => '/usr/bin/found-chrome',
		async startXvfb({executable}) {
			log.xvfb.push(`start ${executable}`);
			return {
				env: {DISPLAY: ':99', XAUTHORITY: '/tmp/x'},
				close: async () => void log.xvfb.push('stop'),
			};
		},
	};
	return {module, log};
}

describe('library mode', () => {
	it('starts searchcast lazily, once, with serpcast proxy (translated) and the caller options', async () => {
		const {module, log} = fakeModule();
		const {transport} = fakeTransport({a: () => pages.results('A')});
		const s = serpcast({
			transport,
			proxy: 'socks5h://127.0.0.1:9050',
			searchcast: {
				module,
				chrome: '/opt/chrome',
				headless: true,
				profile: join(dir, 'p'),
				chromeArgs: ['--x'],
				concurrency: 3,
			},
		});
		await s.search('q', {engines: [engine('a'), inBrowser()]});
		expect(log.created).toEqual([]); // an HTTP engine answered: no browser
		const answer = await s.search('one', {engines: [inBrowser()]});
		await s.search('two', {engines: [inBrowser()]});
		expect(answer).toEqual({
			engine: 'web',
			failures: [],
			results: [{title: 'T', url: 'https://t.test/'}],
		});
		expect(log.searches).toEqual(['one', 'two']);
		expect(log.created).toEqual([
			{
				browser: {
					executable: '/opt/chrome',
					userDataDir: join(dir, 'p'),
					proxy: 'socks5://127.0.0.1:9050',
					headless: true,
					extraArgs: ['--x'],
				},
				concurrency: 3,
			},
		]);
		await s.close();
		expect(log.closed).toBe(1);
		expect(existsSync(join(dir, 'p'))).toBe(false); // never created by serpcast
	});

	it('passes no proxy when serpcast has none, finds Chrome with searchcast, and runs Xvfb', async () => {
		const {module, log} = fakeModule();
		const s = serpcast({searchcast: {module, xvfb: '/usr/bin/Xvfb'}});
		await s.search('q', {engines: [inBrowser()]});
		const {browser} = log.created[0]!;
		expect(browser.proxy).toBeUndefined();
		expect(browser.executable).toBe('/usr/bin/found-chrome');
		expect(browser.env).toEqual({DISPLAY: ':99', XAUTHORITY: '/tmp/x'});
		await s.close();
		expect(log.xvfb).toEqual(['start /usr/bin/Xvfb', 'stop']);
	});

	it('creates a temporary 0700 profile and deletes it on close()', async () => {
		const {module, log} = fakeModule();
		const s = serpcast({searchcast: {module}});
		await s.search('q', {engines: [inBrowser()]});
		const [profile] = log.profiles;
		expect(profile!.mode).toBe(0o700);
		expect(existsSync(profile!.path)).toBe(true);
		await s.close();
		expect(existsSync(profile!.path)).toBe(false);
		expect(log.closed).toBe(1);
	});

	for (const [code, kind] of [
		['blocked', 'blocked'],
		['recipe', 'recipe'],
		['timeout', 'timeout'],
		['browser', 'transport'],
		[undefined, 'transport'],
	] as const) {
		it(`maps a thrown ${code ?? 'plain'} error to ${kind}`, async () => {
			const error = Object.assign(new Error('boom'), code && {code});
			const {module} = fakeModule(() => error);
			expect((await failureOf(inBrowser(), {searchcast: {module}})).kind).toBe(
				kind,
			);
		});
	}

	it('is transport when searchcast answers something else', async () => {
		const {module} = fakeModule(() => ({results: 'nope'}));
		expect((await failureOf(inBrowser(), {searchcast: {module}})).kind).toBe(
			'transport',
		);
	});

	it('rejects with the signal reason on abort', async () => {
		const {module} = fakeModule(() => new Promise(() => {}));
		const controller = new AbortController();
		const search = serpcast({searchcast: {module}}).search('q', {
			engines: [inBrowser()],
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error('stop')), 20);
		await expect(search).rejects.toThrow('stop');
	});

	it('uses the installed searchcast when none is injected (it has the shape serpcast uses)', async () => {
		// pnpm installs the optional peer in this workspace; a consumer that
		// does not install it gets browser-missing.test.ts's error instead.
		const real = (await import('searchcast' as string)) as SearchcastModule;
		expect(typeof real.Searchcast).toBe('function');
		expect(typeof real.findChrome).toBe('function');
		expect(typeof real.startXvfb).toBe('function');
		expect(typeof real.Searchcast.prototype.search).toBe('function');
		expect(typeof real.Searchcast.prototype.close).toBe('function');
		// No browser is launched: with a chrome that does not exist, the
		// search fails as searchcast's `browser` error, mapped to transport.
		const error = await failureOf(inBrowser(), {
			searchcast: {
				chrome: join(dir, 'no-such-chrome'),
				profile: join(dir, 'real-profile'),
			},
		});
		expect(error.kind).toBe('transport');
		expect(error.message).toContain('searchcast browser');
	});
});

describe('isBrowserEngine', () => {
	it('tells browser engines from recipes', () => {
		expect(isBrowserEngine(inBrowser())).toBe(true);
		expect(isBrowserEngine(at(base, 'web'))).toBe(true);
		expect(isBrowserEngine(engine('a'))).toBe(false);
	});
});

describe('the searchcast import', () => {
	it('is in browser.ts only, and dynamic', () => {
		const src = fileURLToPath(new URL('../src/', import.meta.url));
		const importing = readdirSync(src).filter((file) =>
			/from ['"]searchcast['"]|import\(['"]?searchcast|const name = 'searchcast'/.test(
				readFileSync(join(src, file), 'utf8'),
			),
		);
		expect(importing).toEqual(['browser.ts']);
		expect(readFileSync(join(src, 'browser.ts'), 'utf8')).not.toMatch(
			/from ['"]searchcast['"]/,
		);
	});
});

describe('the temporary profile on process exit', () => {
	it('is deleted when the process exits without close()', () => {
		const dist = new URL('../dist/index.js', import.meta.url).href;
		const script = `
			import {existsSync} from 'node:fs';
			const {createSerpcast} = await import(${JSON.stringify(dist)});
			let profile;
			const module = {
				Searchcast: class {
					constructor(o) { profile = o.browser.userDataDir; }
					async search() { return {results: []}; }
					async close() {}
				},
				findChrome: () => '/bin/chrome',
			};
			const s = createSerpcast({searchcast: {module}});
			await s.search('q', {engines: [{name: 'b', searchcast: {recipe: {name: 'b'}}}]});
			console.log(JSON.stringify({profile, existed: existsSync(profile)}));
			process.exit(0);
		`;
		const out = execFileSync(
			process.execPath,
			['--input-type=module', '-e', script],
			{
				encoding: 'utf8',
			},
		);
		const {profile, existed} = JSON.parse(out) as {
			profile: string;
			existed: boolean;
		};
		expect(existed).toBe(true);
		expect(profile).toContain('serpcast-profile-');
		expect(existsSync(profile)).toBe(false);
	});
});
