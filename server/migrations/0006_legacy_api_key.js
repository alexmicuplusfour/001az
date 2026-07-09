// Fold the legacy single-key setting into the ai_keys registry and point the
// default at it. Guarded on the presence of the old `api_key` setting, so fresh
// installs and already-migrated DBs no-op.
export async function up(client) {
  const { rows } = await client.query("SELECT value FROM settings WHERE key='api_key'");
  const legacy = rows[0]?.value;
  if (!legacy) return;

  const { rows: keyRows } = await client.query(
    "INSERT INTO ai_keys (name, provider, api_key, created_at) VALUES ('Anthropic', 'anthropic', $1, $2) RETURNING id",
    [legacy, Date.now()]
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('default_key_id', $1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [String(keyRows[0].id)]
  );
  await client.query("DELETE FROM settings WHERE key='api_key'");
}
