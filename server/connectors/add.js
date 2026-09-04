// Create one connector entity + its file-less tag-vehicle instance and return
// the client row. Shared by the single add, the bulk add (server.js routes)
// and the connector-feed ingestion adapter. Throws a tagged error on the two
// recoverable cases so callers can map them: `.duplicate` for a 23505
// (identity already on the board), `.provider` for a fetch/provider error.
import { createEntity, insertItem, setEntityRefreshAt, withTx } from "../db.js";
import { firstRefreshAt } from "./runtime.js";

// Where a connector vehicle goes once its definition data is in hand, and
// whether it carries the park stamp — ONE encoding of the landing rule, read
// by both add paths here and by the worker's fetch leg (which computes its
// advance target from a fresh board read). The park flag is decided at
// enqueue time and the status it pairs with at land time, so the two halves
// living in one function is what keeps them from drifting apart.
//
// `refetch` (Stage 3a): a fetched vehicle re-entering the fetch leg is a
// reprocess — an EXPLICIT run whose park the reprocess already stripped — so
// it never re-parks: the add rule's auto-tag-off 'held' landing would break
// the promise every other leg keeps for explicit runs. Face boards land at
// the face leg either way (the fresh chart is the point); park stays an
// enqueue-time decision, so a refetch never stamps one.
export function connectorLanding(board, { refetch = false } = {}) {
  const wantsFace = board.mapping?.face?.source === "connector";
  const parked = !refetch && !board.auto_tag; // an automatic run on a no-auto-tag board
  return {
    wantsFace,
    status: wantsFace ? "pending_face" : parked ? "held" : "pending",
    park: wantsFace && parked,
  };
}

// The client row both add paths return — one author for the card shape, so a
// key the client learns ships from the bulk and the single route alike.
const connectorRow = ({ eid, iid, identity, displayName, symbol, status, fields }) => ({
  id: eid,
  name: identity,
  identity,
  display_name: displayName,
  symbol: symbol || null,
  displayLabel: displayName || identity,
  status,
  tags: [],
  kind: "connector",
  w: null,
  h: null,
  label: null,
  fields,
  instances: [{
    id: iid, name: identity, label: null, w: null, h: null,
    kind: "connector", status, tags: [], undecided: false,
  }],
});

// 23505 on (board_id, identity) → the tagged error both routes map to a 409.
const asDuplicate = (err) => {
  if (err.code === "23505") { const e = new Error("entity already on this board"); e.duplicate = true; throw e; }
  throw err;
};

export async function addConnectorEntity(db, board, connector, connectorName, entityId) {
  let entity;
  try {
    entity = await connector.fetchEntity(db, entityId, board.id);
  } catch (err) { err.provider = true; throw err; }

  // Bound fields live on the entity; one file-less instance is the tag
  // vehicle (tags/reasoning/queue state are per instance). A connector-face
  // board renders the chart first (face leg) so the tagger sees it — the face
  // is part of the item's definition, so it renders even with auto-tag off
  // (`park` makes the face leg park the item in held afterwards instead of
  // flowing into tagging). Face-less connector items are definition-complete
  // at birth: auto-tag off holds them as before.
  const { status, park } = connectorLanding(board);
  const eid = await createEntity(db, board.id, {
    identity: entity.identity,
    displayName: entity.display_name,
    symbol: entity.symbol || null,
    fields: entity.fields,
  }).catch(asDuplicate);
  // Provider handle rides on the tag-vehicle instance (entities has no free-
  // form payload) for a future liveness re-fetch.
  const payload = {
    identity: entity.identity, files: [], fields: {}, mapping: board.mapping, source: entity.source,
    ...(park ? { park: true } : {}),
  };
  const id = await insertItem(db, board.id, payload, status, eid);

  // Schedule the first liveness refresh when the mapping has live fields. The
  // face needs no schedule here — the face leg above renders it on arrival.
  const first = firstRefreshAt(entity.fields, board.mapping);
  if (first !== null) await setEntityRefreshAt(db, eid, first);

  console.log(`connector entity created: ${connectorName}/${entityId} → #${eid} (${entity.display_name})`);
  return connectorRow({
    eid, iid: id, identity: entity.identity, displayName: entity.display_name,
    symbol: entity.symbol, status, fields: entity.fields,
  });
}

// The enqueue half of the same add (planning/add-feedback-plan.md Stage 2):
// create the entity + vehicle NOW from what the browse row already carries —
// identity is the pinned derivation the browse route's on_board marking uses,
// so the (board_id, identity) duplicate check fires here, before any provider
// I/O — and leave the provider fetch to the worker's fetch leg, routed there
// by status 'pending_fetch' + the payload's 'unfetched' stamp. The response
// therefore returns in milliseconds for any batch size, and the gallery shows
// the queued cards immediately (the connector card face needs only symbol +
// display name, both of which the row supplies).
//
// In a transaction, unlike addConnectorEntity above: that pair is preceded by
// a slow provider fetch, this one is pure db work, and a crash between the
// two statements would strand an empty entity for reapEmptyEntities to eat.
//
// `providerName` is the active provider resolved ONCE by the route (may be
// null when the domain has no provider right now — the fetch leg re-resolves
// and overwrites source with the truth when it lands).
export async function enqueueConnectorEntity(db, board, connectorName, { id, symbol, name }, providerName = null) {
  const sourceId = String(id);
  const identity = (symbol || "").toLowerCase() || sourceId;
  const displayName = name || symbol || sourceId;
  const payload = {
    identity, files: [], fields: {}, mapping: board.mapping,
    source: { provider: providerName, id: sourceId },
    unfetched: true,
    ...(connectorLanding(board).park ? { park: true } : {}),
  };
  const { eid, iid } = await withTx(db, async (tx) => {
    const e = await createEntity(tx, board.id, {
      identity, displayName, symbol: symbol || null, fields: {},
    });
    const i = await insertItem(tx, board.id, payload, "pending_fetch", e);
    return { eid: e, iid: i };
  }).catch(asDuplicate);
  console.log(`connector entity queued: ${connectorName}/${sourceId} → #${eid} (${displayName})`);
  return connectorRow({
    eid, iid, identity, displayName, symbol, status: "pending_fetch", fields: {},
  });
}
