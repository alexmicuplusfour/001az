// The identity slot becomes a field (planning/card-key-plan.md).
//
//   identity: { source: "extract", instruction, options? }
//     →  fields: [{ key: "identity", kind: "text", source: "extract",
//                  instruction, options? }, ...rest]      (lifted, FIRST)
//        card:   { by: "identity" }
//   identity: { source: "connector" }  →  slot dropped (the input already
//                                          says whose cards these are)
//   anything else in the slot          →  dropped
//
// "identity" was the reserved field key under the old shape, so the lifted
// field can never collide with an existing one. The instruction and options
// travel verbatim; the user renames the field in the drawer afterwards.
//
// TWO stores hold mapping JSON and both are rewritten: boards.mapping, and the
// per-item stamped copy at items.payload.mapping — the worker's extract replay
// reads the stamp, so a missed stamp is a dead shape read on the very next
// retry (precedent: 0038, 0007). Stored field VALUES don't change: identity
// never landed in payload.fields, so items simply lack the lifted field's
// value until they are re-extracted.
//
// The transform is defined HERE, not imported — migrations must stay frozen
// while app code drifts. Idempotent: a mapping without an `identity` slot
// passes through untouched, so a re-run or a half-applied crash replay is
// safe. Fresh installs have no rows: a no-op.

export function transformMapping(m) {
  if (!m || typeof m !== "object" || m.identity === undefined) return m;
  const { identity, ...rest } = m;
  const fields = Array.isArray(rest.fields) ? rest.fields : [];
  if (identity && typeof identity === "object" && identity.source === "extract") {
    const lifted = {
      key: "identity", kind: "text", source: "extract",
      ...(typeof identity.instruction === "string" ? { instruction: identity.instruction } : {}),
      ...(Array.isArray(identity.options) && identity.options.length ? { options: identity.options } : {}),
    };
    return { ...rest, card: { by: "identity" }, fields: [lifted, ...fields] };
  }
  return { ...rest, fields };
}

export async function up(client) {
  const { rows: boards } = await client.query(
    "SELECT id, mapping FROM boards WHERE mapping IS NOT NULL AND mapping ? 'identity'"
  );
  for (const b of boards) {
    await client.query("UPDATE boards SET mapping = $1 WHERE id = $2", [
      JSON.stringify(transformMapping(b.mapping)), b.id,
    ]);
  }
  if (boards.length) console.log(`migration 0052: rewrote ${boards.length} board mapping(s)`);

  const { rows: items } = await client.query(
    `SELECT id, payload->'mapping' AS mapping FROM items WHERE payload->'mapping' ? 'identity'`
  );
  for (const it of items) {
    await client.query(
      `UPDATE items SET payload = jsonb_set(payload, '{mapping}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(transformMapping(it.mapping)), it.id]
    );
  }
  if (items.length) console.log(`migration 0052: rewrote ${items.length} stamped item mapping(s)`);
}
