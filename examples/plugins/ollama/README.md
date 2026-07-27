# Ollama plugin

Tag and embed with models running on your own [Ollama](https://ollama.com) server. This is
also the reference example of a **keyless-networked** ai-provider plugin: no API key, but a
real server — connections register without a secret, pacing still applies.

## Install

1. Edit `index.js` if needed: the `base` URL (or set `OLLAMA_BASE_URL` on the app container)
   and the model lists — list what you've actually `ollama pull`ed. Tagging requires a
   tool-calling-capable model (llama3.1+, qwen2.5/3, mistral-nemo…).
2. Copy this directory somewhere the app server can read.
3. Admin → Plugins → **Add plugin** → paste the directory's absolute path (or a `file:` URL)
   into the install box. Local paths install with no network fetch; `github:`/`npm:` sources
   work too if you publish it.
4. Open the Ollama card → **Add connection** (a name, no key — unless a reverse proxy in
   front of your server wants a token) → **test** proves the server is reachable.
5. Make it the default tagger and/or embedder on the same card, or pick the connection
   per-board in the board's AI settings.

## Notes

- The app calls Ollama's OpenAI-compatible endpoints: `/v1/chat/completions` (tagging),
  `/v1/embeddings` (semantic search), `/v1/models/<id>` (the connection test).
- PDFs can't be tagged over the chat-completions protocol (Anthropic-only capability) —
  the wire fails loudly with the reason if a board sends one.
- Rate limit (rpm/burst) is a knob on the plugin card; it guards your GPU during backlog
  sweeps rather than any account tier.
