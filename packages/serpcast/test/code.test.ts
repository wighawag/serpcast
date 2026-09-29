// Code recipes: modules written to a temp directory, loaded by path, run in
// the engine chain over the fake transport (test/engines.ts). No network.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
	createSerpcast,
	DEFAULT_COOLDOWN_MS,
	isCodeRecipe,
	loadCodeRecipe,
	runCodeRecipe,
	SerpcastError,
	type CodeRecipe,
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

const dir = mkdtempSync(join(tmpdir(), 'serpcast-code-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));
let files = 0;
/** Write a module whose body is `source` and return its path. */
function module(source: string): string {
	const path = join(dir, `recipe-${files++}.mjs`);
	writeFileSync(path, source);
	return path;
}

const json = (value: unknown): Answer => ({
	body: JSON.stringify(value),
	headers: {'content-type': 'application/json'},
});

/** A code recipe (built in the test, not loaded) with the given search. */
const code = (
	name: string,
	search: CodeRecipe['search'],
	extra: Partial<CodeRecipe> = {},
): CodeRecipe => ({name, search, ...extra});

function setup(
	answers: Record<string, (request: FakeRequest) => Answer>,
	options: SerpcastOptions & {proxy?: string} = {},
) {
	const time = clock();
	const fake = fakeTransport(answers, {proxy: options.proxy});
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
/** The failure of the one engine of a chain that failed. */
const onlyFailure = async (
	serpcast: ReturnType<typeof setup>['serpcast'],
	e: CodeRecipe,
) => {
	const error = await failure(serpcast.search('q', {engines: [e]}));
	expect(error.kind).toBe('exhausted');
	return error.failures![0]!.error;
};

describe('loadCodeRecipe', () => {
	it('loads a module from a temp directory by path, and it runs in the chain', async () => {
		const path = module(`
			export default {
				name: 'api',
				async search(query, ctx) {
					const data = await ctx.http.json(
						'https://api.test/search?q=' + encodeURIComponent(query),
						{kind: 'document'},
					);
					return data.hits.map((h) => ({title: h.t, url: h.u, snippet: h.s}));
				},
			};
		`);
		const recipe = await loadCodeRecipe(path);
		expect(recipe.name).toBe('api');
		expect(isCodeRecipe(recipe)).toBe(true);
		expect(isCodeRecipe(engine('x'))).toBe(false);
		const {serpcast, requests} = setup({
			a: pages.broken,
			api: () =>
				json({hits: [{t: 'One', u: 'https://one.example/', s: 'first'}]}),
		});
		const response = await serpcast.search('a b', {
			engines: [engine('a'), recipe],
		});
		expect(response.engine).toBe('api');
		expect(response.results).toEqual([
			{title: 'One', url: 'https://one.example/', snippet: 'first'},
		]);
		expect(response.failures.map((f) => f.engine)).toEqual(['a']);
		expect(requests.map((r) => r.url)).toEqual([
			'https://a.test/search?q=a%20b',
			'https://api.test/search?q=a%20b',
		]);
	});

	it('resolves a relative path against the working directory', async () => {
		const path = module(`export default {name: 'rel', search: () => []};`);
		const rel = join('.', relative(process.cwd(), path));
		expect((await loadCodeRecipe(rel)).name).toBe('rel');
	});

	it('keeps `this` for a method that uses the module object', async () => {
		const path = module(`
			export default {
				name: 'self',
				title: 'from this',
				search() { return [{title: this.title, url: 'https://x.example/'}]; },
			};
		`);
		const {serpcast} = setup({});
		const {results} = await serpcast.search('q', {
			engines: [await loadCodeRecipe(path)],
		});
		expect(results[0]!.title).toBe('from this');
	});

	it.each([
		['a missing file', null, /cannot load code recipe/],
		['a syntax error', 'export default {', /cannot load code recipe/],
		['no default export', 'export const x = 1;', /no default export/],
		['no name', 'export default {search() {}};', /"name"/],
		['no search', "export default {name: 'n'};", /"search"/],
		[
			'a bad timeoutMs',
			"export default {name: 'n', search() {}, timeoutMs: -1};",
			/"timeoutMs"/,
		],
	])('rejects %s as a recipe error', async (_, source, message) => {
		const path = source === null ? join(dir, 'absent.mjs') : module(source);
		const error = await failure(loadCodeRecipe(path));
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(message);
	});
});

describe('code recipes: ctx.http goes through the transport', () => {
	it("uses the engine's transport session: proxy, cookies and request kind", async () => {
		let n = 0;
		const recipe = code('api', async (query, ctx) => {
			const page = await ctx.http.get('https://api.test/', {kind: 'document'});
			const data = (await ctx.http.json('https://api.test/q', {
				kind: 'fetch',
				referer: page.url,
			})) as {title: string};
			await ctx.http.text('https://api.test/lib.js', {
				kind: 'script',
				referer: page.url,
			});
			return [{title: data.title, url: `https://r.example/${query}`}];
		});
		const {serpcast, requests} = setup(
			{
				api: (request) =>
					request.url.endsWith('/q')
						? json({title: 'T'})
						: {body: '', setCookie: n++ === 0 ? ['sid=1; Path=/'] : []},
			},
			{proxy: 'socks5h://127.0.0.1:9050'},
		);
		await serpcast.search('q1', {engines: [recipe]});
		await serpcast.search('q2', {engines: [recipe]});
		expect(requests).toEqual([
			...['q1', 'q2'].flatMap((q) => [
				{
					engine: 'api',
					url: 'https://api.test/',
					kind: 'document',
					cookie: q === 'q1' ? undefined : 'sid=1',
					proxy: 'socks5h://127.0.0.1:9050',
				},
				{
					engine: 'api',
					url: 'https://api.test/q',
					kind: 'fetch',
					referer: 'https://api.test/',
					cookie: 'sid=1',
					proxy: 'socks5h://127.0.0.1:9050',
				},
				{
					engine: 'api',
					url: 'https://api.test/lib.js',
					kind: 'script',
					referer: 'https://api.test/',
					cookie: 'sid=1',
					proxy: 'socks5h://127.0.0.1:9050',
				},
			]),
		]);
	});

	it('passes its signal to every request', async () => {
		const signals: (AbortSignal | undefined)[] = [];
		let seen: AbortSignal | undefined;
		const recipe = code('s', async (_, ctx) => {
			seen = ctx.signal;
			await ctx.http.get('https://s.test/', {kind: 'document'});
			return [];
		});
		await runCodeRecipe(recipe, 'q', {
			session: {
				async request(_, options) {
					signals.push(options.signal);
					return {
						url: '',
						status: 200,
						headers: new Headers(),
						body: new Uint8Array(),
						text: () => '',
					};
				},
			},
		});
		expect(signals).toEqual([seen]);
	});

	it.each([
		[202, 'blocked'],
		[403, 'blocked'],
		[429, 'blocked'],
		[404, 'recipe'],
		[410, 'recipe'],
		[302, 'transport'],
		[500, 'transport'],
	])(
		'text/json map HTTP %i to %s, like declarative recipes',
		async (status, kind) => {
			const recipe = code('api', async (_, ctx) => {
				await ctx.http.json('https://api.test/', {kind: 'document'});
				return [];
			});
			const {serpcast} = setup({api: () => ({status, body: '{}'})});
			const error = await onlyFailure(serpcast, recipe);
			expect(error.kind).toBe(kind);
			expect(error.message).toMatch(`HTTP ${status}`);
		},
	);

	it('get returns the raw response whatever its status', async () => {
		const recipe = code('api', async (_, ctx) => {
			const response = await ctx.http.get('https://api.test/', {
				kind: 'document',
			});
			return [
				{
					title: String(response.status),
					url: response.headers.get('location')!,
				},
			];
		});
		const {serpcast} = setup({
			api: () => ({
				status: 302,
				body: '',
				headers: {location: 'https://l.example/'},
			}),
		});
		const {results} = await serpcast.search('q', {engines: [recipe]});
		expect(results).toEqual([{title: '302', url: 'https://l.example/'}]);
	});

	it('invalid JSON is a recipe error', async () => {
		const recipe = code('api', async (_, ctx) => {
			await ctx.http.json('https://api.test/', {kind: 'document'});
			return [];
		});
		const {serpcast} = setup({api: () => ({body: '<html>challenge</html>'})});
		const error = await onlyFailure(serpcast, recipe);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/not JSON/);
	});

	it('a missing or unknown request kind is a recipe error, before any request', async () => {
		const recipe = code('api', async (_, ctx) => {
			await ctx.http.get('https://api.test/', {} as never);
			return [];
		});
		const {serpcast, requests} = setup({api: () => json([])});
		const error = await onlyFailure(serpcast, recipe);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/request kind/);
		expect(requests).toEqual([]);
	});
});

describe('code recipes: ctx.http.post and postJson', () => {
	it('a loaded module posts JSON as a page fetch and reads the JSON answer, with the session cookies', async () => {
		const path = module(`export default {
			name: 'pow',
			async search(query, ctx) {
				const page = await ctx.http.get('https://pow.test/', {kind: 'document'});
				const answer = await ctx.http.postJson(
					'https://pow.test/api/answer',
					{query, nonce: 42},
					{kind: 'fetch', referer: page.url},
				);
				return answer.hits;
			},
		};`);
		const {serpcast, requests} = setup({
			pow: (request) =>
				request.method === 'POST'
					? json({hits: [{title: 'T', url: 'https://r.example/'}]})
					: {body: '', setCookie: ['sid=1; Path=/']},
		});
		const response = await serpcast.search('q', {
			engines: [await loadCodeRecipe(path)],
		});
		expect(response.results).toEqual([{title: 'T', url: 'https://r.example/'}]);
		expect(requests[1]).toEqual({
			engine: 'pow',
			url: 'https://pow.test/api/answer',
			kind: 'fetch',
			referer: 'https://pow.test/',
			cookie: 'sid=1',
			method: 'POST',
			body: '{"query":"q","nonce":42}',
			contentType: 'application/json',
		});
	});

	it('post sends the body and content type as given and returns the raw response; postJson keeps an explicit contentType', async () => {
		const recipe = code('api', async (_, ctx) => {
			const raw = await ctx.http.post('https://api.test/form', {
				kind: 'fetch',
				referer: 'https://api.test/',
				body: 'a=1&b=x',
				contentType: 'application/x-www-form-urlencoded',
			});
			await ctx.http.postJson('https://api.test/json', [1], {
				kind: 'fetch',
				referer: 'https://api.test/',
				contentType: 'application/json;charset=UTF-8',
			});
			return [{title: String(raw.status), url: 'https://r.example/'}];
		});
		const {serpcast, requests} = setup({
			api: (request) =>
				request.url.endsWith('/form') ? {status: 403, body: ''} : json({}),
		});
		const {results} = await serpcast.search('q', {engines: [recipe]});
		expect(results[0]!.title).toBe('403');
		expect(requests.map((r) => [r.method, r.body, r.contentType])).toEqual([
			['POST', 'a=1&b=x', 'application/x-www-form-urlencoded'],
			['POST', '[1]', 'application/json;charset=UTF-8'],
		]);
	});

	it.each([
		[202, 'blocked'],
		[403, 'blocked'],
		[429, 'blocked'],
		[404, 'recipe'],
		[410, 'recipe'],
		[302, 'transport'],
		[500, 'transport'],
	])('postJson maps HTTP %i to %s, like json', async (status, kind) => {
		const recipe = code('api', async (_, ctx) => {
			await ctx.http.postJson(
				'https://api.test/',
				{},
				{
					kind: 'fetch',
					referer: 'https://api.test/',
				},
			);
			return [];
		});
		const {serpcast} = setup({api: () => ({status, body: '{}'})});
		const error = await onlyFailure(serpcast, recipe);
		expect(error.kind).toBe(kind);
		expect(error.message).toMatch(`HTTP ${status}`);
	});

	it('postJson: an answer that is not JSON, or a value that cannot be JSON, is a recipe error', async () => {
		const {serpcast} = setup({api: () => ({body: '<html>challenge</html>'})});
		const options = {kind: 'fetch', referer: 'https://api.test/'} as const;
		const notJson = code('api', async (_, ctx) => {
			await ctx.http.postJson('https://api.test/', {}, options);
			return [];
		});
		expect((await onlyFailure(serpcast, notJson)).message).toMatch(/not JSON/);
		const badValue = code('api', async (_, ctx) => {
			await ctx.http.postJson('https://api.test/', undefined, options);
			return [];
		});
		const error = await onlyFailure(serpcast, badValue);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/not JSON-serializable/);
	});

	it('a POST whose kind is not fetch is a recipe error, before any request; get never POSTs', async () => {
		const notFetch = code('api', async (_, ctx) => {
			await ctx.http.post('https://api.test/', {
				kind: 'document',
				body: 'x',
			} as never);
			return [];
		});
		const {serpcast, requests} = setup({api: () => json([])});
		const error = await onlyFailure(serpcast, notFetch);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/fetch/);
		expect(requests).toEqual([]);

		const sneaky = code('api', async (_, ctx) => {
			await ctx.http.get('https://api.test/', {
				kind: 'fetch',
				referer: 'https://api.test/',
				method: 'POST',
				body: 'x',
			} as never);
			return [];
		});
		await serpcast.search('q', {engines: [sneaky]});
		expect(requests[0]!.method).toBeUndefined();
	});
});

describe('code recipes: ctx.session', () => {
	const counter = code('count', (_, ctx) => {
		const n = ((ctx.session.get('n') as number | undefined) ?? 0) + 1;
		ctx.session.set('n', n);
		return [{title: String(n), url: 'https://c.example/'}];
	});
	const titles = async (serpcast: ReturnType<typeof setup>['serpcast']) =>
		(await serpcast.search('q', {engines: [counter]})).results[0]!.title;

	it('persists across searches until the idle time passes', async () => {
		const {serpcast, time} = setup({}, {sessionIdleMs: 60_000});
		expect(await titles(serpcast)).toBe('1');
		time.advance(59_999);
		expect(await titles(serpcast)).toBe('2');
		time.advance(60_000);
		expect(await titles(serpcast)).toBe('1');
	});

	it('is dropped by clearSessions', async () => {
		const {serpcast} = setup({});
		await titles(serpcast);
		await serpcast.clearSessions('count');
		expect(await titles(serpcast)).toBe('1');
		await titles(serpcast);
		await serpcast.clearSessions();
		expect(await titles(serpcast)).toBe('1');
	});

	it('is kept when the search fails, like the cookies', async () => {
		let fail = true;
		const recipe = code('f', (_, ctx) => {
			if (fail) {
				ctx.session.set('token', {t: 'abc'});
				ctx.recipeError('first attempt fails');
			}
			return [
				{
					title: JSON.stringify(ctx.session.get('token')),
					url: 'https://f.example/',
				},
			];
		});
		const {serpcast} = setup({});
		await failure(serpcast.search('q', {engines: [recipe]}));
		fail = false;
		const {results} = await serpcast.search('q', {engines: [recipe]});
		expect(results[0]!.title).toBe('{"t":"abc"}');
	});

	it('get, set and delete copy plain JSON; anything else is a recipe error', async () => {
		const state: {[key: string]: import('../src/index.js').JsonValue} = {};
		const recipe = code('j', (_, ctx) => {
			const value = {list: [1]};
			ctx.session.set('v', value);
			value.list.push(2);
			(ctx.session.get('v') as {list: number[]}).list.push(3);
			ctx.session.set('gone', 1);
			ctx.session.delete('gone');
			ctx.session.set('d', new Date() as never);
			return [];
		});
		const error = await failure(
			runCodeRecipe(recipe, 'q', {
				session: {request: () => expect.fail()},
				state,
			}),
		);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/not plain JSON/);
		expect(state).toEqual({v: {list: [1]}});
	});

	it("does not touch a declarative engine's session", async () => {
		const {serpcast} = setup({a: () => pages.results('A')});
		await expect(
			serpcast.search('q', {engines: [engine('a')]}),
		).resolves.toMatchObject({engine: 'a'});
	});
});

describe('code recipes: ctx.cookies (document.cookie)', () => {
	it('a cookie it sets is sent by the next matching request only, as a page script would set it', async () => {
		const recipe = code('c', async (_, ctx) => {
			const page = 'https://c.test/app/page';
			expect(ctx.cookies.set(page, 'tok#1=abc; Path=/; SameSite=Lax')).toBe(
				true,
			);
			expect(ctx.cookies.set(page, 'dir=1')).toBe(true); // default path /app
			expect(ctx.cookies.set(page, 'sec=1; Path=/; Secure')).toBe(true);
			expect(
				ctx.cookies.set(page, 'dom=1; Path=/; Domain=c.test; HttpOnly'),
			).toBe(true);
			// Rejected as document.cookie would: another site's Domain, Secure from http.
			expect(ctx.cookies.set(page, 'x=1; Domain=other.test')).toBe(false);
			expect(ctx.cookies.set('http://c.test/', 'y=1; Secure')).toBe(false);
			for (const url of [
				'https://c.test/app/q',
				'https://c.test/other',
				'http://c.test/app/q',
				'https://api.c.test/',
				'https://other.test/',
			])
				await ctx.http.get(url, {kind: 'document'});
			return [];
		});
		const {serpcast, requests} = setup({});
		await serpcast.search('q', {engines: [recipe]});
		expect(requests.map((r) => [r.url, r.cookie])).toEqual([
			['https://c.test/app/q', 'dir=1; tok#1=abc; sec=1; dom=1'],
			['https://c.test/other', 'tok#1=abc; sec=1; dom=1'],
			['http://c.test/app/q', 'dir=1; tok#1=abc; dom=1'],
			['https://api.c.test/', 'dom=1'],
			['https://other.test/', undefined],
		]);
	});

	it('HttpOnly in the string is ignored: the cookie stays visible to get', async () => {
		const recipe = code('h', (_, ctx) => {
			ctx.cookies.set('https://h.test/', 'a=1; Path=/; HttpOnly');
			return [
				{title: ctx.cookies.get('https://h.test/'), url: 'https://r.example/'},
			];
		});
		const {serpcast} = setup({});
		const {results} = await serpcast.search('q', {engines: [recipe]});
		expect(results[0]!.title).toBe('a=1');
	});

	it('get shows the non-HttpOnly cookies sent to a URL, delete removes one by name', async () => {
		const recipe = code('g', async (_, ctx) => {
			await ctx.http.get('https://g.test/', {kind: 'document'});
			ctx.cookies.set('https://g.test/', 'b=2; Path=/');
			const before = ctx.cookies.get('https://g.test/');
			ctx.cookies.delete('https://g.test/', 'b');
			ctx.cookies.delete('https://g.test/', 'server'); // HttpOnly: untouched
			const after = ctx.cookies.get('https://g.test/');
			await ctx.http.get('https://g.test/next', {kind: 'document'});
			return [{title: `${before}|${after}`, url: 'https://r.example/'}];
		});
		const {serpcast, requests} = setup({
			g: () => ({
				body: '',
				setCookie: ['server=s; Path=/; HttpOnly', 'seen=1; Path=/'],
			}),
		});
		const {results} = await serpcast.search('q', {engines: [recipe]});
		expect(results[0]!.title).toBe('seen=1; b=2|seen=1');
		expect(requests[1]!.cookie).toBe('server=s; seen=1');
	});

	it('persists across searches with the session, and is dropped with it (idle expiry, clearSessions)', async () => {
		let set = true;
		const recipe = code('p', async (_, ctx) => {
			if (set) ctx.cookies.set('https://p.test/', 'k#1=v; Path=/');
			set = false;
			await ctx.http.get('https://p.test/', {kind: 'document'});
			return [];
		});
		const {serpcast, requests, time} = setup({}, {sessionIdleMs: 60_000});
		const cookie = async () => {
			await serpcast.search('q', {engines: [recipe]});
			return requests.at(-1)!.cookie;
		};
		expect(await cookie()).toBe('k#1=v');
		time.advance(59_999);
		expect(await cookie()).toBe('k#1=v');
		time.advance(60_000);
		expect(await cookie()).toBeUndefined();
		set = true;
		expect(await cookie()).toBe('k#1=v');
		await serpcast.clearSessions('p');
		expect(await cookie()).toBeUndefined();
		set = true;
		expect(await cookie()).toBe('k#1=v');
		await serpcast.clearSessions();
		expect(await cookie()).toBeUndefined();
	});

	it('saves the cookie in the state store with the session', async () => {
		const store = (await import('../src/index.js')).createMemoryStore();
		const recipe = code('s', (_, ctx) => {
			ctx.cookies.set('https://s.test/', 'a#b=1; Path=/');
			return [];
		});
		const {serpcast} = setup({}, {store});
		await serpcast.search('q', {engines: [recipe]});
		const saved = (await store.get('engine/s/session')) as {
			cookies: {name: string; value: string}[];
		};
		expect(saved.cookies).toMatchObject([{name: 'a#b', value: '1'}]);
	});

	it('a non-http(s) URL is a recipe error', async () => {
		const {serpcast} = setup({});
		const error = await onlyFailure(
			serpcast,
			code('u', (_, ctx) => {
				ctx.cookies.set('javascript:x', 'a=1');
				return [];
			}),
		);
		expect(error.kind).toBe('recipe');
		expect(error.message).toBe('u: not an http(s) URL: javascript:x');
	});

	it('a session without documentCookies (an older injected transport) makes ctx.cookies a recipe error', async () => {
		const recipe = code('o', (_, ctx) => {
			ctx.cookies.get('https://o.test/');
			return [];
		});
		const error = await failure(
			runCodeRecipe(recipe, 'q', {session: {request: () => expect.fail()}}),
		);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(
			/ctx.cookies needs a transport session with documentCookies/,
		);
	});
});

describe('code recipes: output and errors', () => {
	it.each([
		['not an array', {results: []}, /not an array/],
		['a non-object entry', ['x'], /result 0 is not an object/],
		['a missing title', [{url: 'https://u.example/'}], /result 0 has no title/],
		['a missing url', [{title: 'T'}], /result 0 has no url/],
		['an empty url', [{title: 'T', url: ''}], /result 0 has no url/],
		[
			'a non-string field',
			[{title: 'T', url: 'https://u.example/', rank: 1}],
			/"rank" is not a string/,
		],
	])('%s is a recipe error', async (_, output, message) => {
		const {serpcast} = setup({});
		const error = await onlyFailure(
			serpcast,
			code('m', () => output as never),
		);
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(message);
	});

	it('passes well-formed results through (extra string fields kept, undefined dropped)', async () => {
		const {serpcast} = setup({});
		const {results} = await serpcast.search('q', {
			engines: [
				code('ok', () => [
					{
						title: 'T',
						url: 'https://u.example/',
						snippet: undefined,
						lang: 'en',
					},
				]),
			],
		});
		expect(results).toEqual([
			{title: 'T', url: 'https://u.example/', lang: 'en'},
		]);
	});

	it('[] is an answer: the module says there are no results', async () => {
		const {serpcast, hits} = setup({b: () => pages.results('B')});
		const response = await serpcast.search('q', {
			engines: [code('none', () => []), engine('b')],
		});
		expect(response).toEqual({results: [], engine: 'none', failures: []});
		expect(hits('b')).toHaveLength(0);
	});

	it('receives maxResults, and the answer is cut to it anyway', async () => {
		let seen: number | undefined;
		const {serpcast} = setup({});
		const many = code('many', (_, ctx) => {
			seen = ctx.maxResults;
			return ['1', '2', '3'].map((t) => ({
				title: t,
				url: `https://u.example/${t}`,
			}));
		});
		const {results} = await serpcast.search('q', {
			engines: [many],
			maxResults: 2,
		});
		expect(seen).toBe(2);
		expect(results.map((r) => r.title)).toEqual(['1', '2']);
	});

	it('a thrown blocked() starts the cooldown', async () => {
		let calls = 0;
		const wall = code('wall', (_, ctx) => {
			calls++;
			return ctx.blocked('captcha');
		});
		const {serpcast, time} = setup({b: () => pages.results('B')});
		const first = await serpcast.search('q', {engines: [wall, engine('b')]});
		expect(first.failures[0]!.error).toMatchObject({
			kind: 'blocked',
			message: 'wall: blocked (captcha)',
		});
		time.advance(DEFAULT_COOLDOWN_MS - 1);
		const second = await serpcast.search('q', {engines: [wall, engine('b')]});
		expect(second.failures[0]!.error.message).toMatch(/cooling down/);
		expect(calls).toBe(1);
		time.advance(1);
		await serpcast.search('q', {engines: [wall, engine('b')]});
		expect(calls).toBe(2);
	});

	it('recipeError() is a recipe error and starts no cooldown', async () => {
		const {serpcast} = setup({});
		const error = await onlyFailure(
			serpcast,
			code('r', (_, ctx) => ctx.recipeError('layout changed')),
		);
		expect(error).toMatchObject({kind: 'recipe', message: 'r: layout changed'});
	});

	it('any other throw is a recipe error carrying the cause', async () => {
		const bug = new TypeError('x is undefined');
		const {serpcast, hits} = setup({b: () => pages.results('B')});
		const response = await serpcast.search('q', {
			engines: [
				code('t', () => {
					throw bug;
				}),
				engine('b'),
			],
		});
		expect(response.engine).toBe('b');
		const error = response.failures[0]!.error;
		expect(error.kind).toBe('recipe');
		expect(error.cause).toBe(bug);
		expect(hits('b')).toHaveLength(1);
	});

	it('an impersonation error from ctx.http aborts the whole search', async () => {
		const {serpcast, hits} = setup({
			api: () => ({throw: new SerpcastError('impersonation', 'no library')}),
			b: () => pages.results('B'),
		});
		const recipe = code('api', async (_, ctx) => {
			await ctx.http.get('https://api.test/', {kind: 'document'});
			return [];
		});
		const error = await failure(
			serpcast.search('q', {engines: [recipe, engine('b')]}),
		);
		expect(error.kind).toBe('impersonation');
		expect(hits('b')).toHaveLength(0);
	});

	it('times out after its timeoutMs, aborting ctx.signal, with no unhandled rejection', async () => {
		let signal: AbortSignal | undefined;
		const slow = code(
			'slow',
			(_, ctx) => {
				signal = ctx.signal;
				// Rejects only after the abort: must not surface as unhandled.
				return new Promise((_, reject) =>
					ctx.signal.addEventListener('abort', () =>
						setTimeout(() => reject(new Error('late')), 1),
					),
				);
			},
			{timeoutMs: 20},
		);
		const {serpcast} = setup({});
		const error = await onlyFailure(serpcast, slow);
		expect(error).toMatchObject({
			kind: 'timeout',
			message: 'slow: timed out after 20 ms',
		});
		expect(signal!.aborted).toBe(true);
		await new Promise((r) => setTimeout(r, 10));
	});

	it("rejects with the caller's reason when aborted, calling no later engine", async () => {
		const controller = new AbortController();
		const reason = new Error('stop');
		const {serpcast, hits} = setup({b: () => pages.results('B')});
		const waits = code('waits', (_, ctx) => {
			controller.abort(reason);
			return new Promise((_, reject) =>
				ctx.signal.addEventListener('abort', () => reject(new Error('inner'))),
			);
		});
		await expect(
			serpcast.search('q', {
				engines: [waits, engine('b')],
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(hits('b')).toHaveLength(0);
	});
});
