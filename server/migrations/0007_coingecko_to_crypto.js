// The `crypto` domain connector replaces the flat `coingecko` connector, with
// the provider now selected in settings.
//  1. Board mappings rename their input connector coingecko -> crypto.
//  2. Connector entities re-key identity from the CoinGecko id ("bitcoin") to
//     the lowercase symbol ("btc") — portable across providers so a coin added
//     under two backends dedupes — and stamp the provider handle onto the tag-
//     vehicle instance for a future liveness re-fetch (captured before the
//     identity is overwritten).
// All guarded/idempotent; file boards never match. On a fresh install the tables
// are empty and every statement is a no-op.
export async function up(client) {
  await client.query(
    `UPDATE boards SET mapping = jsonb_set(mapping, '{input,connector}', '"crypto"')
     WHERE mapping->'input'->>'connector' = 'coingecko'`
  );
  await client.query(
    `UPDATE items i
     SET payload = i.payload
       || jsonb_build_object('source', jsonb_build_object('provider', 'coingecko', 'id', e.identity))
     FROM entities e
     WHERE i.entity_id = e.id
       AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto')
       AND NOT i.payload ? 'source'
       AND COALESCE(e.symbol, '') <> ''`
  );
  await client.query(
    `UPDATE entities e
     SET identity = lower(e.symbol)
     WHERE COALESCE(e.symbol, '') <> ''
       AND e.identity <> lower(e.symbol)
       AND EXISTS (
         SELECT 1 FROM items i WHERE i.entity_id = e.id
           AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto'))`
  );
}
