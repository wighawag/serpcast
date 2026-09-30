// The decoy rule: is a result page about the query at all? Some engines, Bing
// above all, answer some queries with a well-formed page of results unrelated
// to the query (a "decoy": dictionary entries for "why", a gaming guide for a
// Debian query). Decoys follow one pattern: each result is about ONE word of
// the query, usually a generic one. So a result is relevant only when its
// title + snippet + URL carries at least two distinct query terms (or the only
// term), and a page is a decoy when at most one of its top 5 results is
// relevant. Queries with fewer than 2 terms, or pages with fewer than 3
// results, are never judged: too little to go on.
//
// A port of the guard measured in my-boxes (`packages/search-challenges/
// relevance.py`: it flagged every decoy seen and none of ~55 genuine pages),
// kept identical on purpose, stopword list and ASCII word pattern included,
// so the rule deployed is the rule measured. The engine chain applies it to
// the engines it guards (serpcast.ts); it is exported so code recipes and
// callers can apply it themselves. The three thresholds (top, maxRelevant,
// prefix) can be overridden with a `DecoyRule`, at the caller's risk: only
// the defaults were measured. The stopword list, the 3-character minimum and
// the "fewer than 2 terms or 3 results: never judged" floor stay fixed: they
// are what keeps the rule from judging on too little evidence.
// Decisions: work/notes/observations/decoy-guard-decisions.md.

import type {SearchResult} from './declarative.js';
import {checkNumber} from './options.js';

/** Function words and generic modifiers: matching one of these says nothing. */
const STOPWORDS = new Set(
	`the and for with from that this what when where which who why how are was were
	you your can does did not but all any its it's into onto than then them they their
	there here about over under near best top vs versus between using use used get
	make need want like just also more most much many some very one two new`.split(
		/\s+/,
	),
);
const WORD = /[a-z0-9]+/g;

/** The decoy rule's thresholds (see `DEFAULT_DECOY_RULE`). */
export interface DecoyRule {
	/** How many top results are judged. */
	top: number;
	/** A page with at most this many relevant top results is a decoy. */
	maxRelevant: number;
	/** Terms match by this many first characters: "replication" ~ "replicate". */
	prefix: number;
}

/** The measured thresholds: the top 5 results, at most 1 relevant, 5-character prefixes. */
export const DEFAULT_DECOY_RULE: Readonly<DecoyRule> = Object.freeze({
	top: 5,
	maxRelevant: 1,
	prefix: 5,
});

const words = (text: string) => text.toLowerCase().match(WORD) ?? [];

/** The distinct content terms of a query (3+ characters, no stopwords), sorted. */
export function decoyTerms(query: string): string[] {
	return [
		...new Set(words(query).filter((w) => w.length >= 3 && !STOPWORDS.has(w))),
	].sort();
}

/** `rule` completed with the defaults, each value checked (a positive integer, else a RangeError). */
export function decoyRule(rule: Partial<DecoyRule> = {}): DecoyRule {
	if (typeof rule !== 'object' || rule === null)
		throw new RangeError(`serpcast: decoyRule must be an object`);
	const value = (name: keyof DecoyRule) =>
		checkNumber(`decoyRule.${name}`, rule[name], {integer: true}) ??
		DEFAULT_DECOY_RULE[name];
	return {
		top: value('top'),
		maxRelevant: value('maxRelevant'),
		prefix: value('prefix'),
	};
}

function isRelevant(
	terms: readonly string[],
	result: SearchResult,
	prefix: number,
): boolean {
	const text = `${result.title ?? ''} ${result.snippet ?? ''} ${result.url ?? ''}`;
	const stems = new Set(
		words(text)
			.filter((w) => w.length >= 3)
			.map((w) => w.slice(0, prefix)),
	);
	const matched = terms.filter((t) => stems.has(t.slice(0, prefix))).length;
	return matched >= Math.min(2, terms.length);
}

/**
 * Whether `results` is a decoy page for `query`: at most one of its top 5
 * results carries two distinct query terms (title, snippet and URL; terms of
 * 3+ characters minus stopwords, matched by 5-character prefix). True only for
 * a confident decoy: a query with fewer than 2 terms or a page with fewer than
 * 3 results is never one. `rule` overrides the thresholds (the defaults are
 * the measured ones; others are the caller's risk).
 */
export function isDecoy(
	query: string,
	results: readonly SearchResult[],
	rule: Partial<DecoyRule> = {},
): boolean {
	const {top, maxRelevant, prefix} = decoyRule(rule);
	const terms = decoyTerms(query);
	const page = results.slice(0, top);
	if (terms.length < 2 || page.length < 3) return false;
	return page.filter((r) => isRelevant(terms, r, prefix)).length <= maxRelevant;
}
