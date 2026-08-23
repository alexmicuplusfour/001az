// One source model for the mapping (planning/field-sources-plan.md).
//
// The mapping's four spellings of "where a value comes from" collapse into one:
//   fields[].from "ai"|"connector"|"file"  →  source "extract"|"detect"|"connector"|"file"
//     (kind:"object" was the detector hiding inside "ai" — it becomes
//      source:"detect" and loses `kind`; detection output isn't a scalar)
//   identity.from "raw"                    →  slot omitted (absence of config)
//   face.from "raw"                        →  slot omitted (the tile is the
//      fallback when nothing renders, never a configuration — 0035 already
//      coerced finance boards onto the chart, so only file boards still carry it)
//   input: "files"                         →  key omitted (same two-spellings
//      disease as `raw`: absent already meant files)
//   hint → instruction, candidates → options, live+every → refresh:{every}
//
// TWO stores hold mapping JSON and both are rewritten: boards.mapping, and the
// per-item stamped copy at items.payload.mapping — the worker's extract replay
// and db.js's face/extract routing predicates read the stamp, so a missed stamp
// is a dead shape read on the very next retry. (Precedent: 0007 rewrote both.)
//
// The transform is defined HERE, not imported — migrations must stay frozen
// while app code drifts. Idempotent: a binding already carrying `source` (or a
// slot already absent) passes through untouched, so a re-run or a half-applied
// crash replay is safe. Fresh installs have no rows: a no-op.

function transformField(f) {
  if (!f || typeof f !== "object" || f.source || !f.from) return f;
  if (f.from === "connector") {
    return {
      key: f.key, kind: f.kind, source: "connector", fn: f.fn,
      ...(f.live && Number.isInteger(f.every) ? { refresh: { every: f.every } } : {}),
    };
  }
  if (f.from === "file") return { key: f.key, kind: f.kind, source: "file", fn: f.fn };
  // from === "ai": the detector was disguised as a kind of it
  if (f.kind === "object") {
    return { key: f.key, source: "detect", ...(f.hint ? { instruction: f.hint } : {}) };
  }
  return { key: f.key, kind: f.kind, source: "extract", ...(f.hint ? { instruction: f.hint } : {}) };
}

export function transformMapping(m) {
  if (!m || typeof m !== "object") return m;
  const out = {};
  // input: only the connector spelling survives; "files" and absence both meant files.
  if (m.input && typeof m.input === "object" && m.input.connector) {
    out.input = { connector: m.input.connector };
  }
  const id = m.identity;
  if (id && typeof id === "object") {
    if (id.source) out.identity = id;
    else if (id.from === "ai") {
      out.identity = {
        source: "extract",
        instruction: id.hint || "",
        ...(Array.isArray(id.candidates) && id.candidates.length ? { options: id.candidates } : {}),
      };
    } else if (id.from === "connector") out.identity = { source: "connector" };
    // from "raw" (or anything else): slot omitted
  }
  const fc = m.face;
  if (fc && typeof fc === "object") {
    if (fc.source) out.face = fc;
    else if (fc.from === "connector") {
      out.face = {
        source: "connector", producer: fc.producer, period: fc.period,
        ...(fc.live && Number.isInteger(fc.every) ? { refresh: { every: fc.every } } : {}),
      };
    } else if (fc.from === "file") {
      out.face = { source: "file", prefer: fc.prefer || "image", pick: fc.pick || "first" };
    }
    // from "raw": slot omitted
  }
  out.fields = Array.isArray(m.fields) ? m.fields.map(transformField) : [];
  return out;
}

export async function up(client) {
  const { rows: boards } = await client.query(
    "SELECT id, mapping FROM boards WHERE mapping IS NOT NULL"
  );
  for (const b of boards) {
    await client.query("UPDATE boards SET mapping = $1 WHERE id = $2", [
      JSON.stringify(transformMapping(b.mapping)), b.id,
    ]);
  }
  if (boards.length) console.log(`migration 0038: rewrote ${boards.length} board mapping(s)`);

  const { rows: items } = await client.query(
    `SELECT id, payload->'mapping' AS mapping FROM items WHERE payload ? 'mapping'`
  );
  for (const it of items) {
    await client.query(
      `UPDATE items SET payload = jsonb_set(payload, '{mapping}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(transformMapping(it.mapping)), it.id]
    );
  }
  if (items.length) console.log(`migration 0038: rewrote ${items.length} stamped item mapping(s)`);
}
