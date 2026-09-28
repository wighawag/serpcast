#!/usr/bin/env node
// Stub CLI: prints usage. Real commands (`query`, the libcurl-impersonate
// install) arrive with their tasks.
import {usage} from './index.js';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
	console.log(usage());
} else {
	console.error(`serpcast: unknown command: ${args[0]}\n\n${usage()}`);
	process.exitCode = 1;
}
