// The declarative runner against a local HTTP server serving HTML fixtures,
// through a fake transport session (Node's HTTP client), so these tests need
// no native library. declarative-native.test.ts runs through the real one.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {parseRecipe} from 'serpcast-recipe';
import {runDeclarativeRecipe, SerpcastError} from '../src/index.js';
import {
	fakeSession,
	item,
	recipe,
	resultsPage,
	startPageServer,
	type PageServer,
} from './pages.js';

let server: PageServer;
const at = (path: string, overrides: object = {}) =>
	recipe(server.origin, {
		navigate: {url: `${server.origin}${path}?q={query}`},
		...overrides,
	});
const run = (r = at('/results'), query = 'q', signal?: AbortSignal) =>
	runDeclarativeRecipe(r, query, {session: fakeSession(), signal});
const failure = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => expect.fail('expected a failure'),
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(SerpcastError);
	return error as SerpcastError;
};

beforeAll(async () => {
	server = await startPageServer({
		'/results': {
			body: resultsPage(
				item('First', '/one', 'The first  result'),
				item('Second', 'https://other.example/two'),
				'<div class="result"><p class="snippet">no link</p></div>',
				'<div class="result"><a class="title" href="/no-title"></a></div>',
				item('Third', 'three?x=1', 'third'),
			),
		},
		'/dir/page': {
			body: resultsPage(item('Relative', '../up'), item('Abs', '/abs')),
		},
		'/redirect': {status: 302, headers: {location: '/dir/page'}},
		'/base': {
			body: `<head><base href="https://base.example/sub/"></head>${resultsPage(item('B', 'x'))}`,
		},
		'/empty': {
			body: '<div id="main"><p class="no-results">Nothing found</p></div>',
		},
		'/captcha': {
			body: `<div id="captcha"></div>${resultsPage(item('A', '/a'))}`,
		},
		'/to-challenge': {status: 301, headers: {location: '/challenge/x'}},
		'/challenge/x': {body: resultsPage(item('A', '/a'))},
		'/s202': {status: 202, body: resultsPage(item('A', '/a'))},
		'/s403': {status: 403, body: resultsPage(item('A', '/a'))},
		'/s429': {status: 429, body: ''},
		'/nothing': {body: '<p>Something else entirely</p>'},
		'/unusable': {
			body: resultsPage(
				'<div class="result"><a class="title">no href</a></div>',
			),
		},
		'/both': {
			body: `<p class="no-results">x</p>${resultsPage(item('Kept', '/k'))}`,
		},
		'/s404': {status: 404, body: '<p>not found</p>'},
		'/s410': {status: 410, body: ''},
		'/s503': {status: 503, body: '<p>down</p>'},
		'/s503-captcha': {status: 503, body: '<div id="captcha"></div>'},
		'/slow': {hang: true},
		'/loop': {status: 302, headers: {location: '/loop'}},
		'/text': {
			body: resultsPage(
				`<div class="result"><a class="title" href="/t"><div>Two</div><div>blocks</div><script>var x=1</script><style>a{}</style><span hidden>secret</span>&amp; more<br>line</a><p class="snippet">s</p></div>`,
			),
		},
		'/extra': {
			body: resultsPage(
				`<div class="result" data-id="7"><a class="title" href="/e">E</a><img src="/i.png"><span class="desc">D</span></div>`,
			),
		},
	});
});

afterAll(() => server.close());

describe('runDeclarativeRecipe: results', () => {
	it('parses results, resolves relative URLs, skips items without title/url', async () => {
		const response = await run();
		expect(response).toEqual({
			recipe: 'test',
			results: [
				{
					title: 'First',
					url: `${server.origin}/one`,
					content: 'The first result',
					snippet: 'The first result',
				},
				{title: 'Second', url: 'https://other.example/two'},
				{
					title: 'Third',
					url: `${server.origin}/three?x=1`,
					content: 'third',
					snippet: 'third',
				},
			],
		});
	});

	it('honours limit', async () => {
		const {results} = await run(at('/results', {limit: 2}));
		expect(results.map((r) => r.title)).toEqual(['First', 'Second']);
	});

	it('follows redirects and resolves URLs against the final URL', async () => {
		const {results} = await run(at('/redirect'));
		expect(results.map((r) => r.url)).toEqual([
			`${server.origin}/up`,
			`${server.origin}/abs`,
		]);
	});

	it('resolves against <base href> like the DOM does', async () => {
		const {results} = await run(at('/base'));
		expect(results[0]!.url).toBe('https://base.example/sub/x');
	});

	it('reads visible text: no script/style/hidden, blocks separate words', async () => {
		const {results} = await run(at('/text'));
		expect(results[0]!.title).toBe('Two blocks & more line');
	});

	it('passes extra fields through; snippet from content, snippet, then description', async () => {
		const fields = {
			title: {selector: 'a'},
			url: {selector: 'a', attr: 'href'},
			id: {attr: 'data-id'},
			image: {selector: 'img', attr: 'src'},
			description: {selector: '.desc'},
			missing: {selector: '.nope'},
		};
		const {results} = await run(
			at('/extra', {results: {item: '.result', fields}}),
		);
		expect(results).toEqual([
			{
				title: 'E',
				url: `${server.origin}/e`,
				id: '7',
				image: `${server.origin}/i.png`,
				description: 'D',
				snippet: 'D',
			},
		]);
	});

	it('URL-encodes the query into every {query}', async () => {
		const session = fakeSession();
		await runDeclarativeRecipe(
			at('/results', {
				navigate: {url: `${server.origin}/results?q={query}&again={query}`},
			}),
			'a b&c/é',
			{session},
		);
		const q = encodeURIComponent('a b&c/é');
		expect(session.requests).toEqual([
			{
				url: `${server.origin}/results?q=${q}&again=${q}`,
				options: expect.objectContaining({kind: 'document'}),
			},
		]);
		expect(session.requests[0]!.options.referer).toBeUndefined();
	});

	it('returns [] only when the empty selector matched', async () => {
		expect(await run(at('/empty'))).toEqual({recipe: 'test', results: []});
	});

	it('checks ready before empty, as searchcast does', async () => {
		const {results} = await run(at('/both'));
		expect(results.map((r) => r.title)).toEqual(['Kept']);
	});
});

describe('runDeclarativeRecipe: failures', () => {
	it.each([
		['/captcha', /found #captcha/],
		['/to-challenge', /url matched \/challenge/],
		['/s202', /HTTP 202/],
		['/s403', /HTTP 403/],
		['/s429', /HTTP 429/],
		['/s503-captcha', /found #captcha/],
	])('%s is blocked', async (path, message) => {
		const error = await failure(run(at(path)));
		expect(error.kind).toBe('blocked');
		expect(error.message).toMatch(message);
	});

	it('a page matching nothing is a recipe error, not an empty list', async () => {
		const error = await failure(run(at('/nothing')));
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/matches none of ready/);
	});

	it('ready with no usable item is a recipe error, not an empty list', async () => {
		const error = await failure(run(at('/unusable')));
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/no result had both a title and a url/);
	});

	it.each([
		['/s404', 'recipe', /HTTP 404/],
		['/s410', 'recipe', /HTTP 410/],
		['/s503', 'transport', /HTTP 503/],
	])('%s is a %s error with the status', async (path, kind, message) => {
		const error = await failure(run(at(path)));
		expect(error.kind).toBe(kind);
		expect(error.message).toMatch(message);
	});

	it('a slow page is a timeout', async () => {
		const started = Date.now();
		const error = await failure(run(at('/slow', {timeoutMs: 200})));
		expect(error.kind).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('a redirect loop is a transport error', async () => {
		const error = await failure(run(at('/loop')));
		expect(error.kind).toBe('transport');
		expect(error.message).toMatch(/more than 20 redirects/);
	});

	it('an invalid selector is a recipe error', async () => {
		const error = await failure(run(at('/results', {ready: 'div['})));
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/invalid selector div\[/);
	});

	it('rejects a form recipe before any request', async () => {
		const session = fakeSession();
		const form = parseRecipe({
			name: 'formy',
			form: {url: `${server.origin}/results`, input: 'input[name=q]'},
			ready: '#results',
			results: {item: '.result', fields: {title: {}, url: {attr: 'href'}}},
		});
		const hits = server.hits.length;
		const error = await failure(runDeclarativeRecipe(form, 'q', {session}));
		expect(error.kind).toBe('recipe');
		expect(error.message).toMatch(/searchcast/);
		expect(session.requests).toEqual([]);
		expect(server.hits.length).toBe(hits);
	});

	it("rejects with the caller's abort reason", async () => {
		const controller = new AbortController();
		const reason = new Error('stop');
		const pending = run(at('/slow'), 'q', controller.signal);
		setTimeout(() => controller.abort(reason), 50);
		await expect(pending).rejects.toBe(reason);
	});

	it('an already aborted signal sends nothing', async () => {
		const session = fakeSession();
		const reason = new Error('before');
		await expect(
			runDeclarativeRecipe(at('/results'), 'q', {
				session,
				signal: AbortSignal.abort(reason),
			}),
		).rejects.toBe(reason);
		expect(session.requests).toEqual([]);
	});
});
