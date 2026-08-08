# DeepSeek plugin

Tag **text** with [DeepSeek](https://deepseek.com) V4 models. This is also the reference
example of a **keyed, hosted** ai-provider plugin whose vendor diverges from the OpenAI
defaults — the whole plugin is a descriptor plus a quirk block, with no protocol code (the
Ollama plugin next door covers the keyless self-hosted shape).

> **DeepSeek cannot tag images.** There is no vision model on their API — V4 accepts only
> `text` content parts and rejects any image with
> `400 … unknown variant 'image_url', expected 'text'`. Verified on both `v4-flash` and
> `v4-pro`. **Do not make this the default tagger for a board of images**, or every item on
> it will fail. Use it on text and document boards, and leave image boards on a
> vision-capable tagger (Anthropic, OpenAI, Gemini, OpenRouter).
>
> The plugin fails such items *cleanly* rather than letting DeepSeek's serde error through
> — see [Text only, and how that's enforced](#text-only-and-how-thats-enforced) — but it
> cannot make them succeed.

## Install

1. Admin → Plugins → **Add plugin** → paste any of:
   - the GitHub folder URL of this directory —
     `https://github.com/<owner>/<repo>/tree/main/examples/plugins/deepseek`
     (or the shorthand `github:<owner>/<repo>/examples/plugins/deepseek`);
   - a directory path on the server — absolute, or relative to the server's working
     directory (in the Docker image this directory is baked in at
     `examples/plugins/deepseek`, so that exact string works);
   - a `file:` URL. Local paths install with no network fetch.
2. Open the DeepSeek card → **Add connection** and paste an API key from
   [platform.deepseek.com](https://platform.deepseek.com/api_keys). **test** proves the key
   works (it lists the models your account can reach).
3. Make it the default tagger on the same card, or pick it per-board in the board's AI
   settings.

## The model list is not in this file

This plugin hardcodes **no model catalog**. Every picker is filled from DeepSeek's own
`GET /models`, asked per connection with that connection's key, so a model DeepSeek adds or
retires appears or disappears with no edit here and no app update.

The one model id `index.js` names is `defaultModel`, and it isn't a catalog — it's the
pre-selection for a picker nobody has touched yet (the plugin contract requires one of any
tagging provider), and the single option shown if DeepSeek can't be reached when a picker
opens, so the select is never empty.

At the time of writing DeepSeek's `/models` returns exactly `deepseek-v4-flash` and
`deepseek-v4-pro` — so a two-entry picker is the live answer, not a stub.

## Text only, and how that's enforced

DeepSeek has no vision model, so an image board pointed at it fails on every item. Left
alone, each failure would surface as DeepSeek's own deserializer complaining about an
`image_url` variant — a message that never names the real cause — and, because a raw 400
looks transient, the queue would re-pay for it five times per image.

So the plugin wraps one method of the shared compat wire and refuses images up front, with
`status: 422` — the app's permanent-failure shape, which parks the item on the first
attempt instead of retrying:

> DeepSeek has no vision model — it can only tag text. Point image boards at a
> vision-capable tagger (Anthropic, OpenAI, Gemini, OpenRouter).

Worth noting as a plugin-authoring pattern: this needed **no change to the app**. The
contract lets a descriptor return any wire object, so spreading the shared one and
overriding a single method is the sanctioned way to model a divergence the shared wire
doesn't. Every other method — `testKey`, `listModels`, `embed` — stays core's, one copy.

## What it can and can't do

- **No images.** See above. Text and document boards only.
- **Tagging only.** DeepSeek publishes no `/embeddings` and no `/audio/transcriptions`
  endpoint, so the card advertises neither. Semantic search keeps whatever embedder is
  already selected — installing this doesn't disturb it.
- **No PDFs.** Document blocks are an Anthropic-only capability; the compat wire fails
  loudly with the reason if a board sends one. Use an Anthropic tagger for PDF boards.
- **No web research.** DeepSeek has no server-side search on the chat-completions path.
- Rate limit (rpm/burst) is a knob on the plugin card. DeepSeek publishes no RPM figure —
  it gates by *concurrency* (500 for v4-pro, 2500 for v4-flash, account-wide, expandable
  for free on request) — so the shipped 60/5 is a conservative choice, not a provider
  number. Raise it freely.

## Vendor quirks, and why they move together

Every setting below was live-probed against the real API on 2026-08-08.

`disableThinking: true` is the load-bearing one. V4 models think by default, and **in
thinking mode DeepSeek rejects any forced tool call** with `400 — "Thinking mode does not
support this tool_choice"`. Turning thinking off lifts that restriction:

| request | result |
| --- | --- |
| thinking default + `tool_choice: "required"` | **400** Thinking mode does not support this tool_choice |
| thinking off + `tool_choice: "required"` | 200, tool call made |
| thinking off + named `tool_choice` | 200, tool call made |

So `disableThinking` and `forceToolChoice` move together — flipping thinking back on
without also dropping `forceToolChoice` to `false` fails every tag on the board with a 400.
Disabling thinking is worth it on its own merits regardless: it bills as output tokens
against the tagger's budget, and hidden reasoning is exactly what clips a tool call
mid-JSON on other providers.

The rest, all verified against a realistic multi-facet board schema (nested reasoning
objects, enums, `additionalProperties: false`):

| Setting | Why |
| --- | --- |
| `forceToolChoice: "required"` | Legal once thinking is off, so tagging never depends on the model volunteering a tool call. `"required"` over the named form because with one tool defined they're the same guarantee, and the named form is what tripped OpenAI's prompt filter. |
| `strictTools: true` | Accepted, with a valid tool call returned. |
| `temperature: 0` | Accepted with thinking off. Three repeat runs returned near-identical selections — the churn reduction the compat request builder documents. |
| `keyTest: "list"` | A robustness choice, **not** a compatibility one: the per-model `GET /models/{id}` is undocumented but does answer 200. `list` is preferred because `defaultModel` is the only model id this file names, and a per-model probe would turn a retired default into a red Test button on a perfectly good key. |
