// A parsed HTML page and the few DOM reads a declarative recipe needs, with
// the meaning they have in searchcast's in-page probe (searchcast@0.1.1
// `src/probe.ts`): `querySelector` semantics (descendants only, ancestors may
// match the selector's left part), a field's visible text with whitespace
// collapsed, and `href`/`src` read as absolute URLs the way the DOM properties
// resolve them (against `<base href>`, else the page URL). No script runs.
//
// Parser and selector engine: htmlparser2 + css-select (cheerio's own core,
// without cheerio), the smallest pair that covers CSS Selectors level 4 as
// recipes use it (`:has`, `:not`, `:is`, attribute operators, combinators).
// Installed size of the closure: about 2.4 MB, of which about 320 KB is
// JavaScript (htmlparser2, css-select and their deps: domhandler, domutils,
// domelementtype, dom-serializer, entities, css-what, nth-check, boolbase).
//
// Visible text is an approximation of `innerText`, which needs layout: the
// text of script/style/template/noscript and of `hidden` elements is dropped,
// and block-level elements and `<br>` separate words, so `<div>a</div><div>b
// </div>` reads "a b" as in a browser. CSS that hides an element is not seen.

import * as css from 'css-select';
import type {AnyNode, Document, Element} from 'domhandler';
import {parseDocument} from 'htmlparser2';
import type {FieldSpec} from 'serpcast-recipe';
import {SerpcastError} from './errors.js';

const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'head']);
const BLOCK = new Set(
	(
		'address article aside blockquote br caption dd details dialog div dl dt ' +
		'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup ' +
		'hr li main nav ol option p pre section summary table tbody td tfoot th ' +
		'thead tr ul'
	).split(' '),
);
// Elements whose `href` / `src` DOM property is a resolved URL.
const URL_PROPERTY: Record<string, Set<string>> = {
	href: new Set(['a', 'area', 'link']),
	src: new Set(
		'audio embed frame iframe img input script source track video'.split(' '),
	),
};
// querySelector semantics: a selector is matched against the whole document,
// not relative to the element it is called on (whose descendants are searched).
const OPTIONS = {relativeSelector: false};
const selectOne = (selector: string, root: AnyNode) =>
	css.selectOne<AnyNode, Element>(selector, root, OPTIONS);
const selectAll = (selector: string, root: AnyNode) =>
	css.selectAll<AnyNode, Element>(selector, root, OPTIONS);

export interface Page {
	/** Whether any element matches `selector`. */
	has(selector: string): boolean;
	/** Every element matching `selector`, in document order. */
	all(selector: string): Element[];
	/** One field of a result item, or undefined when absent or blank. */
	read(item: Element, field: FieldSpec): string | undefined;
}

/**
 * Parse `html` served at `url`. `label` prefixes error messages (the recipe
 * name). An invalid selector is a `recipe` error.
 */
export function parsePage(html: string, url: string, label: string): Page {
	const doc = parseDocument(html);
	const select = <T>(selector: string, run: () => T): T => {
		try {
			return run();
		} catch (cause) {
			throw new SerpcastError(
				'recipe',
				`${label}: invalid selector ${selector}: ${(cause as Error).message}`,
				{cause},
			);
		}
	};
	const baseHref = selectOne('base[href]', doc)?.attribs.href;
	const base = (baseHref !== undefined && tryUrl(baseHref, url)) || url;
	return {
		has: (selector) =>
			select(selector, () => selectOne(selector, doc) !== null),
		all: (selector) => select(selector, () => selectAll(selector, doc)),
		read(item, field) {
			const el = field.selector
				? select(field.selector, () => selectOne(field.selector!, item))
				: item;
			if (!el) return undefined;
			const value = field.attr
				? attribute(el, field.attr, base)
				: text(el, true);
			if (value === undefined) return undefined;
			return value.replace(/\s+/g, ' ').trim() || undefined;
		},
	};
}

function attribute(el: Element, attr: string, base: string) {
	const name = attr.toLowerCase();
	const raw = el.attribs[name];
	if (!URL_PROPERTY[name]?.has(el.name)) return raw;
	// The DOM property: "" when the attribute is absent, the raw value when it
	// does not parse as a URL.
	if (raw === undefined) return '';
	return tryUrl(raw, base) || raw;
}

function tryUrl(value: string, base: string): string | undefined {
	try {
		return new URL(value, base).href;
	} catch {
		return undefined;
	}
}

// `root`: the element asked for is read even when not rendered, as innerText
// then falls back to its text content.
function text(node: AnyNode | Document, root = false): string {
	if (node.type === 'text') return node.data;
	if (!('children' in node)) return '';
	if ('name' in node) {
		const hidden = SKIPPED.has(node.name) || node.attribs.hidden !== undefined;
		if (hidden && !root) return '';
		const inner = node.children.map((child) => text(child)).join('');
		return BLOCK.has(node.name) ? ` ${inner} ` : inner;
	}
	return node.children.map((child) => text(child)).join('');
}
