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
// the engines named in `decoyGuard` (serpcast.ts); it is exported so code
// recipes and callers can apply it themselves.
// Decisions: work/notes/observations/decoy-guard-decisions.md.

import type {SearchResult} from './declarative.js';

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
/** Terms match by prefix: "replication" ~ "replicate", "starters" ~ "starter". */
const PREFIX = 5;
/** How many top results are judged. */
const TOP = 5;
/** A page with at most this many relevant top results is a decoy. */
const MAX_RELEVANT = 1;

const words = (text: string) => text.toLowerCase().match(WORD) ?? [];

/** The distinct content terms of a query (3+ characters, no stopwords), sorted. */
export function decoyTerms(query: string): string[] {
	return [
		...new Set(words(query).filter((w) => w.length >= 3 && !STOPWORDS.has(w))),
	].sort();
}

function isRelevant(terms: readonly string[], result: SearchResult): boolean {
	const text = `${result.title ?? ''} ${result.snippet ?? ''} ${result.url ?? ''}`;
	const stems = new Set(
		words(text)
			.filter((w) => w.length >= 3)
			.map((w) => w.slice(0, PREFIX)),
	);
	const matched = terms.filter((t) => stems.has(t.slice(0, PREFIX))).length;
	return matched >= Math.min(2, terms.length);
}

/**
 * Whether `results` is a decoy page for `query`: at most one of its top 5
 * results carries two distinct query terms (title, snippet and URL; terms of
 * 3+ characters minus stopwords, matched by 5-character prefix). True only for
 * a confident decoy: a query with fewer than 2 terms or a page with fewer than
 * 3 results is never one.
 */
export function isDecoy(
	query: string,
	results: readonly SearchResult[],
): boolean {
	const terms = decoyTerms(query);
	const page = results.slice(0, TOP);
	if (terms.length < 2 || page.length < 3) return false;
	return page.filter((r) => isRelevant(terms, r)).length <= MAX_RELEVANT;
}
