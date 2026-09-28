// The state store: where sessions and cooldowns live. The caller injects it
// because where state lives and how it is partitioned (per identity, per
// process, on disk or not) is a privacy decision (ADR 0002). serpcast ships
// only this in-memory default and never writes to disk on its own.
//
// Values are plain JSON so any store (a file, a database, a Map) can keep
// them. Expiry is relative (`ttlMs`), measured by the store's own clock;
// serpcast also stamps the times it relies on into the values and checks them
// with its own clock, so a store that expires lazily or late stays correct.

/** A JSON value, as kept by a state store. */
export type JsonValue =
	string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};

/**
 * A small async key/value store with per-key expiry. serpcast namespaces its
 * keys per engine (`engine/<name>/session`, `engine/<name>/cooldown`) plus one
 * index key (`serpcast/sessions`).
 */
export interface StateStore {
	/** The value of `key`, or undefined when absent or expired. */
	get(key: string): Promise<JsonValue | undefined>;
	/** Store `value` under `key`; with `ttlMs`, it expires that many ms from now. */
	set(key: string, value: JsonValue, options?: {ttlMs?: number}): Promise<void>;
	/** Remove `key` (no error when absent). */
	delete(key: string): Promise<void>;
}

export interface MemoryStoreOptions {
	/** The clock expiry is measured with, in ms since the epoch. Default `Date.now`. */
	now?: () => number;
}

/** The default state store: a Map in this process, copies in and out, nothing on disk. */
export function createMemoryStore(
	options: MemoryStoreOptions = {},
): StateStore {
	const now = options.now ?? Date.now;
	const entries = new Map<string, {value: JsonValue; expires?: number}>();
	const live = (e: {expires?: number}) =>
		e.expires === undefined || e.expires > now();
	return {
		async get(key) {
			const entry = entries.get(key);
			if (!entry) return undefined;
			if (!live(entry)) {
				entries.delete(key);
				return undefined;
			}
			return structuredClone(entry.value);
		},
		async set(key, value, {ttlMs} = {}) {
			for (const [k, e] of entries) if (!live(e)) entries.delete(k);
			entries.set(key, {
				value: structuredClone(value),
				...(ttlMs !== undefined && {expires: now() + ttlMs}),
			});
		},
		async delete(key) {
			entries.delete(key);
		},
	};
}
