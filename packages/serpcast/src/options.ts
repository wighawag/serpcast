// Checking the caller's tuning options, once, where they are given (at
// construction for `createTransport` and `createSerpcast`, at the call for the
// installers). A numeric option must be a positive finite number (an integer
// where it counts something); zero is accepted only where the option documents
// it as "off". A bad value is a `RangeError` naming the option: it is a bug in
// the caller's configuration, not a search failure, so it is not a
// `SerpcastError` (whose kinds describe what happened to a search).
// Decisions: work/notes/observations/2026-09-30-tunables-and-install-api-decisions.md.

export interface NumberRule {
	/** Only whole numbers (counts, byte sizes). */
	integer?: boolean;
	/** Zero is accepted (it means "off" for this option). */
	zero?: boolean;
	/** The largest value accepted (a safety ceiling that may only be lowered). */
	max?: number;
}

/** `value` unchanged when it is undefined or a valid number for `name`, else a RangeError. */
export function checkNumber(
	name: string,
	value: unknown,
	rule: NumberRule = {},
): number | undefined {
	if (value === undefined) return undefined;
	const ok =
		typeof value === 'number' &&
		Number.isFinite(value) &&
		(rule.zero ? value >= 0 : value > 0) &&
		(!rule.integer || Number.isInteger(value)) &&
		(rule.max === undefined || value <= rule.max);
	if (ok) return value;
	const kind = rule.integer ? 'integer' : 'number';
	const range = rule.zero
		? `a finite ${kind} >= 0`
		: `a positive finite ${kind}`;
	const ceiling = rule.max === undefined ? '' : ` at most ${rule.max}`;
	throw new RangeError(
		`serpcast: ${name} must be ${range}${ceiling}, got ${String(value)}`,
	);
}

/** `value` unchanged when it is undefined or a boolean, else a RangeError. */
export function checkBoolean(
	name: string,
	value: unknown,
): boolean | undefined {
	if (value === undefined || typeof value === 'boolean') return value;
	throw new RangeError(
		`serpcast: ${name} must be a boolean, got ${String(value)}`,
	);
}

/** `value` unchanged when it is undefined or an array of strings, else a RangeError. */
export function checkNames(
	name: string,
	value: unknown,
): readonly string[] | undefined {
	if (
		value === undefined ||
		(Array.isArray(value) && value.every((v) => typeof v === 'string'))
	)
		return value as readonly string[] | undefined;
	throw new RangeError(
		`serpcast: ${name} must be an array of engine names, got ${JSON.stringify(value)}`,
	);
}
