-- A connection to a self-hosted provider (Ollama, LM Studio, vLLM, …) is
-- defined by WHERE it points, not by a secret — the server URL is
-- per-connection state (two rows = two boxes), not plugin code. NULL falls
-- back to the descriptor's default base; providers opt in via `needsBase`
-- on the descriptor (fixed-endpoint providers never store one).
ALTER TABLE ai_keys ADD COLUMN IF NOT EXISTS base_url TEXT;
