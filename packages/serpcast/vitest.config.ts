import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// Each test file runs in its own process: the native library path is
		// process-global, and plain-libcurl.test.ts loads a different library.
		pool: 'forks',
		isolate: true,
		globalSetup: ['./test/native-notice.ts'],
	},
});
