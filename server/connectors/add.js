// Create one connector entity + its file-less tag-vehicle instance and return
// the client row. Shared by the single add, the bulk add (server.js routes)
// and the connector-feed ingestion adapter. Throws a tagged error on the two
// recoverable cases so callers can map them: `.duplicate` for a 23505
// (identity already on the board), `.provider` for a fetch/provider error.
import { createEntity, insertItem, setEntityRefreshAt } from "../db.js";
import { firstRefreshAt } from "./runtime.js";

export async function addConnectorEntity(db, board, connector, connectorName, entityId) {
  let entity;
  try {
    entity = await connector.fetchEntity(db, entityId);
  } catch (err) { err.provider = true; throw err; }

  // Bound fields live on the entity; one file-less instance is the tag
  // vehicle (tags/reasoning/queue state are per instance). A connector-face
  // board renders the chart first (face leg) so the tagger sees it — the face
  // is part of the item's definition, so it renders even with auto-tag off
  // (`park` makes the face leg park the item in held afterwards instead of
  // flowing into tagging). Face-less connector items are definition-complete
  // at birth: auto-tag off holds them as before.
  const wantsFace = board.mapping?.face?.source === "connector";
  const status = wantsFace ? "pending_face" : board.auto_tag ? "pending" : "held";
  let eid;
  try {
    eid = await createEntity(db, board.id, {
      identity: entity.identity,
      displayName: entity.display_name,
      symbol: entity.symbol || null,
      fields: entity.fields,
    });
  } catch (err) {
    if (err.code === "23505") { const e = new Error("entity already on this board"); e.duplicate = true; throw e; }
    throw err;
  }
  // Provider handle rides on the tag-vehicle instance (entities has no free-
  // form payload) for a future liveness re-fetch.
  const payload = {
    identity: entity.identity, files: [], fields: {}, mapping: board.mapping, source: entity.source,
    ...(wantsFace && !board.auto_tag ? { park: true } : {}),
  };
  const id = await insertItem(db, board.id, payload, status, eid);

  // Schedule the first liveness refresh when the mapping has live fields. The
  // face needs no schedule here — the face leg above renders it on arrival.
  const first = firstRefreshAt(entity.fields, board.mapping);
  if (first !== null) await setEntityRefreshAt(db, eid, first);

  console.log(`connector entity created: ${connectorName}/${entityId} → #${eid} (${entity.display_name})`);
  return {
    id: eid,
    name: entity.identity,
    identity: entity.identity,
    display_name: entity.display_name,
    symbol: entity.symbol || null,
    displayLabel: entity.display_name || entity.identity,
    status,
    tags: [],
    kind: "connector",
    w: null,
    h: null,
    label: null,
    fields: entity.fields,
    instances: [{
      id, name: entity.identity, label: null, w: null, h: null,
      kind: "connector", status, tags: [], undecided: false,
    }],
  };
}
