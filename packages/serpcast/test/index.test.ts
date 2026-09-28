import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import {packageName as recipePackageName} from 'serpcast-recipe';
import {packageName, usage} from '../src/index.js';

const run = promisify(execFile);
// The built bin; the verify gate builds before it tests.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('serpcast placeholder', () => {
	it('exports its package name', () => {
		expect(packageName).toBe('serpcast');
	});

	it('usage names the bin', () => {
		expect(usage()).toMatch(/^Usage: serpcast /);
	});

	it('resolves serpcast-recipe through the workspace', () => {
		expect(recipePackageName).toBe('serpcast-recipe');
	});
});

describe('serpcast bin', () => {
	it('prints usage with --help and exits 0', async () => {
		const {stdout} = await run(process.execPath, [cli, '--help']);
		expect(stdout.trim()).toBe(usage());
	});

	it('rejects an unknown command with a non-zero exit', async () => {
		await expect(run(process.execPath, [cli, 'nope'])).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('unknown command: nope'),
		});
	});
});
