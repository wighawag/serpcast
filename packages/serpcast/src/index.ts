// Placeholder entry so the scaffold builds, ships and tests something. The
// transport, recipe runners and engine chain replace it (see work/tasks/).

/** The published name of this package. */
export const packageName = 'serpcast';

/** The CLI usage text printed by the `serpcast` bin. */
export function usage(): string {
	return [
		'Usage: serpcast <command>',
		'',
		'serpcast runs keyless search engines described by recipes over HTTP with',
		"a real browser's fingerprint. No commands are available yet.",
		'',
		'Options:',
		'  -h, --help  Show this message',
	].join('\n');
}
