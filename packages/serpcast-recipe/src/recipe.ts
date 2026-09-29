// The recipe schema, its types and its validator, shared by serpcast (HTTP)
// and searchcast (real browser). This is an exact extraction of searchcast's
// `src/recipe.ts` (searchcast@0.1.1): same types, same validation, same
// messages, so every recipe searchcast accepts is accepted unchanged (ADR
// 0003). Keep it that way: searchcast re-exports this module, so any change in
// meaning or wording here is a change to searchcast too. This file must not
// import anything from `node:*`; the file loaders live in `./node.ts`.
//
// One addition since the extraction: the optional `decoyProne` boolean. It is
// validated and kept in `parseRecipe`'s output; serpcast's engine chain reads
// it, searchcast ignores it (it has no chain). A recipe without it is parsed
// exactly as before, with the same messages.

/** How to read one value out of a result item. */
export interface FieldSpec {
	/** CSS selector relative to the item. Omitted: the item element itself. */
	selector?: string;
	/**
	 * Attribute to read. Omitted: the element's visible text.
	 * `href` and `src` are read as resolved absolute URLs.
	 */
	attr?: string;
}

export type Submit = 'enter' | {click: string};

/**
 * A recipe describes one site: how to get a query in, how to tell the page
 * is ready or blocked, and how to read the results out.
 */
export interface Recipe {
	name: string;
	/** Go straight to a URL. `{query}` is replaced by the URL-encoded query. */
	navigate?: {url: string};
	/** Load a page, type the query into `input`, then submit. */
	form?: {url: string; input: string; submit: Submit};
	/** Selector whose presence means results are rendered. */
	ready: string;
	/** Selector whose presence means the site answered with no results. */
	empty?: string;
	/** Selectors whose presence means a challenge or block page. */
	blocked?: string[];
	/** Regular expressions matched against the page URL that mean blocked. */
	blockedUrl?: string[];
	results: {
		/** Selector matching each result item. */
		item: string;
		/** Must include `title` and `url`; any extra fields are passed through. */
		fields: Record<string, FieldSpec>;
	};
	/** Maximum number of results returned. Default 10. */
	limit?: number;
	/** Per-request budget in milliseconds. Default 15000. */
	timeoutMs?: number;
	/**
	 * The site sometimes answers with results unrelated to the query (a decoy
	 * page). serpcast's engine chain then checks this engine's answers without
	 * the caller naming it in `decoyGuard`; searchcast ignores it.
	 */
	decoyProne?: boolean;
}

export class RecipeError extends Error {
	override name = 'RecipeError';
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new RecipeError(`${path} must be a non-empty string`);
	}
	return v;
}

function optStr(v: unknown, path: string): string | undefined {
	return v === undefined ? undefined : str(v, path);
}

function strList(v: unknown, path: string): string[] | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v))
		throw new RecipeError(`${path} must be an array of strings`);
	return v.map((s, i) => str(s, `${path}[${i}]`));
}

function posInt(v: unknown, path: string): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
		throw new RecipeError(`${path} must be a positive integer`);
	}
	return v;
}

function optBool(v: unknown, path: string): boolean | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== 'boolean')
		throw new RecipeError(`${path} must be a boolean`);
	return v;
}

/** Validate an untrusted value (usually parsed JSON) into a Recipe. */
export function parseRecipe(value: unknown, fallbackName?: string): Recipe {
	if (!isObject(value)) throw new RecipeError('recipe must be a JSON object');
	const name =
		value.name === undefined && fallbackName
			? fallbackName
			: str(value.name, 'name');
	const where = (p: string) => `recipe "${name}": ${p}`;

	const hasNavigate = value.navigate !== undefined;
	const hasForm = value.form !== undefined;
	if (hasNavigate === hasForm) {
		throw new RecipeError(
			where('exactly one of "navigate" or "form" is required'),
		);
	}

	let navigate: Recipe['navigate'];
	if (hasNavigate) {
		if (!isObject(value.navigate))
			throw new RecipeError(where('navigate must be an object'));
		const url = str(value.navigate.url, where('navigate.url'));
		if (!url.includes('{query}')) {
			throw new RecipeError(where('navigate.url must contain {query}'));
		}
		navigate = {url};
	}

	let form: Recipe['form'];
	if (hasForm) {
		if (!isObject(value.form))
			throw new RecipeError(where('form must be an object'));
		const f = value.form;
		let submit: Submit;
		if (f.submit === undefined || f.submit === 'enter') {
			submit = 'enter';
		} else if (isObject(f.submit) && typeof f.submit.click === 'string') {
			submit = {click: str(f.submit.click, where('form.submit.click'))};
		} else {
			throw new RecipeError(
				where('form.submit must be "enter" or {"click": "<selector>"}'),
			);
		}
		form = {
			url: str(f.url, where('form.url')),
			input: str(f.input, where('form.input')),
			submit,
		};
	}

	if (!isObject(value.results))
		throw new RecipeError(where('results must be an object'));
	const item = str(value.results.item, where('results.item'));
	if (!isObject(value.results.fields)) {
		throw new RecipeError(where('results.fields must be an object'));
	}
	const fields: Record<string, FieldSpec> = {};
	for (const [key, spec] of Object.entries(value.results.fields)) {
		if (!isObject(spec))
			throw new RecipeError(where(`results.fields.${key} must be an object`));
		fields[key] = {
			selector: optStr(spec.selector, where(`results.fields.${key}.selector`)),
			attr: optStr(spec.attr, where(`results.fields.${key}.attr`)),
		};
	}
	for (const required of ['title', 'url']) {
		if (!fields[required])
			throw new RecipeError(where(`results.fields.${required} is required`));
	}

	const blockedUrl = strList(value.blockedUrl, where('blockedUrl'));
	for (const [i, pattern] of (blockedUrl ?? []).entries()) {
		try {
			new RegExp(pattern);
		} catch {
			throw new RecipeError(
				where(`blockedUrl[${i}] is not a valid regular expression`),
			);
		}
	}

	return {
		name,
		navigate,
		form,
		ready: str(value.ready, where('ready')),
		empty: optStr(value.empty, where('empty')),
		blocked: strList(value.blocked, where('blocked')),
		blockedUrl,
		results: {item, fields},
		limit: posInt(value.limit, where('limit')),
		timeoutMs: posInt(value.timeoutMs, where('timeoutMs')),
		decoyProne: optBool(value.decoyProne, where('decoyProne')),
	};
}
