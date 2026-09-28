// The one error type serpcast throws. Every failure carries a `kind` (see the
// Errors section of CONTEXT.md); an empty result list is never an error.

/** What went wrong, from the caller's point of view. */
export type SerpcastErrorKind =
	| 'blocked'
	| 'recipe'
	| 'timeout'
	| 'transport'
	| 'impersonation'
	| 'exhausted';

/** A typed serpcast failure. Branch on `kind`, not on the message. */
export class SerpcastError extends Error {
	override name = 'SerpcastError';
	readonly kind: SerpcastErrorKind;

	constructor(
		kind: SerpcastErrorKind,
		message: string,
		options?: {cause?: unknown},
	) {
		super(message, options);
		this.kind = kind;
	}
}
