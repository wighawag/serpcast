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

/** One engine of the chain that did not answer, and why. */
export interface EngineFailure {
	/** The engine's name. */
	engine: string;
	error: SerpcastError;
}

/** A typed serpcast failure. Branch on `kind`, not on the message. */
export class SerpcastError extends Error {
	override name = 'SerpcastError';
	readonly kind: SerpcastErrorKind;
	/** For `exhausted`: every engine of the chain, in order, with its failure. */
	readonly failures?: EngineFailure[];

	constructor(
		kind: SerpcastErrorKind,
		message: string,
		options?: {cause?: unknown; failures?: EngineFailure[]},
	) {
		super(message, options);
		this.kind = kind;
		if (options?.failures) this.failures = options.failures;
	}
}
