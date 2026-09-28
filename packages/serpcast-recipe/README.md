# serpcast-recipe

The recipe format for keyless search engines: the schema, its TypeScript types and its validator. It is shared by [serpcast](https://github.com/wighawag/serpcast) (runs a recipe over plain HTTP with a real browser's fingerprint) and [searchcast](https://github.com/wighawag/searchcast) (runs a recipe in a real browser), so one recipe file describes a site for both. It has no runtime dependencies and is MIT licensed so projects under any license can share the format.

The format is the one searchcast introduced, unchanged: every recipe searchcast accepts is accepted here, with the same error messages.

## Recipes

A recipe is a JSON file. When loading a directory, each `*.json` file is one recipe, named by its `name` field or else its file name.

```json
{
	"name": "web",
	"navigate": {"url": "https://search.example/?q={query}"},
	"ready": "article.result a.title",
	"empty": ".no-results",
	"blocked": ["#captcha", ".challenge"],
	"blockedUrl": ["/challenge"],
	"results": {
		"item": "article.result",
		"fields": {
			"title": {"selector": "a.title"},
			"url": {"selector": "a.title", "attr": "href"},
			"content": {"selector": ".snippet"}
		}
	},
	"limit": 10,
	"timeoutMs": 15000
}
```

| Field            | Meaning                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate.url`   | URL template; `{query}` becomes the URL-encoded query.                                                                                                                                                                                                                                |
| `form`           | Instead of `navigate`: `{"url", "input", "submit"}`. Loads `url`, clicks `input`, replaces its value by typing the query key by key, then submits. `submit` is `"enter"` (default) or `{"click": "<selector>"}`.                                                                      |
| `ready`          | Selector that means results are rendered.                                                                                                                                                                                                                                             |
| `empty`          | Optional selector that means the site found nothing.                                                                                                                                                                                                                                  |
| `blocked`        | Optional selectors that mean a challenge or block page.                                                                                                                                                                                                                               |
| `blockedUrl`     | Optional regular expressions over the page URL that mean blocked.                                                                                                                                                                                                                     |
| `results.item`   | Selector for each result.                                                                                                                                                                                                                                                             |
| `results.fields` | Field name to `{selector?, attr?}`. `selector` is relative to the item (omitted: the item itself). `attr` omitted reads visible text; `href` and `src` resolve to absolute URLs. `title` and `url` are required; results missing either are skipped. Other fields are passed through. |
| `limit`          | Maximum results, default 10.                                                                                                                                                                                                                                                          |
| `timeoutMs`      | Per-query budget, default 15000.                                                                                                                                                                                                                                                      |

Exactly one of `navigate` and `form` must be set.

The `limit` and `timeoutMs` defaults are applied by the runner, not by the validator: `parseRecipe` leaves them undefined when absent, and the package exports them as `DEFAULT_LIMIT` (10) and `DEFAULT_TIMEOUT_MS` (15000) so both runners use the same values.

`form` needs a real browser (it types into the page). serpcast runs recipes over HTTP, so it rejects a `form` recipe with a clear error; run it with searchcast. `requiresBrowser(recipe)` tells a runner which case it has.

## API

```ts
import {
	parseRecipe,
	RecipeError,
	requiresBrowser,
	DEFAULT_LIMIT,
	DEFAULT_TIMEOUT_MS,
	type Recipe,
	type FieldSpec,
	type Submit,
} from 'serpcast-recipe';

// Validate an untrusted value (usually parsed JSON). Throws RecipeError with
// the offending path in the message, e.g. `recipe "web": ready must be a
// non-empty string`. The fallback name is used when the value has no `name`.
const recipe: Recipe = parseRecipe(JSON.parse(text), 'web');
```

The main entry imports nothing from `node:*`, so it works anywhere. The file loaders are on a separate, Node-only subpath:

```ts
import {loadRecipeFile, loadRecipes} from 'serpcast-recipe/node';

// One file; the name defaults to the file name without its extension.
const web = loadRecipeFile('./recipes/web.json');

// Files and directories (every `*.json` inside, in name order), keyed by
// recipe name. Duplicate names are a RecipeError.
const recipes: Map<string, Recipe> = loadRecipes(['./recipes']);
```

## License

MIT, see [`LICENSE`](LICENSE).
