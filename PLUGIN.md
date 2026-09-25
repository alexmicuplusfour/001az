# Writing a plugin for 001az

001az loads plugins while it runs: code you install from a GitHub folder, an npm package, a
tarball or a directory on the server, with no rebuild and no restart. This document is the
contract between a plugin and the app — what a plugin is, what it's handed, what it has to
return, and how it's installed, updated and removed.

Two complete plugins ship in [examples/plugins/](examples/plugins): DeepSeek (a hosted AI
provider that needs a key) and Ollama (a self-hosted one that doesn't). The app's own crypto
and stocks providers in [server/connectors/](server/connectors) are written against the same
contract: any one of those files, copied into a directory beside a manifest, installs as a
plugin.

- [What a plugin is](#what-a-plugin-is)
- [manifest.json](#manifestjson)
- [Installing, developing, updating, removing](#installing-developing-updating-removing)
- [ctx](#ctx)
- [ai-provider](#ai-provider)
- [connector-provider](#connector-provider)
- [connector-domain](#connector-domain)
- [source](#source)
- [Errors](#errors)
- [Versions](#versions)
- [Sharing a plugin](#sharing-a-plugin)

## What a plugin is

A directory with at least two files:

```
my-plugin/
  manifest.json   what the plugin is — readable without running anything
  index.js        the code: an ES module whose default export is a factory
```

The app calls the factory once when the plugin loads, passing `ctx` (everything the app hands
a plugin — see [ctx](#ctx)), and the factory returns the plugin: an object whose shape depends
on its kind. `main` may import other files in the directory (`import { rows } from "./cities.js"`),
and an update loads all of them fresh.

```js
export default function (ctx) {
  return { /* the kind's object */ };
}
```

<!-- pin: kinds -->
| kind | what it adds | the factory returns |
|---|---|---|
| `ai-provider` | a model vendor, for tagging, field extraction, embeddings, transcription or object detection | a descriptor |
| `connector-provider` | a live-data source for a domain that exists — crypto, stocks, or one a plugin added | a provider |
| `connector-domain` | a new kind of live data — its fields, board template, browse table, charts and card face — with its first provider | `{ providers, defaultProvider, manifest, faces, faceProducers }` |
| `source` | a place a board ingests files from, like the built-in FTP and S3 sources | `{ manifest, backend }` |

A plugin is server-side only. It can't add pages, scripts or styles to the app, or capabilities
beyond the ones this document lists.

### Trust

A plugin runs inside the server process, as the server. There is no sandbox: it can read the
server's files and environment — API keys included — and reach the network and the database.
Install only what you'd run on your server yourself.

What the app does about it:

- Only an admin can install, update or remove a plugin.
- Before a plugin is installed or updated from anywhere but the app's bundled examples, the app
  says the code will run with the server's full access, and asks.
- npm installs a plugin's dependencies with their install scripts off, unless the manifest
  asks for them (`allowScripts`).
- A plugin's card shows where it came from and the version that ran — for GitHub, the commit.
- A plugin on the Add plugin dialog's Community tab is listed, not vouched for: its entry was
  checked and merged, and nobody audited its code (see [Getting listed](#getting-listed)).
- An operator can turn installing off: `PLUGIN_INSTALL_DISABLE=1` (see
  [Locking installs](#locking-installs)).

## manifest.json

```json
{
  "id": "acme.paprika",
  "apiVersion": 1,
  "kind": "connector-provider",
  "domain": "crypto",
  "label": "Paprika",
  "description": "Crypto prices from Paprika — no key needed.",
  "main": "index.js",
  "version": "1.0.0"
}
```

| field | kinds | |
|---|---|---|
| `id` | all | Required. `vendor.name` — letters, digits, `.`, `-` and `_`, with at least one dot. It names everything saved for the plugin, and a plugin can't be installed twice. |
| `apiVersion` | all | Required: `1`. See [Versions](#versions). |
| `kind` | all | Required. One of the four kinds above. |
| `label` | all | Required. The plugin's name until its code has run: on the Add plugin list (a bundled example's), and on the card of a plugin that failed to load. Once the code runs, the card shows the name the code returns. |
| `description` | all | Optional. Shown under `label` on the Add plugin list until the code has run; after that, the description the code returns. |
| `main` | all | Required. The module's path inside the directory, usually `index.js`. No `..`. |
| `version` | all | Optional. A string, shown on the card as written; nothing compares versions. |
| `domain` | connector-provider, connector-domain | Required for these two: the domain the provider serves, or the new domain's name. Letters, digits and `-`. |
| `faceProducers` | connector-domain | Optional. The card-face renderers the plugin brings — see [faces](#faces). |
| `allowScripts` | all | Optional, `false` by default. `true` lets npm run install scripts — the plugin's own and its dependencies' — for a native module that has to compile. |
| `keyless`, `needsBase` | ai-provider | Optional hints for the app's own bundled examples, read before their code runs: today, `keyless` puts one first on the first-run screen. They do nothing for any other plugin — the descriptor's own `keyless` and `needsBase` are what count. |

The code is an ES module. Without a `package.json`, that's all it takes: the app runs Node 22,
which reads `export` syntax as a module. If the plugin has a `package.json` — for its
dependencies — give it `"type": "module"`, or every load logs a warning about the module's type.
Dependencies are installed with `npm install --omit=dev`, and only when `package.json` lists
some.

## Installing, developing, updating, removing

### Installing

Admin → Plugins → **Add plugin**. The dialog lists the app's bundled examples, and its box
takes a source:

| source | for example |
|---|---|
| a GitHub repository, or a folder in one | `https://github.com/you/repo`, `https://github.com/you/repo/tree/main/plugins/mine`, `github:you/repo/plugins/mine@v1.2.0` |
| an npm package | `npm:acme-001az-plugin@1.0.0`, or just `acme-001az-plugin` |
| a tarball | `https://example.com/mine-1.0.0.tgz` |
| a directory on the server | `/srv/plugins/mine`, `./plugins/mine`, `file:///srv/plugins/mine` — a relative path is relative to the server's working directory |

Installing fetches the source, checks the manifest, installs dependencies, calls the factory,
checks what it returned, and only then adds the plugin — live. If any step fails, the dialog
says why and nothing is left behind.

- GitHub and npm are fetched without credentials, so only public repositories and packages
  install. An npm source takes an exact version, or none for the latest — not a range or a
  tag — and the download is checked against the registry's integrity hash.
- A tarball URL has to end in `.tgz` or `.tar.gz` (a query string after it is fine). A
  tarball — GitHub's and npm's included — has to hold one top-level directory. A GitHub
  folder URL installs the plugin in that folder, which needs its own `manifest.json`.
- The card records what ran: `local` for a path, `url` for a tarball, the version for npm, and
  `<ref>@<commit>` for GitHub — `main@7f02846`, which `github:you/repo@7f02846` pins. A source
  pinned to a commit records the commit.
- Limits: a 50 MB tarball, a 60-second download and 3 minutes of npm
  (`PLUGIN_MAX_TARBALL_BYTES`, `PLUGIN_FETCH_TIMEOUT_MS`, `PLUGIN_NPM_TIMEOUT_MS`).
- Installed code lives in `PLUGINS_DIR` (default `/data/plugins`), on the data volume, so it
  survives restarts and image upgrades.
- When the community list is on, the dialog has two tabs: **Included**, the app's own plugins,
  its examples and what you've added, and **Community**, the plugins listed in
  [community/plugins.json](community/plugins.json) (see [Getting listed](#getting-listed)). A
  listed plugin installs from the source its entry pins, after the same question as the box.
  `PLUGIN_INDEX_URL` is where the list is read from — this repository's copy by default, read
  when the tab is opened and at most every ten minutes. Empty turns the tab off.

### Developing

The quickest loop is a directory the server can read. With the Docker setup that means a path
inside the container:

```sh
docker compose cp ./my-plugin/. app:/tmp/my-plugin
```

then add `/tmp/my-plugin` in Add plugin. After an edit, run the same copy again and press
**Update** on the plugin's card, which reads the same path again. Keep the `/.`: without it, a
second copy lands inside the first (`/tmp/my-plugin/my-plugin`), and Update loads the old files.
`ctx.log(...)` goes to the server's log: `docker compose logs -f app`.

Or push the plugin to GitHub and install the folder's URL; **Update** fetches the branch again.

### Updating

**Update** on a plugin's card fetches it again from the source it was installed from, or the pin
the Community tab last moved it to. The new version is built and checked while the old one keeps serving, then swapped in; if anything
fails, the old one is untouched and you're told why. Everything saved for the plugin stays:
connections and keys, settings, defaults, and boards' choices of it.

- A listed plugin moves on through the Community tab: when its entry pins a different source
  from the one installed, its row offers **Update to** the entry's `version`, which installs from
  the new pin the same way and keeps everything saved. Any other move — another repository,
  another tag — means removing the plugin and adding it again, which deletes what it saved.
- The new version must keep its `id`, its `kind` and, for the two connector kinds, its `domain`.
- The factory can run twice in one process — the new version is built while the old one still
  serves — so don't start timers or other work in it that outlive the object it returns.
- A connector-domain should keep the fields and faces boards use: a board bound to a field the
  new version dropped can't be saved until the field is taken off it.
- A plugin that failed to load has **Retry** on its card instead. It does the same thing.

### Removing

**Remove** deletes a plugin's code and everything saved for it:

- an ai-provider: its connections (API keys and server URLs), any app default that names it,
  and boards' choices of it — those boards fall back to the app's defaults;
- a connector-provider: its API key, and the domain's default if it was this provider;
- a connector-domain: the same, and the domain. Its boards stop refreshing, and providers
  other plugins added to it stop working at once — their cards show them as failed to load;
- a source: its connections.

Boards keep their items in every case.

### Locking installs

`PLUGIN_INSTALL_DISABLE=1` in the server's environment refuses installs and updates from any
source except the bundled examples. Installed plugins keep loading, and Remove keeps working.
The Community tab's **Add** and **Update to** buttons are held too, and say why.

## ctx

<!-- pin: ctx -->
| member | what it is |
|---|---|
| `apiVersion` | `1`, the version of this contract the app speaks. |
| `fetchJson(url, options)` | `fetch`, returning the parsed JSON body. An answer that isn't 2xx throws an `Error` with `.status`, and `.retryAfter` when the response had a `Retry-After` header — the shape the app's retry rules read (see [Errors](#errors)). The message names the URL without its query string, so a key passed there stays out of it; the response body isn't kept, so call `fetch` yourself when you need an error's body. `options` are `fetch`'s; without a `signal`, it uses `providerSignal()`. It doesn't pace: see [Pacing](#pacing). |
| `wires` | `{ anthropic, compat, google }` — the app's AI protocol code, for an ai-provider to reuse. |
| `renderChart(series, { symbol, name, period })` | The app's price-chart card face: draws `series[].price` as a line and resolves `{ webp, w: 600, h: 360 }`. |
| `log(...args)` | `console.log` with `[plugin <id>]` in front. |
| `providerSignal(kind)` | An `AbortSignal` for one outbound request: `providerSignal()` gives an ordinary request 15 seconds, `providerSignal("bulk")` a slow bulk one 60 (`CONNECTOR_TIMEOUT_MS`, `CONNECTOR_BULK_TIMEOUT_MS`). |
| `providerBudgetMs(kind)` | That deadline, in milliseconds. |
| `num(value)` | `value` as a finite number — numeric strings included — or `null`. |
| `series` | The chart helpers — see [The chart helpers](#the-chart-helpers). |
| `createQuoteCache({ ttl, max, idOf })` | A cache of rows by id, for buying many ids in one request. `ttl` is in milliseconds (default 60,000), `max` is how many rows it keeps, dropping the oldest (default 20,000), and `idOf(row)` gives a row's id (default `row.id`). `warm(rows)` stores rows, `fresh(id)` returns a row younger than `ttl` or `null`, `missing(ids)` returns the ids that aren't fresh — as strings, without repeats — and `reset()` empties it. |
| `pickFields(fields, keys)` | The subset of a field map that `keys` ask for. A key the map lacks stays missing rather than becoming `null`, so build the whole map first — with `{ v: null }` for a field you can't serve — or `fetchFields` answers short (see [Methods](#methods)). |

Anything that belongs to one call — the API key, the rate limiter — arrives in that call's
arguments, never in `ctx`. `ctx` has no `id`: write the plugin's id in the code where it's needed.

## ai-provider

The factory returns a descriptor: facts about the vendor, and `wire`, the code that talks to
it. Most vendors speak OpenAI's chat-completions API, so a descriptor usually reuses the app's
own wire and brings only its address and quirks:

```js
export default function (ctx) {
  return {
    label: "Acme AI",
    description: "Acme's models, for tagging and search.",
    wire: ctx.wires.compat,
    base: "https://api.acme.ai/v1",
    rpm: 60, burst: 5,
    provides: {
      tag: { default: "acme-large", filter: "^acme-(?!embed)" },
      embed: { default: "acme-embed-1", filter: "embed" },
    },
    compat: { forceToolChoice: "required", strictTools: true, temperature: 0 },
  };
}
```

An admin then adds connections from the plugin's card — an API key, and a server URL for a
self-hosted vendor — and picks the plugin as an app default or for one board.

### provides

`provides` lists what the plugin does. What it leaves out, it doesn't do, even when its wire
has the method — every shared wire has `tag`.

<!-- pin: capabilities -->
| key | what | wire method |
|---|---|---|
| `tag` | Tagging, and with it field extraction and facet review, which run on taggers. | `tag` |
| `embed` | Embeddings, for semantic search. | `embed` |
| `transcribe` | Speech to text, for audio files. | `transcribe` |
| `detect` | Finding objects in images. | `detect` |
| `research` | `true` when the tagger can search the web before it tags, for boards that turn research on. Needs `tag`, and a wire that does it: `ctx.wires.anthropic`, `ctx.wires.google` or your own — the compat wire ignores it. | — |

Every capability but `research` is an object:

| field | |
|---|---|
| `default` | The model a picker starts on. Required for `tag`. |
| `models` | `[{ id, note }]` — models to recommend: listed first, and all a picker shows when the vendor's model list can't be read. Optional. For `transcribe` and `detect` it's also a limit: a model it doesn't name can't be saved, even one `filter` offers. |
| `filter` | A regular expression, as a string, matched against the ids the vendor lists — this capability's share of them. Without one, tagging offers every listed model and the other capabilities offer only `models`. |

A plugin declares at least one of `tag`, `embed`, `transcribe` and `detect`, and its wire has
the method for each one it declares.

### The descriptor

| field | |
|---|---|
| `label` | Required. Its name on the card and in every model picker. |
| `description` | The card's line. |
| `wire` | Required. `ctx.wires.compat`, `ctx.wires.anthropic` or `ctx.wires.google`; a copy of one with a method replaced — `{ ...ctx.wires.compat, async tag(desc, opts) { … } }`; or your own (see [Your own wire](#your-own-wire)). |
| `base` | The API root, such as `https://api.acme.ai/v1` — without the `/v1` for `ctx.wires.anthropic`, whose client adds `/v1/messages` itself. With `needsBase`, it's the server a connection uses when its URL is left blank; leave `base` out to make the URL required. |
| `needsBase` | `true`: each connection can carry its own server URL — a self-hosted server. |
| `keyless` | `true`: a connection needs no API key. It can still hold a token, for a proxy in front of the server, which arrives as `apiKey`. |
| `rpm`, `burst` | Required unless `onDevice`: requests per minute per API key, and how many may go at once before pacing starts. An admin can change both on the card. |
| `images` | `{ maxEdge, maxBytes }` — the largest image the model accepts: pixels on the long edge, and bytes. The defaults are 2048 and 4,000,000. |
| `prices` | `{ [model or "*"]: { [unit or "*"]: rate } }` — what calls cost, for the usage meter. A rate is microdollars per unit, which for tokens is the same number as dollars per million. Units: `requests`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `web_searches`, `audio_seconds`, `images`. A price an admin types in, or one `listPrices` reads, wins over these; a model nothing prices — here, there or in the community list — is metered without a price. |
| `priceNamespace` | The vendor's name in the community price list (LiteLLM's), when the models this plugin serves are that vendor's, at its prices. Leave it out for a self-hosted server. |
| `onDevice` | `true` for an embedder, transcriber or detector that runs inside the server, with no network: keyless, free, and no rate limit. |
| `compat` | Quirks for `ctx.wires.compat` and `ctx.wires.google` — below. |
| `nativeBase` | For `ctx.wires.google` with research on: the root of Gemini's own API. |

### The shared wires

`ctx.wires.compat` speaks OpenAI's API: `POST {base}/chat/completions` for tagging (as a tool
call), `/embeddings` and `/audio/transcriptions`, and `GET {base}/models`. The `compat` block
holds what differs between vendors. Every key is optional, and one set to `null` counts as left
out:

| key | default | |
|---|---|---|
| `maxTokensField` | `"max_tokens"` | The name of the output-cap field. OpenAI's newer models want `"max_completion_tokens"`. |
| `forceToolChoice` | off | `"required"` sends `tool_choice: "required"`; `true` names the tool; off leaves it to the model, and a reply that skips the tool fails the attempt. |
| `strictTools` | off | Sends `strict: true` on the tool, so turn it on only for a vendor that takes it: the wire drops it and remembers only when a refusal says the schema is too big to compile strictly, and any other refusal fails the item. |
| `disableThinking` | off | Sends `thinking: { type: "disabled" }`. |
| `temperature` | none | Sent when set. If a model refuses it, the wire drops it and remembers. |
| `noTemperature` | none | A regular expression of model ids never sent a temperature. |
| `keyTest` | `"list"` | How **Test** checks a connection: `"list"` reads `/models`; `"completion"` makes a one-token chat call, for a vendor without `/models`; anything else reads `/models/<model>`. |
| `listModels` | on | `false` for a vendor without `/models`: pickers show your `models` lists. |
| `stripListPrefix` | none | A prefix to take off listed ids — `"models/"` for Gemini. |
| `priceFields` | none | `{ [vendor's pricing field]: unit }`: read prices, in dollars per unit, from each listed model's `pricing` object. |

The compat wire can't read PDFs, and says so when a board sends one.

`ctx.wires.anthropic` speaks Anthropic's Messages API and reads no quirks.
`ctx.wires.google` is the compat wire, plus Gemini's own API at `nativeBase` for research.

### Your own wire

A wire is an object of methods, each called with the descriptor first. Write the ones for the
capabilities you declare, and `testKey`:

| method | called with | returns |
|---|---|---|
| `tag(desc, opts)` | `{ apiKey, base, model, systemText, schema, parts, tool, research }` | `{ input, usage }` |
| `embed(desc, opts)` | `{ apiKey, base, model, texts }` | `{ vectors, usage }` |
| `transcribe(desc, opts)` | `{ apiKey, base, model, audio, filename }` | `{ text, turns, usage }` |
| `detect(desc, opts)` | `{ apiKey, base, model, image, queries, threshold }` | `{ objects, usage }` |
| `testKey(desc, opts)` | `{ apiKey, base, model }` | resolves when the connection works |
| `listModels(desc, opts)` | `{ apiKey, base }` | `[{ id, note }]`, or `null` |
| `listPrices(desc, opts)` | `{ apiKey, base }` | `[{ model, unit, dollarsPerUnit }]`, or `null` |

- `apiKey` is `null` on a connection without one. `base` is the connection's server URL, or
  missing — use `desc.base` then.
- The app puts no deadline on a wire call, so give each request one
  (`signal: AbortSignal.timeout(…)`): a call that never answers holds its key's slot until the
  server restarts. The shared wires allow a chat call 180 seconds, an embedding 60 and a
  transcription 240; `ctx.fetchJson`'s own 15 seconds is sized for data providers.
- `tag`: `systemText` is the instructions and `parts` the item — `{ kind: "text", text }`,
  `{ kind: "image", mediaType, b64 }` or `{ kind: "document", mediaType: "application/pdf", b64 }`.
  Have the model call one tool, named `tool.name` and described by `tool.description`, whose
  input matches the JSON Schema `schema`, and return that input as `input`. With no `tool`, the
  name is `record_tags`; field extraction and facet review pass their own. `research` is `true`
  only if you declare it and the board has it on.
- `embed`: one vector per text, in order, as arrays or `Float32Array`s. The app scales each to
  unit length.
- `transcribe`: `audio` is a `Buffer`, and `filename` carries the file's extension. `turns`,
  when you have them, are `[{ start, end, text, speaker }]` in seconds; `speaker` is optional.
- `detect`: `image` is a `Buffer` — a JPEG, except for **Test**'s small PNG and an image the
  app couldn't re-encode, which arrives as it was — and `queries` the names of what to look
  for. Each object is `{ label, box: [x1, y1, x2, y2], score }` — the box and the score between
  0 and 1, and the label one of the queries. `threshold` is the lowest score worth returning.
- `testKey`: resolve if the key or server works; throw a readable error if not. `model` is
  usually `null` — the Test button picks none — so test with your default.
- `listModels` may fail: throw or return `null`, and pickers fall back to your `models`.
- `usage`: `{ input, output, cacheRead, searches }` — input tokens not read from cache, output
  tokens, input tokens read from cache, and web searches. Report what the vendor reports; zeros
  are fine. The app counts audio seconds and images itself.

If the vendor can never take an input — an image, for a text-only model — throw with `status`
422 so the item fails once instead of being retried. The DeepSeek example does exactly this.

## connector-provider

A connector provider fetches live data for a domain — `crypto`, `stocks`, or one a
connector-domain plugin added. The domain decides what an item's fields are; the provider fills
them.

```js
export default function (ctx) {
  const BASE = "https://api.example.com/v1";
  return {
    label: "Example Markets",
    rpm: 30, burst: 5,
    async fetchEntity(id) {
      const coin = await ctx.fetchJson(`${BASE}/coins/${encodeURIComponent(id)}`);
      return {
        id: coin.id,
        symbol: coin.symbol,
        display_name: coin.name,
        fields: { price: { v: ctx.num(coin.price_usd), kind: "number" } },
      };
    },
    async search(symbol) {
      const hits = await ctx.fetchJson(`${BASE}/search?symbol=${encodeURIComponent(symbol)}`);
      return hits.map((h) => ({ id: h.id, symbol: h.symbol }));
    },
    async list({ page, pageSize }) {
      const rows = await ctx.fetchJson(`${BASE}/coins?page=${page}&per_page=${pageSize}`);
      return rows.map((c) => ({
        id: c.id, symbol: c.symbol, label: c.name,
        values: { name: c.name, price: ctx.num(c.price_usd) },
      }));
    },
  };
}
```

Its manifest names the domain: `"kind": "connector-provider", "domain": "crypto"`. At install,
the app checks that `label`, `rpm` and `burst` are there, that `fetchEntity` and `search` are
functions, and that every optional method you define is one.

### Items

An item is what `fetchEntity` returns, as in the example above:

- `id` is your id for it. Give it as a string: the app stores it and passes it back to your
  other methods as one.
- `symbol` is what makes it the same item under another provider: an item on a board is known
  by its symbol, lowercased — or by your `id` when it has none. Providers of one domain have to
  agree on symbols, or a board that switches providers finds its items strangers. Two items with
  one symbol are one item on a board: adding the second is refused as a duplicate. The symbol
  shows under the name in the browse table, on a card's plain tile and on the built-in chart
  face. An item without one can't be found again after a switch, and gets no live chart.
- `display_name` names the card.
- `fields` is keyed by the domain's field names (`fn` — see
  [the built-in domains](#the-built-in-domains)). Each value is `{ v, kind }`: `v` is a number
  for a `number` field, a string for `text`, the address as a string for `url`, epoch
  milliseconds for `date`, or `null`. A field you can't serve can be left out.

### Methods

Every method's last argument — `call` below — is `{ apiKey, pace }`: the provider's stored key,
or `null`, and its rate limiter (see [Pacing](#pacing)).

<!-- pin: provider-methods -->
| method | required | called with | returns |
|---|---|---|---|
| `fetchEntity(id, call)` | yes | an id from `list` or `search` | the item |
| `search(symbol, call)` | yes | a symbol | `[{ id, symbol }]` |
| `list(opts, call)` | no | `{ sort, order, page, pageSize, query, …filters }` | `[{ id, symbol, label, values }]` |
| `fetchFields(id, fns, call)` | no | an id and the field names due for a refresh | `{ fields }` |
| `prefetch(ids, call)` | no | the ids the app is about to ask for | nothing |
| `history(id, period, call)` | no | an id and one of the face's periods | `[{ t, price }]` |
| `chart(id, { range, kind }, call)` | no | an id, and a range and kind from the domain's `chart` | a series — see [chart()](#chart) |
| `filterOptions(call)` | no | nothing | `{ [filter key]: [value, or { value, label }] }` |
| `testConnection(call)` | no | nothing | resolves when the key works |

- `fetchEntity` runs when an item is added, and again when someone refreshes it by hand. An id
  you don't know should throw with `status` 404.
- `search` finds an item again after a board's domain has switched to your provider. The id it
  finds isn't kept, so it's asked each time an item added under another provider is refreshed,
  drawn or charted: keep it cheap. It's asked with the item's symbol, and the app takes the
  first hit whose symbol matches, ignoring case — or else the first hit. If your API's search is
  loose, return only exact matches: an empty answer means you don't have the item, and you
  won't be asked to refresh it.
- `list` fills the browse table, which is the only way to add items from the UI, and it's what a
  board's automatic ingestion (a feed) walks: on a schedule, the app pages through `list`,
  filters the rows itself, and adds what passes. Without `list`, browsing shows nothing while
  your provider is the domain's default, and feeds refuse to run.
  - `sort` is one of the domain's sort keys, and `order` is `"asc"` or `"desc"` (the browse
    table starts descending). `page` starts at 1. The browse table takes a page shorter than
    `pageSize` as the last, but a feed stops only at an empty one, so answer `[]` past the end.
  - `query` is what the user typed into the browse box, and each of the domain's filters
    arrives under its own key, as one value. Only the browse window sends those: a feed asks
    with `sort`, `order`, `page` and `pageSize` alone, and filters what comes back itself.
  - `label` is the row's name in feeds and the ingest preview. `values` is keyed by the
    domain's browse columns: numbers for `number`, `usd` and `percent` columns — a percent is a
    percentage, so 1.5 is 1.5% — and strings for `text`. The browse table names a row, and an
    added item, by its `primary` column's value, so set that to the same name.
- `fetchFields` makes refreshes cheap. `fns` is an array of the domain's field names; return
  `{ fields }` with an entry, `{ v, kind }`, for every one — `{ v: null }` counts. If one is
  missing, the app calls `fetchEntity` instead.
- `prefetch` runs before the app asks for two or more ids at once — a refresh, a bulk add, a
  feed's new items: buy them in one request and cache them (`ctx.createQuoteCache`). An error
  there fails nothing, but it counts like any other (see [Errors](#errors)).
- `history` feeds the domain's card face, oldest point first: `t` is epoch milliseconds and
  `price` the value drawn. It runs when a card's face is drawn — when the item is added, then as
  often as the board's face refreshes, if it does. If you can't serve a period, return `[]` and
  the card keeps its plain tile. A throw does that too, but counts as an error (see
  [Errors](#errors)). Either way you're asked again later — on the face's cadence, or hourly.
- `filterOptions` runs whenever the browse window opens, and for each page asked for with a
  filter set, so cache what it returns. Give values as strings: a bare number is dropped, and a
  `{ value }` that isn't a string never matches what's picked.
- `testConnection` is the card's **Test** button. For an API with no key, make it a check that
  the API answers.

How often the rest run is up to the board: each field refreshes on its own `refresh` cadence
(`fetchFields`, else `fetchEntity`).

### Other fields

| field | |
|---|---|
| `label` | Required. The card's name. |
| `rpm`, `burst` | Required. Requests per minute, and how many may go at once before pacing starts — for the provider as a whole: every board and every key share them. An admin can change both on the card. |
| `description` | The card's line. |
| `needsKey` | `true` when the provider can't work without an API key: the card marks the key as required, the provider can't become the domain's default without one, and the domain shows as blocked while it's missing. Without it, the card still offers a key, as optional, and an API with no keys can ignore `apiKey`. |
| `keylessRpm` | The rate to use while no key is stored, if it's lower. |
| `pacesRequests` | `true` when you call `pace()` yourself — see below. |
| `attribution` | `{ text, url }`: a credit shown under the browse table and the chart. |
| `maxPageSize` | The largest page a feed asks `list` for. Default 250. |
| `honorsSorts` | The sort keys your `list` really sorts by, both ways. A feed that filters on one of them can stop walking early, so a key your API sorts only one way, listed here, loses rows. |

To serve boards, a provider has to be its domain's default: **Make default for …** in its
settings on the Plugins page. The API key is stored there too, and passed to every call as
`apiKey`.

### Pacing

By default the app waits for the rate limiter once before each method call, retries included,
and counts it on the usage meter — even when your method answers from its own cache. With
`pacesRequests: true` on the provider, the app leaves pacing to you in every method: call
`await pace()` (no arguments) before each request you make. Each call waits for the rate limiter
and counts one request on the meter, and a method that answers from a cache calls nothing and
costs nothing.

### The built-in domains

A provider for crypto or stocks fills these. Symbols are tickers (`BTC`, `AAPL`); case doesn't
matter.

Crypto's fields:

<!-- pin: fields crypto -->
| `fn` | kind | |
|---|---|---|
| `price` | number | Price (USD) |
| `market_cap` | number | Market cap (USD) |
| `change_1h` | number | 1h change (%) |
| `change_24h` | number | 24h change (%) |
| `change_7d` | number | 7d change (%) |
| `change_30d` | number | 30d change (%) |
| `volume` | number | 24h volume (USD) |
| `rank` | number | Market cap rank |
| `ath` | number | All-time high (USD) |
| `circulating_supply` | number | Circulating supply |
| `url` | url | Market page |

<!-- pin: browse crypto -->
| | crypto |
|---|---|
| `list` values | `rank` (number), `name` (text), `price` (usd), `change_24h` (percent), `change_7d` (percent), `market_cap` (usd), `volume` (usd) |
| sorts | `market_cap`, `volume`, `price`, `name` |
| filters | `category` |
| `history` periods | `24h`, `7d`, `30d`, `90d`, `1y` |
| `chart` ranges | `1d`, `5d`, `1m`, `6m`, `ytd`, `1y`, `5y`, `max` |
| `chart` kinds | `area`, `candles` |
| `chart` default range | `1y` |

Crypto's `category` filter gets its values from the provider's `filterOptions()`; without it,
there's no category control. A board made from crypto's template binds every field above, none
refreshing until the board turns it on, and draws a `1y` price chart as the card's face.

Stocks' fields:

<!-- pin: fields stocks -->
| `fn` | kind | |
|---|---|---|
| `price` | number | Price (USD) |
| `change_1d` | number | Daily change (%) |
| `market_cap` | number | Market cap (USD) |
| `volume` | number | Volume |
| `pe_ratio` | number | P/E ratio |
| `dividend_yield` | number | Dividend yield (%) |
| `sector` | text | Sector |
| `industry` | text | Industry |
| `exchange` | text | Exchange |
| `currency` | text | Currency |
| `website` | url | Company website |

<!-- pin: browse stocks -->
| | stocks |
|---|---|
| `list` values | `rank` (number), `name` (text), `price` (usd), `market_cap` (usd), `volume` (number), `type` (text), `sector` (text), `exchange` (text) |
| sorts | `market_cap`, `volume`, `price`, `name` |
| filters | `type`, `sector`, `exchange`, `industry` |
| `history` periods | `7d`, `30d`, `90d`, `1y`, `5y` |
| `chart` ranges | `1d`, `5d`, `1m`, `6m`, `ytd`, `1y`, `5y`, `max` |
| `chart` kinds | `area`, `candles` |
| `chart` default range | `1y` |

Stocks' `type` and `sector` filters have fixed values; `exchange` and `industry` come from
`filterOptions()`.

## connector-domain

A connector-domain adds a new kind of live data: its fields, a board template, a browse table,
a live chart and a card face. It brings its first provider, which is the plugin itself; more
providers for it are connector-provider plugins that name its `domain`.

```js
export default function (ctx) {
  const provider = { label: "Acme Weather", rpm: 30, burst: 5, search, fetchEntity, list, history };
  return {
    providers: { "acme.weather": provider },  // exactly one, keyed by manifest.json's id
    defaultProvider: "acme.weather",
    manifest: {                                // the domain manifest
      label: "Weather",
      fields: [/* … */],
      template: {/* … */},
      browse: {/* … */},
      faces: [{ name: "chart", label: "Temperature", periods: ["7d", "30d"], requires: "history" }],
    },
    faces: { chart: "price-chart" },           // each face → the producer that draws it
  };
}
```

manifest.json has `"kind": "connector-domain", "domain": "weather"`. The factory's `manifest`
is a different thing — the *domain manifest*, below. `ctx` doesn't carry the plugin's id, so the
provider's key and `defaultProvider` repeat manifest.json's `id`.

The provider follows the [connector-provider](#connector-provider) contract, and it serves the
domain from install: it's the domain's default provider until an admin makes another one the
default.

The domain's name — manifest.json's `domain` — shows on the card's tag, capitalized on a
board's toolbar, and in the browse window's search box. It can't be one that already exists —
`crypto`, `stocks`, or another plugin's — so pick a specific one that reads well. Nor can it be
one of these:

<!-- pin: reserved-domains -->
| name | why |
|---|---|
| `ai` | a family of plugins has the name |
| `media` | a family of plugins has the name |
| `source` | a family of plugins has the name |
| `embed` | its default-provider setting is the AI embedder's |
| `transcribe` | its default-provider setting is the AI transcriber's |
| `detect` | its default-provider setting is the AI detector's |

### The domain manifest

| key | |
|---|---|
| `label` | Required. The domain's name: in the board editor's templates, on the browse window, on the Capabilities tab. |
| `description` | Its line on the Capabilities tab. |
| `fields` | The catalog: `[{ key, kind, fn, label, note, group }]`. `fn` is the name providers fill, and `key` the name on a board — lowercase letters, digits and `_`, starting with a letter. Use the same word for both. `kind` is `text`, `number`, `url` or `date`. `label`, `note` and `group` show in the board editor. Units go in the label ("Temp (°C)"): nothing else carries one. |
| `identity` | `{ blurb }`: what one card is, in the board editor's words — "each city is its own card". |
| `template` | The board a user starts from. Needed in practice: the board editor binds a board to a domain only through its template. |
| `browse` | The browse table. Needed in practice: it's the only way to add items from the UI, and what feeds walk. |
| `chart` | `{ ranges, kinds, defaultRange }` for the lightbox's live chart — see [chart()](#chart). |
| `faces` | `[{ name, label, periods, requires }]`: the card faces a board can pick — see [faces](#faces). |

A field, column, sort, filter or face without a `label` is shown by its key. A `null` counts as
absent for every optional key above — but not inside `template`, which is checked the way a
board's save is: leave a key out there instead.

### template

The template is a board's field setup, in the shape a board saves:

```js
template: {
  input: { connector: "weather" },
  fields: [
    { key: "temp", source: "connector", kind: "number", fn: "temp", refresh: { every: 60 } },
  ],
  face: { source: "connector", producer: "chart", period: "30d" },  // optional
}
```

The app checks it at install with the rules a board's save uses:

- `input.connector` is the domain's own name. Nothing but `input`, `fields` and `face` belongs
  at the top.
- Field keys are lowercase letters, digits and `_`, start with a letter, and don't repeat.
- A `connector` field names a catalog entry by `fn`, with that entry's `kind`, and may refresh
  every so many minutes (`refresh: { every }`, 1–43200). A field without `refresh` is filled
  when an item is added, and when someone refreshes it by hand.
- Boards may add AI-extracted fields of their own (`source: "extract"`); a template doesn't
  need any.
- `face`, if any: `producer` is a face's **name** from the domain manifest's `faces` — not the
  producer that draws it — and `period` one of that face's periods.

### browse

```js
browse: {
  columns: [
    { key: "name", label: "City", kind: "text", primary: true },
    { key: "temp", label: "Temp (°C)", kind: "number", preview: true,
      presets: [{ label: "Above 20°", op: "gte", value: 20 }] },
  ],
  sorts: [{ key: "temp", label: "Temperature" }],
  defaultSort: "temp",
  pageSize: 50,
  filters: [{ key: "country", label: "Country", from: "provider" }],
}
```

`columns`: `key` names the value in each `list` row's `values`, and `kind` says how it's drawn
and filtered:

<!-- pin: column-kinds -->
| kind | |
|---|---|
| `text` | |
| `number` | |
| `usd` | a dollar amount |
| `percent` | a change, in percent — 1.5 shows as "+1.50%", green, and -2 as "-2.00%", red. A percentage that isn't a change, like humidity, reads better as `number` with "%" in its label. |
| `date` | epoch milliseconds; filters as a date, and the browse table leaves it blank for now |

- `primary` makes the column the row's name, and the name an added item starts with.
- `preview` puts the column in the ingest dialog's preview.
- `presets` are ready-made thresholds for a `number`, `usd` or `percent` column, each
  `{ label, op, value }`: `op` is `gte` or `lte`, `value` a number, and a preset missing one is
  dropped. Picking one in the ingest dialog adds that filter, which the app applies to what
  `list` returns.
- `width` is in pixels.
- `sorts` are what the browse table and feeds can sort by; `list` gets the key as `sort`.
  `defaultSort` is the browse table's first sort (feeds start on the first of `sorts`), and the
  board's default card order when a field with the same key is on it.
- `pageSize` is the browse table's page: 50 by default, 100 at most.
- `filters`: each has a `key` and either `options` — `[value, or { value, label }]`, values as
  strings — or `from: "provider"`, when the provider's `filterOptions()` supplies them. The
  value picked in the browse window reaches `list` under the filter's key.

### faces

A face is a picture on a card instead of its plain tile, drawn from the provider's
`history(id, period)`. The domain manifest lists the faces a board can pick, and the module maps
each one to the producer that draws it:

```js
// the domain manifest
faces: [{ name: "chart", label: "Temperature", periods: ["7d", "30d"], requires: "history" }],
// the module
faces: { chart: "price-chart" },
```

- `requires` is `"history"`, the one method a face is drawn from. It tells the board editor
  whether the domain's default provider can draw the face.
- `periods` are what `history` is asked for. They're strings, shown as written in the board
  editor, and nothing in the app parses them; a face without periods is asked with `undefined`.
  `history` isn't told which face is asking, so give two faces different period names.
- `price-chart` is the app's producer (the same function as `ctx.renderChart`): it draws the
  points' `price` in order as a line — green if it ends at or above where it started, red if
  below — with `symbol`, `name` and `period` printed on it, and no currency or percentage.
  Any number works as `price` — a number, not a numeric string — and `t` isn't read, so future
  points are fine.
- A producer of your own: list its name in manifest.json's `faceProducers`, an array of names —
  each the plugin's `id`, or `<id>.` followed by letters, digits, `.`, `-` or `_` — and return
  the function in the module's `faceProducers`:

  ```js
  faceProducers: {
    "acme.weather.forecast": async (series, { symbol, name, period }) =>
      ctx.renderChart(series, { symbol, name: `${name} · forecast`, period }), // or { webp, w, h }, or null
  },
  ```

  `series` is what `history` returned. Return a WebP `Buffer` and its size, or `null` to keep
  the plain tile. `ctx` has no image encoder but `renderChart`, so a face that isn't a chart
  needs one as a dependency — and a native one may need `allowScripts`.

### chart()

The lightbox's live chart calls the default provider's `chart(id, { range, kind })` with a range
from `chart.ranges` and a kind from `chart.kinds`: `"candles"`, or anything else, which is drawn
as an area. It opens only on a board whose card face is one of the domain's `faces`, and only
for an item with a `symbol` — a domain without `faces` never has `chart()` called. It returns:

```js
{ time: "daily", tz: "utc", points: [{ d: "2026-09-25", p: 67012.5 }] }
```

- `time` is `"daily"` (points carry `d`, a date) or `"intraday"` (points carry `t`, epoch
  milliseconds). Points run oldest first, with `p` for an area and `o`, `h`, `l`, `c` for
  candles.
- `tz`: `"local"` shows an intraday chart's times in the viewer's time zone; `"utc"` shows them
  in UTC, as given. Daily charts show dates as given either way.
- A range or kind the source can't serve — a plan limit, an endpoint it doesn't have — is an
  answer, not a failure: throw `ctx.series.unsupported("why")`. The app remembers that range
  and kind together, for six hours per provider and key, stops offering the pair, and serves
  the range in its other kind — or, with none left, `chart.defaultRange`, and failing that the
  last range still offered. Only `chart()` can answer this way; thrown anywhere else, it's an
  ordinary error.
- The app doesn't cache chart answers; cache them yourself if your source is metered
  (`ctx.series.createTtlCache`, with `CHART_TTL_LIVE` and `CHART_TTL_SETTLED` as lifetimes).

### The chart helpers

`ctx.series` holds the helpers the built-in providers shape their charts with:

<!-- pin: series -->
| helper | |
|---|---|
| `unsupported(message)` | The refusal above: an `Error` the app reads as "this range and kind can't be served". |
| `encodeArea(points, { daily, tz })` | `[{ t, p }]` rows (`t` in epoch milliseconds) → an area series. With `daily`, each `t` becomes its UTC date. Sorts, keeps the last point per time, and thins an intraday series to 2,000 points. |
| `encodeCandles(bars, { daily, tz })` | `[{ t, o, h, l, c }]` bars → a candle series. Sorts and keeps the last bar per time; a daily series longer than 400 bars is merged into weeks, then months. |
| `dedupeAscending(points, key)` | Sorts by `key` (`"t"` or `"d"`) and keeps the last point per time. |
| `strideArea(points, max)` | Thins an area series to at most `max` points (2,000 by default). |
| `aggregateCandles(candles, max)` | Merges daily candles (`{ d, o, h, l, c }`) into weeks when there are more than `max` (400 by default), and into months when weeks are still too many. Months are as far as it goes, so the result can pass `max`. |
| `utcDate(t)` | Epoch milliseconds → `"YYYY-MM-DD"`, in UTC. |
| `ytdDays()` | Days since 1 January UTC — the length of `ytd`. |
| `createTtlCache(max)` | A small cache: `get(key)`, `put(key, value, ttlMs)`, `reset()`. Keeps at most `max` entries (200 by default), dropping the oldest. |
| `walkLadder(rungs, memory, key, isGate, tryRung)` | Tries `rungs` in order until `tryRung(rung)` answers, stepping past each error `isGate(error)` recognizes as a plan limit; remembers the winning rung in `memory` (a `createTtlCache`) under `key`. Resolves `{ value, rung }`, or `null` when every rung was gated. |
| `keyFingerprint(apiKey)` | A short, one-way stamp of a key, for keying what you learn per key. |
| `CHART_TTL_LIVE` | 60 seconds: how long an intraday chart, whose newest point still moves, stays fresh. |
| `CHART_TTL_SETTLED` | 5 minutes: how long a daily chart, where only the last bar moves, stays fresh. |
| `CHART_LEARN_TTL` | 6 hours: how long a learned refusal is trusted. |

### What a domain assumes today

The domains so far are market data, and that shows:

- An item is known by its `symbol`, so give every item a stable one — and write down what your
  domain's symbols are, so another provider can match them.
- A face is drawn from `history()`, and the built-in face charts `price`.
- Numbers read as money outside the browse table. The lightbox lists a card's fields by key,
  and shows a number as a signed percentage when its key says `change`, `pct` or `percent`, and
  in dollars when its key says `price`, `market_cap` or `volume`, or when it's 1 or more — so
  `temp: 21.5` reads "$21.50". The live chart's prices are in dollars.

### Removing it

Removing a connector-domain plugin removes the domain. See [Removing](#removing).

## source

A source is a place a board's ingestion reads files from. The factory returns:

```js
export default function (ctx) {
  return {
    manifest: {
      name: "acme.webdav",  // the manifest's id
      label: "WebDAV",
      needsConnection: true,
      browsable: true,
      connectionSchema: [
        { key: "url", label: "Server URL", type: "text", required: true },
        { key: "password", label: "Password", type: "secret" },
      ],
      sourceSchema: [
        { key: "path", label: "Folder" },
        { key: "recursive", label: "Include subfolders", default: true },
      ],
    },
    backend: ({ source, conn }) => ({
      async list(opts) { /* … */ return { entries: [], truncated: false }; },
      async fetch(key, tmpPath) { /* … */ },
      async test() { /* … */ },
    }),
  };
}
```

### The source manifest

| key | |
|---|---|
| `name` | Required: the manifest's `id`. |
| `label` | Required. Its name on the card and in the ingest dialog. |
| `description` | The card's line. |
| `needsConnection` | `true`: an admin adds connections — a server, credentials — on the plugin's card, and each board picks one. `connectionSchema` is then required; without `needsConnection`, it must be left out. |
| `browsable` | `true`: `list` can walk folders, so the ingest dialog shows a folder tree. Otherwise the user types a path. |
| `connectionSchema` | The connection form: `[{ key, label, type, default, required, min, help }]`. `key`, `label` and `type` are required. `help` is a text or number field's placeholder, a toggle's note, and a secret's placeholder while nothing's stored and it isn't `required`; `required` applies to text and secret fields, `min` to numbers. |
| `sourceSchema` | A board's settings. The ingest dialog draws the entry keyed `path` — its `label` names the field — and the one keyed `recursive`, a switch that's on unless its `default` is `false`. Other entries only contribute their `default`. |

A connection field's `type`:

<!-- pin: connection-field-types -->
| type | |
|---|---|
| `text` | |
| `number` | |
| `secret` | stored with spaces trimmed from both ends; an admin sees whether it's set, never its value |
| `toggle` | |

Labels are shown as HTML, so keep them plain text.

### backend({ source, conn })

The app calls `backend` afresh for each job — a listing, a download, a Test — with:

- `source`: the board's saved settings for the source — `{ type, connectionId, path, recursive }`
  and any other `sourceSchema` defaults. `path` is saved without a trailing `/`. While someone
  is browsing, `source` is only `{ type, connectionId, path }`, with `path` the folder open —
  nothing else is saved yet.
- `conn`: the connection's saved values, secrets included. It's absent for a source without
  connections. A field your `connectionSchema` gained in a later version is missing from
  connections saved before it, so fall back to its default yourself.

It returns:

| method | called with | returns |
|---|---|---|
| `list(opts)` | `{ path, recursive, limit, accept, maxBytesFor, includeDirs }` | `{ entries, truncated }` |
| `fetch(key, tmpPath)` | an entry's `key`, and a path that doesn't exist yet | nothing — write the file to `tmpPath` |
| `test()` | nothing | resolves when the connection works |

- Each entry is `{ type, key, name, path, size, modified, created }`: `type` is `"file"` or
  `"dir"`; `size` is in bytes; `modified` and `created` are epoch milliseconds (a fraction is
  rounded away), or `null`. `name` is the file's name, and its extension decides how the app
  reads the file. `path` is where it is, for browsing and path filters.
- `key`, a string, is the file's identity on a board: a key seen before isn't ingested again
  unless its `size` or `modified` changed (a `null` skips that check). Keep keys stable between
  listings.
- `accept(name)` says whether the app can ingest a file of that type, and `maxBytesFor(name)`
  gives its size limit. Leave out what fails either, and count only what passes toward
  `limit`. Set `truncated: true` when you stopped at `limit`. While someone is browsing, both
  let everything through.
- `includeDirs` is `true` when someone is browsing: list the folders too, and don't recurse.
- `test()` is a connection's **Test** button. It's called as `backend({ conn }).test()`, with no
  `source`, and never for a source without connections.
- A `list` that throws fails that run, and a scheduled board tries again 5 minutes later. While
  browsing, an error with `notFound: true` sends the folder tree up a level. A `fetch` that
  throws leaves that file for the next run.

A run lists once, then fetches at most 25 new files (`INGEST_RUN_CAP`). Boards run on demand,
continuously (every 30 seconds), on an interval or daily.

## Errors

Throw an `Error`; give it a `status` when you know one. `ctx.fetchJson` does this for you.

- A 4xx other than 408 and 429 is about this request, so the item fails at once, with your
  message. Throw 404 for an id you don't know, and 422 for an input you can never take.
- A 429, 408, 5xx, or no status at all, is treated as temporary: the item is tried again after
  1, 5 and 15 minutes, five attempts in all. Set `retryAfter` (seconds) to ask for a longer wait,
  up to an hour.
- Transcription works differently. An error that isn't a 429, 408 or 5xx, and isn't marked
  `transient: true`, stops the clip until someone reprocesses it. A temporary one pauses
  transcription for a minute — for a hosted provider, everything on that API key, tagging
  included — and the clip is tried again, with no limit.
- Embeddings: when a batch fails with a 4xx other than 401, 403, 404, 408 and 429, its texts are
  retried one at a time, and each that fails alone is skipped from then on — if at least one
  succeeds. Otherwise, and for every other failure, a batch of one text included, embedding
  pauses for a minute — for a hosted provider, everything on that API key, tagging included —
  and the batch comes back.
- Connector providers: the app retries a 429 or 401 up to three times on the spot, and a 429
  also lowers the provider's rate for a while. After that, a 429, a 5xx or an error with no
  status pauses the whole provider for a minute.

Error messages reach admins and board members, so keep keys out of them.

## Versions

`apiVersion` is `1`. The app refuses a plugin whose `apiVersion` it doesn't speak, and says so
on the card; on the Community tab, a listing written for one it doesn't speak shows **Needs a
newer app**. Additions to the contract — a new `ctx` member, a new optional field — keep the
number; a change that would break a working plugin changes it.

`ctx` as listed here is the baseline. Its last six members, `providerSignal` to `pickFields`,
are newer than the rest, and an app image from before them doesn't have them. Calling one
there throws where the call runs — at load, with the error on its card, if the factory makes
it. A plugin that has to run on older images can check for a member before using it
(`if (ctx.pickFields) …`). Members added from now on will say when they arrived.

## Sharing a plugin

Publish the directory in any form [Installing](#installing) takes, and anyone can paste it into
Add plugin. A commit is a fixed install. A tag usually is, but it can be moved, and a branch
moves with every push. To have your plugin show up on every app's Community tab, get it listed.

### Getting listed

The Add plugin dialog's **Community** tab reads [community/plugins.json](community/plugins.json)
in this repository: a list of pointers at plugins other people wrote. To add yours, open a pull
request adding an entry to its `plugins`, and leave the file's own `apiVersion` as it is:

<!-- pin: list-example -->
```json
{
  "id": "acme.tides",
  "kind": "connector-domain",
  "domain": "tides",
  "label": "Tides",
  "description": "Tide heights for harbours worldwide — no key needed.",
  "author": "acme",
  "version": "1.2.0",
  "apiVersion": 1,
  "source": "github:acme/001az-tides@3f2a9c1e7b0d4a5f6c8e9d0b1a2c3d4e5f6a7b8c"
}
```

<!-- pin: list-fields -->
| field | |
|---|---|
| `id`, `kind`, `label`, `apiVersion` | Your manifest's, exactly. |
| `domain` | Your manifest's. |
| `description` | Shown under the label. Yours to write: it can be shorter than the manifest's. |
| `author` | Your name or handle, shown under the description. |
| `version` | Shown on the row and on its **Update to** button. If your manifest names a version, the two must be the same; if it doesn't, the label is yours to choose. |
| `source` | Where the plugin installs from, pinned: `github:owner/repo@<commit>` — `github:owner/repo/path/to/folder@<commit>` for a plugin in a folder — with the full 40-character commit, or `npm:name@<version>` with an exact version. |

Every field is required, `domain` only for the two connector kinds. Any other field is ignored.

The source is pinned because a listing is checked once, and what it points at must not change
after that: a commit can't, and neither can a published npm version.

**The check.** Every pull request that touches the file runs a check; the first time you
contribute, GitHub may hold it until a maintainer approves it. It downloads each entry that's new
or changed, the way the app installs it, and reads the manifest — it never runs the plugin's
code, and never runs npm. It fails when:

- the file isn't valid JSON, or an entry lacks a field or has one of the wrong type;
- a source isn't pinned as above;
- two entries would install as the same plugin, or an entry would install as one of the app's
  bundled examples;
- the download fails, or its `manifest.json` breaks a rule of [manifest.json](#manifestjson);
- the manifest's `id`, `kind`, `label`, `apiVersion` or `domain` isn't the entry's, or it names
  a `version` that isn't;
- GitHub's download comes from another commit than the pinned one, or npm's doesn't match the
  registry's integrity hash.

It prints one line per problem and exits with 1 when there are any; once it gets through the
file, it ends with how many entries it downloaded and how many problems it found. It can't catch
a factory that throws, or a provider missing a method it needs, so install your pinned source in
an app of your own before you open the pull request.

To run it before you open the pull request, in a clone of this repository with your entry added:

```sh
npm ci
node scripts/check-plugin-index.mjs community/plugins.json
```

Run that way, it downloads every entry in the file. Add `--base` with a copy of the file from
before your change, and it downloads only the entries that are new or changed, as the pull
request's check does: `node scripts/check-plugin-index.mjs community/plugins.json --base before.json`.

Then a maintainer reads the entry and merges it — a review of the pointer, not an audit of the
code. A merged entry reaches every app within about a quarter of an hour — GitHub caches the file
for a few minutes, and each app reads it at most every ten.

**Shipping an update.** Open a pull request changing your entry's `source` to the new commit or
version, and its `version` to match. Once it's merged, apps that have your plugin show
**Update to 1.3.0** on its Community row — see [Updating](#updating).
