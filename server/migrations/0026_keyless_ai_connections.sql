-- An ai_keys row is a provider CONNECTION: it stores the secret AND it is the
-- selection handle (boards.ai_key_id and settings.default_key_id point at a
-- row — a provider with no row is unselectable as a tagger). A keyless
-- networked provider (a self-hosted Ollama, LM Studio, vLLM, …) needs the
-- handle but has no secret to put in it, so the secret becomes optional:
-- api_key NULL = a keyless connection. The wires omit the Authorization
-- header when the key is absent; registration still requires a key for
-- providers that declare one (the route gates on the descriptor's `keyless`).
ALTER TABLE ai_keys ALTER COLUMN api_key DROP NOT NULL;
