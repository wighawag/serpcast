// Says, once per run and visibly, which native-library tests are skipped and
// how to run them (a message logged inside a skipped test file is swallowed).

export default function setup(): void {
	if (!process.env.SERPCAST_LIBCURL_PATH) {
		process.stderr.write(
			'\n[serpcast] Skipping the native transport tests: no library configured. Set SERPCAST_LIBCURL_PATH to a libcurl-impersonate shared library to run them.\n',
		);
	}
	if (!process.env.SERPCAST_TEST_PLAIN_LIBCURL) {
		process.stderr.write(
			'[serpcast] Skipping the plain-libcurl strict-mode tests: set SERPCAST_TEST_PLAIN_LIBCURL to a plain libcurl shared library to run them.\n\n',
		);
	}
}
