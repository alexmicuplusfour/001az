// Hash any raw session ids / invite tokens left at rest (48 hex chars → 64-char
// SHA-256). Non-breaking — an existing cookie or login link still hashes to the
// stored digest. Idempotent via the length guard, so a fresh install (empty
// tables) and an already-hashed DB both no-op. Postgres has sha256() built in
// (>= PG 11); text::bytea gives the same bytes Node hashes.
export async function up(client) {
  await client.query("UPDATE sessions SET id = encode(sha256(id::bytea), 'hex') WHERE length(id) <> 64");
  await client.query("UPDATE invites SET token = encode(sha256(token::bytea), 'hex') WHERE length(token) <> 64");
}
