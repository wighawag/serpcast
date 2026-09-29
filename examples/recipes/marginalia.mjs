// An example serpcast code recipe for Marginalia Search (https://marginalia-search.com),
// an independent web search engine whose API is meant for programs:
// https://about.marginalia-search.com/article/api/ (read 2026-09-29).
//
// Terms, in short: the key `public` is for experimentation and its rate limit
// is shared by everyone who uses it (HTTP 503 when hit); ask for a free
// personal key (non-commercial) for regular use and set it in
// MARGINALIA_API_KEY. Results are provided under CC-BY-NC-SA 4.0.
//
// It uses the URL-keyed API (`api.marginalia.nu/<key>/search/<query>`), which
// Marginalia documents as deprecated but working "as long as the project
// does". The current API (`api2.marginalia-search.com`) takes the key in an
// `API-Key` header, and serpcast's transport sends only Chrome's header table.
// The key is part of the URL, so it appears in serpcast's error messages
// (they name the URL): keep that in mind when you log failures.
//
// This is an example, not an engine bundled with serpcast: load it by path,
// or copy it next to your own recipes and adapt it.

const API = 'https://api.marginalia.nu';

export default {
	name: 'marginalia',
	async search(query, ctx) {
		const key = process.env.MARGINALIA_API_KEY || 'public';
		let url = `${API}/${encodeURIComponent(key)}/search/${encodeURIComponent(query)}`;
		if (ctx.maxResults !== undefined) {
			// The API takes 1 to 100 results.
			const count = Math.min(100, Math.max(1, Math.floor(ctx.maxResults)));
			url += `?count=${count}`;
		}
		let data;
		try {
			data = await ctx.http.json(url, {kind: 'document'});
		} catch (error) {
			// ctx.http maps 429 to `blocked` already; a 503 (a `transport` error
			// there) is how this API reports its rate limit, so it is `blocked` too
			// (the engine cools down instead of being retried at once).
			if (error?.kind === 'transport' && /\bHTTP 503\b/.test(error.message))
				ctx.blocked('HTTP 503, the rate limit of the API key');
			throw error;
		}
		if (!Array.isArray(data?.results))
			ctx.recipeError('no "results" array in the API response');
		return data.results
			.filter((r) => typeof r?.url === 'string' && r.url)
			.map((r) => ({
				title: typeof r.title === 'string' && r.title ? r.title : r.url,
				url: r.url,
				...(typeof r.description === 'string' &&
					r.description && {snippet: r.description}),
			}));
	},
};
