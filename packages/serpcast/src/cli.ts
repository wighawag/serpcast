#!/usr/bin/env node
// The `serpcast` bin, for recipe development: `serpcast query` runs one
// declarative recipe once through the impersonated transport.
//
// Exit codes: 0 with `{recipe, results}` as JSON on stdout (results may be
// empty only when the recipe's `empty` selector matched); 1 on a search
// failure, with `serpcast: <kind>: <message>` on stderr (an unreadable or
// invalid recipe file is a `recipe` failure); 2 on a usage error.
import {parseArgs} from 'node:util';
import {RecipeError} from 'serpcast-recipe';
import {loadRecipeFile} from 'serpcast-recipe/node';
import {
	createTransport,
	runDeclarativeRecipe,
	SerpcastError,
	usage,
} from './index.js';

function usageError(message: string): never {
	process.stderr.write(`serpcast: ${message}\n\n${usage()}\n`);
	process.exit(2);
}

async function query(recipePath: string | undefined, values: Values) {
	if (!recipePath) usageError('query needs --recipe <file>');
	const text = values.positionals.join(' ').trim();
	if (!text) usageError('query needs a query');
	let recipe;
	try {
		recipe = loadRecipeFile(recipePath);
	} catch (error) {
		if (!(error instanceof RecipeError)) throw error;
		throw new SerpcastError('recipe', error.message, {cause: error});
	}
	const transport = createTransport({
		proxy: values.proxy,
		libcurlPath: values.libcurl,
	});
	const response = await runDeclarativeRecipe(recipe, text, {
		session: transport.session(),
	});
	process.stdout.write(JSON.stringify(response, null, 2) + '\n');
}

interface Values {
	positionals: string[];
	proxy?: string;
	libcurl?: string;
}

async function main(argv: string[]): Promise<void> {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				recipe: {type: 'string'},
				proxy: {type: 'string'},
				libcurl: {type: 'string'},
				help: {type: 'boolean', short: 'h'},
			},
		});
	} catch (error) {
		usageError((error as Error).message);
	}
	const {values, positionals} = parsed;
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		process.stdout.write(usage() + '\n');
		return;
	}
	if (command !== 'query') usageError(`unknown command: ${command}`);
	await query(values.recipe, {
		positionals: rest,
		proxy: values.proxy,
		libcurl: values.libcurl,
	});
}

main(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof SerpcastError) {
		process.stderr.write(`serpcast: ${error.kind}: ${error.message}\n`);
	} else {
		process.stderr.write(
			`serpcast: ${(error as Error).stack ?? String(error)}\n`,
		);
	}
	process.exitCode = 1;
});
