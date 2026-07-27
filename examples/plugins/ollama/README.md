# Ollama plugin

Tag and embed with models running on your own [Ollama](https://ollama.com) server. This is
also the reference example of a **keyless-networked** ai-provider plugin: no API key, but a
real server — connections register without a secret, pacing still applies.

## Install

1. Edit `index.js` if needed: the `base` URL (or set `OLLAMA_BASE_URL` on the app container)
   and the model lists — list what you've actually `ollama pull`ed. Tagging requires a
   tool-calling-capable model (llama3.1+, qwen2.5/3, mistral-nemo…).
2. Admin → Plugins → **Add plugin** → paste any of:
   - the GitHub folder URL of this directory —
     `https://github.com/<owner>/<repo>/tree/main/examples/plugins/ollama`
     (or the shorthand `github:<owner>/<repo>/examples/plugins/ollama`);
   - a directory path on the server — absolute, or relative to the server's working
     directory (in the Docker image this directory is baked in at
     `examples/plugins/ollama`, so that exact string works);
   - a `file:` URL. Local paths install with no network fetch.

   Note: a path edit (step 1) needs the *installed copy* to carry it — installing from
   GitHub installs the committed version, so prefer `OLLAMA_BASE_URL` for the base and
   install from a local copy if you changed the model list.
3. Open the Ollama card → **Add connection** (a name, no key — unless a reverse proxy in
   front of your server wants a token) → **test** proves the server is reachable.
4. Make it the default tagger and/or embedder on the same card, or pick the connection
   per-board in the board's AI settings.

## Notes

- The app calls Ollama's OpenAI-compatible endpoints: `/v1/chat/completions` (tagging),
  `/v1/embeddings` (semantic search), `/v1/models/<id>` (the connection test).
- PDFs can't be tagged over the chat-completions protocol (Anthropic-only capability) —
  the wire fails loudly with the reason if a board sends one.
- Rate limit (rpm/burst) is a knob on the plugin card; it guards your GPU during backlog
  sweeps rather than any account tier.
