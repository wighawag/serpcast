import {describe, expect, it} from 'vitest';
import {packageName} from '../src/index.js';

describe('serpcast-recipe placeholder', () => {
	it('exports its package name', () => {
		expect(packageName).toBe('serpcast-recipe');
	});
});
