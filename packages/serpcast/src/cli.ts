#!/usr/bin/env node
// The `serpcast` bin. `serpcast query` runs one declarative recipe once
// through the impersonated transport (recipe development); `install-libcurl`
// downloads the pinned library into the data directory, the only download
// serpcast ever makes and only when typed; `doctor` reports the library and
// whether impersonation is active (no network request without `--remote`);
// `install-recipes` installs a recipe set from a checksum-pinned archive (a
// URL is downloaded only then, and only when typed); `recipes list` shows the
// installed sets.
//
// Exit codes: 0 on success (for `query`, `{recipe, results}` as JSON on
// stdout, results empty only when the recipe's `empty` selector matched); 1 on
// a failure, with `serpcast: <kind>: <message>` on stderr for a search failure
// (an unreadable or invalid recipe file is a `recipe` failure) or
// `serpcast: <message>` for a failed install, and for `doctor` when the
// report is not healthy; 2 on a usage error.
import {parseArgs} from 'node:util';
import {RecipeError} from 'serpcast-recipe';
import {loadRecipeFile} from 'serpcast-recipe/node';
import {
	createTransport,
	runDeclarativeRecipe,
	SerpcastError,
	usage,
} from './index.js';
import {doctor, formatReport, healthy} from './doctor.js';
import {InstallError, installLibcurl} from './install.js';
import {installRecipes} from './install-recipes.js';
import {formatRecipeSets, listRecipeSets, recipesDir} from './recipes.js';

/** The options each command accepts (besides --help). */
const COMMANDS: Record<string, string[]> = {
	query: ['recipe', 'proxy', 'libcurl'],
	'install-libcurl': ['proxy', 'force'],
	doctor: ['libcurl', 'proxy', 'remote'],
	'install-recipes': ['sha256', 'name', 'dir', 'proxy', 'force'],
	recipes: ['dir'],
};

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
	force?: boolean;
	remote?: boolean;
	sha256?: string;
	name?: string;
	dir?: string;
}

async function installCommand(values: Values) {
	const {path} = await installLibcurl({
		proxy: values.proxy,
		force: values.force,
		log: (line) => process.stderr.write(`serpcast: ${line}\n`),
	});
	process.stdout.write(path + '\n');
}

async function installRecipesCommand(values: Values) {
	const [source, ...extra] = values.positionals;
	if (!source || extra.length) {
		usageError('install-recipes takes one <url|path>');
	}
	if (!values.sha256) {
		usageError(
			"install-recipes needs --sha256 <hex>: pinning the archive's checksum is the trust decision",
		);
	}
	const {dir} = await installRecipes(source, {
		sha256: values.sha256,
		name: values.name,
		dir: values.dir,
		proxy: values.proxy,
		force: values.force,
		log: (line) => process.stderr.write(`serpcast: ${line}\n`),
	});
	process.stdout.write(dir + '\n');
}

function recipesCommand(values: Values) {
	if (values.positionals.join(' ') !== 'list') {
		usageError('recipes takes one subcommand: list');
	}
	const base = values.dir ?? recipesDir();
	process.stdout.write(formatRecipeSets(base, listRecipeSets(base)) + '\n');
}

async function doctorCommand(values: Values) {
	const report = await doctor({
		libcurlPath: values.libcurl,
		proxy: values.proxy,
		remote: values.remote,
	});
	process.stdout.write(formatReport(report, values.proxy) + '\n');
	if (!healthy(report)) process.exitCode = 1;
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
				force: {type: 'boolean'},
				remote: {type: 'boolean'},
				sha256: {type: 'string'},
				name: {type: 'string'},
				dir: {type: 'string'},
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
	const allowed = COMMANDS[command];
	if (!allowed) usageError(`unknown command: ${command}`);
	for (const option of Object.keys(values)) {
		if (!allowed.includes(option)) {
			usageError(`${command} does not take --${option}`);
		}
	}
	const given = {positionals: rest, ...values};
	if (command === 'query') return query(values.recipe, given);
	if (command === 'install-recipes') return installRecipesCommand(given);
	if (command === 'recipes') return recipesCommand(given);
	if (rest.length) usageError(`${command} takes no arguments`);
	if (command === 'install-libcurl') return installCommand(given);
	return doctorCommand(given);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof SerpcastError) {
		process.stderr.write(`serpcast: ${error.kind}: ${error.message}\n`);
	} else if (error instanceof InstallError) {
		process.stderr.write(`serpcast: ${error.message}\n`);
	} else {
		process.stderr.write(
			`serpcast: ${(error as Error).stack ?? String(error)}\n`,
		);
	}
	process.exitCode = 1;
});
