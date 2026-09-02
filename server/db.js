import pg from "pg";
import crypto from "node:crypto";
import { runMigrations } from "./migrate.js";
import { selectFace } from "./faces/select.js";
// Pure scheduling rules — safe to import here (schedule.js imports nothing),
// unlike connectors/runtime.js, which imports THIS module.
import { liveFields, nextRefreshAt, faceSchedule } from "./connectors/schedule.js";
import { aiWork } from "./field-sources.js"; // pure data + one predicate, no imports
import { projectEntry } from "./media/index.js";
import { CAPABILITY_DEFS, bindingSettings } from "./capabilities.js";
import { describeUnit } from "./units.js"; // pure data + predicates, no imports

// BIGINT (int8) comes back from pg as a string by default. Everything we store
// in BIGINT is a ms epoch or a row id — both far below 2^53 — so parse to
// Number globally. Without this, every `expires_at < Date.now()` style
// comparison silently breaks.
pg.types.setTypeParser(20, Number);

// BIGINT[] (int8 array, OID 1016 — e.g. items.entity_ids): the scalar parser
// above doesn't reach array elements, so they'd arrive as strings and break
// numeric compares against row ids. Wrap the default array parser to Number
// each element (all row ids, far below 2^53); NULLs and the empty array pass
// through untouched.
const parseBigintArray = pg.types.getTypeParser(1016);
pg.types.setTypeParser(1016, (val) => parseBigintArray(val).map((v) => (v == null ? v : Number(v))));

// Session ids and invite tokens are bearer credentials: the raw value goes to
// the client (cookie / login URL) but only its SHA-256 is stored, so a DB read
// can't be replayed as a login. Raw tokens are 48 hex chars, digests 64 — the
// length gap drives migration 0003_hash_bearer_tokens.
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export function openDb(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

// Bring the schema up to date, then reconcile live-refresh schedules. The schema
// itself — baseline plus every historical data transform — is the versioned
// migration ledger in server/migrations (run once each, recorded in
// schema_migrations; see runMigrations). reconcileLiveSchedules is NOT a
// migration: it recomputes refresh_at from the current board mappings on every
// boot, so it stays here.
export async function initDb(db) {
  await runMigrations(db);
  await reconcileLiveSchedules(db);
}

// Ensure every entity on a board with live connector fields has a refresh_at.
// Covers boards configured live before this feature deployed (or before a build
// that scheduled them) — otherwise their entities sit with refresh_at NULL and
// the sweep never sees them until the mapping is re-saved. Idempotent: it just
// recomputes min(field.at + every*60000), the correct next-due, each boot.
async function reconcileLiveSchedules(db) {
  const { rows } = await db.query("SELECT id, mapping FROM boards WHERE mapping IS NOT NULL");
  for (const b of rows) {
    const live = liveFields(b.mapping);
    const faceSched = faceSchedule(b.mapping);
    if (live.length || faceSched) await rescheduleEntityRefreshes(db, b.id, live, faceSched);
  }
}

// Run fn with a dedicated client inside BEGIN/COMMIT.
export async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function countItems(db) {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM items");
  return rows[0].c;
}

// Aggregate an entity's display status from its instances: any in-flight
// state wins (the card shows a spinner), then failed, then held; an entity
// whose instances are all done reads tagged. Single-instance entities (every
// raw board) pass their status through verbatim.
const STATUS_PRIORITY = ["fetching", "pending_fetch", "facing", "pending_face", "extracting", "pending_extract", "processing", "pending", "failed", "held"];

// The legs an item passes through before it carries tags, each as the
// state it WAITS in and the state the worker claims it INTO. Lives up here with
// STATUS_PRIORITY rather than beside its first user, because it is the
// authoritative list of "the pipeline is doing something to this row" and two
// other things now derive from it — including failOrRequeue's value fence,
// which is why a leg missing here can't fail its own work (the fence falls
// back to 'processing' and matches nothing).
const IN_FLIGHT_FOR = { pending_fetch: "fetching", pending: "processing", pending_extract: "extracting", pending_face: "facing" };

// …and the derived spellings the SQL below composes, so the claim CASE, the
// recovery arms and the in-flight WHERE lists cannot drift from the map (they
// did: recoverStuck's hand-written lists survived one leg addition only
// because a close-look audit caught them). All values are code-local
// literals — nothing user-supplied ever enters these strings.
export const IN_FLIGHT_STATES = Object.entries(IN_FLIGHT_FOR).flat();
const CLAIM_CASE = `CASE items.status ${Object.entries(IN_FLIGHT_FOR)
  .map(([p, f]) => `WHEN '${p}' THEN '${f}'`).join(" ")} ELSE 'processing' END`;
const REQUEUE_ARMS = Object.entries(IN_FLIGHT_FOR)
  .map(([p, f]) => `WHEN status = '${f}' THEN '${p}'`).join("\n         ");
const IN_FLIGHT_SQL = `(${Object.values(IN_FLIGHT_FOR).map((s) => `'${s}'`).join(",")})`;

// Every state that means "this item's tags are about to be rewritten" — both
// halves of all four legs, eight in total. DERIVED rather than written out, so
// a fifth leg cannot be added without this following it. (The fetch leg's
// inclusion mildly over-counts tagQueueDepth's "N waiting on the tagger" —
// accepted: those items do reach the tag leg.)
//
// Facet diagnosis had this as `('pending','processing')` in three separate
// queries, and retagBoard does not queue items uniformly: it routes each one by
// payload, so an item carrying a `mapping` it has not been extracted under enters
// 'pending_extract' and a connector vehicle with no rendered file enters
// 'pending_face'. On a mapped or connector board a full retag therefore produced
// no 'pending' row at all. Measured, same retag, two boards differing only in
// payload:
//
//   plain (payload has extracted_at)   21 -> pending          hook marked ["shape"]
//   mapped (payload has mapping)       21 -> pending_extract  hook marked []
//
// So supersedeFacetDiagnostics found nothing queued and left every finding
// standing, boardTagActivity called the board quiet mid-sweep, and the roll-up
// reported nothing in flight — which put "Not measured against the current
// wording yet. Re-tag this board" over a board being re-tagged as the user read
// it. Three surfaces, one missing set of strings, and the first fix for it named
// four states and still missed the two the worker claims into.
const TAG_QUEUE = `(${IN_FLIGHT_STATES.map((s) => `'${s}'`).join(",")})`;
export function aggregateStatus(instances) {
  if (!instances.length) return "tagged";
  if (instances.length === 1) return instances[0].status;
  for (const s of STATUS_PRIORITY) if (instances.some((i) => i.status === s)) return s;
  return "tagged";
}

// The field KEYS holding ≥1 stored detection box (a non-empty array `v` is
// the object-field discriminator, the same one the lightbox overlay reads).
// Feeds the list payload's distilled summary AND the alert tag-set builders'
// `~objects` projection — the two server faces of the objects system facet.
export function objectKeysOf(fields) {
  return Object.entries(fields || {})
    .filter(([, f]) => Array.isArray(f?.v) && f.v.length > 0)
    .map(([k]) => k);
}

// One instance's slice of the list payload.
function instanceEntry(r) {
  const file = r.payload.files?.[0];
  // Detected-object summary: keys only — boxes/scores/whys stay on the lazy
  // per-instance reasoning fetch. Feeds the client's `~objects` system facet;
  // omitted when empty so the common no-detection row costs nothing.
  const objects = objectKeysOf(r.payload.fields);
  return {
    id: r.id,
    name: file?.name || r.payload.identity,
    label: file?.original_name || null,
    w: file?.w || null,
    h: file?.h || null,
    kind: file?.kind || (file ? "image" : "connector"),
    status: r.status,
    tags: r.tags,
    undecided: !!r.undecided,
    ...(objects.length ? { objects } : {}),
  };
}

// The board listing: entities, each carrying its instances. Face fields
// (name/w/h/kind/label) mirror the instance selectFace picks (the board's
// mapping.face { prefer, pick }; oldest by default) so the card path needs no
// special cases; tags at the entity level are the union across instances
// (what filtering and facet counts consume), per-instance tags ride inside.
//
// Three modes, one query shape:
// - no opts: the whole board (legacy full list).
// - limit/after: one keyset page, walking (created_at DESC, id DESC); the
//   cursor is the last row's (created_at, id) pair. Returns nextCursor while
//   pages remain (emitted only on exactly-full pages, so an exact-multiple
//   total costs one final empty page).
// - since: only entities changed after the given ms stamp — their own
//   updated_at or any of their instances'. Timestamps are BIGINT ms, so
//   cursors round-trip exactly (see the type-parser note at the top).
export async function listItems(db, userId = null, boardId = null, { limit = null, after = null, since = null } = {}) {
  const params = [userId, boardId];
  const where = ["($2::text IS NULL OR e.board_id = $2)"];
  let tail = "";
  if (since != null) {
    params.push(since);
    where.push(`(e.updated_at > $3 OR e.id IN (SELECT unnest(entity_ids) FROM items WHERE board_id = $2 AND updated_at > $3))`);
  } else {
    if (after != null) {
      params.push(after.createdAt, after.id);
      where.push(`(e.created_at, e.id) < ($${params.length - 1}::bigint, $${params.length}::bigint)`);
    }
    if (limit != null) {
      params.push(limit);
      tail = ` LIMIT $${params.length}`;
    }
  }
  const { rows: ents } = await db.query(
    `SELECT e.id, e.identity, e.display_name, e.symbol, e.fields, e.identity_provisional, e.created_at, e.updated_at,
      e.uploaded_by AS uploader_id, u.name AS uploader_name, u.email AS uploader_email,
      COALESCE(fh.hearts, 0) AS hearts,
      (fme.user_id IS NOT NULL) AS fav
     FROM entities e
     LEFT JOIN users u ON u.id = e.uploaded_by
     LEFT JOIN (SELECT item_id, COUNT(*)::int AS hearts FROM favorites GROUP BY item_id) fh ON fh.item_id = e.id
     LEFT JOIN favorites fme ON fme.item_id = e.id AND fme.user_id = $1
     WHERE ${where.join(" AND ")}
     ORDER BY e.created_at DESC, e.id DESC${tail}`,
    params
  );

  // A page/delta covers a known set of entities — fetch just their instances
  // (an entity needs ALL of them for aggregateStatus and the face mirror).
  // The full listing keeps the board-wide query.
  const partial = limit != null || after != null || since != null;
  const { rows: insts } = await db.query(
    partial
      ? `SELECT id, entity_ids, status, tags, undecided, payload FROM items
         WHERE entity_ids && $1::bigint[]
         ORDER BY created_at ASC, id ASC`
      : `SELECT id, entity_ids, status, tags, undecided, payload FROM items
         WHERE ($1::text IS NULL OR board_id = $1)
         ORDER BY created_at ASC, id ASC`,
    [partial ? ents.map((e) => e.id) : boardId]
  );
  const byEntity = new Map();
  // Raw file entries by instance id — kept aside so the face's media bag can be
  // projected at assembly without shipping metadata for every instance.
  const entryByInstance = new Map();
  // An instance can belong to several entities (classify mode). Push it into
  // every one of its entities that this page/delta covers; a partial page only
  // wants the buckets it asked for (the && query can return an instance shared
  // with an off-page entity).
  const wanted = partial ? new Set(ents.map((e) => e.id)) : null;
  for (const r of insts) {
    const entry = instanceEntry(r);
    for (const eid of r.entity_ids || []) {
      if (wanted && !wanted.has(eid)) continue;
      if (!byEntity.has(eid)) byEntity.set(eid, []);
      byEntity.get(eid).push(entry);
    }
    const file = r.payload.files?.[0];
    if (file) entryByInstance.set(r.id, file);
  }

  // The board's face-selection config decides which instance of a derived-
  // identity entity supplies the card face. A single-board view (boardId set)
  // loads it once; the cross-board listing leaves it null → selectFace's
  // first-instance default, identical to the legacy pick.
  let faceCfg = null;
  if (boardId != null) {
    const { rows } = await db.query("SELECT mapping FROM boards WHERE id = $1", [boardId]);
    faceCfg = rows[0]?.mapping?.face || null;
  }

  const crateMap = new Map();
  if (userId) {
    const memberships = await db.query(
      `SELECT ci.item_id, ci.crate_id FROM crate_items ci
       JOIN crates c ON c.id = ci.crate_id
       WHERE c.board_id = $2 AND (c.user_id = $1 OR c.public = TRUE)`,
      [userId, boardId]
    );
    for (const m of memberships.rows) {
      if (!crateMap.has(m.item_id)) crateMap.set(m.item_id, []);
      crateMap.get(m.item_id).push(m.crate_id);
    }
  }

  const items = ents.map((e) => {
    const instances = byEntity.get(e.id) || [];
    const face = selectFace(instances, faceCfg);
    const faceEntry = face ? entryByInstance.get(face.id) : null;
    const tags = [];
    const seen = new Set();
    for (const i of instances) for (const t of i.tags) if (!seen.has(t)) { seen.add(t); tags.push(t); }
    // Union of the instances' detected-object keys — the entity-level
    // membership the `~objects` filter matches on (the tags-union shape:
    // dedup, instance order preserved). Omitted when empty, like the
    // per-instance summary.
    const objects = [];
    const seenObjects = new Set();
    for (const i of instances) for (const k of i.objects || []) if (!seenObjects.has(k)) { seenObjects.add(k); objects.push(k); }
    return {
      id: e.id,
      // name = stored filename of the face file, used to construct gallery/
      // thumbnail URLs; identity is the entity key — they diverge on derived
      // boards.
      name: face?.name || e.identity,
      identity: e.identity,
      // AI's original-casing output ("Maya Chen") for display; absent on raw items.
      display_name: e.display_name || null,
      identity_provisional: !!e.identity_provisional,
      status: aggregateStatus(instances),
      tags,
      ...(objects.length ? { objects } : {}),
      undecided: instances.length > 0 && instances.every((i) => i.undecided),
      hearts: e.hearts,
      favoritedByMe: !!e.fav,
      crateIds: crateMap.get(e.id) || [],
      uploadedBy: e.uploader_id ? { id: e.uploader_id, name: e.uploader_name || null, email: e.uploader_email } : null,
      w: face?.w || null,
      h: face?.h || null,
      // connector entities have no files; instanceEntry marks the file-less
      // vehicle "connector" so the client renders the symbol tile face.
      kind: face?.kind || (e.symbol != null ? "connector" : "image"),
      symbol: e.symbol || null,
      label: face?.label || null,
      // Connector-bound entity fields (AI-extracted fields are per instance).
      fields: e.fields || {},
      created_at: e.created_at,
      updated_at: e.updated_at,
      // The face file's full metadata projection — what attribute sorting reads.
      // Connector entities carry no files → null.
      media: faceEntry ? projectEntry(faceEntry) : null,
      instances,
    };
  });

  let nextCursor = null;
  if (limit != null && ents.length === limit) {
    const last = ents[ents.length - 1];
    nextCursor = `${last.created_at}_${last.id}`;
  }
  return { items, nextCursor };
}

// All entity ids on a board, in one cheap scan — delta polls ship this so the
// client can tell "unchanged" apart from "merged/deleted" without the full list.
export async function listEntityIds(db, boardId) {
  const { rows } = await db.query("SELECT id FROM entities WHERE board_id = $1", [boardId]);
  return rows.map((r) => r.id);
}

// status: 'pending' (tag now) or 'held' (wait — for the board's scheduled
// run, or for auto-tagging to be switched back on). Every instance belongs
// to an entity (createEntity first, then insert the instance under it).
export async function insertItem(db, boardId, payload, status = "pending", entityId = null) {
  const { rows } = await db.query(
    `INSERT INTO items (payload, status, board_id, entity_ids, created_at, updated_at)
     VALUES ($1, $2, $3, $4::bigint[], $5, $5) RETURNING id`,
    [JSON.stringify(payload || {}), status, boardId, entityId == null ? [] : [entityId], Date.now()]
  );
  return rows[0].id;
}

// Shallow-merge a patch into an item's payload.
export async function updateItemPayload(db, id, patch) {
  await db.query("UPDATE items SET payload = payload || $1::jsonb WHERE id=$2", [JSON.stringify(patch || {}), id]);
}

// Bulk form of updateItemPayload: shallow-merge a per-item patch into many items
// in a single round-trip. `patches` is [{ id, patch }]. The file-field backfill
// uses this so a mapping change touching every item is one write, not one per row.
export async function updateItemPayloads(db, patches) {
  if (!patches.length) return;
  await db.query(
    `UPDATE items AS i SET payload = i.payload || u.patch
     FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, patch jsonb)
     WHERE i.id = u.id`,
    [JSON.stringify(patches)]
  );
}

// Every item's { id, payload } (startup sweeps like the thumb-dims backfill).
export async function listItemPayloads(db) {
  const { rows } = await db.query("SELECT id, payload FROM items ORDER BY id");
  return rows;
}

// One board's item payloads — used to backfill file-metadata fields when a
// board's file-field set changes (server/media projection over stored entries).
// created_at rides along so a legacy entry can source its `added` date from it.
export async function boardItemPayloads(db, boardId) {
  const { rows } = await db.query("SELECT id, payload, created_at FROM items WHERE board_id=$1 ORDER BY id", [boardId]);
  return rows;
}

export async function getItemBoard(db, id) {
  const { rows } = await db.query("SELECT board_id FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// Group "facet/value" tag strings into { facetKey: Set(values) }.
function tagsByFacet(tags) {
  const map = new Map();
  for (const t of tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    const key = t.slice(0, i);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(t.slice(i + 1));
  }
  return map;
}

// A human made the call, so any AI "undecided" flag is resolved. AI reasoning
// is dropped for facets whose values changed — it justified a different choice.
export async function setItemTags(db, id, tags) {
  const { rows } = await db.query("SELECT tags, tag_reasoning, tag_confidence FROM items WHERE id=$1", [id]);
  const reasoning = { ...(rows[0]?.tag_reasoning || {}) };
  // Vote agreement is dropped alongside the reasoning for the same reason: it
  // describes what the AI kept saying, and the user has just overruled it. A
  // surviving "2 of 3 passes agreed" on a hand-picked value would be a lie.
  const confidence = { ...(rows[0]?.tag_confidence || {}) };
  const before = tagsByFacet(rows[0]?.tags || []);
  const after = tagsByFacet(tags);
  for (const key of new Set([...Object.keys(reasoning), ...Object.keys(confidence)])) {
    if (key === "fit") continue;
    const b = before.get(key) || new Set();
    const a = after.get(key) || new Set();
    if (b.size !== a.size || [...b].some((v) => !a.has(v))) { delete reasoning[key]; delete confidence[key]; }
  }
  // tag_facets=NULL: a human just settled this item, so any pending scoped pass
  // is moot. This UPDATE has no status fence, so it CAN land on a scoped row.
  await db.query(
    "UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, tag_confidence=$3, tag_facets=NULL, undecided=FALSE, embedding=NULL, embedding_model=NULL, embed_error=NULL, updated_at=$4 WHERE id=$5",
    [JSON.stringify(tags), JSON.stringify(reasoning), JSON.stringify(confidence), Date.now(), id]
  );
  await addTagSnapshot(db, id, "user", tags, reasoning, false);
}

// Order-insensitive tag comparison for the snapshot dedupe below.
const sameTagSet = (a, b) => {
  const x = [...(a || [])].sort(), y = [...(b || [])].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
};

// Append one row of judgment history (see tag_snapshots in 0001_baseline.sql).
// History records CHANGES — the mirror of field_snapshots' moved-only
// discipline: a tagging that lands the same tags and verdict as the item's
// latest snapshot appends nothing. Reasoning is excluded from the comparison
// (the model re-words it every call — presentation, not judgment), and so is
// source (a user's no-op save is still a no-op). Without this, a periodic
// retag re-records every stable item's unchanged judgment each pass, and a
// retag_on_refresh live board writes ~1.4k identical rows per item per day.
async function addTagSnapshot(db, itemId, source, tags, reasoning, undecided) {
  const { rows: [last] } = await db.query(
    "SELECT tags, undecided FROM tag_snapshots WHERE item_id=$1 ORDER BY tagged_at DESC, id DESC LIMIT 1",
    [itemId]
  );
  if (last && last.undecided === undecided && sameTagSet(last.tags, tags)) return;
  await db.query(
    "INSERT INTO tag_snapshots (item_id, source, tags, reasoning, undecided, tagged_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [itemId, source, JSON.stringify(tags || []), JSON.stringify(reasoning || {}), undecided, Date.now()]
  );
}

export async function getItemReasoning(db, id) {
  const { rows } = await db.query("SELECT board_id, tag_reasoning, tag_confidence, payload FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// --- the facet confidence roll-up (planning/facet-diagnosis-plan.md §1) ---
//
// Three readers over items.tag_confidence, which vote mode writes per item as
// { of, agreed, votes, d }. The reasoning lives in facet-diagnosis.js; the SQL
// lives here like everything else.
//
// EVERY one of them excludes undecided items, and `status='tagged'` does NOT do
// that — the verdict rides its own column, so an undecided item IS a tagged one
// (the same trap as facet-scope-loose-ends #8). It matters more here and in the
// direction that flatters us: an undecided item has most facets empty, every run
// picked [], so agreed === of and the facet scores UNANIMOUS. Items the model
// explicitly declined to place would count as evidence that the taxonomy works.

// The three queries below read TAG_QUEUE (declared with STATUS_PRIORITY, where
// the reasoning is) rather than naming statuses themselves.
//
// It is NOT extended to boardFacetSegments' scoped-pending clause, which is
// complete as it stands: that clause needs `tag_facets IS NOT NULL`, and a scope
// is only ever armed by retagBoardFacets, which sets 'pending' flat with no
// routing CASE. It holds on that invariant rather than on this list, and the
// invariant is stated where failOrRequeue clears the scope.

// Every (facet, definition-stamp) segment on a board with its unanimity count.
// One query for the whole board rather than two per facet: the caller has to
// compare a facet's segments against each other to choose one, so it needs them
// all regardless. A pre-stamp entry groups under d = NULL, which can never equal
// a computed stamp — "measured under an unknown definition", exactly right.
export async function boardFacetSegments(db, boardId) {
  const { rows } = await db.query(
    `SELECT e.key AS facet,
            e.value->>'d' AS d,
            count(*)::int AS items,
            count(*) FILTER (WHERE (e.value->>'agreed')::int = (e.value->>'of')::int)::int AS unanimous
     FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
     WHERE i.board_id = $1 AND NOT i.undecided
       AND (
         i.status = 'tagged'
         -- A QUEUED item's stored answer still stands for every facet its
         -- pending pass will not touch. A scoped retag rewrites only the facets
         -- it is armed for and preserves the rest (scopeResult's pick), so
         -- dropping the whole item would hide eight facets' worth of perfectly
         -- current measurements because a ninth is being re-measured.
         OR (i.status IN ('pending','processing')
             AND i.tag_facets IS NOT NULL
             AND NOT (e.key = ANY (i.tag_facets)))
       )
     GROUP BY 1, 2`,
    [boardId]
  );
  return rows;
}

// What the tagging queue is armed to rewrite, grouped by scope. NULL means a
// full pass (every facet); an array names the facets a scoped retag will
// replace. One row per distinct scope, so the caller can work out per FACET how
// much is in flight rather than treating "the board is busy" as if it applied
// to all nine equally — which is exactly backwards for the case this feature
// tells users to run.
export async function boardQueuedScopes(db, boardId) {
  const { rows } = await db.query(
    `SELECT tag_facets AS facets, count(*)::int AS n
     FROM items
     WHERE board_id = $1 AND status IN ${TAG_QUEUE} AND NOT undecided
     GROUP BY 1`,
    [boardId]
  );
  return rows;
}

// The values the runs actually PARTED on, counted once per item.
//
// NOT a sum of the tally. `votes` counts how many runs picked each value, so
// summing it across the disagreeing items measures frequency rather than
// tension: three runs, kept set {monoline}, tally {monoline: 3, gradient: 1}
// contributes 3 to monoline and 1 to gradient, and monoline tops the list
// precisely because nobody disputed it. A value is in tension on an item when
// some runs chose it and some didn't — votes[v] < of. The lower bound is free:
// a value no run picked is absent from the tally entirely.
export async function facetSplitValues(db, boardId, key, stamp) {
  const { rows } = await db.query(
    `SELECT v.key AS value, count(*)::int AS split_on
     FROM items i, jsonb_each(i.tag_confidence) AS e(key, value),
          jsonb_each(e.value->'votes') AS v(key, value)
     WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
       AND e.key = $2 AND e.value->>'d' = $3
       AND (e.value->>'agreed')::int < (e.value->>'of')::int
       AND v.value::text::int < (e.value->>'of')::int
     GROUP BY 1 ORDER BY 2 DESC, 1`,
    [boardId, key, stamp]
  );
  return rows;
}

// Boards that could carry confidence data at all. The diagnose loop's cheapest
// gate, and the only one that is a property of configuration rather than of the
// measurements — everything else it needs to know it has to count.
export async function boardsWithVotes(db) {
  const { rows } = await db.query(
    `SELECT id, name, context, facets, facet_diagnostics, ai_votes, ai_key_id, ai_model
     FROM boards WHERE ai_votes > 1 ORDER BY id`
  );
  return rows;
}

// Is the board's tagging lane quiet? A bulk retag lands items over minutes and
// the tally moves the whole time, so a diagnosis taken mid-sweep burns a call on
// a moving target and immediately re-stales. Board-level rather than per-facet
// on purpose: a scoped retag invalidates only its own facet, so this is more
// conservative than it strictly needs to be, and the extra precision would cost
// a per-facet "last landed" stamp that nothing else wants.
export async function boardTagActivity(db, boardId) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status IN ${TAG_QUEUE})::int AS busy,
            max(updated_at) FILTER (WHERE status = 'tagged') AS last_tagged
     FROM items WHERE board_id=$1`,
    [boardId]
  );
  return { busy: rows[0]?.busy || 0, lastTagged: Number(rows[0]?.last_tagged) || 0 };
}

// The whole tagging pipeline's waiting depth, all boards — the number the
// capabilities payload attaches to a blocked/degraded tagger ("N items
// waiting"). TAG_QUEUE, not 'pending' alone: an item parked in an extract or
// face leg is waiting on the same missing binding.
export async function tagQueueDepth(db) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM items WHERE status IN ${TAG_QUEUE}`);
  return rows[0].c;
}

// Boards pinning their own key for a board-scoped capability. `column` comes
// from CAPABILITY_DEFS binding.boardKeys — module constants, never input (the
// same rule the deleteAiKey loop follows).
// How many boards pin their own choice for a capability — takes the registry's
// boardKeys object, because a pin can live in EITHER column: a keyed pick sets
// keyId, a built-in pick sets provider with no key at all, and a keyId-only
// count would call the Whisper boards unpinned.
export async function countBoardOverrides(db, boardKeys) {
  const cols = [boardKeys.provider, boardKeys.keyId].filter(Boolean);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS c FROM boards WHERE ${cols.map((c) => `${c} IS NOT NULL`).join(" OR ")}`
  );
  return rows[0].c;
}

// The diagnose loop's own setter, on setIngestState's terms — and a jsonb MERGE
// rather than a whole-column write, because two facets diagnosed in the same
// pass must not overwrite each other and the user's save may be demoting a third
// at the same moment.
//
// `clearsStale` is the compare-and-swap that keeps invalidate-on-write honest,
// and without it this setter can destroy the mark that is the WHOLE mechanism.
// diagnoseDue reads facet_diagnostics ONCE at the top of a pass and diagnoses
// every facet against that snapshot, sequentially, with a provider call apiece —
// so the gap between the read and this write is the whole pass, tens of seconds,
// not the duration of one call. A retag armed anywhere in it sets stale:true, and
// a plain `||` merge writes an entry with no `stale` straight over it. From there
// the finding looks current, the loop's freshness key was computed pre-retag, and
// if the re-measurement reproduces the counts — the key's documented blind spot,
// and the exact reason the arming hook exists — nothing ever re-asks.
//
// So a write may only clear a mark it KNEW about:
//
//   pass read stale, DB stale     the finding is being replaced   -> clear
//   pass read clean, DB stale     armed mid-pass                  -> KEEP
//   a recorded failure            answered nothing                -> KEEP (false)
//
// The failure path passes false deliberately, which is the other half of the same
// bug: attempted() rebuilds the entry from scratch and drops `stale` with it, so a
// provider blip between a retag and its re-diagnosis erased the mark too.
export async function setFacetDiagnostic(db, boardId, key, entry, clearsStale = false) {
  await db.query(
    `UPDATE boards SET facet_diagnostics = facet_diagnostics || jsonb_build_object($1::text,
       $2::jsonb || CASE WHEN NOT $4::bool AND COALESCE((facet_diagnostics->$1->>'stale')::bool, FALSE)
                         THEN '{"stale":true}'::jsonb ELSE '{}'::jsonb END)
     WHERE id=$3`,
    [key, JSON.stringify(entry), boardId, clearsStale]
  );
}

// A retag has just been armed. Mark stale only the findings it actually
// undermines — the ones whose stored evidence it is about to re-measure.
//
// The question is exact and it is about ROWS, not about size: a finding names
// the twelve items the model reasoned from, so "does this retag touch any of
// them" has a yes or no answer. Retag five items on a board of 2,500 and the
// answer is almost always no, and nothing happens. Retag the board and it is
// yes for everything. There is no threshold anywhere in it.
//
// A finding with no stored evidence predates this and cannot answer, so it is
// marked — the safe direction, and it drains as findings are rewritten.
//
// `stale` rather than a delete: the finding still supplies the sentence the
// reader shows while it waits, and `stats`/`previous` are the baseline a later
// facet edit demotes into place. Only attempts/error go, because new data has
// earned fresh tries.
export async function supersedeFacetDiagnostics(db, boardId, keys = null) {
  const { rows } = await db.query("SELECT facet_diagnostics AS d FROM boards WHERE id=$1", [boardId]);
  const found = rows[0]?.d || {};
  const scoped = keys ? new Set(keys) : null;
  const candidates = Object.entries(found).filter(([k, v]) => v?.verdict && (!scoped || scoped.has(k)));
  if (!candidates.length) return [];

  // One lookup for every facet's evidence at once, by primary key.
  const queued = await queuedAmong(db, [...new Set(candidates.flatMap(([, v]) => v.evidence || []))]);
  const hit = candidates
    .filter(([, v]) => !v.evidence?.length || v.evidence.some((id) => queued.has(id)))
    .map(([k]) => k);
  if (!hit.length) return [];

  await db.query(
    `UPDATE boards SET facet_diagnostics = (
       SELECT COALESCE(jsonb_object_agg(k, CASE WHEN k = ANY($2::text[])
                                                THEN (v - 'attempts' - 'error') || '{"stale":true}'::jsonb
                                                ELSE v END), '{}'::jsonb)
       FROM jsonb_each(facet_diagnostics) AS e(k, v))
     WHERE id=$1`,
    [boardId, hit]
  );
  return hit;
}

// Demote the findings for facets whose definition the user just changed.
// `edits` is [{ key, description }] — the description being the wording being
// REPLACED, which the next diagnosis quotes back to the model so it can say
// whether the edit helped rather than re-deriving from scratch.
//
// Demote, not drop: the paragraph quotes wording that no longer exists and has
// to go, but `stats` is the only evidence the user's edit did anything, and it
// is what "was 60% unanimous, now 88%" is measured against.
//
// A second edit before any re-measurement finds no `stats` to move and leaves
// the older baseline alone. That is deliberately not "overwrite `previous`":
// overwriting it with a demoted entry's empty stats would destroy the only
// baseline there is, and nesting would grow a history in a board column.
//
// FOR UPDATE rather than a bare read: setFacetDiagnostic is a plain UPDATE from
// the worker, so the lock is what keeps a diagnosis landing mid-save from being
// read, dropped and written back.
export async function demoteFacetDiagnostics(db, boardId, edits) {
  if (!edits?.length) return 0;
  return withTx(db, async (client) => {
    const { rows } = await client.query("SELECT facet_diagnostics FROM boards WHERE id=$1 FOR UPDATE", [boardId]);
    if (!rows.length) return 0;
    const map = { ...(rows[0].facet_diagnostics || {}) };
    let n = 0;
    for (const { key, description } of edits) {
      const e = map[key];
      if (!e?.stats) continue;
      map[key] = {
        previous: {
          stats: e.stats,
          description: description || "",
          d: e.d ?? null,
          scoped: e.scoped ?? null,
          at: e.at ?? null,
        },
      };
      n++;
    }
    if (!n) return 0;
    await client.query("UPDATE boards SET facet_diagnostics=$1 WHERE id=$2", [JSON.stringify(map), boardId]);
    return n;
  });
}

// Worked examples for the diagnosis prompt: items where this facet was contested
// (agreed < of, most contested first) or unanimous (agreed = of). The two sets
// are disjoint by construction and the prompt shows them as labelled groups —
// shown only failures, a model can never reach the "your taxonomy is fine"
// verdict, so every board would read as broken.
//
// The whole-item `description`, NOT the per-facet sentence (tag_reasoning->>key).
// That looks like the better source and is systematically absent exactly where
// it is needed: mergeVotes takes the sentence from the earliest run that
// selected what was KEPT, and from nowhere when no single run proposed that set
// — routine on a multi-value facet, and multi-value facets are the unstable
// ones. Reaching for it would bias the sample toward the items that agreed.
//
// Contested items order on the RATIO: `of` is how many runs completed, not the
// configured ai_votes, so a board carries a mix of 2-, 3- and 5-run items and
// ordering on `agreed` alone would rank 1-of-2 above 2-of-5.
export async function facetExamples(db, boardId, key, stamp, { contested, limit }) {
  const { rows } = await db.query(
    `SELECT i.id::text AS id,
            i.tag_reasoning->>'description' AS description,
            e.value->'votes' AS votes,
            (e.value->>'agreed')::int AS agreed,
            (e.value->>'of')::int AS of
     FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
     WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
       AND e.key = $2 AND e.value->>'d' = $3
       AND (e.value->>'agreed')::int ${contested ? "<" : "="} (e.value->>'of')::int
       AND i.tag_reasoning ? 'description'
     ORDER BY ${contested ? "(e.value->>'agreed')::numeric / (e.value->>'of')::int ASC," : ""} i.id
     LIMIT $4`,
    [boardId, key, stamp, limit]
  );
  return rows;
}

// There was a second query here — facetEvidenceIds — returning the ids of the
// same two groups facetExamples returns, under a comment warning that it "must
// stay byte-identical to facetExamples in its WHERE and ORDER BY or it would be
// tracking a different twelve from the ones the model reads". A warning is the
// weakest possible guard against that, and it was only ever half the problem:
// ids are not what the model reads. It reads each item's DESCRIPTION and vote
// TALLY, and the ordering keys on `agreed/of` alone — so a re-measurement that
// inverts every tally and rewrites every description while preserving the ratios
// left the id list byte-identical and the freshness key unmoved. Demonstrated,
// not argued: same key, "a rounded wordmark" becoming "a broad angular slab".
//
// So the loop calls facetExamples itself and hashes the rows it gets back
// (facet-diagnosis.js, facetEvidence). One query pair serves the check and the
// prompt, which is what makes "the same twelve" true by construction rather than
// by a comment nobody re-reads.

// Of the given item ids, which are currently queued for tagging. A primary-key
// lookup over at most a dozen ids per facet — the cheap half of the arming
// check, and the reason it can run inline on a retag.
//
// TAG_QUEUE, not 'pending' alone: an item routed through the extract or face leg
// is every bit as re-measured as one that went straight to tagging, and reading
// two of the four states made this whole hook a no-op on mapped and connector
// boards while the route still logged "retag queued: 2,406 item(s)".
export async function queuedAmong(db, ids) {
  if (!ids?.length) return new Set();
  const { rows } = await db.query(
    `SELECT id::text AS id FROM items
     WHERE id = ANY($1::bigint[]) AND status IN ${TAG_QUEUE}`,
    [ids]
  );
  return new Set(rows.map((r) => r.id));
}

// The mapping to stamp for AI extraction: the given mapping when it has AI
// work in it (derived identity or extract/detect fields — aiWork asks the
// source table), else null. Same gate as ingest's admitFile.
function aiMappingJson(mapping) {
  return aiWork(mapping) ? JSON.stringify(mapping) : null;
}

// The stamped-face routing predicate shared VERBATIM by retagBoard /
// releaseHeld / queueUntagged: an unfaced connector tag-vehicle (chart face in
// the stamp, no files) re-enters the face leg before tagging. One string so
// the three can't drift. reprocessEntity's variant differs ON PURPOSE — it
// prefers the fresh re-stamp (COALESCE) and also re-faces rendered charts
// (generated file) — so it is not folded in here.
const STAMPED_CONNECTOR_FACE =
  `payload->'mapping'->'face'->>'source' = 'connector'
                AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0`;

// Its sibling, shared by the same three routers AND reprocessEntity: an
// enqueued connector vehicle whose provider fetch never landed (bulk add's
// queued path — connectors/add.js enqueueConnectorEntity) re-enters the FETCH
// leg, and this arm must come FIRST in every CASE that uses it: an unfetched
// vehicle on a chart-face board satisfies STAMPED_CONNECTOR_FACE too, and the
// face arm would swallow it — rendering a chart from empty fields and then
// tagging on nothing, which lands as ordinary-looking tags (the tagger does
// not fail on an empty field set; it just isn't told anything).
const UNFETCHED = `payload ? 'unfetched'`;

async function boardAiMappingJson(db, boardId) {
  const { rows } = await db.query("SELECT mapping FROM boards WHERE id=$1", [boardId]);
  return rows.length ? aiMappingJson(rows[0].mapping) : null;
}

// Reset an item to the extract leg. User-initiated, so the CURRENT board
// mapping is what applies — it's re-stamped onto the instance (the stamp an
// instance was built with only governs automatic replay, e.g. error retries).
// A board with no AI mapping falls back to replaying the instance's stamp;
// with neither there is nothing to extract.
export async function reextractItem(db, id) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM items i JOIN boards b ON b.id = i.board_id WHERE i.id=$1", [id]);
  if (!rows.length) return false;
  const current = aiMappingJson(rows[0].mapping);
  // `- 'park'`: an explicit re-extract runs the full pipeline through tagging,
  // even on an auto-tag-off board — park only gates the automatic ingest flow.
  // `- 'transcript_error'`: for audio the extracted text IS the transcript, so a
  // re-extract retries a failed transcription (a good transcript is kept).
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN $3::jsonb IS NULL THEN payload - 'park' - 'transcript_error'
                        ELSE jsonb_set(payload - 'park' - 'transcript_error', '{mapping}', $3::jsonb) END,
         status='pending_extract', tag_facets=NULL, attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE id=$2 AND ($3::jsonb IS NOT NULL OR payload ? 'mapping')`,
    [Date.now(), id, current]
  );
  return result.rowCount > 0;
}

// Reset one instance to the tag leg — re-tag it from its existing material and
// fields, without re-deriving identity/fields. The per-instance counterpart to
// the card-level full reprocess (reprocessEntity); the lightbox exposes it next
// to Re-extract since a single instance is what's in focus there.
export async function retagItem(db, id) {
  const result = await db.query(
    // tag_facets=NULL: this is an explicit FULL retag. No status fence here, so
    // it can land on a row already queued for a scoped pass — that scope dies.
    "UPDATE items SET status='pending', tags='[]'::jsonb, tag_reasoning='{}'::jsonb, tag_confidence='{}'::jsonb, tag_facets=NULL, undecided=FALSE, attempts=0, error=NULL, retry_at=NULL, updated_at=$1 WHERE id=$2",
    [Date.now(), id]
  );
  return result.rowCount > 0;
}

// --- users / invites / sessions / favorites ---

export async function seedAdmin(db, email) {
  if (!email) return;
  email = email.trim().toLowerCase();
  await db.query(
    `INSERT INTO users (email, name, is_admin, created_at) VALUES ($1, $2, TRUE, $3)
     ON CONFLICT(email) DO UPDATE SET is_admin = TRUE`,
    [email, email.split("@")[0], Date.now()]
  );
}

export async function createUser(db, email, name) {
  email = String(email).trim().toLowerCase();
  const existing = await getUserByEmail(db, email);
  if (existing) return existing;
  const { rows } = await db.query(
    "INSERT INTO users (email, name, is_admin, created_at) VALUES ($1, $2, FALSE, $3) RETURNING *",
    [email, name || null, Date.now()]
  );
  return rows[0];
}

export async function getUserByEmail(db, email) {
  const { rows } = await db.query("SELECT * FROM users WHERE email=$1", [
    String(email).trim().toLowerCase(),
  ]);
  return rows[0] || null;
}

export async function userExists(db, id) {
  const { rows } = await db.query("SELECT 1 FROM users WHERE id=$1", [id]);
  return rows.length > 0;
}

export async function getUserById(db, id) {
  const { rows } = await db.query("SELECT * FROM users WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function setPassword(db, userId, passwordHash) {
  await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [passwordHash, userId]);
}

// True once any account can sign in with a password. The negation is the
// "nobody can log in" state — a fresh instance, or one restored from an
// archive with no passworded accounts — that unlocks first-run setup.
export async function anyPasswordSet(db) {
  const { rows } = await db.query("SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1");
  return rows.length > 0;
}

export async function setUserName(db, userId, name) {
  await db.query("UPDATE users SET name=$1 WHERE id=$2", [name, userId]);
}

// The reader's board arrangement (planning/board-arrangement-plan.md), written
// whole. The client sends the sequence it just produced, so there is no
// per-board bookkeeping here and no way for two ids to claim one position —
// which is the difference between storing a ranking and storing an index.
export async function setBoardOrder(db, userId, order) {
  await db.query("UPDATE users SET board_order=$1 WHERE id=$2", [JSON.stringify(order), userId]);
}

export async function listUsers(db) {
  // No invite token here: it's a bearer credential and only its hash is stored
  // now anyway. The admin mints a fresh link on demand (POST /users/:id/link).
  //
  // Board access rides along as a second query — one join for everyone, grouped
  // below, rather than the query-per-row shape /api/admin/boards still has. The
  // two don't depend on each other, so they overlap. Board order matches
  // listBoards, so a member's boards read in the same sequence as the Boards
  // tab lists them.
  //
  // A global admin gets nothing from that join, on purpose: canAccessBoard
  // reaches every board from is_admin alone, WITHOUT a board_members row, so
  // synthesising rows for them would put a second copy of that rule in a
  // display path. Callers read is_admin and say "all" — the same answer the
  // board access picker gives when it checks their box and disables it.
  const [{ rows }, { rows: memberships }] = await Promise.all([
    db.query(
      `SELECT u.id, u.email, u.name, u.is_admin, u.last_login_at
       FROM users u ORDER BY u.is_admin DESC, u.created_at ASC`
    ),
    db.query(
      `SELECT bm.user_id, bm.board_id, bm.role, b.name
         FROM board_members bm JOIN boards b ON b.id = bm.board_id
        ORDER BY b.created_at ASC`
    ),
  ]);
  const byUser = new Map();
  for (const m of memberships) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push({ id: m.board_id, name: m.name, role: m.role });
  }
  return rows.map((u) => ({ ...u, boards: byUser.get(u.id) || [] }));
}

export async function deleteUser(db, id) {
  // FKs cascade sessions/invites/favorites/crates.
  await db.query("DELETE FROM users WHERE id=$1 AND NOT is_admin", [id]);
}

// A password change revokes any outstanding invite link: an unredeemed
// invite is a live login, so it must die with the other sessions.
export async function deleteUnredeemedInvites(db, userId) {
  await db.query("DELETE FROM invites WHERE user_id=$1 AND used_at IS NULL", [userId]);
}

export async function consumeInvite(db, token) {
  const hash = hashToken(token);
  const { rows } = await db.query("SELECT * FROM invites WHERE token=$1", [hash]);
  const row = rows[0];
  if (!row || row.expires_at < Date.now() || row.used_at) return null;
  await db.query("UPDATE invites SET used_at=$1 WHERE token=$2", [Date.now(), hash]);
  return row.user_id;
}

// Single-use onboarding/reset link. Minting replaces any outstanding
// unredeemed link for the user, so a leaked older link dies with the new mint.
export async function mintInvite(db, userId, ttlMs = 30 * 24 * 3600 * 1000) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await withTx(db, async (client) => {
    await client.query("DELETE FROM invites WHERE user_id=$1 AND used_at IS NULL", [userId]);
    await client.query(
      `INSERT INTO invites (token, user_id, expires_at, used_at, created_at, permanent)
       VALUES ($1, $2, $3, NULL, $4, FALSE)`,
      [hashToken(token), userId, now + ttlMs, now]
    );
  });
  return token; // raw token — returned once, only its hash is stored
}

export async function createSession(db, userId, ttlMs = 90 * 24 * 3600 * 1000) {
  const id = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await db.query(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [hashToken(id), userId, now, now + ttlMs]
  );
  return id; // raw id for the cookie; the DB holds only its hash
}

export async function getSessionUser(db, sid) {
  if (!sid) return null;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > $2`,
    [hashToken(sid), Date.now()]
  );
  return rows[0] || null;
}

export async function deleteSession(db, sid) {
  if (sid) await db.query("DELETE FROM sessions WHERE id=$1", [hashToken(sid)]);
}

// Password change revokes every other session; the caller's own sid survives.
export async function deleteOtherSessions(db, userId, keepSid) {
  await db.query("DELETE FROM sessions WHERE user_id=$1 AND id <> $2", [userId, hashToken(keepSid || "")]);
}

// Sliding expiry: renew the session to now+ttl, but only write if it hasn't
// been renewed in the last `minIdleMs` (≈ once/day). Returns true if renewed.
export async function touchSession(db, sid, ttlMs = 90 * 24 * 3600 * 1000, minIdleMs = 24 * 3600 * 1000) {
  if (!sid) return false;
  const now = Date.now();
  const result = await db.query("UPDATE sessions SET expires_at=$1 WHERE id=$2 AND expires_at < $3", [
    now + ttlMs,
    hashToken(sid),
    now + ttlMs - minIdleMs,
  ]);
  return result.rowCount > 0;
}

export async function touchLogin(db, userId) {
  await db.query("UPDATE users SET last_login_at=$1 WHERE id=$2", [Date.now(), userId]);
}

export async function toggleFavorite(db, userId, itemId) {
  const exists = (
    await db.query("SELECT 1 FROM favorites WHERE user_id=$1 AND item_id=$2", [userId, itemId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM favorites WHERE user_id=$1 AND item_id=$2", [userId, itemId]);
  } else {
    // Hearts are entity-level; item_id references entities (see 0001_baseline.sql).
    const item = await db.query("SELECT 1 FROM entities WHERE id=$1", [itemId]);
    if (!item.rows.length) return null;
    await db.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, $3)", [
      userId,
      itemId,
      Date.now(),
    ]);
  }
  // The heart count is part of the entity's list payload — stamp it so other
  // viewers' delta polls pick the change up.
  await touchEntity(db, itemId);
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM favorites WHERE item_id=$1", [itemId]);
  return { favorited: !exists, count: rows[0].c };
}

export async function heartNames(db, itemId) {
  const { rows } = await db.query(
    `SELECT u.name, u.email FROM favorites f JOIN users u ON u.id = f.user_id
     WHERE f.item_id = $1 ORDER BY f.created_at ASC`,
    [itemId]
  );
  return rows.map((r) => r.name || r.email);
}

// --- crates ---

export async function listCrates(db, userId, boardId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.public, c.user_id = $1 AS owned,
      COALESCE(u.name, u.email) AS owner_name,
      (SELECT COUNT(*) FROM crate_items ci WHERE ci.crate_id = c.id) AS item_count
     FROM crates c
     JOIN users u ON u.id = c.user_id
     WHERE c.board_id = $2 AND (c.user_id = $1 OR c.public = TRUE)
     ORDER BY (c.user_id = $1) DESC, c.created_at ASC`,
    [userId, boardId]
  );
  return rows;
}

export async function createCrate(db, userId, boardId, name) {
  name = String(name).trim().slice(0, 64);
  if (!name || !boardId) return null;
  try {
    const { rows } = await db.query(
      "INSERT INTO crates (user_id, board_id, name, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, boardId, name, Date.now()]
    );
    return { id: rows[0].id, name, public: false, owned: true, item_count: 0 };
  } catch (err) {
    if (err.code !== "23505") throw err; // anything but unique_violation is real
    const { rows } = await db.query(
      "SELECT id, name, public FROM crates WHERE user_id=$1 AND board_id=$2 AND name=$3",
      [userId, boardId, name]
    );
    if (!rows.length) return null;
    const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [rows[0].id]);
    return { id: rows[0].id, name: rows[0].name, public: !!rows[0].public, owned: true, item_count: count.rows[0].c };
  }
}

export async function setCratePublic(db, userId, crateId, isPublic) {
  const { rows } = await db.query(
    `UPDATE crates SET public = $3 WHERE id = $1 AND user_id = $2
     RETURNING id, name, public`,
    [crateId, userId, !!isPublic]
  );
  if (!rows.length) return null;
  const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  return {
    id: rows[0].id,
    name: rows[0].name,
    public: rows[0].public,
    owned: true,
    item_count: count.rows[0].c,
  };
}

export async function deleteCrate(db, userId, crateId) {
  // crate_images cascades.
  const result = await db.query("DELETE FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  return result.rowCount > 0;
}

export async function toggleCrateItem(db, userId, crateId, itemId) {
  const crate = await db.query("SELECT id, board_id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const exists = (
    await db.query("SELECT 1 FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId]);
  } else {
    // A crate only holds entities from its own board.
    const item = await db.query("SELECT 1 FROM entities WHERE id=$1 AND board_id=$2", [itemId, crate.rows[0].board_id]);
    if (!item.rows.length) return null;
    await db.query("INSERT INTO crate_items (crate_id, item_id, created_at) VALUES ($1, $2, $3)", [
      crateId,
      itemId,
      Date.now(),
    ]);
  }
  // crateIds ride in the entity's list payload — stamp for delta polls.
  await touchEntity(db, itemId);
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  return { added: !exists, count: rows[0].c };
}

// --- filter configs (named facet-selection snapshots, per user per board) ---

export async function listFilterConfigs(db, userId, boardId) {
  const { rows } = await db.query(
    "SELECT id, name, config FROM filter_configs WHERE user_id=$1 AND board_id=$2 ORDER BY created_at ASC",
    [userId, boardId]
  );
  return rows;
}

// Saving under an existing name overwrites its config — "save" means
// "this name now points at the current filters".
export async function saveFilterConfig(db, userId, boardId, name, config) {
  name = String(name).trim().slice(0, 64);
  if (!name || !boardId) return null;
  const { rows } = await db.query(
    `INSERT INTO filter_configs (user_id, board_id, name, config, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, board_id, name) DO UPDATE SET config = EXCLUDED.config
     RETURNING id, name, config`,
    [userId, boardId, name, JSON.stringify(config || {}), Date.now()]
  );
  return rows[0];
}

export async function deleteFilterConfig(db, userId, id) {
  const result = await db.query("DELETE FROM filter_configs WHERE id=$1 AND user_id=$2", [id, userId]);
  return result.rowCount > 0;
}

// --- AI keys (multi-provider registry for the tagger) ---

// `boards_using` counts every board pinned to the key through ANY capability's
// board column — the OR-chain comes from the registry, because the hand-written
// pair (`ai_key_id OR extract_key_id`) is exactly the list that would have
// silently missed the transcribe/detect pins.
const BOARDS_USING_KEY = CAPABILITY_DEFS
  .flatMap((c) => (c.binding.boardKeys?.keyId ? [c.binding.boardKeys.keyId] : []))
  .map((col) => `b.${col} = k.id`)
  .join(" OR ");

export async function listAiKeys(db) {
  const { rows } = await db.query(
    `SELECT k.id, k.name, k.provider, k.api_key, k.base_url, k.created_at,
      (SELECT COUNT(*) FROM boards b WHERE ${BOARDS_USING_KEY}) AS boards_using
     FROM ai_keys k ORDER BY k.created_at ASC`
  );
  return rows;
}

export async function getAiKey(db, id) {
  const { rows } = await db.query("SELECT id, name, provider, api_key, base_url FROM ai_keys WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function createAiKey(db, name, provider, apiKey, baseUrl = null) {
  const { rows } = await db.query(
    "INSERT INTO ai_keys (name, provider, api_key, base_url, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [name, provider, apiKey, baseUrl, Date.now()]
  );
  return rows[0].id;
}

// Partial in-place update of a connection row: rename, repoint (server URL),
// or rotate the secret. Editing in place — vs remove + re-add — is what keeps
// every pointer alive (boards, the default-tagger slot, embed/transcribe),
// which is exactly what you want when rotating a key or fixing a typo'd URL.
export async function updateAiKey(db, id, { name, apiKey, baseUrl }) {
  const sets = [], vals = [];
  if (name !== undefined) { vals.push(name); sets.push(`name=$${vals.length}`); }
  if (apiKey !== undefined) { vals.push(apiKey); sets.push(`api_key=$${vals.length}`); }
  if (baseUrl !== undefined) { vals.push(baseUrl); sets.push(`base_url=$${vals.length}`); }
  if (!sets.length) return true;
  vals.push(id);
  const r = await db.query(`UPDATE ai_keys SET ${sets.join(", ")} WHERE id=$${vals.length}`, vals);
  return r.rowCount > 0;
}

// Boards referencing the key fall back to the default via ON DELETE SET NULL;
// their model override goes with it, and if the key *was* the default, clear
// the settings pointer too.
// A deleted key/connection reverts every binding that pointed at it, honestly,
// instead of leaving a dead pointer the UI shows as configured while resolution
// silently falls to the floor. Both loops below iterate CAPABILITY_DEFS rather
// than naming the capabilities: the hand-written version missed `detect`
// entirely, and cleared only part of the namespace for the three it did cover.
export async function deleteAiKey(db, id) {
  // Board-scoped bindings first: the key column itself is FK ON DELETE SET NULL,
  // so only the model it pinned needs clearing. Column names come from the
  // capability table (module constants, not input).
  for (const cap of CAPABILITY_DEFS) {
    const bk = cap.binding.boardKeys;
    if (bk) await db.query(`UPDATE boards SET ${bk.model}=NULL WHERE ${bk.keyId}=$1`, [id]);
  }
  const result = await db.query("DELETE FROM ai_keys WHERE id=$1", [id]);
  if (result.rowCount === 0) return false;
  // Global bindings: clear the WHOLE namespace of any capability bound to this
  // key, not a hand-picked subset. Leaving tagging's `model` behind was its own
  // bug — the env rung reads that setting, so deleting an OpenAI default key
  // left Claude being asked for "gpt-5-mini" on every item.
  for (const cap of CAPABILITY_DEFS) {
    const keyIdSetting = cap.binding.keys?.keyId;
    if (!keyIdSetting || Number(await getSetting(db, keyIdSetting)) !== id) continue;
    for (const s of bindingSettings(cap)) await setSetting(db, s, null);
  }
  return true;
}

// --- boards ---

// Every per-board capability column, from the registry — so a new
// board-scoped capability's columns ride into BOARD_COLS, the admin board
// payload, and updateBoard's boardBindings without a hand edit here. Each
// capability declares its own columns; the Set just guards that invariant.
//
// TWO kinds, and the split is an AUTHORITY boundary, not bookkeeping:
//   PINS    boardKeys — a provider/key/model pointer. Admin-written (they
//           select credentials and therefore a spend account), and cleared by
//           the deleted-key and uninstall loops.
//   CONFIG  binding.config[].boardColumn — a capability-level knob scoped per
//           board (tagging's image detail). A cost/quality dial like
//           ai_votes, so any board MANAGER may set it; not a pointer, so
//           nothing dangles and no cleanup loop touches it.
// Both are selected and writable through updateBoard; only the pins are gated
// behind is_admin in the board payload (server.js).
export const BOARD_PIN_COLS = [...new Set(
  CAPABILITY_DEFS.flatMap((c) => {
    const bk = c.binding.boardKeys;
    return bk ? [bk.provider, bk.keyId, bk.model].filter(Boolean) : [];
  })
)];
export const BOARD_CONFIG_COLS = [...new Set(
  CAPABILITY_DEFS.flatMap((c) => (c.binding.config || []).map((f) => f.boardColumn).filter(Boolean))
)];
export const BOARD_BINDING_COLS = [...new Set([...BOARD_PIN_COLS, ...BOARD_CONFIG_COLS])];

// boards.type still exists in the schema (unread legacy; drop in a later
// schema pass) but is deliberately not selected anywhere.
const BOARD_COLS =
  "id, name, facets, context, ai_reasoning, ai_research, ai_votes, " +
  BOARD_BINDING_COLS.join(", ") + ", " +
  "auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, mapping, gather_every_min, retag_on_refresh, " +
  "ingest, ingest_next_run_at, ingest_state, facet_diagnostics, created_at";
// Hand-written, so a new column is invisible until it is named here — which is
// how a feature evaporates into "it never writes anything" with a green suite.
// facet_diagnostics is read by the board modal and the diagnostics surface; the
// worker's own loop selects it explicitly (boardsWithVotes) and does not rely on
// this list.

// The row a new board is born with — column-named, exactly as getBoard reads
// it back. createBoard's INSERT below writes these values; the create route
// (server.js) runs the shared content trunk against this object as its
// synthetic `prev`, so what the trunk computes for a create (schedule arming,
// the votes/research exclusion) is judged against the same baseline the
// INSERT will write. The values live twice — here and in the INSERT's
// defaults — and a board-manage test pins this object against a freshly
// inserted row so the pair cannot drift silently.
export const NEW_BOARD_DEFAULTS = {
  facets: [], context: "", ai_reasoning: true, ai_research: false, ai_votes: 1,
  auto_tag: true, auto_tag_periodic: false, auto_tag_every_min: 1440,
  auto_tag_skip_weekends: false, auto_tag_next_run_at: null,
  mapping: null, retag_on_refresh: false, ingest: null, ingest_next_run_at: null,
};

export async function createBoard(db, name, facets = [], context = "", aiReasoning = true, aiKeyId = null, aiModel = null, autoTag = {}, aiResearch = false, extras = {}) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO boards (id, name, facets, context, ai_reasoning, ai_research, ai_votes, ai_key_id, ai_model,
       auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at,
       mapping, extract_key_id, extract_model, retag_on_refresh, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id, name, JSON.stringify(facets), context, !!aiReasoning, !!aiResearch, extras.aiVotes ?? 1, aiKeyId, aiModel,
      autoTag.enabled !== false, !!autoTag.periodic, autoTag.everyMin || 1440,
      !!autoTag.skipWeekends, autoTag.nextRunAt ?? null,
      extras.mapping ? JSON.stringify(extras.mapping) : null,
      extras.extractKeyId ?? null, extras.extractModel ?? null, !!extras.retagOnRefresh, Date.now(),
    ]
  );
  return id;
}

// Creation order, which is the INSTANCE's order — the admin board table reads
// it directly and should, since those rows get compared across people. Anything
// a member sees goes through accessibleBoards (server.js), which re-sorts into
// the reader's own arrangement; a new reader-facing listing wants that one.
export async function listBoards(db) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards ORDER BY created_at ASC`);
  return rows;
}

export async function getBoard(db, id) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function updateBoard(db, id, { name, facets, context, aiReasoning, aiResearch, aiVotes, autoTag, autoTagPeriodic, autoTagEveryMin, autoTagSkipWeekends, autoTagNextRunAt, mapping, retagOnRefresh, ingest, ingestNextRunAt, boardBindings } = {}) {
  const sets = [];
  const vals = [];
  // Per-board capability columns as a { column: value } map — BOTH kinds (see
  // BOARD_PIN_COLS / BOARD_CONFIG_COLS above): pins from boardBindingPatch on
  // the admin routes, knobs from boardConfigPatch on the manager route too.
  // The authority split is enforced by which route builds the map; by the time
  // it reaches here the two are written the same way. Column names come from
  // the registry via the route — code, never input — and BOARD_BINDING_COLS
  // (the union) is the allow-list that keeps that true even for a future
  // caller that forgets.
  for (const [col, v] of Object.entries(boardBindings || {})) {
    if (!BOARD_BINDING_COLS.includes(col)) continue;
    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  }
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name=$${vals.length}`); }
  if (facets !== undefined) { vals.push(JSON.stringify(facets)); sets.push(`facets=$${vals.length}`); }
  if (context !== undefined) { vals.push(String(context)); sets.push(`context=$${vals.length}`); }
  if (aiReasoning !== undefined) { vals.push(!!aiReasoning); sets.push(`ai_reasoning=$${vals.length}`); }
  if (aiResearch !== undefined) { vals.push(!!aiResearch); sets.push(`ai_research=$${vals.length}`); }
  if (aiVotes !== undefined) { vals.push(Number(aiVotes)); sets.push(`ai_votes=$${vals.length}`); }
  if (autoTag !== undefined) { vals.push(!!autoTag); sets.push(`auto_tag=$${vals.length}`); }
  if (autoTagPeriodic !== undefined) { vals.push(!!autoTagPeriodic); sets.push(`auto_tag_periodic=$${vals.length}`); }
  if (autoTagEveryMin !== undefined) { vals.push(autoTagEveryMin); sets.push(`auto_tag_every_min=$${vals.length}`); }
  if (autoTagSkipWeekends !== undefined) { vals.push(!!autoTagSkipWeekends); sets.push(`auto_tag_skip_weekends=$${vals.length}`); }
  if (autoTagNextRunAt !== undefined) { vals.push(autoTagNextRunAt); sets.push(`auto_tag_next_run_at=$${vals.length}`); }
  if (mapping !== undefined) { vals.push(mapping === null ? null : JSON.stringify(mapping)); sets.push(`mapping=$${vals.length}`); }
  if (retagOnRefresh !== undefined) { vals.push(!!retagOnRefresh); sets.push(`retag_on_refresh=$${vals.length}`); }
  if (ingest !== undefined) { vals.push(ingest === null ? null : JSON.stringify(ingest)); sets.push(`ingest=$${vals.length}`); }
  if (ingestNextRunAt !== undefined) { vals.push(ingestNextRunAt); sets.push(`ingest_next_run_at=$${vals.length}`); }
  // ingest_state is deliberately absent: the sweep owns it (setIngestState).
  // facet_diagnostics likewise (setFacetDiagnostic) — with one exception the
  // routes handle rather than this function: changing `facets` demotes the
  // findings for the facets whose definition moved. That needs the OLD facet
  // list to diff against, which this function does not read and must not start
  // reading — the modal sends `facets` on every save, so "facets !== undefined"
  // is not "the taxonomy changed". See demoteFacetDiagnostics.
  if (!sets.length) return false;
  vals.push(id);
  const result = await db.query(`UPDATE boards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  return result.rowCount > 0;
}

// Returns the deleted board's item payloads (the caller hands their files to
// sources.cleanup), or null if the board doesn't exist. Rows cascade via FKs.
export async function deleteBoard(db, id) {
  return withTx(db, async (client) => {
    // Lock first: the tx alone doesn't stop a concurrent ingest/reparent from
    // slipping an item between the payload read and the cascade (orphaning its
    // file). FK references take FOR KEY SHARE on this row, so they block here
    // and fail cleanly once the delete commits.
    const locked = await client.query("SELECT 1 FROM boards WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length) return null;
    const items = await client.query("SELECT payload FROM items WHERE board_id=$1", [id]);
    // The meter has no FK on boards (its '' sentinel forbids one — see 0040),
    // so the cascade the other tables ride doesn't reach it. Purged here.
    await client.query("DELETE FROM usage_meter WHERE board_id=$1", [id]);
    const result = await client.query("DELETE FROM boards WHERE id=$1", [id]);
    if (result.rowCount === 0) return null;
    return items.rows.map((r) => r.payload);
  });
}

export async function boardExists(db, id) {
  const { rows } = await db.query("SELECT 1 FROM boards WHERE id=$1", [id]);
  return rows.length > 0;
}

export async function boardHasItems(db, id) {
  const { rows } = await db.query("SELECT 1 FROM items WHERE board_id=$1 LIMIT 1", [id]);
  return rows.length > 0;
}

// Per-board item totals + pending/held counts in one pass: { boardId: { c, p, h } }.
export async function boardItemStats(db) {
  const { rows } = await db.query(
    `SELECT board_id, COUNT(*) AS c,
       COUNT(*) FILTER (WHERE status='pending') AS p,
       COUNT(*) FILTER (WHERE status='held') AS h
     FROM items GROUP BY board_id`
  );
  return Object.fromEntries(rows.map((r) => [r.board_id, { c: r.c, p: r.p, h: r.h }]));
}

// Gallery-card counts for the boards page: entities per board — what a member
// sees as cards — NOT items rows (a derived-identity board bundles several
// instances under one card; boardItemStats answers the admin's inventory
// question, this answers "how big does the gallery look"). { boardId: n }.
export async function boardEntityCounts(db) {
  const { rows } = await db.query(
    "SELECT board_id, COUNT(*)::int AS c FROM entities GROUP BY board_id"
  );
  return Object.fromEntries(rows.map((r) => [r.board_id, r.c]));
}

// The boards page's preview stacks: newest n file-carrying instances per board,
// projected straight from payload.files[0] in the thumbnail vocabulary
// (name/w/h/kind — instanceEntry's face fields). Deliberately NOT the
// gallery's selectFace pick (that needs all of an entity's instances plus
// mapping.face); a preview stack is impressionistic, and on raw boards the two
// coincide anyway. Boards short of n (connector entities carry no files) top
// up with their newest entities' symbol tiles — the same fallback face the
// gallery renders for them. Returns { boardId: entries[] } for every requested
// id, each entry { name, w, h, kind } or { symbol, display_name }.
// Top-n-per-board is a LATERAL, not a window over the whole table: paired with
// idx_items_board_created (migration 0028) each board walks its own slice of
// the index and stops after n, so the cost tracks the number of BOARDS rather
// than the size of the library. The window form re-read and sorted every row on
// every board to keep n of them — measured at ~19ms over 8k items and growing
// linearly, against ~3ms flat here. (The index alone doesn't help the window
// form: reading `payload` forces a heap visit per row, so nothing terminates
// early. Both halves of the change are needed.)
export async function boardPreviewFaces(db, boardIds, n = 8) {
  const out = Object.fromEntries(boardIds.map((id) => [id, []]));
  if (!boardIds.length) return out;
  // created_at/iid ride along only so the outer ORDER BY can be explicit —
  // nested-loop output order is a plan detail, not a guarantee.
  const { rows: files } = await db.query(
    `SELECT b.id AS board_id, t.name, t.w, t.h, t.kind
     FROM unnest($1::text[]) AS b(id)
     CROSS JOIN LATERAL (
       SELECT i.created_at, i.id AS iid,
         i.payload->'files'->0->>'name'      AS name,
         (i.payload->'files'->0->>'w')::int  AS w,
         (i.payload->'files'->0->>'h')::int  AS h,
         i.payload->'files'->0->>'kind'      AS kind
       FROM items i
       WHERE i.board_id = b.id AND i.payload->'files'->0 IS NOT NULL
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT $2
     ) t
     ORDER BY b.id, t.created_at DESC, t.iid DESC`,
    [boardIds, n]
  );
  for (const r of files) out[r.board_id].push({ name: r.name, w: r.w, h: r.h, kind: r.kind || "image" });
  const short = boardIds.filter((id) => out[id].length < n);
  if (short.length) {
    const { rows: ents } = await db.query(
      `SELECT b.id AS board_id, t.symbol, t.display_name, t.identity
       FROM unnest($1::text[]) AS b(id)
       CROSS JOIN LATERAL (
         SELECT e.created_at, e.id AS eid, e.symbol, e.display_name, e.identity
         FROM entities e
         WHERE e.board_id = b.id AND e.symbol IS NOT NULL
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $2
       ) t
       ORDER BY b.id, t.created_at DESC, t.eid DESC`,
      [short, n]
    );
    for (const r of ents) {
      const bucket = out[r.board_id];
      if (bucket.length < n) bucket.push({ symbol: r.symbol, display_name: r.display_name || r.identity });
    }
  }
  return out;
}

// Queue a board's settled items for a fresh tagging pass (held ones included —
// retag is an explicit "tag now"). Returns the count. Only terminal states are
// touched: items still in the pipeline (any waiting or claimed leg status)
// already end in the tag leg when their legs finish, so flipping them here
// would only skip their definition legs and tag them with no fields,
// identity or face. Touched items resume the RIGHT leg,
// with the same routing as releaseHeld: an unfaced connector vehicle re-enters
// the face leg (another shot at the chart), anything already extracted goes
// straight to tagging, anything not yet extracted — a failed extraction, or a
// tagged item that never got its definition — re-enters the extract leg. Held
// items with no stamp adopt the current board mapping (the board may have
// gained one since they were uploaded); other unstamped items stay tag-only,
// so retag never turns into a surprise extraction sweep over a whole board.
export async function retagBoard(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN status='held' AND NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN ${UNFETCHED} THEN 'pending_fetch'
           WHEN ${STAMPED_CONNECTOR_FACE} THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR (status='held' AND $3::jsonb IS NOT NULL) THEN 'pending_extract'
           ELSE 'pending' END,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status IN ('tagged','failed','held')`,
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Re-tag a board on SOME of its facets (planning/facet-addressable-tagging-plan.md).
// The pass still asks the model about every facet; `tag_facets` says which
// answers are allowed to land, so the others keep what they already have.
//
// Only settled, decided rows, and unlike retagBoard there is no status CASE: a
// facet retag must never turn into a re-extraction or a re-face. An item that
// never landed has no other facets to preserve, and a held/failed one needs its
// whole pass — both are retagBoard's job, not this one.
//
// `NOT undecided` is not redundant with status='tagged': an undecided item IS
// 'tagged' (the verdict rides its own column), so the status filter alone would
// sweep in exactly the items scoping cannot help. They have nothing to preserve,
// a scoped pass deliberately does not move the verdict, and the landing would
// leave an item flagged "the model could not place this" carrying a fresh AI tag
// — and firing alerts off it, which are recorded once and never retracted.
export async function retagBoardFacets(db, boardId, facetKeys) {
  const { rowCount } = await db.query(
    `UPDATE items SET status='pending', tag_facets=$3::text[],
       attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status='tagged' AND NOT undecided`,
    [Date.now(), boardId, facetKeys]
  );
  return rowCount;
}

// The per-instance counterpart, for the lightbox. Same settled-and-decided rule:
// picking one item by hand does not make a partial verdict any more coherent, and
// the route turns the miss into a 409 rather than a silent no-op.
export async function retagItemFacets(db, id, facetKeys) {
  const { rowCount } = await db.query(
    `UPDATE items SET status='pending', tag_facets=$3::text[],
       attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE id=$2 AND status='tagged' AND NOT undecided`,
    [Date.now(), id, facetKeys]
  );
  return rowCount > 0;
}

// --- periodic auto-tagging ---

// Release a board's held items. Connector entities awaiting a chart face enter
// the face leg (pending_face); already-extracted items (the extract leg runs
// even with auto-tag off and parks them back in held) go straight to the tag
// leg; items with AI extraction still to do enter the extract leg. Held items
// with no stamp adopt the current board mapping — the board may have gained
// one since they were uploaded.
export async function releaseHeld(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN ${UNFETCHED} THEN 'pending_fetch'
           WHEN ${STAMPED_CONNECTOR_FACE} THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR $3::jsonb IS NOT NULL THEN 'pending_extract'
           ELSE 'pending' END,
         updated_at = $1
     WHERE board_id = $2 AND status = 'held'`,
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Queue everything untagged in a board: held uploads, AI-undecided items,
// and failed ones (fresh attempts). Fired when auto-tagging turns on — the
// point of the board is tags, so nothing untagged is left behind. In-flight
// ('processing') and human-tagged items are untouched. Everything routes
// through the face/extract legs exactly like releaseHeld/retagBoard:
// already-extracted items go straight to tagging, ones whose definition never
// ran — including an extraction that FAILED — resume the extract leg, and
// unstamped held items adopt the board mapping.
export async function queueUntagged(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN status='held' AND NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN ${UNFETCHED} THEN 'pending_fetch'
           WHEN ${STAMPED_CONNECTOR_FACE} THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR (status='held' AND $3::jsonb IS NOT NULL) THEN 'pending_extract'
           ELSE 'pending' END,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status IN ('held','tagged','failed') AND tags='[]'::jsonb`,
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Periodic boards whose scheduled run time has arrived.
//
// Still flag-gated, where dueIngestBoards below is now stamp-only. That's not
// drift: nothing ever arms auto_tag_next_run_at by hand — the admin retag route
// queues items directly and never touches the stamp — so the flags here can't
// hide a requested run the way ingest's `enabled` could. Give auto-tag a
// hand-fire path and this predicate has to go the same way, for the same reason.
export async function dueBoards(db, now) {
  const { rows } = await db.query(
    `SELECT id, name, auto_tag_every_min, auto_tag_skip_weekends FROM boards
     WHERE auto_tag AND auto_tag_periodic AND auto_tag_next_run_at IS NOT NULL AND auto_tag_next_run_at <= $1`,
    [now]
  );
  return rows;
}

export async function setBoardNextRun(db, boardId, ts) {
  await db.query("UPDATE boards SET auto_tag_next_run_at=$1 WHERE id=$2", [ts, boardId]);
}

// --- automatic ingestion ---

// Boards whose ingestion run time has arrived. Full rows: the sweep needs the
// mapping (adapter resolution) and the ingest config/state (budget, trigger).
//
// ingest_next_run_at is the whole truth about "will this fire": the save path
// nulls it for a paused or manual board, and the sweep only re-arms it when the
// schedule is live. `enabled` is deliberately NOT a predicate here — that is
// what lets "Run now" fire a paused feed once without resuming its watch.
export async function dueIngestBoards(db, now) {
  const { rows } = await db.query(
    `SELECT ${BOARD_COLS} FROM boards
     WHERE ingest IS NOT NULL
       AND ingest_next_run_at IS NOT NULL AND ingest_next_run_at <= $1`,
    [now]
  );
  return rows;
}

export async function setIngestNextRun(db, boardId, ts) {
  await db.query("UPDATE boards SET ingest_next_run_at=$1 WHERE id=$2", [ts, boardId]);
}

// Sweep-owned run status (last_run_at, last_added, last_error, drain_left) —
// kept out of updateBoard so a user saving config never clobbers it.
export async function setIngestState(db, boardId, state) {
  await db.query("UPDATE boards SET ingest_state=$1 WHERE id=$2", [state === null ? null : JSON.stringify(state), boardId]);
}

// The two sweep-state fields a config save IS allowed to touch, because both
// are verdicts on the OLD config: drain_left is the unfinished budget of the
// run it started (carried forward it hands the next run a stale limit), and
// last_error is its failure (carried forward every chip stays red after the
// user just fixed the folder — the next run re-judges the new config either
// way). Run history (last_run_at / last_added) stays.
export async function clearIngestSuperseded(db, boardId) {
  await db.query("UPDATE boards SET ingest_state = ingest_state - 'drain_left' - 'last_error' WHERE id=$1", [boardId]);
}

// The dedup ledger: every source_key ever admitted to this board. Rows outlive
// their entities on purpose — deleting an item is a user judgment the feed
// must not overturn on the next scan.
export async function ingestedKeys(db, boardId) {
  const { rows } = await db.query("SELECT source_key FROM ingest_log WHERE board_id=$1", [boardId]);
  return new Set(rows.map((r) => r.source_key));
}

// Ledger membership for a handful of specific keys (a preview page) — a PK
// probe instead of materializing a board's whole ledger.
export async function ingestedAmong(db, boardId, keys) {
  if (!keys.length) return new Set();
  const { rows } = await db.query(
    "SELECT source_key FROM ingest_log WHERE board_id=$1 AND source_key = ANY($2)",
    [boardId, keys]
  );
  return new Set(rows.map((r) => r.source_key));
}

// Accepts the pool or a tx client (the folder adapter ledgers inside the
// admit transaction).
export async function recordIngest(dbc, boardId, sourceKey, at) {
  await dbc.query(
    "INSERT INTO ingest_log (board_id, source_key, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [boardId, sourceKey, at]
  );
}

// --- source connections (reusable credentials for remote ingestion sources) ---
// One row per saved connection (ftp/s3 host+login), referenced by boards from
// JSONB (ingest.source.connectionId). Secrets live in `config` — the routes
// mask them on read and the runtime reads them raw. Mirrors the ai_keys shape.

export async function listSourceConnections(db, type = null) {
  const { rows } = await db.query(
    `SELECT c.id, c.type, c.label, c.config, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM boards b WHERE (b.ingest #>> '{source,connectionId}') = c.id::text) AS boards_using
     FROM source_connections c
     ${type ? "WHERE c.type = $1" : ""}
     ORDER BY c.created_at ASC`,
    type ? [type] : []
  );
  return rows;
}

export async function getSourceConnection(db, id) {
  if (!Number.isFinite(Number(id))) return null;
  const { rows } = await db.query("SELECT id, type, label, config FROM source_connections WHERE id=$1", [Number(id)]);
  return rows[0] || null;
}

export async function createSourceConnection(db, type, label, config) {
  const now = Date.now();
  const { rows } = await db.query(
    "INSERT INTO source_connections (type, label, config, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING id",
    [type, label, JSON.stringify(config || {}), now]
  );
  return rows[0].id;
}

// Partial: an undefined field is left alone. `config` is a full replacement of
// the merged object — the route merges blank-secret-keeps before calling.
export async function updateSourceConnection(db, id, { label, config } = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (label !== undefined) { sets.push(`label=$${i++}`); vals.push(label); }
  if (config !== undefined) { sets.push(`config=$${i++}::jsonb`); vals.push(JSON.stringify(config)); }
  if (!sets.length) return false;
  sets.push(`updated_at=$${i++}`); vals.push(Date.now());
  vals.push(Number(id));
  const r = await db.query(`UPDATE source_connections SET ${sets.join(", ")} WHERE id=$${i}`, vals);
  return r.rowCount > 0;
}

export async function deleteSourceConnection(db, id) {
  const r = await db.query("DELETE FROM source_connections WHERE id=$1", [Number(id)]);
  return r.rowCount > 0;
}

// --- board membership ---

export async function getBoardMemberIds(db, boardId) {
  const { rows } = await db.query("SELECT user_id FROM board_members WHERE board_id=$1", [boardId]);
  return rows.map((r) => r.user_id);
}

// User ids that are board-admins (role='admin') on this board — a subset of the
// members. Global admins aren't listed here; they manage every board implicitly.
export async function getBoardAdminIds(db, boardId) {
  const { rows } = await db.query(
    "SELECT user_id FROM board_members WHERE board_id=$1 AND role='admin'",
    [boardId]
  );
  return rows.map((r) => r.user_id);
}

// The row shape both membership editors write. Kept in one place so a column
// added here can't reach one writer and miss the other — the two functions
// below stay separate (their DELETE scopes are the point), but they insert the
// same row.
const ADD_BOARD_MEMBER =
  "INSERT INTO board_members (board_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING";

// Replace a board's membership. adminIds get role='admin' (only if also members);
// everyone else is a plain 'member'. adminIds defaults to none.
export async function setBoardMembers(db, boardId, userIds, adminIds = []) {
  const admins = new Set(adminIds.map(Number));
  await withTx(db, async (client) => {
    await client.query("DELETE FROM board_members WHERE board_id=$1", [boardId]);
    for (const uid of userIds) {
      await client.query(ADD_BOARD_MEMBER, [
        boardId, uid, admins.has(Number(uid)) ? "admin" : "member", Date.now(),
      ]);
    }
  });
}

// The same table as setBoardMembers, pivoted: replace ONE user's access across
// every board. The DELETE is scoped to that user, so a save here can't disturb
// anyone else's membership on the boards it touches — the two editors write
// disjoint sets of rows and can't clobber each other's people.
//
// adminBoardIds take role='admin', and only where the user is also a member:
// the loop walks boardIds, so an admin grant on a board they can't see is
// dropped rather than stored as a manage right with no access behind it.
export async function setUserBoards(db, userId, boardIds, adminBoardIds = []) {
  const admins = new Set(adminBoardIds.map(String)); // board ids are TEXT
  await withTx(db, async (client) => {
    await client.query("DELETE FROM board_members WHERE user_id=$1", [userId]);
    for (const bid of boardIds) {
      await client.query(ADD_BOARD_MEMBER, [
        String(bid), userId, admins.has(String(bid)) ? "admin" : "member", Date.now(),
      ]);
    }
  });
}

// Which of these board ids actually exist. The membership writers take ids from
// a client, and an id that has since been deleted has to be dropped before it
// reaches the foreign key, which would answer it with a 500.
export async function existingBoardIds(db, ids) {
  if (!ids.length) return new Set();
  const { rows } = await db.query("SELECT id FROM boards WHERE id = ANY($1::text[])", [ids]);
  return new Set(rows.map((r) => r.id));
}

export async function canAccessBoard(db, boardId, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  const { rows } = await db.query("SELECT 1 FROM board_members WHERE board_id=$1 AND user_id=$2", [
    boardId,
    user.id,
  ]);
  return rows.length > 0;
}

// May this user edit the board's content? Global admins always; otherwise a
// board-admin (board_members.role='admin'). Read side of the board-manager routes.
export async function canManageBoard(db, boardId, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  const { rows } = await db.query(
    "SELECT 1 FROM board_members WHERE board_id=$1 AND user_id=$2 AND role='admin'",
    [boardId, user.id]
  );
  return rows.length > 0;
}

// --- settings ---

export async function getSetting(db, key) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key=$1", [key]);
  return rows.length ? rows[0].value : null;
}

export async function setSetting(db, key, value) {
  if (value === null || value === undefined || value === "") {
    await db.query("DELETE FROM settings WHERE key=$1", [key]);
  } else {
    await db.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, String(value)]
    );
  }
}

// --- plugins ---
// One row per plugin id; an ABSENT (or NULL-installed) row falls to the tier
// default (server/plugins.js coalesces), so nothing is ever seeded. `config`
// holds only schema-declared overrides — secrets live in their existing stores.

export async function listPluginRows(db) {
  const { rows } = await db.query("SELECT * FROM plugins");
  return rows;
}

export async function getPluginRow(db, id) {
  const { rows } = await db.query("SELECT * FROM plugins WHERE id=$1", [id]);
  return rows[0] || null;
}

// Partial upsert: an undefined field leaves the stored value alone, so an
// install write never clobbers config and vice versa. A config-only write
// leaves `installed` NULL (falls to the tier default) rather than forcing it.
export async function setPluginState(db, id, { installed, config } = {}) {
  await db.query(
    `INSERT INTO plugins (id, installed, config, updated_at)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4)
     ON CONFLICT (id) DO UPDATE SET
       installed  = COALESCE($2, plugins.installed),
       config     = COALESCE($3::jsonb, plugins.config),
       updated_at = $4`,
    [id, installed ?? null, config !== undefined ? JSON.stringify(config) : null, Date.now()]
  );
}

// Drop a plugin's config/health row entirely. Used when UNINSTALLING an external
// plugin (built-ins keep their row and just flip `installed`). Safe if absent.
export async function deletePluginRow(db, id) {
  await db.query("DELETE FROM plugins WHERE id = $1", [id]);
}

// Health ledger (the self-healing seed): failures always write (streaks bump
// fail_count, last_error stays structured); success writes ONLY when healing
// (fail_count > 0 or never-ok) so steady-state sweeps don't chatter the table.
export async function recordPluginHealth(db, id, error = null) {
  const now = Date.now();
  if (error) {
    const payload = JSON.stringify({
      message: String(error.message || error).slice(0, 500),
      status: error.status ?? null,
      at: now,
    });
    await db.query(
      `INSERT INTO plugins (id, last_fail_at, fail_count, last_error, updated_at)
       VALUES ($1, $2, 1, $3::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET
         last_fail_at = $2, fail_count = plugins.fail_count + 1, last_error = $3::jsonb, updated_at = $2`,
      [id, now, payload]
    );
  } else {
    await db.query(
      `INSERT INTO plugins (id, last_ok_at, updated_at) VALUES ($1, $2, $2)
       ON CONFLICT (id) DO UPDATE SET last_ok_at = $2, fail_count = 0, last_error = NULL, updated_at = $2
       WHERE plugins.fail_count > 0 OR plugins.last_ok_at IS NULL`,
      [id, now]
    );
  }
}

// Run `fn` and ledger its outcome on plugin `id` (heal on success, structured
// error on throw). The ledger write never masks the call's own result — a
// failed health write is swallowed, the original value/throw passes through.
// The one health-tracking pattern; every live provider/tagger/embed call and
// admin reachability test funnels through here.
export async function withPluginHealth(db, id, fn) {
  try {
    const out = await fn();
    await recordPluginHealth(db, id).catch(() => {});
    return out;
  } catch (err) {
    await recordPluginHealth(db, id, err).catch(() => {});
    throw err;
  }
}

// --- external plugins (the dynamic-loading install record) ---
// Distinct from the `plugins` table (config/health for ALL plugins): this holds
// only WHERE an external plugin came from and where its code lives, so boot can
// reload it. See server/migrations/0020_external_plugins.sql.

export async function listExternalPlugins(db) {
  const { rows } = await db.query("SELECT * FROM external_plugins");
  return rows;
}

export async function getExternalPlugin(db, id) {
  const { rows } = await db.query("SELECT * FROM external_plugins WHERE id = $1", [id]);
  return rows[0] || null;
}

// Record an install (or re-install). `manifest` is stored verbatim; a successful
// (re)load clears any prior load_error. Called only after the code is on disk.
export async function upsertExternalPlugin(db, { id, kind, sourceUrl, resolvedRef, dir, manifest }) {
  await db.query(
    `INSERT INTO external_plugins (id, kind, source_url, resolved_ref, dir, manifest, installed_at, load_error)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL)
     ON CONFLICT (id) DO UPDATE SET
       kind = $2, source_url = $3, resolved_ref = $4, dir = $5, manifest = $6::jsonb,
       installed_at = $7, load_error = NULL`,
    [id, kind, sourceUrl, resolvedRef ?? null, dir, JSON.stringify(manifest), Date.now()]
  );
}

// Mark a load failure without dropping the install record — the code stays on
// disk (the dir is unchanged), so a later Retry can reload it. `error` is
// coerced to the same structured shape the health ledger uses.
export async function setExternalLoadError(db, id, error) {
  const payload = error
    ? JSON.stringify({ message: String(error.message || error).slice(0, 500), at: Date.now() })
    : null;
  await db.query("UPDATE external_plugins SET load_error = $2::jsonb WHERE id = $1", [id, payload]);
}

// Remove the install record. The caller also rm's the dir + drops the `plugins`
// row (config/health) — this is only the provenance half.
export async function deleteExternalPlugin(db, id) {
  await db.query("DELETE FROM external_plugins WHERE id = $1", [id]);
}

// --- AI tagging queue helpers ---

// Atomically take the oldest ready item — whatever stage it's in — and mark it
// with that stage's in-flight status. ONE queue, one policy: oldest work first
// (created_at, id), so an item flows extract → face → tag to completion before
// newer items start (it re-enters the queue with its original created_at and
// stays at the front). There are no per-stage legs to starve: a bulk upload's
// extractions and other boards' tagging interleave by age. The returned row's
// status ('extracting' | 'facing' | 'processing') tells the worker which step
// to run.
//
// SKIP LOCKED keeps concurrent claimers (or a second worker) from grabbing the
// same row. When no default key is configured, boards without their own key
// are skipped for the AI stages — their items stay queued until a key appears
// (never failed for a missing key) — while faces and fetches still claim
// (rendering a chart and pulling provider data are data steps, no model
// call). Rows whose retry_at is still in the future (a spaced transient
// retry) are skipped; every requeue path that wants an immediate run clears
// retry_at.
//
// `stages` is the set of pending statuses the caller will accept — the worker's
// dispatcher passes only the stages whose lane has a free slot (worker-rework
// Stage 1: capacity-aware claiming), so a full sidecar lane doesn't stop tag work
// from being claimed. Default = all four (the single-flight/test path, unchanged).
// Board-fair batch claim (worker-rework Stage 2). Ranks each board's ready items by
// age (row_number per board), then serves rank 0 of every board before rank 1, etc. —
// so a small board's work interleaves ahead of a large board's backlog instead of
// waiting behind it. Fairness holds while active boards ≤ the batch size and degrades
// to plain FIFO beyond (no worse than before). Claimed as ONE snapshot of `limit` rows:
// single-row claims would collapse to FIFO (removing a head promotes the same board's
// next item). The window function forbids FOR UPDATE, so the pick (ranked, unlocked)
// and the lock (by id, SKIP LOCKED) are separate CTEs feeding the UPDATE.
export async function claimFairBatch(db, hasDefaultKey = true, stages = Object.keys(IN_FLIGHT_FOR), limit = 1) {
  const now = Date.now();
  const { rows } = await db.query(
    `WITH ready AS (
       SELECT i.id, i.created_at,
              row_number() OVER (PARTITION BY i.board_id ORDER BY i.created_at, i.id) AS board_rank
       FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.status = ANY($3::text[])
         AND (i.status IN ('pending_face', 'pending_fetch') OR b.ai_key_id IS NOT NULL OR $2)
         AND (i.retry_at IS NULL OR i.retry_at <= $1)
     ),
     pick AS (
       SELECT id FROM ready ORDER BY board_rank ASC, created_at ASC, id ASC LIMIT $4
     ),
     claimed AS (
       SELECT id FROM items WHERE id IN (SELECT id FROM pick) FOR UPDATE SKIP LOCKED
     )
     UPDATE items SET
       status = ${CLAIM_CASE},
       updated_at = $1
     WHERE id IN (SELECT id FROM claimed)
     RETURNING *`,
    [now, hasDefaultKey, stages, limit]
  );
  return rows;
}

// One row, oldest-ready-first — the LIMIT-1 case of claimFairBatch (which equals plain
// FIFO: the globally-oldest ready row is always its own board's rank 0). The stable
// entry point for tests and any single-claim caller.
export async function claimNextWork(db, hasDefaultKey = true, stages = Object.keys(IN_FLIGHT_FOR)) {
  return (await claimFairBatch(db, hasDefaultKey, stages, 1))[0] || null;
}

export async function setEntityFaceAt(db, id, at) {
  await db.query("UPDATE entities SET face_at=$1, updated_at=$2 WHERE id=$3", [at, Date.now(), id]);
}

// Write extracted fields into payload and advance. Extraction is part of the
// item's definition (identity, fields), so it runs regardless of auto-tagging;
// auto_tag gates only the TAG leg. Items born on an auto-tag-off board carry
// `park`: definition done, they return to held instead of flowing into
// tagging. Explicit runs (reprocess/re-extract/release) carry no park and go
// all the way — the toggle gates the automatic flow, not the user's hand.
// The board is re-checked so a mid-flight auto-tag flip beats a stale park.
// extracted_at records that the extract leg ran, so a later release routes
// the item to the tag leg rather than paying for a second extraction.
// Value-fenced like markTagged: lands only while the row is still
// 'extracting'; a mid-flight re-route/delete discards (returns false).
export async function markExtracted(db, id, fields) {
  const { rowCount } = await db.query(
    `UPDATE items
     SET payload = (payload - 'park') || jsonb_build_object('fields', $1::jsonb, 'extracted_at', $2::bigint),
         status = CASE WHEN payload ? 'park'
                            AND NOT (SELECT b.auto_tag FROM boards b WHERE b.id = items.board_id)
                       THEN 'held' ELSE 'pending' END,
         attempts = 0,
         error = NULL,
         retry_at = NULL,
         updated_at = $2
     WHERE id = $3 AND status = 'extracting'`,
    [JSON.stringify(fields || {}), Date.now(), id]
  );
  return rowCount > 0;
}

// The fetch leg's advance: provider data landed on the entity, so the vehicle
// moves on to whichever leg the board wants next (the caller computes
// toStatus from a fresh board read: face leg, tag leg, or held). Clears the
// 'unfetched' routing stamp — park is NOT consumed here; the face leg and the
// held-park rule read it later — and folds the true provider source into the
// payload in the same fenced statement, because updateItemPayload has no
// fence and a stale fetch must not splat provider data over a re-routed row.
// Value-fenced like its siblings: lands only while the row is still
// 'fetching'; false = discarded (deleted or re-routed mid-fetch).
export async function advanceFetched(db, id, toStatus, patch = {}) {
  const { rowCount } = await db.query(
    `UPDATE items
     SET payload = (payload - 'unfetched') || $1::jsonb,
         status = $2,
         attempts = 0,
         error = NULL,
         retry_at = NULL,
         updated_at = $3
     WHERE id = $4 AND status = 'fetching'`,
    [JSON.stringify(patch), toStatus, Date.now(), id]
  );
  return rowCount > 0;
}

// A board's still-queued fetch ids — the prewarm horizon for the fetch leg
// (connectors/index.js prefetchClaimedFetches): the lane claims one row at a
// time in steady state, so warming only the claimed slice would leave every
// subsequent claim paying a provider call; warming the queue makes them cache
// hits. Oldest first, capped at one provider batch.
export async function queuedFetchSourceIds(db, boardId, limit = 250) {
  const { rows } = await db.query(
    `SELECT payload->'source'->>'id' AS id FROM items
     WHERE board_id=$1 AND status='pending_fetch'
     ORDER BY created_at, id LIMIT $2`,
    [boardId, limit]
  );
  return rows.map((r) => r.id).filter(Boolean);
}

// The face leg's counterpart: the chart (or tile fallback) is rendered — the
// visual half of the item's definition — so advance with the same park rule.
// extracted_at is stamped here too: for a connector vehicle the face IS its
// definition leg, and the stamp is what routes a later release straight to
// the tag leg.
// Value-fenced like its siblings: lands only while the row is still 'facing'.
export async function advanceFaced(db, id) {
  const { rowCount } = await db.query(
    `UPDATE items
     SET payload = (payload - 'park') || jsonb_build_object('extracted_at', $1::bigint),
         status = CASE WHEN payload ? 'park'
                            AND NOT (SELECT b.auto_tag FROM boards b WHERE b.id = items.board_id)
                       THEN 'held' ELSE 'pending' END,
         attempts = 0,
         error = NULL,
         retry_at = NULL,
         updated_at = $1
     WHERE id = $2 AND status = 'facing'`,
    [Date.now(), id]
  );
  return rowCount > 0;
}

// --- entities ---

// Create an entity row. identity must be unique per board — a 23505 here
// means the entity already exists (connector adds answer 409; the extract
// leg re-parents instead). Returns the new id.
export async function createEntity(db, boardId, { identity, displayName = null, symbol = null, fields = {}, provisional = false, uploadedBy = null } = {}) {
  const { rows } = await db.query(
    `INSERT INTO entities (board_id, identity, display_name, symbol, fields, identity_provisional, uploaded_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [boardId, identity, displayName, symbol, JSON.stringify(fields || {}), provisional, uploadedBy, Date.now()]
  );
  return rows[0].id;
}

export async function getEntity(db, id) {
  const { rows } = await db.query("SELECT * FROM entities WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function getEntityBoard(db, id) {
  const { rows } = await db.query("SELECT board_id FROM entities WHERE id=$1", [id]);
  return rows[0] || null;
}

// Find an entity by its (normalised) identity string.
export async function getEntityByIdentity(db, boardId, identity) {
  const { rows } = await db.query(
    "SELECT * FROM entities WHERE board_id=$1 AND identity=$2",
    [boardId, identity]
  );
  return rows[0] || null;
}

// The set of entity identities already on a board — for marking connector rows
// as already added in the browse modal.
export async function boardEntityIdentities(db, boardId) {
  const { rows } = await db.query("SELECT identity FROM entities WHERE board_id=$1", [boardId]);
  return new Set(rows.map((r) => r.identity));
}

// Set a derived identity on an entity, clearing the provisional flag.
// displayName preserves the AI's original casing for display; identity is the
// normalised lowercase key. Throws 23505 on collision — caller re-parents the
// instance into the existing entity instead.
export async function setEntityIdentity(db, id, identity, displayName = null) {
  await db.query(
    `UPDATE entities
     SET identity=$1, display_name=COALESCE($2, display_name), identity_provisional=FALSE, updated_at=$3
     WHERE id=$4`,
    [identity, displayName, Date.now(), id]
  );
}

// Flag an entity whose identity the AI couldn't derive (still keyed by its
// provisional filename). Purely informational — nothing blocks on it.
export async function markEntityProvisional(db, id) {
  await db.query("UPDATE entities SET identity_provisional=TRUE, updated_at=$1 WHERE id=$2", [Date.now(), id]);
}

// Bump an entity's change stamp without touching anything else. For writes
// that alter what the list shows for an entity but live in OTHER rows —
// losing an instance, gaining/losing a heart or crate membership — so delta
// polls (?since=) see the entity as changed.
export async function touchEntity(db, id) {
  await db.query("UPDATE entities SET updated_at=$1 WHERE id=$2", [Date.now(), id]);
}

// Set an instance's entity membership — the ordered set of entities it belongs
// to (entity_ids[0] is canonical for logging/faces/search). Replaces the old
// single-parent reparentItem: merge and split are no longer special moves, just
// "the array changed". Length 1 is the extract-mode norm; length N is classify.
export async function setItemEntities(db, itemId, entityIds) {
  await db.query("UPDATE items SET entity_ids=$1::bigint[], updated_at=$2 WHERE id=$3", [entityIds, Date.now(), itemId]);
}

export async function entityInstanceCount(db, entityId) {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]", [entityId]);
  return Number(rows[0].c);
}

// The connector vehicle's payload for one entity — the instance carrying the
// provider `source` handle (the dueLiveEntities marker; NOT file-count, since
// a generated face gives the vehicle a file). Oldest-first for determinism,
// like entityForAlerts' first-file rule. Null for file entities: the chart
// route treats that as "resolve by symbol", same as a provider switch.
export async function entityVehiclePayload(db, entityId) {
  const { rows } = await db.query(
    `SELECT payload FROM items
      WHERE entity_ids @> ARRAY[$1]::bigint[] AND payload ? 'source'
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [entityId]
  );
  return rows[0]?.payload || null;
}

// Drop an entity that lost its last instance (post membership change).
// Returns true when it was actually deleted.
export async function deleteEntityIfEmpty(db, entityId) {
  const result = await db.query(
    "DELETE FROM entities WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM items WHERE entity_ids @> ARRAY[$1]::bigint[])",
    [entityId]
  );
  return result.rowCount > 0;
}

// After a membership change, tidy every entity that gained or lost the instance:
// delete the ones that emptied out, stamp the survivors so delta polls repaint
// their aggregate status/tags/face. Idempotent — safe to pass the union of the
// old and new membership sets (with dupes).
export async function reconcileEntities(db, entityIds) {
  for (const id of new Set(entityIds)) {
    if (id == null) continue;
    if (!(await deleteEntityIfEmpty(db, id))) await touchEntity(db, id);
  }
}

// Reap ghost entities: rows no instance points at any longer, settled empty for
// at least `olderThanMs`. A zero-instance entity should never persist — reconcile
// (after a membership change) and deleteEntity clean up inline — but entity_ids
// carries no FK cascade, so a crash between the membership write and its reconcile,
// or a concurrent last-two-instance delete, can strand one, and it renders as a
// blank card with nothing to remove it. The age floor is load-bearing: upload
// creates the entity and its instance in two statements, so a freshly empty entity
// is an in-flight upload, not a ghost — only settled ones are reaped. Returns the
// count deleted.
export async function reapEmptyEntities(db, olderThanMs) {
  const { rowCount } = await db.query(
    `DELETE FROM entities e
      WHERE e.updated_at < $1
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.entity_ids @> ARRAY[e.id]::bigint[])`,
    [Date.now() - olderThanMs]
  );
  return rowCount;
}

// Delete an entity and the instances it's the SOLE home of; instances shared
// with another entity survive, just losing this id from their array. Returns the
// orphaned instances' file entries so the caller can clean the stores. The row is
// locked FOR UPDATE before the orphan read so two concurrent deletes of the same
// entity serialize instead of both reading — and double-returning — its files.
// entity_ids carries no FK cascade anymore, so an extraction resolving to this
// entity can still append its id right after the scrub (a dangling id / re-emptied
// entity); the empty-entity reaper (reapEmptyEntities) backstops that.
export async function deleteEntity(db, id) {
  return withTx(db, async (client) => {
    const locked = await client.query("SELECT 1 FROM entities WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length) return null;
    // Instances this entity is the SOLE home of are orphaned by the delete —
    // remove them and hand back their files for store cleanup. Instances shared
    // with another entity survive; just drop this id from their arrays. (There's
    // no FK cascade to lean on anymore — an item can belong to several entities,
    // so the delete must not take shared instances with it.)
    const { rows: orphans } = await client.query(
      "SELECT id, payload FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] AND cardinality(entity_ids) = 1",
      [id]
    );
    if (orphans.length)
      await client.query("DELETE FROM items WHERE id = ANY($1::bigint[])", [orphans.map((o) => o.id)]);
    await client.query(
      "UPDATE items SET entity_ids = array_remove(entity_ids, $1), updated_at=$2 WHERE entity_ids @> ARRAY[$1]::bigint[]",
      [id, Date.now()]
    );
    const { rows } = await client.query("DELETE FROM entities WHERE id=$1 RETURNING board_id", [id]);
    if (!rows.length) return null;
    return { board_id: rows[0].board_id, files: orphans.flatMap((r) => r.payload?.files || []) };
  });
}

// Delete one instance row. Returns { payload, entity_ids, board_id } for file
// cleanup and last-instance checks, or null when it doesn't exist. Every entity
// the instance belonged to is stamped in the same statement — each one's
// aggregate status/tags/face just changed — so delta polls see them (a no-op
// for an entity the delete empties: the row goes away right after and the ids
// list covers that).
export async function deleteInstance(db, id) {
  const { rows } = await db.query(
    `WITH del AS (DELETE FROM items WHERE id=$1 RETURNING payload, entity_ids, board_id),
          touch AS (UPDATE entities SET updated_at=$2 WHERE id IN (SELECT unnest(entity_ids) FROM del))
     SELECT payload, entity_ids, board_id FROM del`,
    [id, Date.now()]
  );
  return rows[0] || null;
}

// --- connector liveness (slice 5c) ---

// Entities due for a live-field or face refresh: refresh_at set and reached.
// Each rides with its connector instance — matched by `payload ? 'source'` (the
// tag vehicle's marker; NOT file-count, since a generated face gives it a file)
// — and its board. Soonest-due first, bounded per sweep.
export async function dueLiveEntities(db, now, limit = 20) {
  const { rows } = await db.query(
    `SELECT e.id AS e_id, e.identity, e.symbol, e.fields, e.refresh_at, e.face_at,
            i.id AS i_id, i.payload AS i_payload,
            b.id AS b_id, b.mapping AS b_mapping, b.retag_on_refresh, b.auto_tag
     FROM entities e
     JOIN items i ON i.entity_ids @> ARRAY[e.id]::bigint[] AND i.payload ? 'source'
     JOIN boards b ON b.id = e.board_id
     WHERE e.refresh_at IS NOT NULL AND e.refresh_at <= $1
     ORDER BY e.refresh_at ASC
     LIMIT $2`,
    [now, limit]
  );
  return rows.map((r) => ({
    entity: { id: r.e_id, identity: r.identity, symbol: r.symbol, fields: r.fields, refresh_at: r.refresh_at, face_at: r.face_at },
    inst: { id: r.i_id, payload: r.i_payload },
    board: { id: r.b_id, mapping: r.b_mapping, retag_on_refresh: r.retag_on_refresh, auto_tag: r.auto_tag },
  }));
}

// Land a fetch leg's provider answer on an enqueued entity in ONE statement:
// fields, the (possibly corrected) identity/display_name/symbol, and the
// first liveness due time. One statement on purpose — composing
// setEntityIdentity + updateEntityFields would strand a real identity with
// empty fields if the process died between them, and setEntityIdentity also
// force-clears identity_provisional, a side effect this path doesn't want.
// Throws 23505 when the corrected identity collides with an entity already on
// the board (an enqueue that lacked the symbol, or a provider disagreeing
// with its own list) — the caller fails the item as a late duplicate.
export async function landEntityFetch(db, id, { identity, displayName = null, symbol = null, fields, refreshAt = null }) {
  await db.query(
    `UPDATE entities
     SET identity=$1, display_name=COALESCE($2, display_name), symbol=COALESCE($3, symbol),
         fields=$4, refresh_at=$5, updated_at=$6
     WHERE id=$7`,
    [identity, displayName, symbol, JSON.stringify(fields || {}), refreshAt, Date.now(), id]
  );
}

// Write refreshed connector fields + the next due time, atomically.
export async function updateEntityFields(db, id, fields, refreshAt) {
  await db.query(
    "UPDATE entities SET fields=$1, refresh_at=$2, updated_at=$3 WHERE id=$4",
    [JSON.stringify(fields), refreshAt, Date.now(), id]
  );
}

export async function setEntityRefreshAt(db, id, at) {
  await db.query("UPDATE entities SET refresh_at=$1 WHERE id=$2", [at, id]);
}

// One movement-history row (only the fields whose value actually changed).
export async function addFieldSnapshot(db, entityId, fields, source, at) {
  await db.query(
    "INSERT INTO field_snapshots (entity_id, fields, source, refreshed_at) VALUES ($1,$2,$3,$4)",
    [entityId, JSON.stringify(fields || {}), source || null, at]
  );
}

// Drop movement history older than the cutoff (the worker's retention prune).
// Returns the number of rows removed.
export async function pruneFieldSnapshots(db, cutoff) {
  const { rowCount } = await db.query("DELETE FROM field_snapshots WHERE refreshed_at < $1", [cutoff]);
  return rowCount;
}

// The judgment-history counterpart. Post-dedupe every row is a real judgment
// change (the then-vs-now data), so this backstop defaults to disabled — see
// TAG_SNAPSHOT_RETENTION_DAYS in the worker.
export async function pruneTagSnapshots(db, cutoff) {
  const { rowCount } = await db.query("DELETE FROM tag_snapshots WHERE tagged_at < $1", [cutoff]);
  return rowCount;
}

// --- job log (the per-board transparency ledger, planning/job-log-plan.md) ---
// One row per execution attempt. `running` rows exist only for the sweep
// families (transcribe, ingest) — the pipeline legs are visible via
// items.status while in flight and write one completed row at resolution.
// Writers never throw into the job they observe: the worker wraps every call
// in jobLogWrite (warn, not throw).

export async function addJobLog(db, {
  boardId, entityId = null, itemId = null, target = null, kind,
  outcome = "running", error = null, detail = {}, startedAt = Date.now(), endedAt = null,
}) {
  const { rows } = await db.query(
    `INSERT INTO job_log (board_id, entity_id, item_id, target, kind, outcome, error, detail, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [boardId, entityId, itemId, target, kind, outcome,
     error ? String(error).slice(0, 500) : null, JSON.stringify(detail || {}), startedAt, endedAt]
  );
  return rows[0].id;
}

// Resolve a running row. Detail merges over what the row already carries, so
// a stamp can add outcome facts without re-sending the start-time context.
export async function stampJobLog(db, id, { outcome, error = null, detail = null, endedAt = Date.now() }) {
  await db.query(
    "UPDATE job_log SET outcome=$1, error=$2, detail=detail || $3, ended_at=$4 WHERE id=$5",
    [outcome, error ? String(error).slice(0, 500) : null, JSON.stringify(detail || {}), endedAt, id]
  );
}

// History page for the jobs view: newest first, keyset on (started_at, id) —
// the /api/items cursor pattern. Settled rows only; running rows are a
// separate, tiny, unpaginated fetch (listRunningJobs). The entity join is for
// display: live rows get the current name, deleted ones fall back to `target`.
export async function listJobLog(db, boardId, { after = null, kind = null, outcome = null, limit = 50 } = {}) {
  const cond = ["j.board_id=$1", "j.outcome <> 'running'"];
  const args = [boardId];
  if (kind) { args.push(kind); cond.push(`j.kind=$${args.length}`); }
  if (outcome) { args.push(outcome); cond.push(`j.outcome=$${args.length}`); }
  if (after) {
    const [at, id] = String(after).split("_").map(Number);
    if (Number.isFinite(at) && Number.isFinite(id)) {
      args.push(at, id);
      cond.push(`(j.started_at, j.id) < ($${args.length - 1}, $${args.length})`);
    }
  }
  args.push(limit);
  const { rows } = await db.query(
    `SELECT j.*, e.display_name AS entity_display, e.identity AS entity_identity
       FROM job_log j LEFT JOIN entities e ON e.id = j.entity_id
      WHERE ${cond.join(" AND ")}
      ORDER BY j.started_at DESC, j.id DESC LIMIT $${args.length}`,
    args
  );
  const last = rows[rows.length - 1];
  return { jobs: rows, nextCursor: rows.length === limit ? `${last.started_at}_${last.id}` : null };
}

export async function listRunningJobs(db, boardId) {
  const { rows } = await db.query(
    `SELECT j.*, e.display_name AS entity_display, e.identity AS entity_identity
       FROM job_log j LEFT JOIN entities e ON e.id = j.entity_id
      WHERE j.board_id=$1 AND j.outcome='running'
      ORDER BY j.started_at ASC`,
    [boardId]
  );
  return rows;
}

// Remove one row — the ingest sweep retracts a boring run's `running` row
// (an idle scan is a flat tick, not history) instead of stamping it.
export async function deleteJobLog(db, id) {
  await db.query("DELETE FROM job_log WHERE id=$1", [id]);
}

// The newest settled row for one job family — the fold check for repeating
// non-events: a transient transcribe retry every backoff tick, or a scheduled
// scan re-finding the same error every 30 s, stamps its prior row (attempts
// in detail) instead of writing a near-identical row per cycle. itemId=null
// means board-level rows (an ingest or retag run).
export async function latestSettledJob(db, boardId, kind, itemId = null) {
  const cond = ["board_id=$1", "kind=$2", "outcome <> 'running'",
    itemId == null ? "item_id IS NULL" : "item_id=$3"];
  const { rows } = await db.query(
    `SELECT * FROM job_log WHERE ${cond.join(" AND ")}
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    itemId == null ? [boardId, kind] : [boardId, kind, itemId]
  );
  return rows[0] || null;
}

// The newest FAILED row's stamp — the jobs chip's attention dot, which the
// client compares against its own "last looked" watermark (public/seen-mark.js).
//
// `failed` ALONE, and the other three non-ok outcomes are excluded on purpose:
// `requeued` is the pipeline retrying and resolves itself, `discarded` is a
// stale result dropped by the fence (a merge landed mid-flight — nothing was
// lost that the user can see), and `interrupted` is a restart, which would put
// a dot on every reader's header after each deploy. A signal that lights for
// self-healing states is a signal people learn to ignore.
//
// Keyed on started_at, which is also the history list's ORDER BY — so the dot
// and the row it sends you to agree about which failure is newest, and a FOLDED
// repeat (a wedged scan re-stamping one row every 30 s rather than writing
// 3,000 of them) correctly counts as no news at all. The cost is a job that
// started before your last look and fails after it: its row is older than the
// watermark, so it waits for the next distinct failure to be announced.
// Exported as one string so the test that pins its query PLAN pins the query
// the app actually runs. This read happens on a background tick, per open tab,
// and migration 0032 cuts a partial index for exactly this shape; a copy of the
// SQL in the test would keep passing while this drifted off it — a widened
// ORDER BY, a second outcome — and the regression is invisible from the outside,
// since a sequential scan returns the right answer, slowly.
export const LATEST_JOB_FAILURE_SQL =
  "SELECT started_at FROM job_log WHERE board_id=$1 AND outcome='failed' ORDER BY started_at DESC LIMIT 1";

export async function latestJobFailureAt(db, boardId) {
  const { rows } = await db.query(LATEST_JOB_FAILURE_SQL, [boardId]);
  return rows[0]?.started_at ?? null;
}

// The same question across a set of boards, for the index's dots
// (boards-signals-plan.md). LATERAL over unnest rather than
// `board_id = ANY(...) GROUP BY board_id`: the aggregate form has to reach every
// failed row of every board to take a MAX, while this walks each board's slice
// of idx_job_log_failed and stops at the first — the shape boardPreviewFaces
// already uses one table over, and the reason 0032's partial index exists.
//
// CROSS JOIN, so a board with no failures returns no row at all and the caller's
// default stands. That is also what keeps the payload proportional to the news
// rather than to the board count.
export const BOARD_FAILURES_SQL =
  `SELECT b.id AS board_id, t.started_at
   FROM unnest($1::text[]) AS b(id)
   CROSS JOIN LATERAL (
     SELECT j.started_at FROM job_log j
     WHERE j.board_id = b.id AND j.outcome='failed'
     ORDER BY j.started_at DESC LIMIT 1
   ) t`;

export async function boardLatestFailures(db, boardIds) {
  if (!boardIds.length) return {};
  const { rows } = await db.query(BOARD_FAILURES_SQL, [boardIds]);
  return Object.fromEntries(rows.map((r) => [r.board_id, r.started_at]));
}

// The modal's Clear button: drop the board's settled history in one go.
// Running rows survive — they're live work whose stamp is still coming (and
// the worker's fold lookups tolerate a vanished prior row: the next attempt
// simply opens a fresh one). Refresh history is field_snapshots — movement
// data, not this ledger — so it isn't touched either. Returns rows removed.
export async function clearJobLog(db, boardId) {
  const { rowCount } = await db.query(
    "DELETE FROM job_log WHERE board_id=$1 AND outcome <> 'running'",
    [boardId]
  );
  return rowCount;
}

// Boot sweep: a row still `running` from before this boot was orphaned by a
// crash/stop — nothing else can own it (single worker process). The
// started_at fence keeps this boot's own fresh rows out of the sweep
// regardless of query ordering at startup. Returns rows flipped.
export async function markInterruptedJobs(db, bootAt = Date.now()) {
  const { rowCount } = await db.query(
    "UPDATE job_log SET outcome='interrupted', error='interrupted by a restart', ended_at=$1 WHERE outcome='running' AND started_at < $1",
    [bootAt]
  );
  return rowCount;
}

// Retention backstop (JOB_LOG_RETENTION_DAYS in the worker). Running rows are
// exempt — the boot sweep owns those. Returns rows removed.
export async function pruneJobLog(db, cutoff) {
  const { rowCount } = await db.query("DELETE FROM job_log WHERE started_at < $1 AND outcome <> 'running'", [cutoff]);
  return rowCount;
}

// Refresh history for the jobs view: field_snapshots wearing the log's page
// shape. Refresh ticks are deliberately NOT in job_log (a 1-minute live board
// would be 1,440 rows/day/entity of mostly nothing) — the snapshots already
// record the informative subset, movement, so the jobs endpoint serves them
// under kind=refresh instead of duplicating them. Keyset on (refreshed_at, id).
export async function listRefreshHistory(db, boardId, { after = null, limit = 50 } = {}) {
  const cond = ["e.board_id=$1"];
  const args = [boardId];
  if (after) {
    const [at, id] = String(after).split("_").map(Number);
    if (Number.isFinite(at) && Number.isFinite(id)) {
      args.push(at, id);
      cond.push(`(s.refreshed_at, s.id) < ($${args.length - 1}, $${args.length})`);
    }
  }
  args.push(limit);
  const { rows } = await db.query(
    `SELECT s.id, s.entity_id, s.fields, s.source, s.refreshed_at,
            e.display_name AS entity_display, e.identity AS entity_identity
       FROM field_snapshots s JOIN entities e ON e.id = s.entity_id
      WHERE ${cond.join(" AND ")}
      ORDER BY s.refreshed_at DESC, s.id DESC LIMIT $${args.length}`,
    args
  );
  const last = rows[rows.length - 1];
  return { rows, nextCursor: rows.length === limit ? `${last.refreshed_at}_${last.id}` : null };
}

// Whether the board has any refresh history at all — drives the Refresh pill.
export async function boardHasRefreshHistory(db, boardId) {
  const { rows } = await db.query(
    "SELECT EXISTS (SELECT 1 FROM field_snapshots s JOIN entities e ON e.id = s.entity_id WHERE e.board_id=$1) AS has",
    [boardId]
  );
  return rows[0].has;
}

// The board's soonest live-field refresh — the jobs view's "next refresh" stamp.
export async function boardNextRefreshAt(db, boardId) {
  const { rows } = await db.query(
    "SELECT MIN(refresh_at) AS at FROM entities WHERE board_id=$1 AND refresh_at IS NOT NULL",
    [boardId]
  );
  return rows[0].at ?? null;
}

// Send one instance back to the tag queue (the opt-in retag-on-new-data path).
// Only settled items: the refresh cascade must not yank a row out of the
// definition legs or a user's mid-flight run. Returns whether it requeued.
export async function requeueItemForTag(db, id) {
  const { rowCount } = await db.query(
    "UPDATE items SET status='pending', attempts=0, error=NULL, retry_at=NULL, updated_at=$1 WHERE id=$2 AND status IN ('tagged','failed')",
    [Date.now(), id]
  );
  return rowCount > 0;
}

// Recompute refresh_at for every entity on a board after its mapping changes
// (a field or the face turned live/idle, or a cadence moved). `live` = the
// mapping's live connector fields [{ key, every }]; `faceSched` = the face's
// schedule from connectors/schedule.js ({ every } live / { first: true }
// one-shot / null none). Empty/null both clear that term.
export async function rescheduleEntityRefreshes(db, boardId, live, faceSched = null, now = Date.now()) {
  // Nothing live and no face to render → every entity's next refresh is null. Clear
  // the whole board in one statement instead of a write per entity. This is the common
  // case on a file board, where no field can be live — so the mapping save that
  // used to fan out N no-op writes now does a single targeted one.
  if (!live.length && !faceSched) {
    await db.query("UPDATE entities SET refresh_at=NULL WHERE board_id=$1 AND refresh_at IS NOT NULL", [boardId]);
    return;
  }
  const { rows } = await db.query("SELECT id, fields, face_at FROM entities WHERE board_id=$1", [boardId]);
  const sched = [];
  for (const e of rows) {
    let next = nextRefreshAt(e.fields, live, now);
    if (faceSched) {
      // A never-rendered face (face_at null) is due NOW — this is the urgency
      // path that backfills every existing entity when a board's face turns on,
      // live or not. An already-rendered face is due one cadence out, or never
      // when the face is one-shot (nothing left to do for that entity).
      const due = e.face_at == null ? now
        : faceSched.every ? e.face_at + faceSched.every * 60000
        : null;
      if (due !== null && (next === null || due < next)) next = due;
    }
    sched.push({ id: e.id, nx: next });
  }
  if (!sched.length) return;
  // One bulk write instead of a round-trip per entity.
  await db.query(
    `UPDATE entities AS e SET refresh_at = u.nx
     FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, nx bigint)
     WHERE e.id = u.id`,
    [JSON.stringify(sched)]
  );
}

// Re-run the full pipeline for every instance of an entity (the card-level
// "reprocess"). User-initiated, so the CURRENT board mapping is re-stamped and
// applied — a mapping edited after upload (or added to a board that had none)
// actually takes effect here; connector vehicles restart at the face leg (the
// chart is part of the definition, and this is the only manual path that can
// re-render a non-live face — e.g. after a period change), other instances at
// the extract leg when there is AI work (current or stamped), else at tagging.
// Tags are cleared up front so the card shows a clean reprocessing state
// either way. The face check reads the mapping that will apply ($3 when
// re-stamped, else the stamp — $3 is null for connector-only mappings, which
// carry no AI work); a vehicle is zero-files (unrendered) or generated-file
// (rendered chart), never a user upload.
export async function reprocessEntity(db, entityId) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM entities e JOIN boards b ON b.id = e.board_id WHERE e.id=$1", [entityId]);
  if (!rows.length) return false;
  const current = aiMappingJson(rows[0].mapping);
  // `- 'park'`: an explicit reprocess runs the full pipeline through tagging,
  // even on an auto-tag-off board — park only gates the automatic ingest flow.
  // `- 'transcript_error'`: a reprocess retries a failed transcription (the loop
  // re-queues any audio item lacking both transcript + error). A successful
  // `transcript` is kept — no needless re-transcription / provider re-billing.
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN $3::jsonb IS NULL THEN payload - 'park' - 'transcript_error'
                        ELSE jsonb_set(payload - 'park' - 'transcript_error', '{mapping}', $3::jsonb) END,
         status = CASE
           WHEN ${UNFETCHED} THEN 'pending_fetch'
           WHEN COALESCE($3::jsonb, payload->'mapping')->'face'->>'source' = 'connector'
                AND (jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0
                     OR payload->'files'->0->>'generated' = 'true') THEN 'pending_face'
           WHEN $3::jsonb IS NOT NULL OR payload ? 'mapping' THEN 'pending_extract'
           ELSE 'pending' END,
         tags='[]'::jsonb, tag_reasoning='{}'::jsonb, tag_confidence='{}'::jsonb,
         tag_facets=NULL, undecided=FALSE,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE entity_ids @> ARRAY[$2]::bigint[]`,
    [Date.now(), entityId, current]
  );
  return result.rowCount > 0;
}

// Value-fenced (`AND status='processing'`): the stamp lands only while the row
// is still this claim's in-flight status. A per-card route (reprocess,
// re-extract, retag, tag edit) that re-routed the row mid-call wins — the
// stale result is discarded (returns false) and the snapshot is skipped, so
// history never records a judgment that was never current. A row deleted
// mid-call discards the same way instead of FK-erroring on the snapshot.
// Sound single-process because a stale stamp always executes before any
// re-claim (single-flight tick); across processes a value fence is NOT
// ownership — see the worker-queue audit, hole #7.
// `confidence` is the per-facet vote agreement (vote mode); {} on a single-pass
// board means NOT MEASURED, never zero — readers must distinguish those.
//
// `scoped` says this pass only spoke for some of the item's facets (0030). Two
// consequences, and they must move together:
//   - `undecided` is NOT written. The verdict is a whole-item judgment and a
//     scoped pass did not make one; an item flagged undecided while eight
//     facets keep their tags is incoherent.
//   - the caller must therefore pass the item's EXISTING flag, because
//     addTagSnapshot dedupes on it. Handing it a verdict that was never stored
//     makes the comparison test fiction — appending when the flag "changed",
//     skipping when it "matched".
export async function markTagged(db, id, tags, undecided = false, reasoning = {}, confidence = {}, scoped = false) {
  // Clearing the vector marks the item for the embedding sweep — the text it
  // was embedded from just changed.
  // tag_facets=NULL on EVERY landing, scoped or not: the scope is consumed here,
  // and a stale one would narrow the next pass.
  const vals = [JSON.stringify(tags), JSON.stringify(reasoning || {}), JSON.stringify(confidence || {}), Date.now()];
  const sets = [
    "status='tagged'", "tags=$1", "tag_reasoning=$2", "tag_confidence=$3",
    "tag_facets=NULL", "error=NULL", "retry_at=NULL",
    "embedding=NULL", "embedding_model=NULL", "embed_error=NULL", "updated_at=$4",
  ];
  if (!scoped) { vals.push(undecided); sets.push(`undecided=$${vals.length}`); }
  vals.push(id); // last, so the fence's placeholder is always vals.length
  const { rowCount } = await db.query(
    `UPDATE items SET ${sets.join(", ")} WHERE id=$${vals.length} AND status='processing'`,
    vals
  );
  if (rowCount) await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
  return rowCount > 0;
}

// --- semantic search embeddings ---

export async function setItemEmbedding(db, id, vector, model) {
  await db.query("UPDATE items SET embedding=$1, embedding_model=$2, embed_error=NULL WHERE id=$3", [
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    model,
    id,
  ]);
}

// Mark an item the embedder rejected on its own (a poison input): the sweep
// skips it so one bad item can't wedge the whole backfill. Cleared wherever
// the embed text changes (markTagged, setItemTags) and on a later success.
export async function setItemEmbedError(db, id, message) {
  await db.query("UPDATE items SET embed_error=$1 WHERE id=$2", [String(message).slice(0, 500), id]);
}

// The embedding sweep's work queue: items whose vector is missing or from
// another model. Two sources become searchable — tagged items (embedded from
// their tags + reasoning) and transcribed audio (embedded from its transcript,
// even when the board doesn't tag). Newest first so fresh uploads become
// searchable before a long backfill finishes; items the embedder rejected
// (embed_error) are skipped until they get fresh text.
export async function itemsNeedingEmbedding(db, model, limit) {
  const { rows } = await db.query(
    `SELECT id, board_id, entity_ids, tags, tag_reasoning, payload FROM items
     WHERE embed_error IS NULL
       AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
       AND (status='tagged'
            OR (payload->'files'->0->>'kind'='audio' AND payload ? 'transcript'))
     ORDER BY updated_at DESC, id DESC LIMIT $2`,
    [model, limit]
  );
  return rows;
}

// One audio item still needing a transcript — the transcription loop's work
// queue. Independent of tagging and status: any audio item with neither a
// `transcript` nor a permanent `transcript_error` qualifies, newest first so
// fresh uploads transcribe before a backlog. `payload ? 'key'` is the jsonb
// key-exists test (an empty-string transcript for a silent clip still counts).
// excludeIds: clips in per-item retry backoff (the worker's in-memory ledger) —
// skipped so one repeatedly-failing clip doesn't head-of-line-block the lane.
// `served` is the transcription lane's claim gate, the shape claimFairBatch
// (above) uses for tagging: don't hand back work no engine can do. When the
// app-wide chain resolves nothing — no provider bound and the built-in's
// sidecar isn't on this host (sidecar-presence-plan.md) — only boards carrying
// their OWN pin are servable, so the filter moves into SQL rather than being
// approximated in JS, where every unservable clip would still be claimed,
// resolved, logged and backed off once a minute forever.
//
// A pin OF the absent built-in is not a pin that can serve, so the floor's
// provider is excluded by name — the name arrives from the capability registry,
// never spelled here. `IS DISTINCT FROM` so a null floorProvider (a capability
// with no built-in) still admits every named pin.
//
// Coarse on purpose, exactly like the tag queue's `b.ai_key_id IS NOT NULL`: a
// pin that exists but can't resolve (its provider uninstalled) passes here and
// is handled per item, unfailed, by transcribeOne.
export async function oneAudioNeedingTranscription(db, excludeIds = [], served = {}) {
  const { globally = true, pinCols = null, floorProvider = null } = served;
  // The floor's name is bound only where the SQL references it — a caller that
  // names no pin columns (the plain "give me the next clip" reads) would
  // otherwise send a parameter the statement never mentions, which Postgres
  // refuses outright.
  const params = [excludeIds, globally];
  const pins = [];
  if (pinCols?.keyId) pins.push(`b.${pinCols.keyId} IS NOT NULL`);
  if (pinCols?.provider) {
    params.push(floorProvider);
    pins.push(`(b.${pinCols.provider} IS NOT NULL AND b.${pinCols.provider} IS DISTINCT FROM $${params.length})`);
  }
  const { rows } = await db.query(
    `SELECT i.id, i.board_id, i.entity_ids, i.payload FROM items i
     LEFT JOIN boards b ON b.id = i.board_id
     WHERE i.payload->'files'->0->>'kind'='audio'
       AND NOT (i.payload ? 'transcript')
       AND NOT (i.payload ? 'transcript_error')
       AND NOT (i.id = ANY($1::bigint[]))
       AND ($2 OR ${pins.length ? pins.join(" OR ") : "FALSE"})
     ORDER BY i.created_at DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// Current-model vectors for one board (the search corpus). Stale vectors are
// excluded rather than compared wrongly; they reappear once re-embedded.
// entity_id rides along so search results can speak in card (entity) ids.
export async function boardEmbeddings(db, boardId, model) {
  const { rows } = await db.query(
    "SELECT id, entity_ids[1] AS entity_id, embedding FROM items WHERE board_id=$1 AND embedding IS NOT NULL AND embedding_model=$2",
    [boardId, model]
  );
  return rows;
}

// Backfill progress for the admin panel: how many tagged items exist, how
// many already carry a current-model vector, and how many were skipped after
// the embedder rejected their text (so a stuck count has a visible why).
export async function embeddingStats(db, model) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='tagged') AS tagged,
            COUNT(*) FILTER (WHERE status='tagged' AND embedding IS NOT NULL AND embedding_model=$1) AS embedded,
            COUNT(*) FILTER (WHERE status='tagged' AND embed_error IS NOT NULL) AS failed
     FROM items`,
    [model]
  );
  return { tagged: Number(rows[0].tagged), embedded: Number(rows[0].embedded), failed: Number(rows[0].failed) };
}

// Route a failed work attempt by what the error says. Three classes:
//  - permanent (HTTP 4xx except 408/429 — bad request, bad key, too large):
//    fail on the FIRST attempt; repeating the same rejected call just repeats
//    the rejection. Providers stamp err.status (compatError / the Anthropic
//    SDK); no status means we can't prove it's permanent, so we retry.
//  - transient (429/408/5xx, network errors, model whims — anything else):
//    requeue with a spaced retry_at (1m, 5m, then 15m — honoring a longer
//    Retry-After when the provider sent one) so the attempts outlast a
//    rate-limit window or an outage instead of burning within seconds, and
//    with TRANSIENT_EXTRA headroom over maxAttempts.
//  - configuration gaps (err.noCount, e.g. "no API key configured"): requeue
//    without consuming an attempt at all — the claim gate promises a missing
//    key never fails an item, and this closes its race.
// requeueStatus controls which queue the item returns to ('pending' for the
// tag leg, 'pending_fetch' / 'pending_extract' / 'pending_face' for the
// definition legs).
// Returns true if the item was failed.
const RETRY_BACKOFF_MS = [60000, 300000, 900000];
const TRANSIENT_EXTRA = 2;
// IN_FLIGHT_FOR — the leg map this fences on — is declared with STATUS_PRIORITY
// at the top of the file, because TAG_QUEUE derives from it too.

export async function failOrRequeue(db, id, error, maxAttempts, requeueStatus = "pending") {
  const httpStatus = Number(error?.status);
  const permanent =
    Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500 &&
    httpStatus !== 408 && httpStatus !== 429;
  const noCount = error?.noCount === true;
  const { rows } = await db.query("SELECT attempts FROM items WHERE id=$1", [id]);
  const attempts = (rows.length ? rows[0].attempts : 0) + (noCount ? 0 : 1);
  const failed = !noCount && (permanent || attempts >= maxAttempts + TRANSIENT_EXTRA);
  const backoff = noCount
    ? RETRY_BACKOFF_MS[0]
    : RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1)];
  const ra = Number(error?.retryAfter);
  const wait = Math.max(backoff, Number.isFinite(ra) ? Math.min(ra * 1000, 3600000) : 0);
  // Value-fenced: a stale failure must not stamp error/retry_at over a row the
  // user re-routed mid-flight (their reprocess/re-extract already reset it and
  // chose its leg). The fence also closes the attempts read-then-write race —
  // every writer that resets attempts also moves the row out of this status.
  //
  // A REQUEUE keeps any facet scope (0030) — the retry is the same partial pass.
  // A FAILURE clears it, and that is load-bearing: it is what keeps "a scoped row
  // is only ever pending or processing" true. A 'failed' row is visible to
  // retagBoard, queueUntagged and requeueItemForTag, none of which filter on the
  // scope, so a surviving one would silently narrow the FULL retag that comes to
  // rescue the item — and narrow it again on every later pass, since a still-broken
  // item lands back here. (No-op on the definition legs, which never set a scope.)
  const { rowCount } = await db.query(
    `UPDATE items SET status=$1, attempts=$2, error=$3, retry_at=$4, updated_at=$5${failed ? ", tag_facets=NULL" : ""}
     WHERE id=$6 AND status=$7`,
    [
      failed ? "failed" : requeueStatus,
      attempts,
      String(error?.message ?? error).slice(0, 500),
      failed ? null : Date.now() + wait,
      Date.now(),
      id,
      IN_FLIGHT_FOR[requeueStatus] || "processing",
    ]
  );
  return rowCount > 0 && failed;
}

// Recover items stranded mid-flight (every claimed in-flight status) by a
// crash or a shutdown that outlived the 5s drain. Each recovery counts as an
// attempt — an interruption is evidence — and requeues to its own leg with
// the same spaced retry_at as transient failures, so a crash-looping poison
// item stops re-leading the FIFO on every boot and, at the transient ceiling,
// actually fails. Nothing else can fail it: claims don't check attempts, and
// failOrRequeue only ever sees CAUGHT errors — a crash reaches neither. The
// ceiling's headroom means an innocent item must straddle maxAttempts+2
// separate interruptions (deploys included) before it could be wrongly
// failed. Returns the number of rows touched.
// excludeIds: rows THIS worker process is actively holding — the in-memory in-flight
// set (worker-rework Stage 0: recovery ownership). A live in-flight call can outlast
// olderThanMs (research tagging runs minutes; the extractor 240 s), so status + age
// alone can't tell "crashed" from "still working" — ownership can. Recovery then only
// ever touches rows no live flight owns: genuine crash/drain debris. An empty array
// excludes nothing (id <> ALL('{}') is vacuously true) — the single-flight / boot path.
export async function recoverStuck(db, olderThanMs, maxAttempts = 3, excludeIds = []) {
  const now = Date.now();
  const [b0, b1, b2] = RETRY_BACKOFF_MS;
  const { rowCount } = await db.query(
    `UPDATE items SET
       attempts = attempts + 1,
       status = CASE
         WHEN attempts + 1 >= $2 THEN 'failed'
         ${REQUEUE_ARMS}
         ELSE 'pending' END,
       error = CASE WHEN attempts + 1 >= $2
                    THEN 'interrupted mid-flight repeatedly (crash or shutdown)' ELSE error END,
       retry_at = CASE WHEN attempts + 1 >= $2 THEN NULL
                       ELSE $3::bigint + (CASE LEAST(attempts, 2) WHEN 0 THEN ${b0} WHEN 1 THEN ${b1} ELSE ${b2} END) END,
       -- Same rule as failOrRequeue: a recovered pass is still scoped, a failed
       -- one is over. Leaving the scope on a 'failed' row lets the full retag
       -- that rescues the item inherit it and tag one facet instead of nine.
       tag_facets = CASE WHEN attempts + 1 >= $2 THEN NULL ELSE tag_facets END,
       updated_at = $3
     WHERE status IN ${IN_FLIGHT_SQL} AND updated_at < $1
       AND id <> ALL($4::bigint[])`,
    [now - olderThanMs, maxAttempts + TRANSIENT_EXTRA, now, excludeIds]
  );
  return rowCount;
}

// YYYY-MM-DD (UTC) — the day key every rollup in this file is filed under.
// One derivation, so a change to what "a day" means lands in one place.
export function day(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

// --- the usage meter (metering-plan.md, Stage 1) ---

// Record "N units of `unit` consumed by this subject" — the whole contract.
// The meter does not know AI exists: `units` is { unit: quantity } with any
// unit string a spender cares to name, and the dimensions are plain text with
// '' — never NULL — for "doesn't apply" (see 0040 for why NULL would quietly
// break the upsert). Zero/absent quantities are skipped so the common
// no-cache, no-search call writes only the rows it has news for. Throws like
// any db helper — route through meterWrite to make a failure survivable.
//
// `rates` is { unit: microsPerUnit } with '*' as a whole-subject wildcard —
// plain data handed in by the caller (metering.js joins pricing to this;
// Stage 3). A unit WITH a rate stamps cost_micros = round(q × rate) and
// counts its whole quantity as priced — rate 0 (on-device) is priced-at-zero,
// which is a knowledge claim, not an absence. A unit WITHOUT a rate stamps
// neither, and quantity − priced_quantity stays visible as the unpriced
// remainder. Cost is computed HERE, at write time, and never recomputed — a
// later price edit must not rewrite history.
// The meter's "doesn't apply" sentinel, and what it MEANS — declared once,
// here, beside the writer that stamps it. Work with no board (a sweep, a
// connector's quota burn) files under it; readers filter to it as a value and
// name it from this label rather than each inventing the English (0040 says
// why it is '' and never NULL).
export const APP_SCOPE = "";
export const APP_SCOPE_LABEL = "outside any board";
// The model-call axes' own '' has a different meaning and so its own name:
// work with no provider/model attribution — the pre-meter backfill (0040), or
// spend with no model call behind it. Named for the PROVIDER axis; a bare ''
// model under a named provider stays blank (the provider's name already
// carries the row, and "OpenAI · unattributed" would read as a claim).
export const UNATTRIBUTED_LABEL = "unattributed";

export async function meter(db, { boardId = "", capability, provider = "", model = "" }, units = {}, rates = {}) {
  const rows = Object.entries(units)
    .map(([unit, n]) => [unit, Math.round(Number(n)), rates[unit] ?? rates["*"]])
    .filter(([, q]) => q > 0)
    .map(([unit, q, rate]) => ({
      unit, q,
      pq: rate == null ? 0 : q,
      cm: rate == null ? 0 : Math.round(q * rate),
    }));
  if (!rows.length) return;
  await db.query(
    `INSERT INTO usage_meter (day, board_id, capability, provider, model, unit, quantity, priced_quantity, cost_micros)
     SELECT $1, $2, $3, $4, $5, u.unit, u.q, u.pq, u.cm
     FROM jsonb_to_recordset($6::jsonb) AS u(unit text, q bigint, pq bigint, cm bigint)
     ON CONFLICT (day, board_id, capability, provider, model, unit)
     DO UPDATE SET quantity = usage_meter.quantity + EXCLUDED.quantity,
                   priced_quantity = usage_meter.priced_quantity + EXCLUDED.priced_quantity,
                   cost_micros = usage_meter.cost_micros + EXCLUDED.cost_micros`,
    [day(), boardId, capability, provider, model, JSON.stringify(rows)]
  );
}

// --- the rate map's stored rungs (model_prices; pricing.js resolves) ---

// The latest effective row per (provider, model, unit, source) — the shape the
// rate-table build consumes. Older effective_from rows stay as history.
export async function loadModelPrices(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (provider, model, unit, source)
            provider, model, unit, source, micros_per_unit
     FROM model_prices WHERE effective_from <= $1
     ORDER BY provider, model, unit, source, effective_from DESC`,
    [Date.now()]
  );
  // NUMERIC comes back from pg as a string; coercing HERE (like every other
  // reader in this file) rather than leaving each consumer to remember it.
  return rows.map((r) => ({ ...r, micros_per_unit: Number(r.micros_per_unit) }));
}

// When each learner rung last heard from its source, per provider — the
// staleness input for price-learner.js's cadence. fetched_at is NULL on admin
// rows, which is exactly what keeps hand-typed prices out of a "when did we
// last fetch" answer.
export async function modelPriceFreshness(db) {
  const { rows } = await db.query(
    `SELECT source, provider, MAX(fetched_at) AS at FROM model_prices
     WHERE fetched_at IS NOT NULL GROUP BY source, provider`
  );
  return rows.map((r) => ({ source: r.source, provider: r.provider, at: Number(r.at) }));
}

// A price is learned or edited by INSERTING a new effective row, never by
// updating one — stamped costs reference the past, and the past keeps its row.
// Takes MANY rows in one round-trip: the provider rung stores whole catalogs
// (an aggregator answers with hundreds of models × several units), and a row
// at a time would be that many round-trips inside a maintenance tick. Same
// jsonb_to_recordset shape as meter() and updateItemPayloads.
export async function addModelPrices(db, rows) {
  if (!rows.length) return;
  const now = Date.now();
  await db.query(
    `INSERT INTO model_prices (provider, model, unit, micros_per_unit, source, effective_from, fetched_at)
     SELECT p.provider, p.model, p.unit, p.micros_per_unit, p.source, p.effective_from, p.fetched_at
     FROM jsonb_to_recordset($1::jsonb)
       AS p(provider text, model text, unit text, micros_per_unit numeric, source text, effective_from bigint, fetched_at bigint)
     ON CONFLICT (provider, model, unit, source, effective_from) DO UPDATE SET
       micros_per_unit = EXCLUDED.micros_per_unit, fetched_at = EXCLUDED.fetched_at`,
    [JSON.stringify(rows.map(({ provider, model, unit, microsPerUnit, source = "admin", effectiveFrom = now, fetchedAt = null }) =>
      ({ provider, model, unit, micros_per_unit: microsPerUnit, source, effective_from: effectiveFrom, fetched_at: fetchedAt })))]
  );
}
export const addModelPrice = (db, row) => addModelPrices(db, [row]);

// The meter observes work; it must never break the work it observes. Every
// metering write goes through here — a failure is a warn, never a throw into
// the leg or sweep being measured (worker.js's jobLogWrite, same rule for the
// same reason). Concretely, it is what stops a bookkeeping blip from being
// written up as "post-tag write failed — left for recovery" by the tag
// landing's catch. A new spender routes through this rather than remembering
// to re-implement the rule.
export async function meterWrite(fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn("usage meter write failed:", e.message);
    return null;
  }
}

// The AI adapters (meterAiCall/meterAiCalls/spentDetail) live in metering.js —
// they join this mechanism to the pricing rungs, and pricing reads the
// provider registry, which this module must not import.

// Age out meter rows. Day is the TEXT primary-key prefix, so the cutoff
// compares as a date string.
export async function pruneUsageMeter(db, cutoffMs) {
  const { rowCount } = await db.query(`DELETE FROM usage_meter WHERE day < $1`, [day(cutoffMs)]);
  return rowCount;
}

// Per-board paid-call usage, all-time + today, plus the last 14 days broken
// out for the admin sparkline:
// { boardId: { units: { unit: quantity }, today: { unit: quantity },
//              days: [{ day, units }] } }  (days ascending, gaps omitted)
// Every capability's spend rolls up together here (that is what the admin cell
// shows); the per-capability breakdown is Stage 4's query, not this one.
//
// Every half is a UNITS MAP (Stage 5b): which units to feature, and how, is
// the cell's display choice, so a unit this query never heard of rides
// through to the client with no edit here — the route serves the vocabulary
// beside it. Both halves ride `usageRows`, the one dimensioned reader, rather
// than spelling its GROUP BY a third time; the day half just windows and
// groups by day as well.
export async function boardAiUsage(db) {
  // Independent — the day window is not a subset of the all-time aggregate's
  // work, and the admin page waits on both.
  const [allTime, dayRows] = await Promise.all([
    usageRows(db, { group: ["board"] }),
    usageRows(db, { group: ["board", "day"], from: day(Date.now() - 13 * 86400000) }),
  ]);
  const out = Object.fromEntries(
    allTime
      // The app scope is not a board — the admin table has no row for it (the
      // Usage tab is where app-level spend is read).
      .filter((r) => r.board !== APP_SCOPE)
      .map((r) => [
        r.board,
        {
          units: Object.fromEntries(Object.entries(r.units).map(([u, x]) => [u, x.quantity])),
          // Spend, when any is known — one fold, shared with the board's own
          // reader (boardUsageSummary): micros sum legally across units, the
          // remainder never does.
          cost: costOf(r.units),
          today: {},
          days: [],
        },
      ])
  );
  // Today is always inside the 14-day window, so it is one of these rows —
  // read it off rather than making the aggregate above compute it a second time.
  const t = day();
  for (const r of dayRows) {
    const b = out[r.board];
    if (!b) continue;
    const units = Object.fromEntries(Object.entries(r.units).map(([u, x]) => [u, x.quantity]));
    b.days.push({ day: r.day, units });
    if (r.day === t) b.today = units;
  }
  return out;
}

// The dimensioned usage read (metering-plan.md, Mechanism 3): group by any
// subset of the meter's dimensions over any day window. `group` names are the
// API's, mapped here onto columns — the allowlist is what makes interpolating
// them into SQL safe, and the route 400s anything not in it before calling.
// Rows always additionally group by unit (the meter's grain), folded into a
// per-unit object under each dimension tuple: quantities sum legally within a
// unit, and cost sums across everything (one currency); nothing else is ever
// added together.
// The groupable dimensions, WITH their names. This is the one resolver — the
// route validates against it AND serves it, so what a client can offer and
// what the server will accept are the same list by construction (the
// browseFilters rule, connectors/runtime.js). Mechanism 3 asks for three
// things: the units, their labels, and WHICH BREAKDOWNS EXIST. A Stage 5
// dimension added here appears in the picker with no client edit — the
// alternative is a hardcoded list in the tab, which is the mistake this
// feature has already caught twice (a prose capability list, then a unit-id
// transform).
//
// `emptyLabel` is what THIS axis's '' means, stated on the axis rather than
// branched on by whoever renders it. The sentinel is one schema fact with a
// different meaning per dimension (no board / no attribution), and the reader
// had grown one `id === "" ? …` branch per axis in another file — two of them,
// already disagreeing about whether to compare against the named constant or a
// bare "". A dimension with no `emptyLabel` has nothing to say about '' and
// renders it blank, which is the deliberate answer for `model`: under a named
// provider, "OpenAI · unattributed" would read as a claim.
export const USAGE_DIMS = {
  day: { column: "day", label: "Day" },
  board: { column: "board_id", label: "Board", emptyLabel: APP_SCOPE_LABEL },
  capability: { column: "capability", label: "Work" },
  provider: { column: "provider", label: "Provider", emptyLabel: UNATTRIBUTED_LABEL },
  model: { column: "model", label: "Model" },
};

export async function usageRows(db, { from = null, to = null, board = null, capability = null, group = [] } = {}) {
  const cols = group.map((g) => USAGE_DIMS[g]?.column);
  // Also the guard on the interpolation below — every name reaching the SQL
  // came out of the table above, never out of a request.
  if (cols.some((c) => !c)) throw new Error("unknown group dimension");
  const cond = [], args = [];
  const where = (sql, v) => { args.push(v); cond.push(`${sql} $${args.length}`); };
  if (from) where("day >=", from);
  if (to) where("day <=", to);
  // `board` is compared when GIVEN, including the '' app scope — which is a
  // value, not an absence, so null is the only way to say "every board".
  if (board != null) where("board_id =", board);
  if (capability) where("capability =", capability);
  const sel = [...cols, "unit"];
  const { rows } = await db.query(
    `SELECT ${sel.join(", ")}, SUM(quantity) AS q, SUM(priced_quantity) AS pq, SUM(cost_micros) AS cm
     FROM usage_meter ${cond.length ? `WHERE ${cond.join(" AND ")}` : ""}
     GROUP BY ${sel.join(", ")} ORDER BY ${sel.join(", ")}`,
    args
  );
  // Fold one row per unit into one row per dimension tuple.
  const out = new Map();
  for (const r of rows) {
    const key = JSON.stringify(cols.map((c) => r[c]));
    let row = out.get(key);
    if (!row) out.set(key, row = { ...Object.fromEntries(group.map((g, i) => [g, r[cols[i]]])), units: {} });
    row.units[r.unit] = { quantity: Number(r.q), priced_quantity: Number(r.pq), cost_micros: Number(r.cm) };
  }
  return [...out.values()];
}

// The unpriced remainder as something displayable: per UNIT, never one summed
// number — unpriced tokens plus unpriced searches is a quantity of nothing.
// Labels come from the registry here, at the source, rather than being
// invented from the id by whoever renders it (units.js says why).
// Named field by field rather than spread: this list is a statement about
// QUANTITIES ("1,200 input tokens are unpriced"), so it takes the naming half
// of describeUnit and leaves the rate frame to the surface that prices things.
const unpricedList = (byUnit) =>
  Object.entries(byUnit || {})
    .filter(([, q]) => Number(q) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, q]) => {
      const { label, format } = describeUnit(unit);
      return { unit, label, format, quantity: Number(q) };
    });

// Everything one board's chip and its cost figure need, in ONE pass over its
// rows: the token buckets kept apart (input and output bill at 3-5× different
// rates and cache reads at a fraction of input, so adding any of them together
// produces a figure that means nothing) and the spend.
//
// Grouping by unit rather than pivoting per bucket is what keeps this reader
// free of a unit vocabulary — a Stage 5 unit joins the cost and the remainder
// with no edit here. The three named buckets are a DISPLAY choice, made where
// the display is.
//
// `cost` is null when nothing was ever priced: "≈$0.00" on a board whose rates
// we don't know would be a claim, not an absence. A board that ran free
// on-device DOES get its true $0.00 — rate 0 is priced-at-zero. Note cost is
// computed for every caller and DISCLOSED by the route (spend is
// management-visible); it is one query either way, so the gate stays a
// disclosure rule rather than becoming a second query path.
export async function boardUsageSummary(db, boardId) {
  // The ungrouped read of the dimensioned reader IS this query — one board,
  // every unit. Calling it rather than spelling the same SELECT again is what
  // keeps a Stage 5 unit (or a renamed cost column) from having to land twice.
  const [row] = await usageRows(db, { board: boardId });
  return {
    // Every unit, by id — NOT three named token buckets. The bucket pivot that
    // used to live here was a display choice made in the wrong building: it
    // decided what the chip COULD say, so Stage 5b's audio joined the cost and
    // the remainder while being unrepresentable in `tokens` — and the chip,
    // which gates on input+output, went dark on a board whose only spend was
    // transcription. The surfaces name their own buckets now; this reader
    // stays free of a unit vocabulary, which is what it always claimed.
    units: Object.fromEntries(Object.entries(row?.units || {}).map(([u, x]) => [u, x.quantity])),
    cost: costOf(row?.units),
  };
}

// The spend fold both board readers share: micros sum legally across units
// (one currency), the per-unit remainder never does, and `null` means NOTHING
// was ever priced — "≈$0.00" on a board whose rates we don't know would be a
// claim, not an absence, while a board that ran free on-device gets its true
// $0.00 (rate 0 is priced-at-zero). One rule, stated once, so the two grades
// of the same figure cannot drift apart.
function costOf(units) {
  let micros = 0, priced = false;
  const remainder = {};
  for (const [unit, u] of Object.entries(units || {})) {
    micros += u.cost_micros;
    if (u.priced_quantity > 0) priced = true;
    if (u.quantity > u.priced_quantity) remainder[unit] = u.quantity - u.priced_quantity;
  }
  return priced ? { micros, unpriced: unpricedList(remainder) } : null;
}

// Delete a row; returns { payload, board_id } (the caller hands the payload's
// files to sources.cleanup) or null if missing.
// Pull a board's items out of the tagging queue. Items that still carry
// their previous tags go back to 'tagged'; never-tagged ones also become
// 'tagged' but flagged undecided — the same untagged-for-human-review state
// as when the AI can't place an item. An in-flight 'processing' item is
// left to finish.
export async function cancelBoardQueue(db, boardId) {
  return withTx(db, async (client) => {
    const now = Date.now();
    const restored = (
      await client.query(
        // tag_facets=NULL on both branches: these target status='pending', which
        // is exactly the window a scoped pass waits in. Pulling an item out of
        // the queue must not leave a scope armed for the next pass.
        `UPDATE items SET status='tagged', tag_facets=NULL, attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending' AND tags != '[]'::jsonb`,
        [now, boardId]
      )
    ).rowCount;
    const cleared = (
      await client.query(
        `UPDATE items SET status='tagged', undecided=TRUE, tag_facets=NULL, attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending'`,
        [now, boardId]
      )
    ).rowCount;
    return { restored, cleared };
  });
}

// --- alerts (watched facet conditions; the matcher and sweep live in alerts.js) ---

// Every alert query below carries the owner-access clause: an alert whose
// owner has been removed from the board goes dormant — it stops matching AND
// stops delivering (a webhook is an open pipe out of the board; revoking
// membership must close it, not just the UI). Matches and pending firings
// freeze in place and resume if the owner is re-added.
const ALERT_OWNER_ACCESS = `(
  (SELECT u.is_admin FROM users u WHERE u.id = a.user_id)
  OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = a.board_id AND bm.user_id = a.user_id)
)`;

export async function boardAlerts(db, boardId) {
  const { rows } = await db.query(
    `SELECT a.id, a.condition FROM alerts a WHERE a.board_id=$1 AND a.enabled AND ${ALERT_OWNER_ACCESS}`,
    [boardId]
  );
  return rows;
}

// The entity as the matcher sees it: the union tag set across instances (the
// listItems union stance — what the grid filters on) plus a display label to
// freeze into the match row. Label preference mirrors legLog's: display_name
// (connector/derived), else the first instance's original filename — for
// uploads the identity is the vestigial STORED name nobody recognizes.
export async function entityForAlerts(db, entityId) {
  const { rows: [ent] } = await db.query(
    `SELECT e.display_name, e.identity, e.uploaded_by,
       (SELECT i.payload->'files'->0->>'original_name' FROM items i
         WHERE i.entity_ids @> ARRAY[e.id]::bigint[] ORDER BY i.created_at ASC, i.id ASC LIMIT 1) AS first_file
     FROM entities e WHERE e.id=$1`,
    [entityId]
  );
  if (!ent) return null;
  const { rows: insts } = await db.query(
    "SELECT tags, payload->'fields' AS fields FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]",
    [entityId]
  );
  const tagSet = new Set();
  for (const r of insts) {
    for (const t of r.tags || []) tagSet.add(t);
    // System facets project in as `~facet/value` strings — matchesCondition
    // then sees them exactly the way the client's filter engine does, so an
    // {"~objects": ["car"]} or {"~uploaders": ["5"]} condition needs no
    // matcher change.
    for (const k of objectKeysOf(r.fields)) tagSet.add(`~objects/${k}`);
  }
  if (ent.uploaded_by != null) tagSet.add(`~uploaders/${ent.uploaded_by}`);
  return { tagSet, label: ent.display_name || ent.first_file || ent.identity || null };
}

export async function getItemEntity(db, id) {
  const { rows } = await db.query("SELECT board_id, entity_ids FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// The once-only dedupe: (alert_id, entity_id) is the primary key, so an
// entity that already fired this alert inserts nothing. Returns whether the
// match is new.
export async function addAlertMatch(db, alertId, entityId, itemId, label) {
  const { rowCount } = await db.query(
    `INSERT INTO alert_matches (alert_id, entity_id, item_id, label, matched_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (alert_id, entity_id) DO NOTHING`,
    [alertId, entityId, itemId, label, Date.now()]
  );
  return rowCount > 0;
}

// Baseline rows: matches recorded pre-claimed under a sentinel firing_id no
// alert_firings row ever carries (identities start at 1). They occupy the
// (alert, entity) primary key for everything that matched BEFORE the alert
// existed, so detection's ON CONFLICT swallows the re-landings a board retag
// (periodic auto-tag, admin retag, retag-on-refresh) would otherwise
// announce as "new". Never delivered, never listed: pending queries filter
// firing_id IS NULL and display queries join a real firing.
export const ALERT_BASELINE_FIRING = 0;

// Every entity's union tag set on a board, for the baseline pass — the
// entityForAlerts union (system-facet projections included, so a baseline
// records already-matching object/uploader conditions too), board-wide.
export async function boardEntityTagUnions(db, boardId) {
  const { rows } = await db.query(
    "SELECT unnest(entity_ids) AS entity_id, tags, payload->'fields' AS fields FROM items WHERE board_id=$1 AND cardinality(entity_ids) > 0",
    [boardId]
  );
  const unions = new Map();
  for (const r of rows) {
    let set = unions.get(r.entity_id);
    if (!set) unions.set(r.entity_id, (set = new Set()));
    for (const t of r.tags || []) set.add(t);
    for (const k of objectKeysOf(r.fields)) set.add(`~objects/${k}`);
  }
  const { rows: ups } = await db.query(
    "SELECT id, uploaded_by FROM entities WHERE board_id=$1 AND uploaded_by IS NOT NULL",
    [boardId]
  );
  for (const r of ups) {
    let set = unions.get(r.id);
    if (!set) unions.set(r.id, (set = new Set()));
    set.add(`~uploaders/${r.uploaded_by}`);
  }
  return unions;
}

export async function addAlertBaselineMatches(db, alertId, entityIds) {
  await db.query(
    `INSERT INTO alert_matches (alert_id, entity_id, firing_id, matched_at)
     SELECT $1, eid, ${ALERT_BASELINE_FIRING}, $3 FROM unnest($2::bigint[]) AS eid
     ON CONFLICT (alert_id, entity_id) DO NOTHING`,
    [alertId, entityIds, Date.now()]
  );
}

// The other half of a condition edit: unfired claims — pending matches and
// baseline rows — for entities OUTSIDE the edited condition's matching set
// are stale under the new reading. Pending ones would deliver the old
// condition's backlog on the next sweep; baseline ones squat on the (alert,
// entity) key and swallow the entity's real entry into the new set forever.
// Deleted, not demoted: freeing the key keeps the entity announceable when
// it genuinely enters the set the alert NOW watches. Fired rows stay —
// history, announced under the reading of their day. `before` fences the
// concurrent sweep: a match landing mid-reseed was already evaluated against
// the updated condition and is real news, not a stale claim.
export async function pruneAlertStaleClaims(db, alertId, keepEntityIds, before) {
  const { rowCount } = await db.query(
    `DELETE FROM alert_matches
      WHERE alert_id=$1 AND (firing_id IS NULL OR firing_id = ${ALERT_BASELINE_FIRING})
        AND matched_at <= $3 AND NOT (entity_id = ANY($2::bigint[]))`,
    [alertId, keepEntityIds, before]
  );
  return rowCount;
}

// Alerts holding ungrouped matches, with the window stats the settle logic
// reads (deliverDueAlerts). Daily alerts are excluded — their grouping is
// stamp-driven, not settle-driven (dueDailyAlerts below).
export async function alertsWithPendingMatches(db) {
  const { rows } = await db.query(
    `SELECT a.id, a.delivery, a.webhook_url,
       COUNT(*)::int AS pending, MIN(m.matched_at) AS oldest, MAX(m.matched_at) AS newest
     FROM alerts a JOIN alert_matches m ON m.alert_id = a.id AND m.firing_id IS NULL
     WHERE a.enabled AND a.delivery != 'daily' AND ${ALERT_OWNER_ACCESS}
     GROUP BY a.id`
  );
  return rows;
}

// Daily alerts whose stamp has passed, with their pending-match count. The
// sweep re-arms next_delivery_at for every row returned — matches or not —
// so an overdue stamp can't turn into fire-on-next-match.
export async function dueDailyAlerts(db, now) {
  const { rows } = await db.query(
    `SELECT a.id, a.daily_at_min, a.webhook_url,
       (SELECT COUNT(*)::int FROM alert_matches m WHERE m.alert_id = a.id AND m.firing_id IS NULL) AS pending
     FROM alerts a
     WHERE a.enabled AND a.delivery = 'daily' AND a.next_delivery_at IS NOT NULL AND a.next_delivery_at <= $1
       AND ${ALERT_OWNER_ACCESS}`,
    [now]
  );
  return rows;
}

export async function setAlertNextDelivery(db, id, at) {
  await db.query("UPDATE alerts SET next_delivery_at=$1 WHERE id=$2", [at, id]);
}

// Group every pending match into one firing (one tx — a crash can't strand a
// firing without matches or claim matches into nothing). Returns the firing
// id, or null when nothing was pending after all.
export async function createAlertFiring(db, alertId, withWebhook) {
  return withTx(db, async (client) => {
    const { rows: [f] } = await client.query(
      `INSERT INTO alert_firings (alert_id, fired_at, entity_count, webhook_status)
       VALUES ($1, $2, 0, $3) RETURNING id`,
      [alertId, Date.now(), withWebhook ? "pending" : null]
    );
    const { rowCount } = await client.query(
      "UPDATE alert_matches SET firing_id=$1 WHERE alert_id=$2 AND firing_id IS NULL",
      [f.id, alertId]
    );
    if (!rowCount) {
      await client.query("DELETE FROM alert_firings WHERE id=$1", [f.id]);
      return null;
    }
    await client.query("UPDATE alert_firings SET entity_count=$1 WHERE id=$2", [rowCount, f.id]);
    return f.id;
  });
}

// Firings still owed a webhook and due for it — retry_at spaces the attempts
// (NULL = due now), the pass capped so a hung endpoint (attempts × timeout)
// bounds a single tick. Gated on a.enabled like grouping is: the switch says
// "off pauses matching and delivery", so a pending send freezes with the
// alert and thaws on re-enable — the dormancy stance, one toggle down.
export async function pendingWebhookFirings(db, now, limit = 10) {
  const { rows } = await db.query(
    `SELECT f.id, f.alert_id, f.fired_at, f.entity_count, f.attempts,
       a.name, a.board_id, a.webhook_url, a.webhook_secret, a.condition
     FROM alert_firings f JOIN alerts a ON a.id = f.alert_id
     WHERE f.webhook_status = 'pending' AND a.enabled
       AND (f.retry_at IS NULL OR f.retry_at <= $1)
       AND ${ALERT_OWNER_ACCESS}
     ORDER BY f.fired_at ASC LIMIT $2`,
    [now, limit]
  );
  return rows;
}

export async function stampFiringWebhook(db, id, status, error, retryAt = null) {
  await db.query(
    "UPDATE alert_firings SET webhook_status=$2, webhook_error=$3, attempts=attempts+1, retry_at=$4 WHERE id=$1",
    [id, status, error ? String(error).slice(0, 500) : null, retryAt]
  );
}

// A firing's matches, each resolved to where its content lives NOW: entities
// merge (the instance re-parents, the emptied entity is deleted), and a
// match can outlive its recorded entity_id. live_entity_id is the card a
// link should open — the recorded entity while it exists, else the
// triggering instance's current parent, else NULL (hard-deleted: label-only
// in the payload, absent from the ?event= view). Resolved at read time, so
// a webhook retry can even heal a link that was dead a tick earlier.
export async function firingMatches(db, firingId) {
  const { rows } = await db.query(
    `SELECT m.entity_id, m.item_id, m.label, m.matched_at,
       COALESCE(e.id, i.entity_ids[1]) AS live_entity_id
     FROM alert_matches m
       LEFT JOIN entities e ON e.id = m.entity_id
       LEFT JOIN items i ON i.id = m.item_id
     WHERE m.firing_id=$1 ORDER BY m.matched_at ASC, m.entity_id ASC`,
    [firingId]
  );
  return rows;
}

// The owner's alerts on a board, each carrying its unseen NEW-MATCH count —
// entities across unseen firings, not the firing count: "5" means five new
// items arrived, which is the number the user is owed (the dropdown row
// badge; the client sums them for the caret dot).
export async function listAlerts(db, userId, boardId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.condition, a.delivery, a.daily_at_min, a.webhook_url,
       (a.webhook_secret IS NOT NULL) AS has_secret, a.enabled,
       (SELECT COALESCE(SUM(f.entity_count), 0)::int FROM alert_firings f WHERE f.alert_id = a.id AND NOT f.seen) AS unseen
     FROM alerts a WHERE a.user_id=$1 AND a.board_id=$2 ORDER BY a.created_at ASC`,
    [userId, boardId]
  );
  return rows;
}

// listAlerts' unseen subquery, asked once for every board at a time — the
// index's alert dot (boards-signals-plan.md). Same number in the same
// vocabulary: new-match ENTITIES across unseen firings, not the firing count.
//
// The user filter is the whole security of this route's alert half. An alert is
// per-user by construction, so a GROUP BY that lost `a.user_id=$1` would hand
// one member another's counts on boards they legitimately share — which is why
// the test for it seeds two users on one board rather than one.
//
// An inner join, so a board whose alerts have nothing unseen produces no row and
// reads as 0 from the caller's default; there is no state where the two differ.
// Exported so the plan test pins the query the app actually runs. A copy in the
// test would keep passing while this moved, and the regression is invisible from
// outside — a sequential scan returns the right sum, slowly (0037).
export const BOARD_ALERT_UNSEEN_SQL =
  `SELECT a.board_id, SUM(f.entity_count)::int AS unseen
   FROM alerts a JOIN alert_firings f ON f.alert_id = a.id AND NOT f.seen
   WHERE a.user_id=$1 GROUP BY a.board_id`;

export async function boardAlertUnseen(db, userId) {
  const { rows } = await db.query(BOARD_ALERT_UNSEEN_SQL, [userId]);
  return Object.fromEntries(rows.map((r) => [r.board_id, r.unseen]));
}

export async function getAlertOwned(db, userId, id) {
  const { rows } = await db.query("SELECT * FROM alerts WHERE id=$1 AND user_id=$2", [id, userId]);
  return rows[0] || null;
}

// Duplicate name → null (unlike saveFilterConfig's upsert: silently replacing
// an alert's webhook under a reused name would be a surprise, not a save).
export async function createAlert(db, userId, boardId, a) {
  try {
    const { rows } = await db.query(
      `INSERT INTO alerts (user_id, board_id, name, condition, delivery, daily_at_min, next_delivery_at, webhook_url, webhook_secret, enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10) RETURNING id`,
      [userId, boardId, a.name, JSON.stringify(a.condition), a.delivery, a.daily_at_min, a.next_delivery_at, a.webhook_url, a.webhook_secret, Date.now()]
    );
    return rows[0].id;
  } catch (err) {
    if (err.code === "23505") return null; // unique_violation on (user, board, name)
    throw err;
  }
}

export async function updateAlert(db, id, a) {
  try {
    const { rowCount } = await db.query(
      `UPDATE alerts SET name=$2, condition=$3, delivery=$4, daily_at_min=$5, next_delivery_at=$6, webhook_url=$7, webhook_secret=$8, enabled=$9
       WHERE id=$1`,
      [id, a.name, JSON.stringify(a.condition), a.delivery, a.daily_at_min, a.next_delivery_at, a.webhook_url, a.webhook_secret, a.enabled]
    );
    return rowCount > 0;
  } catch (err) {
    if (err.code === "23505") return null;
    throw err;
  }
}

export async function deleteAlert(db, userId, id) {
  const result = await db.query("DELETE FROM alerts WHERE id=$1 AND user_id=$2", [id, userId]);
  return result.rowCount > 0;
}

// History page for the alert modal: newest first, keyset on (fired_at, id) —
// the listJobLog cursor pattern ("at_id"). nextCursor only on an exactly-full
// page, so the client's Load more knows when the well is dry.
export async function listAlertFirings(db, alertId, { after = null, limit = 50 } = {}) {
  const cond = ["alert_id=$1"];
  const args = [alertId];
  if (after) {
    const [at, id] = String(after).split("_").map(Number);
    if (Number.isFinite(at) && Number.isFinite(id)) {
      args.push(at, id);
      cond.push(`(fired_at, id) < ($${args.length - 1}, $${args.length})`);
    }
  }
  args.push(limit);
  const { rows } = await db.query(
    `SELECT id, fired_at, entity_count, webhook_status, webhook_error, seen
       FROM alert_firings WHERE ${cond.join(" AND ")}
      ORDER BY fired_at DESC, id DESC LIMIT $${args.length}`,
    args
  );
  const last = rows[rows.length - 1];
  return { firings: rows, nextCursor: rows.length === limit ? `${last.fired_at}_${last.id}` : null };
}

// A firing with its alert's board/owner — auth happens at the route: board
// ACCESS, not ownership, so a webhook link pasted in a team channel opens
// for every member of the board.
export async function getAlertFiring(db, id) {
  const { rows } = await db.query(
    `SELECT f.id, f.alert_id, f.fired_at, f.entity_count, f.webhook_status, f.webhook_error,
       a.name, a.board_id, a.user_id, a.condition
     FROM alert_firings f JOIN alerts a ON a.id = f.alert_id WHERE f.id=$1`,
    [id]
  );
  return rows[0] || null;
}

export async function markAlertFiringsSeen(db, userId, alertId) {
  await db.query(
    `UPDATE alert_firings f SET seen=TRUE FROM alerts a
     WHERE f.alert_id=$1 AND a.id=f.alert_id AND a.user_id=$2 AND NOT f.seen`,
    [alertId, userId]
  );
}

