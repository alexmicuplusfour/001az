# Ollama plugin

Tag and embed with models running on your own [Ollama](https://ollama.com) server. This is
also the reference example of a **keyless-networked** ai-provider plugin: no API key, but a
real server — connections register without a secret, pacing still applies.

## Install

1. Admin → Plugins → **Add plugin** → **Ollama** → **Add**. It ships with the app (tagged
   `AI · example`), so it installs with no download. To install it from somewhere else —
   your own copy, or a server built without `examples/` — paste any of these into the
   same dialog's **Install from a URL…** instead:
   - the GitHub folder URL of this directory —
     `https://github.com/<owner>/<repo>/tree/main/examples/plugins/ollama`
     (or the shorthand `github:<owner>/<repo>/examples/plugins/ollama`);
   - a directory path on the server — absolute, or relative to the server's working
     directory;
   - a `file:` URL. Local paths install with no network fetch.
2. Open the Ollama card's gear → **Add connection…**: a name, your server's URL (e.g.
   `http://host.docker.internal:11434/v1` or `http://192.168.1.20:11434/v1` — include
   the `/v1`), and no token unless a reverse proxy in front of your server wants one.
   **Test** proves the server is reachable. Two connections can point at two boxes.
3. Make it the default tagger and/or embedder on the same card (**Make default…**), or
   pick the connection for one board under **AI models** in that board's editor.

## The model list is not in this file

Nothing here hardcodes a model catalog, and you never need to edit `index.js` after
pulling something new. Every picker is filled from your box's own `/v1/models`, asked per
connection — so two connections pointing at two machines each list their own models, and
`ollama pull` shows up on the next time you open a picker.

Ollama reports no capability metadata in that dump, so the descriptor carries two *name
patterns* to split it: `provides.tag.filter` claims the tagger picker and
`provides.embed.filter` claims the embedder picker. Those are patterns rather than lists,
which is why they keep working for models nobody has heard of yet — keep them mirror
images of each other if you edit either.

The only model ids named in `index.js` are the two `default` pre-selections
(`provides.tag.default`, `provides.embed.default`), shown when a picker hasn't been
touched and as the sole fallback option when the box can't be reached, so a select is
never empty. Tagging needs a
tool-calling-capable model (llama3.1+, qwen2.5/3, mistral-nemo…) — if you haven't pulled
the default, just pick from the picker, which lists what you actually have.

## Notes

- The app calls Ollama's OpenAI-compatible endpoints: `/v1/chat/completions` (tagging),
  `/v1/embeddings` (semantic search), `/v1/models` (the connection test and the model
  pickers).
- PDFs can't be tagged over the chat-completions protocol (Anthropic-only capability) —
  the wire fails loudly with the reason if a board sends one.
- Rate limit (rpm/burst) is a knob on the plugin card; it guards your GPU during backlog
  sweeps rather than any account tier.
