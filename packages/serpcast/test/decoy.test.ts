// The decoy rule (src/decoy.ts), pure: no transport, no chain. The decoy
// pages are shaped after the real ones Bing served for these queries
// (2026-09-26 measurements): results about ONE word of the query.

import {describe, expect, it} from 'vitest';
import {isDecoy, type SearchResult} from '../src/index.js';

const r = (title: string, url: string, snippet?: string): SearchResult => ({
	title,
	url,
	...(snippet !== undefined && {snippet}),
});

describe('isDecoy', () => {
	it('flags a dictionary page for "why" (the question word is a stopword)', () => {
		const query = 'why does git rebase rewrite commit hashes';
		const page = [
			r(
				'WHY Definition & Meaning - Merriam-Webster',
				'https://www.merriam-webster.com/dictionary/why',
				'The meaning of WHY is for what cause, reason, or purpose.',
			),
			r('Why - Wikipedia', 'https://en.wikipedia.org/wiki/Why'),
			r(
				'why - Wiktionary, the free dictionary',
				'https://en.wiktionary.org/wiki/why',
			),
			r(
				'WHY | English meaning - Cambridge Dictionary',
				'https://dictionary.cambridge.org/dictionary/english/why',
			),
			r(
				'Why Definition & Meaning | Dictionary.com',
				'https://www.dictionary.com/browse/why',
			),
		];
		expect(isDecoy(query, page)).toBe(true);
	});

	it('flags a gaming guide for a Debian query (each result carries one term at most)', () => {
		const query = 'debian bookworm backports kernel install';
		const page = [
			r('Old School RuneScape Wiki', 'https://oldschool.runescape.wiki/'),
			r(
				'How to install Old School RuneScape',
				'https://support.runescape.com/hc/en-gb/articles/install',
			),
			r(
				'OSRS Quest Guide - Kernel of truth',
				'https://www.osrsguide.com/quests',
			),
			r(
				'Old School RuneScape - Download',
				'https://oldschool.runescape.com/download',
			),
			r('RuneScape Beginner Guide', 'https://www.runescape.com/guide'),
		];
		expect(isDecoy(query, page)).toBe(true);
	});

	it('passes a genuine page for the same Debian query', () => {
		const query = 'debian bookworm backports kernel install';
		const page = [
			r('Backports - Debian Wiki', 'https://wiki.debian.org/Backports'),
			r(
				'How to install a newer kernel on Debian 12 Bookworm',
				'https://example.org/bookworm-kernel',
			),
			r(
				'Debian -- Package: linux-image-amd64 (bookworm-backports)',
				'https://packages.debian.org/',
			),
			r('Some forum thread', 'https://forum.test/t/1'),
		];
		expect(isDecoy(query, page)).toBe(false);
	});

	it('never judges a query with fewer than two terms', () => {
		const dictionary = [
			r('Rust - Wikipedia', 'https://en.wikipedia.org/wiki/Rust'),
			r('a', 'https://a.test/'),
			r('b', 'https://b.test/'),
			r('c', 'https://c.test/'),
		];
		expect(isDecoy('rust', dictionary)).toBe(false);
		// Stopwords and words under 3 characters are not terms: one term left.
		expect(isDecoy('why is the best go rust', dictionary)).toBe(false);
		expect(isDecoy('', dictionary)).toBe(false);
	});

	it('never judges a page with fewer than three results', () => {
		const unrelated = [r('a', 'https://a.test/'), r('b', 'https://b.test/')];
		expect(isDecoy('postgres logical replication slot lag', unrelated)).toBe(
			false,
		);
		expect(isDecoy('postgres logical replication slot lag', [])).toBe(false);
		expect(
			isDecoy('postgres logical replication slot lag', [
				...unrelated,
				r('c', 'https://c.test/'),
			]),
		).toBe(true);
	});

	it('is a decoy with exactly one relevant result in the top five, not with two', () => {
		const query = 'postgres logical replication slot lag monitoring';
		const relevant = r(
			'Monitoring replication slot lag in Postgres',
			'https://pg.test/lag',
		);
		const noise = (n: number) =>
			r(`Improve your credit score ${n}`, `https://credit.test/${n}`);
		expect(
			isDecoy(query, [relevant, noise(1), noise(2), noise(3), noise(4)]),
		).toBe(true);
		expect(
			isDecoy(query, [relevant, relevant, noise(2), noise(3), noise(4)]),
		).toBe(false);
		// Only the top five count: a relevant sixth result does not rescue the page.
		expect(
			isDecoy(query, [
				relevant,
				noise(1),
				noise(2),
				noise(3),
				noise(4),
				relevant,
			]),
		).toBe(true);
	});

	it('needs two distinct terms for a relevant result, matched in title, snippet or URL', () => {
		const query = 'postgres logical replication slot lag monitoring';
		const noise = (n: number) =>
			r(`Credit score ${n}`, `https://credit.test/${n}`);
		const rest = [noise(1), noise(2), noise(3)];
		// One term, even repeated, is not enough.
		const once = r('Postgres postgres POSTGRES', 'https://x.test/');
		expect(isDecoy(query, [once, once, ...rest])).toBe(true);
		// The second term in the snippet, or in the URL, is.
		const snippet = r('Postgres', 'https://x.test/', 'about replication');
		const url = r('Postgres', 'https://x.test/replication');
		expect(isDecoy(query, [snippet, url, ...rest])).toBe(false);
	});

	it('matches terms by their first five characters', () => {
		const query = 'postgres logical replication slot lag monitoring';
		const noise = (n: number) =>
			r(`Credit score ${n}`, `https://credit.test/${n}`);
		const rest = [noise(1), noise(2), noise(3)];
		// "replicate" ~ "replication", "monitor" ~ "monitoring": two terms.
		const stem = r('How to replicate and monitor', 'https://x.test/');
		expect(isDecoy(query, [stem, stem, ...rest])).toBe(false);
		// "repl" is shorter than the query term's prefix: no match.
		const short = r('repl and mon', 'https://x.test/');
		expect(isDecoy(query, [short, short, ...rest])).toBe(true);
	});

	it('ignores stopwords in the query and case everywhere', () => {
		const query = 'What is the best way to use the Debian backports';
		// Terms: debian, backports, way (3 chars). "best", "use", "the" are stopwords.
		const matchStopwords = r('The best way to use it', 'https://x.test/');
		const genuine = r('DEBIAN BACKPORTS', 'https://x.test/');
		const noise = (n: number) =>
			r(`Credit score ${n}`, `https://credit.test/${n}`);
		expect(
			isDecoy(query, [matchStopwords, matchStopwords, noise(1), noise(2)]),
		).toBe(true);
		expect(isDecoy(query, [genuine, genuine, noise(1), noise(2)])).toBe(false);
	});
});
