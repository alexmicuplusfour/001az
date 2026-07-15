// Carry over IN-USE connectors on upgrade. The install model (0017) reset
// connectors to "available", but a connector a board actively feeds from — or
// one the admin configured a key for — is clearly in use; resetting those would
// silently stop existing boards from refreshing. "Add what you use" governs the
// default posture for NEW/unconfigured things, not things already in use.
//
// Fresh installs have no such boards or keys, so this is a no-op there. The
// domain→default map is a one-time snapshot of the current connectors; new
// domains added later start clean on their own.
const DOMAIN_DEFAULTS = { crypto: "crypto:coingecko", stocks: "stocks:financialmodelingprep" };

async function install(client, id, now) {
  await client.query(
    `INSERT INTO plugins (id, installed, updated_at) VALUES ($1, TRUE, $2)
     ON CONFLICT (id) DO UPDATE SET installed = TRUE, updated_at = $2`,
    [id, now]
  );
}

export async function up(client) {
  const now = Date.now();

  // Providers the admin adopted with an API key (crypto_key_<p>, stocks_key_<p>).
  const { rows: keys } = await client.query(
    `SELECT key FROM settings WHERE key LIKE 'crypto\\_key\\_%' ESCAPE '\\'
                                OR key LIKE 'stocks\\_key\\_%' ESCAPE '\\'`
  );
  for (const { key } of keys) await install(client, key.replace("_key_", ":"), now);

  // The default provider of any domain that has at least one board (covers the
  // keyless default — CoinGecko — which the key rule above can't see).
  for (const [domain, id] of Object.entries(DOMAIN_DEFAULTS)) {
    const { rows } = await client.query(
      "SELECT 1 FROM boards WHERE mapping->'input'->>'connector' = $1 LIMIT 1",
      [domain]
    );
    if (rows.length) await install(client, id, now);
  }
}
