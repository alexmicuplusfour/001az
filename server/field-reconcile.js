// The mapping-save reconcile: stored field data re-converges on the mapping
// it now belongs to (the stored = declared invariant,
// planning/field-projection-plan.md). One pass, every source, dispatched by
// the `refill` policy its FIELD_SOURCE_DEFS row declares (the column's three
// values are documented ON the column — field-sources.js). The row is the
// CONTRACT, not a caption: the factory refuses to build if a non-manual row
// has no handler here, so a future source declaring a refill can't silently
// be a no-op at save time. This used to be one hand-rolled backfill for file
// fields and NOTHING for connector fields — the exact per-source drift the
// registry exists to kill.
//
// A factory rather than a module-level function because the file handler needs
// the sources instance (metaFor — server.js builds it with its storage dirs).
import { FIELD_SOURCE_DEFS } from "./field-sources.js";
import { boardItemPayloads, updateItemPayloads, stripBoardEntityFields } from "./db.js";
import { extractFileFields } from "./media/index.js";
import { wantedFields } from "./connectors/schedule.js";

export function createFieldReconciler({ metaFor }) {
  const handlers = {
    file: (db, boardId, mapping) => backfillFileFields(db, boardId, mapping, metaFor),
    connector: reconcileConnectorFields,
  };
  for (const def of FIELD_SOURCE_DEFS)
    if (def.refill !== "manual" && !handlers[def.id])
      throw new Error(`field source "${def.id}" declares refill "${def.refill}" but has no reconcile handler`);
  return async function reconcileFields(db, boardId, mapping) {
    for (const def of FIELD_SOURCE_DEFS) {
      if (def.refill === "manual") continue;
      await handlers[def.id](db, boardId, mapping);
    }
  };
}

// The connector arm: entities.fields is wholly the connector source's
// (field-sources.js — the one entity-scoped source), so reconcile is a strip
// to the wanted keys, one bulk statement. Refill is NOT fetched here — the
// caller's rescheduleEntityRefreshes stamps entities missing a newly-mapped
// key due-now and the refresh sweep buys the data, paced and batched. Runs
// whether or not the board has a connector input — a file board's entities
// carry '{}' and the WHERE makes it a no-op — so an input CLEARED out from
// under stored data still converges.
async function reconcileConnectorFields(db, boardId, mapping) {
  await stripBoardEntityFields(db, boardId, wantedFields(mapping).map((f) => f.key));
}

// Re-project file-metadata fields (server/media) over a board's existing
// instances after its file-field set changes: strip the previously-projected
// file fields, add the current ones, leave AI fields alone. Pure projection of
// each stored payload entry — no file is re-opened. Writes only on a real
// change. Connector boards skip the item sweep outright: file fields are
// filesOnly, and connector vehicles carry no file entry to project from.
async function backfillFileFields(db, boardId, mapping, metaFor) {
  if (mapping?.input) return;
  const mappingFields = (mapping && mapping.fields) || [];
  const wantsFileFields = mappingFields.some((f) => f.source === "file");
  const items = await boardItemPayloads(db, boardId);

  // Legacy entries (uploaded before file fields) carry no size/meta; re-derive it
  // once from the stored file (header-only reads) so their file fields aren't all
  // null. The reads are independent, so run them concurrently rather than one at a
  // time — this is the bulk of the wait on a board's first file-field save.
  const needsEnrich = items.map((it) => {
    const entry = it.payload?.files?.[0];
    return wantsFileFields && !!entry && entry.meta === undefined;
  });
  const metas = await Promise.all(items.map((it, i) =>
    needsEnrich[i] ? metaFor(it.payload.files[0]) : null
  ));

  const patches = []; // [{ id, patch }] — flushed in a single bulk write below.
  items.forEach((it, i) => {
    let entry = it.payload?.files?.[0];
    if (!entry) return; // fileless (connector tag vehicle) — nothing to project
    // The enriched entry is persisted, so the header read is paid once. `added`
    // falls back to the item's created_at (modified/created were never captured).
    let enrichedEntry = false;
    if (needsEnrich[i]) {
      const m = metas[i];
      entry = { ...entry, size: m?.size ?? null, meta: m?.meta || {}, addedAt: entry.addedAt ?? it.created_at ?? null };
      enrichedEntry = true;
    }
    const existing = it.payload?.fields || {};
    const kept = {};
    for (const [k, v] of Object.entries(existing)) if (v?.src !== "file") kept[k] = v;
    const merged = { ...kept, ...extractFileFields(entry, mappingFields) };
    if (enrichedEntry) {
      const files = [...it.payload.files];
      files[0] = entry;
      patches.push({ id: it.id, patch: { files, fields: merged } });
    } else if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      patches.push({ id: it.id, patch: { fields: merged } });
    }
  });

  // One bulk write instead of a round-trip per changed item.
  await updateItemPayloads(db, patches);
}
