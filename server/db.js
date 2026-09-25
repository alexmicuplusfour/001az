import pg from "pg";
import crypto from "node:crypto";
import { runMigrations } from "./migrate.js";
import { selectFace } from "./faces/select.js";
// Pure scheduling rules — safe to import here (schedule.js imports nothing),
// unlike connectors/runtime.js, which imports THIS module.
import { wantedFields, nextRefreshAt, faceSchedule } from "./connectors/schedule.js";
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
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  // An IDLE client that errors — which is exactly what a Postgres restart does
  // to a pool sitting between queries — emits 'error' on the pool. EventEmitter
  // throws an unhandled 'error' event, so without this listener a routine `docker
  // compose up` on the db takes the app process down with an uncaughtException.
  // Queries in flight still reject normally where they are awaited; this only
  // covers the idle case, which has no other caller to hand the error to.
  // (test/helpers.js has swallowed this for years for the same reason — the
  // harness was immune to a crash production was not.)
  pool.on("error", (e) => console.error("pg pool error (idle client):", e.message));
  return pool;
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

// Ensure every entity on a board with wanted connector fields has a refresh_at.
// Covers boards configured before this feature deployed — otherwise their
// entities sit with refresh_at NULL and the sweep never sees them until the
// mapping is re-saved. Idempotent: it recomputes the correct next-due each boot,
// and since nextRefreshAt carries an absent-key term it also stamps due-now any
// entity missing a mapped field, so a static field added under an older build
// still backfills.
async function reconcileLiveSchedules(db) {
  const { rows } = await db.query("SELECT id, mapping FROM boards WHERE mapping IS NOT NULL");
  for (const b of rows) {
    const wanted = wantedFields(b.mapping);
    const faceSched = faceSchedule(b.mapping);
    if (wanted.length || faceSched) await rescheduleEntityRefreshes(db, b.id, wanted, faceSched);
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

// …and the job kind each leg's rows wear (legLog in worker.js, KIND_DEFS in
// capabilities.js), keyed by the wait state in PIPELINE order — fetch, face,
// extract, tag — which is the order the wire lists the queues in
// (pipelineWork). Only the tag leg breaks the `pending_<x> → <x>` pattern,
// so this is a table and not a string rule. A fifth leg is one entry here
// and one in IN_FLIGHT_FOR.
const LEG_KIND = { pending_fetch: "fetch", pending_face: "face", pending_extract: "extract", pending: "tag" };
const ACTIVE_KIND = Object.fromEntries(Object.entries(LEG_KIND).map(([wait, kind]) => [IN_FLIGHT_FOR[wait], kind]));

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

// The cancel verbs' status lists (job-control-plan.md Stages 2/3), derived here
// with their siblings so a fifth leg lands in both verbs without anyone
// remembering cancelBoardQueue exists. One rule per leg: soft cancel takes a
// leg's QUEUED half, abort takes both. The fetch lane is the one whose UNFETCHED
// rows DELETE (a vehicle whose provider data never landed is a name-only shell);
// everything else pulls back to a settled state. Under abort the lists still
// cover IN_FLIGHT_STATES exactly, so nothing is left running.
const legHalves = (abort) => ([queued, inFlight]) => (abort ? [queued, inFlight] : [queued]);
const cancelFetchLane = (abort) => legHalves(abort)(["pending_fetch", IN_FLIGHT_FOR.pending_fetch]);
const cancelPulls = (abort) =>
  Object.entries(IN_FLIGHT_FOR).filter(([queued]) => queued !== "pending_fetch").flatMap(legHalves(abort));

// Every state that means "this item's tags are about to be rewritten" — both
// halves of all four legs, eight in total. DERIVED rather than written out, so a
// fifth leg cannot be added without this following it. (The fetch leg's inclusion
// mildly over-counts tagQueueDepth's "N waiting on the tagger" — accepted: those
// items do reach the tag leg.)
//
// Not `('pending','processing')`: retagBoard routes each item by payload, so one
// carrying a `mapping` it has not been extracted under enters 'pending_extract'
// and a connector vehicle with no rendered file enters 'pending_face'. On a
// mapped or connector board a full retag produces no 'pending' row at all, and
// every reader that names fewer states calls such a board quiet mid-sweep.
const TAG_QUEUE = `(${IN_FLIGHT_STATES.map((s) => `'${s}'`).join(",")})`;

// The pause gate (job-control-plan.md Stage 1). Every query that lets a board
// SPEND carries it; pause gates execution, never intake — the queues keep filling
// and resume continues where it left off. The roster, so `grep -c notPaused`
// answers "is the gate complete?": claimFairBatch, dueBoards, dueIngestBoards,
// dueLiveEntities, itemsNeedingEmbedding, audioNeedingTranscription,
// boardsWithVotes. NOT gated: deliverDueAlerts (matches found before the pause;
// alerts have their own `enabled`), recoverStuck (its requeues land in pending,
// where the claim gate holds them), and the prune/reap sweeps.
//
// `IS NOT TRUE`, not `NOT`: audioNeedingTranscription LEFT JOINs boards, so an
// unmatched row yields NULL and `NOT NULL` would drop it. One spelling
// everywhere, so a later reader cannot "harmonize" the two wrongly.
const notPaused = (alias = "") => `${alias ? `${alias}.` : ""}paused IS NOT TRUE`;
export function aggregateStatus(instances) {
  if (!instances.length) return "tagged";
  if (instances.length === 1) return instances[0].status;
  for (const s of STATUS_PRIORITY) if (instances.some((i) => i.status === s)) return s;
  return "tagged";
}

// The routed-status report behind every per-card / per-instance re-queue response
// (`{ ok, entities: [{ id, status, instances }] }` — reprocess, retag,
// re-extract): each affected entity with its fresh aggregate and instance
// statuses, read AFTER the re-route landed.
//
// `affected` comes from the caller's own UPDATE — every re-queue statement
// RETURNs the entity_ids of the rows it moved, and their union IS the set of
// cards whose aggregate changed. That covers classify mode exactly: an instance
// can belong to several entities, so re-queuing it moves every one of those
// cards, and answering for just the clicked one would leave the client guessing
// a level up. Deriving it from the UPDATE also keeps this to ONE query.
//
// The read is after the write on purpose: an affected entity's OTHER instances
// were not touched and their statuses are part of its aggregate. A worker
// claiming a row in the gap only makes the report more current.
export async function routedEntities(db, affected) {
  if (!affected?.length) return [];
  const { rows } = await db.query(
    `SELECT id, status, entity_ids FROM items WHERE entity_ids && $1::bigint[]
     ORDER BY created_at ASC, id ASC`, [affected]);
  const byEntity = new Map(affected.map((id) => [id, []]));
  for (const r of rows)
    for (const eid of r.entity_ids || [])
      // Second-degree entities — ones sharing a sibling instance with an
      // affected entity but holding nothing that moved — are outside the
      // report, so this is the report's boundary, not defensiveness.
      if (byEntity.has(eid)) byEntity.get(eid).push({ id: r.id, status: r.status });
  return [...byEntity].map(([id, instances]) => ({ id, status: aggregateStatus(instances), instances }));
}

// The entity ids an UPDATE's RETURNed rows touched — every re-queue route
// feeds this to routedEntities. [] when nothing moved.
export const affectedEntityIds = (rows) => [...new Set(rows.flatMap((r) => r.entity_ids || []))];

// What a re-queue verb returns: the entity ids its UPDATE touched, or null
// when it moved nothing (every route turns that null into its own 404/409).
// One spelling, so ten verbs can't drift on the empty case.
const touched = (result) => (result.rowCount ? affectedEntityIds(result.rows) : null);

// The field KEYS holding ≥1 stored detection box (a non-empty array `v` is
// the object-field discriminator, the same one the lightbox overlay reads —
// minus a LIST field, whose value is also an array but of option spellings,
// stamped `kind: "list"` at landing for exactly this test). Feeds the list
// payload's distilled summary AND the alert tag-set builders' `~objects`
// projection — the two server faces of the objects system facet.
export function objectKeysOf(fields) {
  return Object.entries(fields || {})
    .filter(([, f]) => Array.isArray(f?.v) && f.v.length > 0 && f.kind !== "list")
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
    // The app is its own source for this file — a connector price chart, which
    // has no upload behind it. The card sizes such a face differently from
    // somebody's photo, and the client re-picks the face off these instances
    // after a removal, so it has to travel with the rest of the face's fields.
    // Omitted when false, like `objects`: the common row costs nothing.
    ...(file?.generated ? { generated: true } : {}),
    status: r.status,
    tags: r.tags,
    undecided: !!r.undecided,
    ...(objects.length ? { objects } : {}),
  };
}

// The board listing: entities, each carrying its instances. Face fields
// (name/w/h/kind/label) mirror the instance selectFace picks (the board's
// mapping.face; oldest by default) so the card path needs no special cases; tags
// at the entity level are the union across instances, per-instance tags ride inside.
//
// Three modes, one query shape:
// - no opts: the whole board (legacy full list).
// - limit/after: one keyset page walking (created_at DESC, id DESC); the cursor
//   is the last row's pair. nextCursor is emitted only on exactly-full pages, so
//   an exact-multiple total costs one final empty page.
// - since: only entities changed after the given ms stamp — their own updated_at
//   or any of their instances'. Timestamps are BIGINT ms, so cursors round-trip
//   exactly (see the type-parser note at the top).
export async function listItems(db, userId = null, boardId = null, { limit = null, after = null, since = null, ids = null } = {}) {
  const params = [userId, boardId];
  const where = ["($2::text IS NULL OR e.board_id = $2)"];
  let tail = "";
  // `ids` names the entities wanted outright — the MCP get_items shape, which
  // knows exactly which half-dozen cards it is about. Without it that tool read
  // the WHOLE board (measured: 95ms and 7.4MB of assembled JSON on the ui
  // board) to reach six rows. It rides here rather than in a second assembly
  // function because face selection, the instance->entity tag union and
  // aggregateStatus all live in this one, and a parallel copy of them is
  // exactly the drift this arc keeps finding.
  if (ids != null) {
    params.push(ids);
    where.push(`e.id = ANY($${params.length}::bigint[])`);
  }
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
  const partial = limit != null || after != null || since != null || ids != null;
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
      generated: !!face?.generated,
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

// The counter reset every explicit re-queue performs: forget the in-flight
// bookkeeping so the row enters its new leg clean.
const REQUEUE_RESET = `tag_facets=NULL, attempts=0, error=NULL, retry_at=NULL, updated_at=$1`;

// "Throw away the AI's verdict" — the tag columns a redo clears. Its ABSENCE
// is the distinction refreshEntityData exists to make (that verb re-buys the
// data but keeps the verdict until the fresh pass lands), so keeping it a
// named fragment makes "keeps tags" a one-token difference rather than an
// eyeball diff of two SQL walls.
const CLEARED_VERDICT =
  `tags='[]'::jsonb, tag_reasoning='{}'::jsonb, tag_confidence='{}'::jsonb, undecided=FALSE`;

// "This item's text-derived vector is stale" — one spelling for every writer
// that changes embed input text (transcript landing, AI tag landing, human
// tag edit), so the embedding sweep re-embeds it.
const CLEAR_EMBEDDING = `embedding=NULL, embedding_model=NULL, embed_error=NULL`;

// Land a transcript (the transcription lane's one writer): the text, the
// per-segment turns when the engine gave them, and the engine stamp that lets
// a later reprocess tell "same answer twice" from "a different engine would
// answer differently". Clears the embedding trio in the same statement — the
// transcript is an embed input (untagged audio embeds from it directly), and
// an item re-transcribed on a no-tag board never passes through markTagged's
// clear, so without this its stale vector would sit in search forever.
export async function landTranscript(db, id, { text, turns = null, engine = null }) {
  const patch = {
    transcript: text,
    ...(turns ? { transcript_turns: turns } : {}),
    ...(engine ? { transcript_engine: engine } : {}),
  };
  await db.query(
    `UPDATE items SET payload = payload || $1::jsonb, ${CLEAR_EMBEDDING} WHERE id=$2`,
    [JSON.stringify(patch), id]
  );
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

// Originals held per board, from the sizes upload stamped on payload file entries
// (storage-plan.md, Stage 2). ATTRIBUTION, not disk truth: thumbnails, sidecars
// and embeddings belong to no cheap per-board sum. `unsized` carries the entries
// with no recorded size — legacy uploads and old generated faces — because
// folding them into a silent 0 would render "0 B" as a claim about sizes that are
// simply unknown. The LATERAL drops fileless rows (connector tag vehicles).
// SUM(bigint) is NUMERIC, which the int8 parser doesn't cover — the ::bigint
// casts are what keep this reader shipping numbers like everything else.
export async function boardFileBytes(db) {
  const { rows } = await db.query(
    `SELECT i.board_id AS id, b.name AS label,
            COALESCE(SUM((f->>'size')::bigint), 0)::bigint AS bytes,
            COUNT(*)::bigint AS files,
            (COUNT(*) FILTER (WHERE f->>'size' IS NULL))::bigint AS unsized
     FROM items i
     JOIN boards b ON b.id = i.board_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.payload->'files', '[]'::jsonb)) f
     GROUP BY i.board_id, b.name
     ORDER BY bytes DESC, label`
  );
  return rows;
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
  const result = await db.query(
    `UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, tag_confidence=$3, tag_facets=NULL, undecided=FALSE, ${CLEAR_EMBEDDING}, updated_at=$4 WHERE id=$5 RETURNING entity_ids`,
    [JSON.stringify(tags), JSON.stringify(reasoning), JSON.stringify(confidence), Date.now(), id]
  );
  await addTagSnapshot(db, id, "user", tags, reasoning, false);
  // A tag edit is a status mutation too (→ 'tagged') — the route reports the
  // affected cards on the same contract as every re-queue verb.
  return touched(result);
}

// Order-insensitive tag comparison for the snapshot dedupe below.
const sameTagSet = (a, b) => {
  const x = [...(a || [])].sort(), y = [...(b || [])].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
};

// Append one row of judgment history (see tag_snapshots in 0001_baseline.sql).
// History records CHANGES — the mirror of field_snapshots' moved-only discipline:
// a tagging that lands the same tags and verdict as the item's latest snapshot
// appends nothing. Reasoning is excluded from the comparison (the model re-words
// it every call — presentation, not judgment), and so is source (a user's no-op
// save is still a no-op). Without this, a retag_on_refresh live board writes
// ~1.4k identical rows per item per day.
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
// { of, agreed, votes, d }. The reasoning lives in facet-diagnosis.js.
//
// EVERY one excludes undecided items, and `status='tagged'` does NOT do that —
// the verdict rides its own column, so an undecided item IS a tagged one. It
// matters in the direction that flatters us: an undecided item has most facets
// empty, every run picked [], so agreed === of and the facet scores UNANIMOUS.
// Items the model declined to place would count as evidence the taxonomy works.

// The three queries below read TAG_QUEUE (declared with STATUS_PRIORITY).
// boardFacetSegments' scoped-pending clause deliberately does not: a scope is
// only ever armed by retagBoardFacets, which sets 'pending' flat.

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
// NOT a sum of the tally: `votes` counts how many runs picked each value, so
// summing it measures frequency, not tension — a value nobody disputed would
// top the list. A value is in tension on an item when some runs chose it and
// some didn't: votes[v] < of.
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
     FROM boards WHERE ai_votes > 1 AND ${notPaused()} ORDER BY id`
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

// The diagnose loop's setter — a jsonb MERGE, not a whole-column write, because
// two facets diagnosed in the same pass must not overwrite each other and the
// user's save may be demoting a third at the same moment.
//
// `clearsStale` is the compare-and-swap that keeps invalidate-on-write honest.
// diagnoseDue reads facet_diagnostics ONCE per pass and diagnoses every facet
// against that snapshot, so the gap between read and write is the whole pass —
// tens of seconds. A retag armed in it sets stale:true, and a plain `||` merge
// writes an entry with no `stale` straight over it; the finding then looks
// current and nothing ever re-asks. So a write may only clear a mark it KNEW:
//
//   pass read stale, DB stale     the finding is being replaced   -> clear
//   pass read clean, DB stale     armed mid-pass                  -> KEEP
//   a recorded failure            answered nothing                -> KEEP (false)
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
// The question is about ROWS, not size: a finding names the twelve items the
// model reasoned from, so "does this retag touch any of them" has a yes or no
// answer. No threshold anywhere in it. A finding with no stored evidence
// predates this and cannot answer, so it is marked — the safe direction.
//
// `stale` rather than a delete: the finding still supplies the sentence shown
// while it waits, and `stats`/`previous` are the baseline a later facet edit
// demotes into place. Only attempts/error go.
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
// REPLACED, which the next diagnosis quotes back to the model.
//
// Demote, not drop: the paragraph quotes wording that no longer exists, but
// `stats` is the only evidence the edit did anything — it is what "was 60%
// unanimous, now 88%" is measured against. A second edit before any
// re-measurement finds no `stats` to move and leaves the older baseline alone;
// overwriting `previous` with empty stats would destroy the only baseline there is.
//
// FOR UPDATE, not a bare read: setFacetDiagnostic is a plain UPDATE from the
// worker, so the lock keeps a diagnosis landing mid-save from being read,
// dropped and written back.
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
// (agreed < of, most contested first) or unanimous (agreed = of), shown as
// labelled groups — given only failures, a model can never reach "your taxonomy
// is fine".
//
// The whole-item `description`, NOT the per-facet sentence (tag_reasoning->>key):
// mergeVotes takes that from the earliest run that selected what was KEPT, and
// from nowhere when no single run proposed that set — routine on multi-value
// facets, which are the unstable ones. It would bias the sample toward agreement.
//
// Contested items order on the RATIO: `of` is runs completed, not the configured
// ai_votes, so a board mixes 2-, 3- and 5-run items and ordering on `agreed`
// alone would rank 1-of-2 above 2-of-5.
//
// These rows ARE the diagnosis freshness key: facet-diagnosis.js hashes them
// (facetEvidence → exampleKey), so a column added to or dropped from this SELECT
// re-diagnoses every board.
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

// Of the given item ids, which are currently queued for tagging. A primary-key
// lookup over at most a dozen ids per facet — the cheap half of the arming
// check, and why it can run inline on a retag. TAG_QUEUE, not 'pending' alone:
// an item routed through the extract or face leg is every bit as re-measured,
// and reading two of the four states made this hook a no-op on mapped boards.
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
// work in it (extract/detect fields, the card key among them — aiWork asks the
// source table), else null. Same gate as ingest's admitFile.
function aiMappingJson(mapping) {
  return aiWork(mapping) ? JSON.stringify(mapping) : null;
}

// The stamped-face routing predicate in requeueSettledSql (the template
// behind retagBoard / releaseHeld / queueUntagged): an unfaced connector
// tag-vehicle (chart face in the stamp, no files) re-enters the face leg
// before tagging. reprocessEntity's variant differs ON PURPOSE — it prefers
// the fresh re-stamp (COALESCE) and also re-faces rendered charts (generated
// file) — so it is not folded in here.
const STAMPED_CONNECTOR_FACE =
  `payload->'mapping'->'face'->>'source' = 'connector'
                AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0`;

// The mark of an enqueued connector vehicle whose provider fetch never
// landed (bulk add's queued path — connectors/add.js enqueueConnectorEntity).
// Two readers: requeueSettledSql's fetch arm re-enters it into the FETCH
// leg, and cancelBoardQueue splits the fetch lane on it (only these
// name-only shells delete; fetched vehicles pull back).
const UNFETCHED = `payload ? 'unfetched'`;

// The mapping that will APPLY after a reprocess statement lands: $3 (the
// re-stamp) when the board has AI work, else the instance's stamp. $3 is
// reprocessEntity's parameter — predicates built on this are bound to that
// verb's $-order and must not be reused under different numbering.
const APPLYING_MAPPING = `COALESCE($3::jsonb, payload->'mapping')`;

// reprocessEntity's fetch-arm predicate: EVERY connector vehicle, fetched or
// not — a full redo re-buys the provider data (Stage 3a), and the fetch
// LANDING then routes onward (face/tag) per connectorLanding's refetch rule.
// Vehicles are the only items carrying payload.source (admitFile builds
// none), and the applying mapping names the connector input.
const CONNECTOR_VEHICLE =
  `payload->'source'->>'id' IS NOT NULL
                AND ${APPLYING_MAPPING}->'input'->>'connector' IS NOT NULL`;

// The canonical queue-routing CASE: every router walks the SAME arms in the SAME
// mandatory order — fetch first (an unfetched vehicle on a chart-face board
// satisfies the face predicate too, and the face arm would swallow it: a chart
// rendered from empty fields, then tags on nothing), then face, then the requeue
// family's already-extracted shortcut, then extract, else tag. The ARMS are fixed
// here; the PREDICATES are the caller's intent. A fifth leg gets added in this
// one builder or not at all.
const routingCase = ({ fetch, face, shortCircuit = null, extract }) => [
  "CASE",
  `WHEN ${fetch} THEN 'pending_fetch'`,
  `WHEN ${face} THEN 'pending_face'`,
  ...(shortCircuit ? [`WHEN ${shortCircuit} THEN 'pending'`] : []),
  `WHEN ${extract} THEN 'pending_extract'`,
  "ELSE 'pending' END",
].join("\n           ");

// Re-stamp $3 over `expr` when the board has AI work, else `expr` as-is —
// the payload half every re-stamping verb (reextract, reprocess) shares.
const restamped = (expr) =>
  `CASE WHEN $3::jsonb IS NULL THEN ${expr} ELSE jsonb_set(${expr}, '{mapping}', $3::jsonb) END`;

async function boardAiMappingJson(db, boardId) {
  const { rows } = await db.query("SELECT mapping FROM boards WHERE id=$1", [boardId]);
  return rows.length ? aiMappingJson(rows[0].mapping) : null;
}

// The per-instance and per-entity spellings of one scope — every re-queue
// verb below ships an item form (`WHERE id=$2`, the lightbox/rows routes) and
// an entity form (`WHERE entity_ids @> ...`, the card routes), same SET, same
// $-order, RETURNING entity_ids for the routed report. One pair of strings so
// a verb can't grow a third scope with a drifted SET clause.
const ITEM_SCOPE = `id=$2`;
const ENTITY_SCOPE = `entity_ids @> ARRAY[$2]::bigint[]`;

// Reset to the extract leg. User-initiated, so the CURRENT board mapping applies
// — re-stamped ($3; the stamp an instance was built with governs only automatic
// replay). With no AI mapping it replays the stamp; with neither there is
// nothing to extract (the WHERE — null return).
// `- 'park'`: an explicit re-extract runs the full pipeline through tagging even
// on an auto-tag-off board. `- 'transcript_error'`: for audio the extracted text
// IS the transcript, so this retries a failed transcription (a good one is kept).
const reextractSql = (scope) => `
  UPDATE items
     SET payload = ${restamped(`payload - 'park' - 'transcript_error'`)},
         status='pending_extract', ${REQUEUE_RESET}
   WHERE ${scope} AND ($3::jsonb IS NOT NULL OR payload ? 'mapping')
   RETURNING entity_ids`;

export async function reextractItem(db, id) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM items i JOIN boards b ON b.id = i.board_id WHERE i.id=$1", [id]);
  if (!rows.length) return null;
  return touched(await db.query(reextractSql(ITEM_SCOPE), [Date.now(), id, aiMappingJson(rows[0].mapping)]));
}

// The card-level form (Stage 3c): every instance of the entity re-enters the
// extract leg. 409-shaped null when NO instance has anything to extract.
export async function reextractEntity(db, entityId) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM entities e JOIN boards b ON b.id = e.board_id WHERE e.id=$1", [entityId]);
  if (!rows.length) return null;
  return touched(await db.query(reextractSql(ENTITY_SCOPE), [Date.now(), entityId, aiMappingJson(rows[0].mapping)]));
}

// Reset to the tag leg — re-tag from existing material and fields, without
// re-deriving identity/fields (the tag-only slice of reprocess).
// tag_facets=NULL: this is an explicit FULL retag. No status fence here, so
// it can land on a row already queued for a scoped pass — that scope dies.
const retagSql = (scope) => `
  UPDATE items
     SET status='pending', ${CLEARED_VERDICT}, ${REQUEUE_RESET}
   WHERE ${scope}
   RETURNING entity_ids`;

// The lightbox exposes this next to Re-extract — a single instance is what's
// in focus there.
export async function retagItem(db, id) {
  return touched(await db.query(retagSql(ITEM_SCOPE), [Date.now(), id]));
}

// The card-level form (Stage 3c): re-tag every instance, leaving
// identity/fields as-is — the tag-only counterpart of reprocessEntity.
export async function retagEntity(db, entityId) {
  return touched(await db.query(retagSql(ENTITY_SCOPE), [Date.now(), entityId]));
}

// Re-transcribe (Stage 3b): forget the transcript — text, turns, engine
// stamp, and any parked error (fresh attempts) — and re-enter the tag leg in
// ONE statement. The absence-keyed transcription lane refills the text on its
// own, and the tag leg's awaiting-transcription wait does the sequencing.
// Audio-only by WHERE, so the null return doubles as the route's 409; both
// scopes below share this SQL.
const retranscribeSql = (scope) => `
  UPDATE items
     SET payload = payload - 'transcript' - 'transcript_turns' - 'transcript_engine' - 'transcript_error',
         status='pending', ${CLEARED_VERDICT}, ${REQUEUE_RESET}
   WHERE ${scope} AND payload->'files'->0->>'kind' = 'audio'
   RETURNING entity_ids`;

export async function retranscribeItem(db, id) {
  return touched(await db.query(retranscribeSql(ITEM_SCOPE), [Date.now(), id]));
}

// The card-level form (Stage 4, the caret): an entity route beats a
// client-side loop over instances, and audio entities are usually one clip.
export async function retranscribeEntity(db, entityId) {
  return touched(await db.query(retranscribeSql(ENTITY_SCOPE), [Date.now(), entityId]));
}

// Refresh a connector card's data on demand: the vehicle re-enters the fetch leg
// — fresh fields, then a fresh chart via the refetch landing, then a fresh tag
// pass — but KEEPS its tags/reasoning/confidence until that pass lands.
// Vehicles only, by WHERE (CONNECTOR_VEHICLE), so the null return doubles as the
// route's 409; everything admitted goes to the fetch leg, so no routingCase.
// NO CLEARED_VERDICT — that omission IS this verb; reprocess is the clear-first
// variant of the same trip. (REQUEUE_RESET still clears tag_facets, and
// `- 'park'` makes an explicit run tag even on an auto-tag-off board.)
export async function refreshEntityData(db, entityId) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM entities e JOIN boards b ON b.id = e.board_id WHERE e.id=$1", [entityId]);
  if (!rows.length) return null;
  const current = aiMappingJson(rows[0].mapping);
  const result = await db.query(
    `UPDATE items
     SET payload = ${restamped(`payload - 'park'`)},
         status='pending_fetch', ${REQUEUE_RESET}
     WHERE ${ENTITY_SCOPE} AND ${CONNECTOR_VEHICLE}
     RETURNING entity_ids`,
    [Date.now(), entityId, current]
  );
  return touched(result);
}

// Does any instance of this entity carry a transcript engine stamp? The
// reprocess route asks this BEFORE resolving the transcriber: reprocessEntity's
// staleness arm only fires on rows that HAVE a stamp, so with none the resolved
// engine is provably irrelevant — and resolving walks the whole capability
// ladder (several uncached settings reads) on a click that, for every
// image/doc/connector card, could never use the answer.
export async function entityHasTranscriptStamp(db, entityId) {
  const { rows } = await db.query(
    `SELECT 1 FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] AND payload ? 'transcript_engine' LIMIT 1`,
    [entityId]
  );
  return rows.length > 0;
}

// The board form, for the board reprocess route — same reasoning.
export async function boardHasTranscriptStamp(db, boardId) {
  const { rows } = await db.query(
    `SELECT 1 FROM items WHERE board_id=$1 AND payload ? 'transcript_engine' LIMIT 1`,
    [boardId]
  );
  return rows.length > 0;
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
  // No invite token here: it's a bearer credential and only its hash is stored.
  // The admin mints a fresh link on demand (POST /users/:id/link).
  //
  // Board access rides along as a second query — one join for everyone, grouped
  // below. The two don't depend on each other, so they overlap. Board order
  // matches listBoards, so a member's boards read in the Boards tab's sequence.
  //
  // A global admin gets nothing from that join, on purpose: canAccessBoard
  // reaches every board from is_admin alone, WITHOUT a board_members row, so
  // synthesising rows for them would put a second copy of that rule in a display
  // path. Callers read is_admin and say "all".
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

// --- MCP tokens (planning/mcp-members-plan.md §3) ---
//
// Beside the sessions above because they answer the same question in the same
// shape — a bearer arrives, a person comes back — for a caller with no cookie.
//
// NOT hashed, unlike a session id or an invite. The MCP tab exists to hand over a
// complete, working command whenever asked, and a digest can only show one once.
// The trade is argued in the plan (§3): per-member tokens make a leak smaller
// than today's single admin-level one.

// TWO THINGS, NOT ONE FLATTENED ROW. The user goes on to be `ctx.user` in every
// tool handler, so it has to be a users row and nothing else — a
// `u.*, t.id AS mcp_token_id` composite would hand every tool token metadata it
// has no business with, under column names that lie about their table. One query
// still; the split happens here, at the boundary that knows.
export async function resolveMcpToken(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.*, t.id AS t_id, t.last_used_at AS t_last_used_at
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = $1`,
    [token]
  );
  if (!rows.length) return null;
  const { t_id: id, t_last_used_at: lastUsedAt, ...user } = rows[0];
  return { user, token: { id, lastUsedAt: lastUsedAt == null ? null : Number(lastUsedAt) } };
}

export async function mcpTokenFor(db, userId) {
  const { rows } = await db.query(
    `SELECT id, token, created_at, last_used_at FROM mcp_tokens
      WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// Mint, rotate and clear are ONE function: each is "this person's token is now X,
// or nothing". Rotating is minting over the top, and a separate rotate would be a
// second place that has to remember there is only one per person.
//
// The transaction is the point, not ceremony. Folding it into one data-modifying
// CTE is cheaper (2.8ms against 4.6) and wrong: within a single statement the
// DELETE's index entry is not yet invisible to the INSERT, so re-setting a
// person's CURRENT token raises a duplicate-key error instead of the no-op it
// reads as. A caller restoring a known value hits exactly that.
export async function setMcpToken(db, userId, token) {
  await withTx(db, async (client) => {
    await client.query("DELETE FROM mcp_tokens WHERE user_id=$1", [userId]);
    if (!token) return;
    await client.query("INSERT INTO mcp_tokens (user_id, token, created_at) VALUES ($1, $2, $3)", [
      userId,
      token,
      Date.now(),
    ]);
  });
}

export async function touchMcpToken(db, id) {
  await db.query("UPDATE mcp_tokens SET last_used_at=$1 WHERE id=$2", [Date.now(), id]);
}

// Every token on the instance, with whose it is — the admin's connections list.
// The question is "who has an agent pointed at this instance, and when did it
// last run", so it reads in ACTIVITY order rather than roster order.
//
// NO TOKEN COLUMN, and not a masked one either. A member reads their own on their
// own page; the admin's list has never shown one and must not start (§3).
export async function listMcpTokens(db) {
  const { rows } = await db.query(
    `SELECT t.id, t.created_at, t.last_used_at, u.email, u.name, u.is_admin
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
      ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC`
  );
  return rows;
}

// Revoking names a ROW, which is why this is not setMcpToken(userId, null).
// `user_id` is deliberately not unique (§3), so clearing by owner would take out
// a second device nobody picked — and the list an admin clicks is keyed by token
// id, so reaching for the owner's id from it is an indirection that happens to
// be correct only while there is one each.
export async function deleteMcpToken(db, id) {
  await db.query("DELETE FROM mcp_tokens WHERE id=$1", [id]);
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

// Does this board show this person any crates at all? The gallery's crates
// control only appears once the answer is yes, which is the one thing
// save_to_crate's closing line needs to know. Asking `listCrates` instead ran
// a correlated COUNT per crate to compute item counts it then threw away.
export async function hasCrates(db, userId, boardId) {
  const { rows } = await db.query(
    "SELECT 1 FROM crates WHERE board_id=$1 AND (user_id=$2 OR public = TRUE) LIMIT 1",
    [boardId, userId]
  );
  return rows.length > 0;
}

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
     RETURNING id, name, public, board_id`,
    [crateId, userId, !!isPublic]
  );
  if (!rows.length) return null;
  // The flip changes what every card in this crate reports to OTHER people:
  // `crateIds` in the list payload is filtered by crate visibility, so going
  // public adds an id to those cards for everyone else and going private takes
  // it away. Nothing on items or entities changes here, so without this stamp
  // the delta poll — which selects on their updated_at — carries nothing and
  // another member's cards keep the answer they were given before.
  await touchCrateMembers(db, crateId);
  const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  // `boardId` OUTSIDE the crate, not a field on it. The route sends the crate
  // to the client verbatim, and listCrates/createCrate both answer without a
  // board_id — putting one here would make state.crates hold two shapes of the
  // same thing depending on which call produced it. The route needs the board
  // to announce the change; the client has never needed it.
  return {
    crate: {
      id: rows[0].id,
      name: rows[0].name,
      public: rows[0].public,
      owned: true,
      item_count: count.rows[0].c,
    },
    boardId: rows[0].board_id,
  };
}

// A crate's members, as a set of entity ids. The MCP's `crate` search filter
// is the caller: it needs membership WITHOUT the crateIds join listItems does,
// because that join is per-entity work on a whole-board read and this is one
// small lookup for the rare call that asks for it.
export async function crateItemIds(db, crateId) {
  const { rows } = await db.query("SELECT item_id FROM crate_items WHERE crate_id=$1", [crateId]);
  return new Set(rows.map((r) => r.item_id));
}

// Stamp every card in a crate, because something about the CRATE changed that
// its cards report — membership visibility, or the crate ceasing to exist. The
// cards' own rows are untouched by those writes, so this is the only thing that
// puts them in a delta poll's answer.
async function touchCrateMembers(db, crateId) {
  const { rows } = await db.query("SELECT item_id FROM crate_items WHERE crate_id=$1", [crateId]);
  await touchEntities(db, rows.map((r) => r.item_id));
}

// Answers the board it was on, not a boolean: the caller has to tell everyone
// watching that board, and after the DELETE there is nothing left to look it up
// from. null means nothing was deleted.
export async function deleteCrate(db, userId, crateId) {
  // BEFORE the delete — crate_items cascades, so afterwards there is nothing
  // left to read the membership from. Same reason as the flip above: the cards
  // each lose a crateId and nothing on their own rows moves to say so.
  await touchCrateMembers(db, crateId);
  const { rows } = await db.query(
    "DELETE FROM crates WHERE id=$1 AND user_id=$2 RETURNING board_id",
    [crateId, userId]
  );
  return rows[0]?.board_id ?? null;
}

// Which of these ids are cards on this board — the board-is-the-authority rule
// `get_items` states in the same words: an id belonging to another board simply
// does not resolve, and cannot become reachable because the caller knew it.
// Shared so that "a crate only holds entities from its own board" is one sentence
// of SQL rather than one per writer.
export async function entitiesOnBoard(db, ids, boardId) {
  if (!ids.length) return new Set();
  const { rows } = await db.query(
    "SELECT id FROM entities WHERE id = ANY($1::bigint[]) AND board_id=$2",
    [ids, boardId]
  );
  return new Set(rows.map((r) => r.id));
}

// Put cards into a crate, ADDITIVELY. toggleCrateItem below is a checkbox's
// primitive: called twice with the same id it removes what it added, which is
// right for a checkbox and wrong for anything that retries — the MCP's
// save_to_crate is the caller that made the difference matter, since a model
// unsure whether its call landed calls again, and so does a transport retry.
// ON CONFLICT DO NOTHING makes a second call a no-op, and RETURNING says which
// ids the insert actually took, so the answer tells "added" from "was already
// there" without a second read. null when the crate is not this user's — the
// same "not yours reads as not found" the toggle gives; otherwise
// { added, already, count }.
export async function addCrateItems(db, userId, crateId, entityIds) {
  const crate = await db.query("SELECT board_id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const ids = [...new Set((entityIds || []).map(Number).filter(Number.isInteger))];
  const valid = await entitiesOnBoard(db, ids, crate.rows[0].board_id);
  const { rows: inserted } = valid.size
    ? await db.query(
        `INSERT INTO crate_items (crate_id, item_id, created_at)
         SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING RETURNING item_id`,
        [crateId, [...valid], Date.now()]
      )
    : { rows: [] };
  // crateIds ride in the entity's list payload — stamp for delta polls. Only
  // the ones that actually moved: an id that was already in the crate saw no
  // change, and stamping it would tell every open poll otherwise.
  await touchEntities(db, inserted.map((r) => r.item_id));
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  // No `skipped` here. The only caller that reports one — save_to_crate —
  // validates before it opens the crate and passes in just the survivors, so
  // this could only ever have returned an empty array.
  return { added: inserted.length, already: valid.size - inserted.length, count: rows[0].c };
}

export async function toggleCrateItem(db, userId, crateId, itemId) {
  const crate = await db.query("SELECT id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const exists = (
    await db.query("SELECT 1 FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId])
  ).rows.length > 0;
  if (!exists) {
    // The add half is addCrateItems with one id — same insert, same board
    // check, same stamp. A checkbox toggling is the only difference between
    // the two, so it is the only thing left here.
    const r = await addCrateItems(db, userId, crateId, [itemId]);
    return r?.added ? { added: true, count: r.count } : null;
  }
  await db.query("DELETE FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId]);
  await touchEntity(db, itemId);
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  return { added: false, count: rows[0].c };
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
// their model override goes with it, and if the key WAS the default the settings
// pointer is cleared too — a deleted key reverts every binding that pointed at it
// rather than leaving a dead pointer the UI shows as configured. Both loops below
// iterate CAPABILITY_DEFS rather than naming capabilities: the hand-written
// version missed `detect` entirely.
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

// The catalog-landing member of the cleanup family above (a deleted key clears by
// keyId here; an uninstalled plugin clears by name in plugin-loader): NULL every
// board model pinned to `provider` that names a model outside what its deployed
// image bakes. Column names come from the registry's boardKeys — module
// constants, never input. Returns the cleared rows: the caller owns the log line
// and the board-cache invalidation, which are its seams.
export async function clearBoardModelPins(db, boardKeys, provider, models) {
  const { rows } = await db.query(
    `UPDATE boards SET ${boardKeys.model}=NULL
      WHERE ${boardKeys.provider}=$1 AND ${boardKeys.model} IS NOT NULL AND NOT (${boardKeys.model} = ANY($2::text[]))
      RETURNING id, name`,
    [provider, models]
  );
  return rows;
}

// --- boards ---

// Every per-board capability column, from the registry — so a new board-scoped
// capability's columns ride into BOARD_COLS, the admin board payload, and
// updateBoard's boardBindings without a hand edit here.
//
// TWO kinds, and the split is an AUTHORITY boundary, not bookkeeping:
//   PINS    boardKeys — a provider/key/model pointer. Admin-written (they pick
//           credentials and therefore a spend account), cleared by the
//           deleted-key and uninstall loops.
//   CONFIG  binding.config[].boardColumn — a per-board capability knob
//           (tagging's image detail). A cost/quality dial like ai_votes, so any
//           board MANAGER may set it; not a pointer, so nothing dangles.
// Both are writable through updateBoard; only the pins are gated behind
// is_admin in the board payload (server.js).
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

// Every board column the app reads. Hand-written, so a new column is invisible
// until it is named here — which is how a feature evaporates into "it never
// writes anything" with a green suite. An array that joins, not a string, so
// NOT_DUPLICATED can subtract from it. (facet_diagnostics is read by the board
// modal and the diagnostics surface; boardsWithVotes selects it explicitly and
// does not rely on this list.)
//
// TODO(schema): drop boards.type — unread legacy (migration 0001_baseline),
// deliberately not selected here.
export const BOARD_COL_LIST = [
  "id", "name", "facets", "context", "ai_reasoning", "ai_research", "ai_votes",
  ...BOARD_BINDING_COLS,
  "auto_tag", "auto_tag_periodic", "auto_tag_every_min", "auto_tag_skip_weekends",
  "auto_tag_next_run_at", "mapping", "gather_every_min", "retag_on_refresh",
  "paused", "ingest", "ingest_next_run_at", "ingest_state", "facet_diagnostics",
  "created_at",
];
const BOARD_COLS = BOARD_COL_LIST.join(", ");

// The row a new board is born with — column-named, exactly as getBoard reads it
// back. The create route runs the shared content trunk against this object as
// its synthetic `prev`, so schedule arming and the votes/research exclusion are
// judged against the same baseline the INSERT below writes. The values live
// twice (here and in the INSERT's defaults) and a board-manage test pins this
// object against a freshly inserted row so the pair cannot drift.
export const NEW_BOARD_DEFAULTS = {
  facets: [], context: "", ai_reasoning: true, ai_research: false, ai_votes: 1,
  auto_tag: true, auto_tag_periodic: false, auto_tag_every_min: 1440,
  auto_tag_skip_weekends: false, auto_tag_next_run_at: null,
  mapping: null, retag_on_refresh: false, paused: false, ingest: null, ingest_next_run_at: null,
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

// What a COPY does not inherit. Everything else in BOARD_COL_LIST travels.
//
// A DENY-list on purpose: an allow-list would rot the way BOARD_COLS can — add
// a board setting, forget the second list, and duplication silently stops
// carrying it with the suite still green. Subtracting inverts the failure, so a
// new setting is copied by default. Each entry below needs a reason.
export const NOT_DUPLICATED = new Set([
  // the copy's own
  "id", "name", "created_at",
  // timers: the sweep arms them. An armed ingest timer on a copy would race the
  // original over one source, and its empty ingest_log means it re-admits
  // everything the original ever took, deletions included.
  "auto_tag_next_run_at", "ingest_next_run_at",
  // run status of a board that has not run
  "ingest_state",
  // measured against items the copy does not have
  "facet_diagnostics",
  // a copy starts unpaused
  "paused",
]);

// The statement text, built once: both the list and the deny-list are frozen at
// module load, so rebuilding this per call is pure repeated work.
const DUP_COLS = BOARD_COL_LIST.filter((c) => !NOT_DUPLICATED.has(c)).join(", ");
const COPY_BOARD_SQL =
  `INSERT INTO boards (id, name, created_at, ${DUP_COLS})
     SELECT $1, $2, $3, ${DUP_COLS} FROM boards WHERE id=$4`;

// Copy a board's CONFIGURATION to a new board — no items, no entities, no files,
// no history (planning/board-duplicate-plan.md). Returns { id, members }, or
// null when the source is gone. Not routed through the create route's validation
// trunk: a duplicate takes no user input, and the source row was validated when
// it was saved.
//
// pauseIngest is the CALLER's decision because "is this feed on a schedule" is
// ingestMode() (ingestion/index.js), which db.js cannot import — ingestion/
// files.js imports db.js, so the edge would close a cycle.
export async function duplicateBoard(db, srcId, name, { pauseIngest = false } = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  return withTx(db, async (client) => {
    const ins = await client.query(COPY_BOARD_SQL, [id, name, now, srcId]);
    if (ins.rowCount === 0) return null; // source gone between the read and here
    if (pauseIngest) {
      await client.query(
        "UPDATE boards SET ingest = jsonb_set(ingest, '{enabled}', 'false') WHERE id=$1",
        [id]
      );
    }
    // Membership, roles included — a board-admin on the original is one on the
    // copy. A raw statement rather than setBoardMembers, which opens its own
    // withTx (db.connect()) and so cannot nest inside this one; it lives beside
    // ADD_BOARD_MEMBER as COPY_BOARD_MEMBERS, with the other writers of this
    // row shape, so a column added to board_members is visibly a change to all
    // three.
    const mem = await client.query(COPY_BOARD_MEMBERS, [id, now, srcId]);
    return { id, members: mem.rowCount };
  });
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

export async function updateBoard(db, id, { name, facets, context, aiReasoning, aiResearch, aiVotes, autoTag, autoTagPeriodic, autoTagEveryMin, autoTagSkipWeekends, autoTagNextRunAt, mapping, retagOnRefresh, paused, ingest, ingestNextRunAt, boardBindings } = {}) {
  const sets = [];
  const vals = [];
  // Per-board capability columns as a { column: value } map — BOTH kinds (see
  // BOARD_PIN_COLS / BOARD_CONFIG_COLS above). The authority split is enforced
  // by which route builds the map; by the time it reaches here the two are
  // written the same way. Column names come from the registry via the route —
  // code, never input — and BOARD_BINDING_COLS is the allow-list that keeps
  // that true even for a caller that forgets.
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
  if (paused !== undefined) { vals.push(!!paused); sets.push(`paused=$${vals.length}`); }
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

// Does this instance have any board at all — one row, or none. Not a COUNT (the
// number is nobody's question) and not listBoards, which selects every column of
// every row. Its one reader is the first-run predicate (capability-resolve.js
// setupPending), where being cheap is the whole reason it exists.
export async function anyBoard(db) {
  const { rows } = await db.query("SELECT 1 FROM boards LIMIT 1");
  return rows.length > 0;
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
    // `p` is every QUEUED leg, not 'pending' alone: it drives the admin row's
    // "(N queued)" and its stop button's visibility, and a board whose whole
    // queue is pending_fetch (the bulk-add case cancel exists for) counted
    // zero — so the button the copy promises never rendered.
    `SELECT board_id, COUNT(*) AS c,
       COUNT(*) FILTER (WHERE status IN ('pending','pending_extract','pending_face','pending_fetch')) AS p,
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
// (name/w/h/kind). NOT the gallery's selectFace pick (that needs all of an
// entity's instances plus mapping.face) — a preview stack is impressionistic.
// Boards short of n top up with their newest entities' symbol tiles. Returns
// { boardId: entries[] } for every requested id.
//
// Top-n-per-board is a LATERAL, not a window over the whole table: paired with
// idx_items_board_created (0028) each board walks its own index slice and stops
// after n, so cost tracks the number of BOARDS, not the size of the library
// (~3ms flat, against ~19ms and growing for the window form). Both halves are
// needed — reading `payload` forces a heap visit per row, so the index alone
// would not let the window form terminate early.
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

// The ONE routing computation behind the three settled-item requeuers.
// retagBoard, releaseHeld and queueUntagged differ only in WHO they sweep — the
// WHERE each passes — never in where an item goes next or which held item adopts
// the board's mapping. Same $1=now, $2=boardId, $3=mapping in all three.
//
// The routing: an unfetched connector vehicle re-enters the FETCH leg (that arm
// must stay first); an unfaced vehicle the face leg; an already-extracted item
// goes straight to tagging (these requeuers re-JUDGE, they don't re-derive); an
// item with AI work still owed enters the extract leg; everything else tags. A
// held item with no stamp adopts the current board mapping. reprocessEntity is
// NOT a fourth caller — a full redo re-stamps unconditionally and skips the
// extracted_at shortcut, a different intent.
const requeueSettledSql = (where) => `
  UPDATE items
     SET payload = CASE WHEN status='held' AND NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = ${routingCase({
           fetch: UNFETCHED,
           face: STAMPED_CONNECTOR_FACE,
           shortCircuit: `payload ? 'extracted_at'`,
           extract: `(payload ? 'mapping') OR (status='held' AND $3::jsonb IS NOT NULL)`,
         })},
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
   WHERE board_id=$2 AND ${where}`;

// Queue a board's settled items for a fresh tagging pass (held ones included —
// retag is an explicit "tag now"). Returns the count. Only terminal states are
// touched: an item still in the pipeline already ends in the tag leg when its
// legs finish, so flipping it here would skip its definition legs and tag it
// with no fields, identity or face. Unstamped items stay tag-only, so retag
// never becomes a surprise extraction sweep.
export async function retagBoard(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    requeueSettledSql(`status IN ('tagged','failed','held')`),
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Re-tag a board on SOME of its facets (planning/facet-addressable-tagging-plan.md).
// The pass still asks the model about every facet; `tag_facets` says which
// answers may land, so the others keep what they have. Only settled, decided
// rows, and unlike retagBoard there is no status CASE: a facet retag must never
// become a re-extraction or a re-face — an item that never landed has no other
// facets to preserve, and a held/failed one needs its whole pass (retagBoard's job).
//
// `NOT undecided` is not redundant with status='tagged': an undecided item IS
// 'tagged' (the verdict rides its own column), so the status filter alone would
// sweep in exactly the items scoping cannot help — and the landing would leave
// an item flagged "could not place this" carrying a fresh AI tag, firing alerts
// that are recorded once and never retracted.
export async function retagBoardFacets(db, boardId, facetKeys) {
  const { rowCount } = await db.query(
    `UPDATE items SET status='pending', tag_facets=$3::text[],
       attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status='tagged' AND NOT undecided`,
    [Date.now(), boardId, facetKeys]
  );
  return rowCount;
}

// The per-instance and per-entity counterparts, for the lightbox and the card
// caret. Same settled-and-decided rule: picking an item by hand does not make
// a partial verdict any more coherent, and the routes turn the miss into a
// 409 rather than a silent no-op. The entity form takes whichever instances
// qualify (a card with one settled and one in-flight instance re-rolls the
// settled one) — null only when NONE do.
const retagFacetsSql = (scope) => `
  UPDATE items
     SET status='pending', tag_facets=$3::text[],
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
   WHERE ${scope} AND status='tagged' AND NOT undecided
   RETURNING entity_ids`;
// NOT REQUEUE_RESET: a scoped pass ARMS tag_facets, where every other verb
// clears it.

export async function retagItemFacets(db, id, facetKeys) {
  return touched(await db.query(retagFacetsSql(ITEM_SCOPE), [Date.now(), id, facetKeys]));
}

export async function retagEntityFacets(db, entityId, facetKeys) {
  return touched(await db.query(retagFacetsSql(ENTITY_SCOPE), [Date.now(), entityId, facetKeys]));
}

// --- periodic auto-tagging ---

// Release a board's held items — the held slice of the shared requeue
// routing. (The "already extracted → straight to tagging" arm matters most
// here: the extract leg runs even with auto-tag off and parks items back in
// held, so a release must not re-derive what that pass already produced.)
export async function releaseHeld(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    requeueSettledSql(`status = 'held'`),
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Queue everything untagged in a board: held uploads, AI-undecided items,
// and failed ones (fresh attempts). Fired when auto-tagging turns on — the
// point of the board is tags, so nothing untagged is left behind. In-flight
// ('processing') and human-tagged items are untouched.
export async function queueUntagged(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    requeueSettledSql(`status IN ('held','tagged','failed') AND tags='[]'::jsonb`),
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
     WHERE ${notPaused()} AND auto_tag AND auto_tag_periodic AND auto_tag_next_run_at IS NOT NULL AND auto_tag_next_run_at <= $1`,
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
// nulls it for a paused or manual board, the sweep re-arms it only when the
// schedule is live. `enabled` is NOT a predicate — that is what lets "Run now"
// fire a paused feed once without resuming its watch.
//
// boards.paused IS one, and the opposite call on purpose: the stamp has many
// writers, so null-on-pause would need each to learn about pause; one WHERE is
// the single choke point. Cost: "Run now" on a paused board arms and DEFERS —
// the run fires on resume rather than being confiscated.
//
// `excludeIds` is the boards already mid-run (queue-by-resource-plan.md Stage
// 6). The stamp only moves when a run SETTLES, so a board is still due for the
// whole length of its own run — and a caller that launches without awaiting
// would start a second run under the same fence. Soonest-due first, bounded,
// now that a tick takes a batch rather than everything.
export async function dueIngestBoards(db, now, limit = 20, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT ${BOARD_COLS} FROM boards
     WHERE ${notPaused()}
       AND ingest IS NOT NULL
       AND ingest_next_run_at IS NOT NULL AND ingest_next_run_at <= $1
       AND NOT (id = ANY($3::text[]))
     ORDER BY ingest_next_run_at ASC
     LIMIT $2`,
    [now, limit, excludeIds]
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

// --- the run fence (job-control-plan.md Stage 5) ---
//
// `ingest_next_run_at` IS a run's identity: dueIngestBoards claims a board at a
// value, so every continuation of that run is conditional on the value still
// being there. Whoever re-stamps it supersedes the run in flight — a cancel,
// "Run now", a save that changes the trigger. A feed run is the one PRODUCER in
// this file, so without the fence a cancel empties the consumer side while the
// drain refills it from the next tick.
//
// The pairing rule: everyone who re-stamps also settles the budget (dropped,
// cleared, restarted), because a superseded tick's settle dies and cannot
// subtract its own admissions from drain_left. NOT superseded, and unchanged by
// this: a filter-only save and a ledger clear both clear drain_left without
// re-stamping, so the tick in flight still writes it back.

// May this tick admit its next row? Asked BETWEEN admissions, so both answers
// land mid-batch instead of after it — one PK lookup against an admission that
// creates an entity, an item and a chart job.
//
// Two questions, answered together because a batch is the only place either is
// asked often enough to matter:
//   armed   is the run this tick claimed still the board's run (the fence)
//   paused  has the board been held since this tick started
// They part company at the SETTLE: a superseded run is over and drops its
// budget, where a paused one is HELD and must keep it — pause's contract is
// that the queue is intact and resumes. Without the pause half a 250-deep batch
// keeps importing for minutes after the button says stopped.
export async function ingestRunGate(db, boardId, fence) {
  const { rows } = await db.query(
    "SELECT (ingest_next_run_at = $2) AS armed, paused FROM boards WHERE id=$1",
    [boardId, fence]
  );
  return { armed: rows[0]?.armed === true, paused: rows[0]?.paused === true };
}

// The sweep's end-of-tick write, fenced: run state and the next stamp in ONE
// statement, so a superseded run cannot resurrect its own budget (the tick in
// flight would otherwise write drain_left back over the cancel that dropped
// it). One statement also settles the schedule and the error together, which
// the error path's two writes used to have to order by hand — last_error is
// what observers poll, so everything it implies must already be true when it
// lands. Returns false when the run was superseded and nothing was written.
export async function settleIngestRun(db, boardId, fence, { state, nextRunAt }) {
  const { rowCount } = await db.query(
    `UPDATE boards SET ingest_state=$1, ingest_next_run_at=$2
      WHERE id=$3 AND ingest_next_run_at=$4`,
    [state === null ? null : JSON.stringify(state), nextRunAt, boardId, fence]
  );
  return rowCount > 0;
}

// Stop the run in flight (the cancel verbs' producer half). Drops the budget —
// the unfinished portion of a run that is now over — and re-stamps, which
// breaks the fence above and stops the tick already running.
//
// `<= $3` distinguishes A RUN from A SCHEDULE: a board armed for tomorrow is
// not running, so a cancel leaves it alone and reports that it stopped nothing.
// `nextRunAt` is the next NATURAL run (null for manual), so stopping a run
// never disarms a live schedule. Returns { stopped, dropped }.
export async function stopIngestRun(db, boardId, nextRunAt, now = Date.now()) {
  const { rows } = await db.query(
    `WITH prev AS (SELECT id, (ingest_state->>'drain_left')::int AS drain FROM boards WHERE id=$1)
     UPDATE boards b
        SET ingest_state = b.ingest_state - 'drain_left' - 'last_error',
            ingest_next_run_at = $2
       FROM prev
      WHERE b.id = prev.id AND b.ingest_next_run_at IS NOT NULL AND b.ingest_next_run_at <= $3
     RETURNING COALESCE(prev.drain, 0) AS dropped`,
    [boardId, nextRunAt, now]
  );
  return { stopped: rows.length > 0, dropped: rows[0]?.dropped || 0 };
}

// Soft cancel — "Cancel queued" (job-control-plan.md Stage 2), the CONSUMER half
// of stopIngestRun above: that one stops the producer, this one empties what the
// producer already queued. Pulls every queued status out of the pipeline in one
// transaction; only rows a worker is actually holding are beyond it, and they run
// to their landings.
//
// The boundary is queue position, nothing else — NOT "has this pass started",
// because on a feed board every row queued to tag has by construction already run
// its fetch/extract/face legs, so a started-ness test protects the whole visible
// queue and cancels nothing. No money sits behind the earlier boundary either:
// every paid unit is in the TAG call, which a queued row has not made.
//
// One status-independent rule for every queued row:
//
//   tags present -> 'tagged'   the pre-queue settled state, restored
//   never-tagged -> 'held'     parked; the release routers re-enter a held row
//                              at the leg its payload shape names, which is why
//                              parking mid-prep strands nothing
//   unfetched pending_fetch -> DELETE, item + sole-home placeholder: no provider
//                              data ever landed, so what goes is a name-only
//                              shell. A FETCHED vehicle in that lane is a
//                              reprocess re-buying real data and pulls instead.
//
// tag_facets=NULL on the touched branches: the queued statuses are exactly the
// window a scoped pass waits in, so pulling an item out must not leave a scope
// armed for the next pass. The client's ghost-card sweep picks up the deletions.
//
// Returns { restored, parked, removed, finishing }. ABORT (Stage 3) is the same
// function with the in-flight halves added, so everything settles NOW: no call is
// cancelled, but the landing fences (markTagged/markExtracted/advanceFaced/
// advanceFetched all write WHERE status='<in-flight>') drop each result as it
// returns and the legs record `discarded` with the tokens spent. `discarding`
// counts those rows, pre-counted; `finishing` reads 0.
export async function cancelBoardQueue(db, boardId, { abort = false } = {}) {
  // Which statuses each branch touches — the rule and its drift guard live at
  // the top of this file, with the other IN_FLIGHT_FOR derivations.
  const pulls = cancelPulls(abort);
  const fetchLane = cancelFetchLane(abort);
  return withTx(db, async (client) => {
    const now = Date.now();
    // Abort's own count, taken BEFORE the flips: the rows a worker is holding
    // right now, whose calls will finish in the background and be discarded by
    // the landing fences. RETURNING can't see pre-update status, hence the
    // pre-count; a call that lands in this window settles normally and the
    // pull below catches its landed row — no gap, at most an overcount of one.
    // It CROSSCUTS `removed` rather than partitioning against it: a `fetching`
    // row is both in-flight here and deleted below.
    const discarding = abort
      ? Number((await client.query(
          `SELECT COUNT(*)::int AS c FROM items WHERE board_id=$1 AND status IN ${IN_FLIGHT_SQL}`,
          [boardId]
        )).rows[0].c)
      : 0;
    // UNFETCHED: only a vehicle whose provider data NEVER landed is a
    // name-only shell. A fetched vehicle in the fetch lane is a reprocess
    // re-buying its data (Stage 3a) — real fields, hearts, history — and it
    // pulls back below like every other leg's row instead of being deleted.
    const del = await client.query(
      `DELETE FROM items
       WHERE board_id=$1 AND status = ANY($2::text[]) AND ${UNFETCHED}
       RETURNING id, entity_ids`,
      [boardId, fetchLane]
    );
    // A cancelled queued FEED add is "don't re-add" — unledgered, the next
    // sweep tick would silently un-do this cancel. Stamped `deleted`, the
    // cancel holds and the bring-back surface can reverse it. Hand-browsed
    // adds have no ledger row; the stamp is a no-op for them.
    await stampIngestDeleted(client, boardId, del.rows.map((r) => r.id));
    // Sole-home placeholders go with their vehicles (no files exist pre-fetch,
    // so there is nothing to hand to sources.cleanup); an entity that somehow
    // has another instance keeps living and only lost this vehicle. A separate
    // statement, NOT a CTE sibling of the DELETE above: within one statement
    // the sibling's deletes are invisible to this NOT EXISTS snapshot, so every
    // entity would still look occupied and none would go.
    await deleteEmptyEntities(client, [...new Set(del.rows.flatMap((r) => r.entity_ids))]);
    // ONE statement for both landings — the branch IS the rule, so it can't be
    // read out of order. (Two statements worked only because the parked one ran
    // second, on what the restored one had already moved out of the status set;
    // nothing said so, and swapping them would have parked every restorable row.)
    // The second status list ($4, the fetch lane) catches the fetched
    // vehicles the delete arm's unfetched guard spared — they pull back with
    // everyone else, so the two statements stay exact per-row complements.
    const { rows: [pulled] } = await client.query(
      `WITH pulled AS (
         UPDATE items
            SET status = CASE WHEN tags != '[]'::jsonb THEN 'tagged' ELSE 'held' END,
                tag_facets=NULL, attempts=0, error=NULL, retry_at=NULL, updated_at=$1
          WHERE board_id=$2
            AND (status = ANY($3::text[])
                 OR (status = ANY($4::text[]) AND NOT ${UNFETCHED}))
          RETURNING status)
       SELECT COUNT(*) FILTER (WHERE status='tagged')::int AS restored,
              COUNT(*) FILTER (WHERE status='held')::int AS parked
         FROM pulled`,
      [now, boardId, pulls, fetchLane]
    );
    // What the cancel LEFT RUNNING: the in-flight rows it cannot reach. Not
    // derivable from the counts above — they report what was touched. Abort
    // skips the query rather than asking a question it has already answered:
    // its two statements cover IN_FLIGHT_STATES between them
    // (the fetch lane splits per-row on the unfetched flag), so it leaves
    // nothing behind by construction.
    const finishing = abort
      ? 0
      : (await boardTagActivity(client, boardId)).busy;
    return { restored: pulled.restored, parked: pulled.parked, removed: del.rowCount, finishing, discarding };
  });
}

// The dedup ledger: every source_key ever ledgered on this board, with what the
// sweep needs to judge it. Rows outlive their entities on purpose — deleting an
// item is a user judgment the feed must not overturn on the next scan.
// Map(key → { reason, size, modified }): `reason` drives the slot rule, and the
// size/mtime pair drives DRIFT — a known key whose recorded pair no longer
// matches the listing is a different file in a reused slot. Both null for
// connector rows and pre-stage-2 rows: nothing to compare means nothing drifts.
export async function ingestedKeys(db, boardId) {
  const { rows } = await db.query(
    "SELECT source_key, reason, file_size, modified_at FROM ingest_log WHERE board_id=$1", [boardId]);
  return new Map(rows.map((r) => [r.source_key, {
    reason: r.reason,
    size: r.file_size === null ? null : Number(r.file_size),
    modified: r.modified_at === null ? null : Number(r.modified_at),
  }]));
}

// Is this content already on the board? Asked of the ITEMS (payload
// provenance), not the ledger, so the answer survives a Forget-all — the
// by-content half of the self-heal as well as the rename check. Returns the
// live item's id, or null. Files only: nothing else carries provenance.
//
// `payload ? 'provenance'` is restated rather than implied: it is the partial
// index's predicate (0050), which Postgres cannot derive from the arrow
// expression below — without it this seq-scans `items` on every admission.
export async function itemByContentHash(db, boardId, hash) {
  if (!hash) return null;
  const { rows } = await db.query(
    `SELECT id FROM items
      WHERE board_id=$1 AND payload ? 'provenance'
        AND payload->'provenance'->>'hash' = $2 LIMIT 1`,
    [boardId, hash]
  );
  return rows[0]?.id ?? null;
}

// Did you delete this content? The `deleted` stamp is the only record left
// once the item is gone, so unlike the question above this one must ask the
// ledger. Returns the key it was deleted under (useful for the log), or null.
export async function deletedByContentHash(db, boardId, hash) {
  if (!hash) return null;
  const { rows } = await db.query(
    "SELECT source_key FROM ingest_log WHERE board_id=$1 AND content_hash=$2 AND reason='deleted' LIMIT 1",
    [boardId, hash]
  );
  return rows[0]?.source_key ?? null;
}

// What the board's memory holds, by reason — one GROUP BY behind the modal's
// three buttons (Forget all / Bring back N / Retry N), each of which hides at
// zero. LEDGER-WIDE on purpose, unlike the preview split's filter-scoped
// tallies: the actions these numbers label are ledger-wide too.
export async function ingestLedgerCounts(db, boardId) {
  const { rows } = await db.query(
    "SELECT reason, COUNT(*)::int AS n FROM ingest_log WHERE board_id=$1 GROUP BY reason", [boardId]);
  const by = Object.fromEntries(rows.map((r) => [r.reason, r.n]));
  return {
    total: rows.reduce((a, r) => a + r.n, 0),
    on_board: by.admitted ?? 0,
    held: by.deleted ?? 0,
    unprocessable: by.skipped ?? 0,
  };
}

// Forget ledger rows, so the next run treats those keys as never seen. ONE verb,
// three scopes (ingest-deletions-plan.md stage 4):
//   all       forget everything
//   deleted   "bring back" — the rows a user deletion stamped
//   skipped   "retry" — unprocessable bytes, worth another pass once the file
//             (or the handler that refused it) has changed
// Forgetting rather than flipping a row to `admitted`, which would claim the
// item is on the board AND keep its key out of `fresh`. Returns rows deleted.
//
// `keys` narrows the delete to a caller-supplied source-key set: the scoped
// verbs sit beside FILTER-SCOPED counts, so they must act on the window those
// counts were read off. The caller supplies keys, never reasons — the scope
// owns that mapping here, so no route learns the vocabulary.
const FORGET_SCOPES = { all: null, deleted: "deleted", skipped: "skipped" };
export const isForgetScope = (scope) => Object.hasOwn(FORGET_SCOPES, scope);
export async function clearIngestLog(db, boardId, scope = "all", keys = null) {
  const reason = FORGET_SCOPES[scope];
  const where = ["board_id=$1"];
  const params = [boardId];
  if (reason) where.push(`reason=$${params.push(reason)}`);
  if (keys) where.push(`source_key = ANY($${params.push(keys)}::text[])`);
  const { rowCount } = await db.query(`DELETE FROM ingest_log WHERE ${where.join(" AND ")}`, params);
  return rowCount;
}

// Accepts the pool or a tx client (the folder adapter ledgers inside the
// admit transaction). An UPSERT, not DO NOTHING, since stage 2: a re-admission
// of a brought-back key must flip its `deleted` stamp back to `admitted`, and
// created_at means "when last ledgered" (what history's time grouping wants).
// COALESCE on the link + provenance so a linkless write — the sweep's dup
// path, which often knows only the key — can never wipe facts a richer write
// already recorded.
export async function recordIngest(dbc, boardId, sourceKey, at,
  { reason = "admitted", itemId = null, hash = null, size = null, modifiedAt = null } = {}) {
  await dbc.query(
    `INSERT INTO ingest_log (board_id, source_key, created_at, reason, item_id, content_hash, file_size, modified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (board_id, source_key) DO UPDATE SET
       created_at = EXCLUDED.created_at,
       reason = EXCLUDED.reason,
       item_id = COALESCE(EXCLUDED.item_id, ingest_log.item_id),
       content_hash = COALESCE(EXCLUDED.content_hash, ingest_log.content_hash),
       file_size = COALESCE(EXCLUDED.file_size, ingest_log.file_size),
       modified_at = COALESCE(EXCLUDED.modified_at, ingest_log.modified_at)`,
    [boardId, sourceKey, at, reason, itemId, hash, size, modifiedAt]
  );
}

// The file adapter's self-heal probe: a LIVE item on this board already born
// from this source key (payload.provenance, stamped at admit — files only).
// What lets a post-clear scan recognize "already here" without the ledger.
//
// Returns { id, size, modified }, not just the id, because a path is only
// evidence when the SLOT hasn't changed — on a watch folder used as a spool the
// same name is reused for different files, so the caller compares these before
// trusting the match. Null when no item claims the key.
export async function itemBySourceKey(db, boardId, key) {
  const { rows } = await db.query(
    `SELECT id,
            (payload->'provenance'->>'size')::bigint     AS size,
            (payload->'provenance'->>'modified')::bigint AS modified
       FROM items
      WHERE board_id=$1 AND payload ? 'provenance'
        AND payload->'provenance'->>'key' = $2 LIMIT 1`,
    [boardId, key]
  );
  const r = rows[0];
  return r ? { id: r.id, size: r.size === null ? null : Number(r.size), modified: r.modified === null ? null : Number(r.modified) } : null;
}

// "Remember deletions" (ingest.rememberDeletions, default true) as a SQL
// predicate over the owning board. The toggle is FORWARD-looking, so it acts by
// stopping the stamp rather than by teaching the sweep to ignore one — the
// retroactive reading would be a mass re-import wearing a preference's clothes,
// and would make "off, but leave the backlog out" inexpressible. Absent config,
// absent key and a board with no ingest all read as true.
const REMEMBERS_DELETIONS =
  `COALESCE((SELECT (b.ingest->>'rememberDeletions')::boolean FROM boards b WHERE b.id = ingest_log.board_id), TRUE)`;

// Stamp the ledger rows of items being deleted `deleted` — rejection is
// RECORDED at the one moment intent is known, never inferred from absence
// (ingest-deletions-plan.md stage 2). Lives beside the three db-level
// deletion sites that call it, so no route can forget. Upload-born items
// have no ledger row; the UPDATE matching nothing is the correct no-op.
async function stampIngestDeleted(dbc, boardId, itemIds) {
  if (!itemIds.length) return;
  await dbc.query(
    `UPDATE ingest_log SET reason='deleted'
      WHERE board_id=$1 AND item_id = ANY($2::bigint[]) AND ${REMEMBERS_DELETIONS}`,
    [boardId, itemIds]
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

// The row shape every membership writer writes. Kept in one place so a column
// added here can't reach one writer and miss the others — the two functions
// below stay separate (their DELETE scopes are the point), but they insert the
// same row.
const ADD_BOARD_MEMBER =
  "INSERT INTO board_members (board_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING";

// The third writer: duplicateBoard, carrying a board's whole membership to its
// copy. Set-based rather than row-by-row, so it cannot reuse the VALUES
// statement above — but it lives here so the column tuple is maintained in one
// place with the others, and `role` travels verbatim rather than being taken
// apart into setBoardMembers' (userIds, adminIds) and rebuilt.
const COPY_BOARD_MEMBERS =
  `INSERT INTO board_members (board_id, user_id, role, created_at)
     SELECT $1, user_id, role, $2 FROM board_members WHERE board_id=$3`;

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
// every board. The DELETE is scoped to that user, so the two editors write
// disjoint sets of rows and can't clobber each other's people. adminBoardIds
// take role='admin', and only where the user is also a member: an admin grant on
// a board they can't see is dropped rather than stored as a manage right with no
// access behind it.
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

// Several settings in ONE round trip, as a { key: value } object with missing
// keys absent. Reading a handful one at a time is the shape that got the MCP
// endpoint to seven queries per thumbnail — and a grid renders thirty of them
// against a five-connection pool. Promise.all makes those concurrent, not free.
export async function getSettings(db, keys) {
  const { rows } = await db.query("SELECT key, value FROM settings WHERE key = ANY($1::text[])", [keys]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
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

// Record an install or an update. `manifest` is stored verbatim; a successful
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
// disk (the dir is unchanged) and the card shows the reason; its Retry fetches
// the plugin again from the stored source. `error` is coerced to the same
// structured shape the health ledger uses.
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

// Board-fair batch claim (worker-rework Stage 2) — the queue's one claim path;
// claimNextWork below is its LIMIT-1 wrapper.
//
// Atomically takes the oldest ready items — whatever stage each is in — and marks
// them with that stage's in-flight status. ONE queue, one policy: oldest work
// first (created_at, id), so an item flows extract → face → tag to completion
// before newer items start, re-entering the queue with its original created_at.
// No per-stage legs to starve. The returned row's status ('extracting' |
// 'facing' | 'processing') tells the worker which step to run.
//
// SKIP LOCKED keeps concurrent claimers off the same row. With no default key,
// boards without their own key are skipped for the AI stages — queued until a key
// appears, never failed for a missing key — while faces and fetches still claim
// (rendering a chart and pulling provider data are data steps, no model call).
// Rows whose retry_at is still in the future are skipped; every requeue path
// wanting an immediate run clears it. A paused board is skipped for ALL four
// stages (notPaused, top of file).
//
// `stages` is the set of pending statuses the caller accepts — the dispatcher
// passes only the stages whose lane has a free slot, so a full sidecar lane
// doesn't stop tag work being claimed. Default = all four.
//
// `excludeBoards` is the per-resource hold-back (queue-by-resource-plan.md
// Stage 2): boards whose API key or connector currently has no free slot in the
// concurrency pool. Deliberately a DENY-list, never an allow-list — the two
// questions "can this run at all" and "what does it contend for" do not
// collapse. The first is the clause above (a tag item with no key anywhere
// waits); the second is this one. A face item on a board with no connector
// resolves to NO resource and must still claim — it renders nothing and
// advances, which is real work that completes. An allow-list built from
// resolvable resources would strand it forever, so anything unresolvable is
// simply left unconstrained.
//
// `onlyBoards` (Stage 3a) is the OTHER list, for the other step of the
// dispatcher's tick: once a resource's boards are known, a claim sized to
// exactly that resource's free slots, restricted to those boards. Both lists
// are honest because they answer different steps — the allow-list sizes a claim
// to a key that has room; the deny-list keeps saturated keys out of the
// catch-all that discovers boards nobody has seen yet. NULL = no restriction,
// so every existing caller is unchanged.
//
// The ranking: each board's ready items ranked by age, then rank 0 of every board
// served before rank 1 — a small board interleaves ahead of a large board's
// backlog. Holds while active boards ≤ the batch size, plain FIFO beyond. ONE
// snapshot of `limit` rows: single-row claims would collapse to FIFO (removing a
// head promotes the same board's next item). The window function forbids FOR
// UPDATE, so the pick (ranked, unlocked) and the lock (by id, SKIP LOCKED) are
// separate CTEs feeding the UPDATE.
export async function claimFairBatch(db, hasDefaultKey = true, stages = Object.keys(IN_FLIGHT_FOR), limit = 1, excludeBoards = [], onlyBoards = null) {
  const now = Date.now();
  const { rows } = await db.query(
    `WITH ready AS (
       SELECT i.id, i.created_at,
              row_number() OVER (PARTITION BY i.board_id ORDER BY i.created_at, i.id) AS board_rank
       FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.status = ANY($3::text[])
         AND ${notPaused("b")}
         AND (i.status IN ('pending_face', 'pending_fetch') OR b.ai_key_id IS NOT NULL OR $2)
         AND (i.retry_at IS NULL OR i.retry_at <= $1)
         AND NOT (i.board_id = ANY($5::text[]))
         AND ($6::text[] IS NULL OR i.board_id = ANY($6::text[]))
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
    [now, hasDefaultKey, stages, limit, excludeBoards, onlyBoards]
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
// `park`: definition done, they return to held instead of flowing into tagging.
// Explicit runs carry no park and go all the way. The board is re-checked so a
// mid-flight auto-tag flip beats a stale park. extracted_at records that the
// extract leg ran, so a later release routes to the tag leg rather than paying
// for a second extraction. Value-fenced like markTagged: lands only while still
// 'extracting'.
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
// moves on to whichever leg the board wants next (the caller computes toStatus
// from a fresh board read). Clears the 'unfetched' routing stamp — park is NOT
// consumed here, the face leg and the held-park rule read it later — and folds
// the true provider source into the payload in the SAME fenced statement,
// because updateItemPayload has no fence and a stale fetch must not splat
// provider data over a re-routed row. Lands only while still 'fetching'.
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

// Put an entity back to the upload shell — keyed by the stored filename, no
// display name, no symbol — keeping its id (hearts and crate places survive).
// The extract leg's no-card branch resets a sole card this way so a
// one-card-per-file board looks like one uniformly (card-key-plan.md Stage 5).
// Throws 23505 only if another entity already holds that filename as its key,
// which the stored names' uniqueness rules out.
export async function resetEntityToShell(db, id, fileName) {
  await db.query(
    `UPDATE entities
     SET identity=$1, display_name=NULL, symbol=NULL, identity_provisional=FALSE, updated_at=$2
     WHERE id=$3`,
    [fileName, Date.now(), id]
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
  await touchEntities(db, [id]);
}

// The same stamp for a set of them, in ONE statement. save_to_crate takes up
// to 100 ids at a time, and a stamp each was measured at 280ms against 7.4ms
// for one — 100 sequential round trips for a single UPDATE's worth of work.
export async function touchEntities(db, ids) {
  if (!ids.length) return;
  await db.query("UPDATE entities SET updated_at=$1 WHERE id = ANY($2::bigint[])", [Date.now(), ids]);
}

// Set an instance's entity membership — the ordered set of entities it belongs
// to (entity_ids[0] is canonical for logging/faces/search). Merge and split are
// not special moves here — both are just "the array changed". Length 1 is the
// extract-mode norm; length N is classify.
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
  return (await deleteEmptyEntities(db, [entityId])) > 0;
}

// Its set form, and where the "an entity nothing points at anymore" predicate
// actually lives — entity_ids carries no FK cascade, so this test is the only
// thing standing between a removed instance and an orphaned card. One
// statement rather than deleteEntityIfEmpty in a loop, because the bulk
// callers (a cancelled 300-item add) would otherwise issue 300 of them.
// reapEmptyEntities keeps its own age-scanned variant: that one sweeps rows
// nobody named, this one answers for ids the caller just orphaned.
export async function deleteEmptyEntities(db, entityIds) {
  const ids = [...new Set(entityIds)].filter((id) => id != null);
  if (!ids.length) return 0;
  const result = await db.query(
    `DELETE FROM entities e
      WHERE e.id = ANY($1::bigint[])
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.entity_ids @> ARRAY[e.id]::bigint[])`,
    [ids]
  );
  return result.rowCount;
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
// and deleteEntity clean up inline — but entity_ids carries no FK cascade, so a
// crash between the membership write and its reconcile can strand one, and it
// renders as a blank card with nothing to remove it. The age floor is
// load-bearing: upload creates the entity and its instance in two statements, so
// a freshly empty entity is an in-flight upload, not a ghost.
export async function reapEmptyEntities(db, olderThanMs) {
  const { rowCount } = await db.query(
    `DELETE FROM entities e
      WHERE e.updated_at < $1
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.entity_ids @> ARRAY[e.id]::bigint[])`,
    [Date.now() - olderThanMs]
  );
  return rowCount;
}

// Delete an entity and the instances it's the SOLE home of; instances shared with
// another entity survive, losing this id from their array. Returns the orphaned
// instances' file entries so the caller can clean the stores. The row is locked
// FOR UPDATE before the orphan read so two concurrent deletes serialize instead
// of both double-returning its files. entity_ids carries no FK cascade, so an
// extraction resolving here can still append its id right after the scrub —
// reapEmptyEntities backstops that.
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
    // The orphans are the items this delete actually removes — the shared
    // instances scrubbed above survive, so they are correctly NOT stamped.
    await stampIngestDeleted(client, rows[0].board_id, orphans.map((o) => o.id));
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
          touch AS (UPDATE entities SET updated_at=$2 WHERE id IN (SELECT unnest(entity_ids) FROM del)),
          stamp AS (UPDATE ingest_log SET reason='deleted'
                    WHERE item_id=$1 AND board_id IN (SELECT board_id FROM del)
                      AND ${REMEMBERS_DELETIONS})
     SELECT payload, entity_ids, board_id FROM del`,
    [id, Date.now()]
  );
  return rows[0] || null;
}

// --- connector liveness (slice 5c) ---

// Entities due for a live-field or face refresh: refresh_at set and reached.
// Each rides with its connector instance — matched by `payload ? 'source'` (the
// tag vehicle's marker; NOT file-count, since a generated face gives it a file)
// — and its board. Soonest-due first, bounded per sweep. `excludeIds` is the
// entities already mid-refresh: refresh_at only moves when the refresh LANDS,
// so a second tick would otherwise hand the same entity out again
// (queue-by-resource-plan.md Stage 5).
export async function dueLiveEntities(db, now, limit = 20, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT e.id AS e_id, e.identity, e.symbol, e.fields, e.refresh_at, e.face_at,
            i.id AS i_id, i.payload AS i_payload,
            b.id AS b_id, b.mapping AS b_mapping, b.retag_on_refresh, b.auto_tag
     FROM entities e
     JOIN items i ON i.entity_ids @> ARRAY[e.id]::bigint[] AND i.payload ? 'source'
     JOIN boards b ON b.id = e.board_id
     WHERE ${notPaused("b")} AND e.refresh_at IS NOT NULL AND e.refresh_at <= $1
       AND NOT (e.id = ANY($3::bigint[]))
     ORDER BY e.refresh_at ASC
     LIMIT $2`,
    [now, limit, excludeIds]
  );
  return rows.map((r) => ({
    entity: { id: r.e_id, identity: r.identity, symbol: r.symbol, fields: r.fields, refresh_at: r.refresh_at, face_at: r.face_at },
    inst: { id: r.i_id, payload: r.i_payload },
    board: { id: r.b_id, mapping: r.b_mapping, retag_on_refresh: r.retag_on_refresh, auto_tag: r.auto_tag },
  }));
}

// Land a fetch leg's provider answer on an enqueued entity in ONE statement:
// fields, the (possibly corrected) identity/display_name/symbol, and the first
// liveness due time. One statement on purpose — composing setEntityIdentity +
// updateEntityFields would strand a real identity with empty fields if the
// process died between them, and setEntityIdentity also force-clears
// identity_provisional, which this path doesn't want. Throws 23505 when the
// corrected identity collides with one already on the board; the caller fails
// the item as a late duplicate.
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

// The ledger's cardinal rule, as a function: a job-log write must never break
// the job it observes. Lives here, beside the writers it guards, because that
// is where the rule is documented and because every writer needs it — the
// worker's legs and sweeps, and the routes that cancel. `label` names the
// caller in the warning, since a bare "job log write failed" in a shared log
// says nothing about which ledger row was lost.
export async function jobLogWrite(fn, label = "") {
  try {
    return await fn();
  } catch (e) {
    console.warn(`job log write failed${label ? ` (${label})` : ""}: ${e.message}`);
    return null;
  }
}

// One lane job's lifecycle, owned in one place: open a `running` row, settle it
// exactly once. Both writes ride jobLogWrite (the cardinal rule above). If the
// OPEN was lost (id null), settle degrades to writing a settled row outright.
// `settle` is idempotent, so a caller's own outcome paths and its catch-all
// backstop can each call it and only the first writes — which is what makes "a
// dangling running row reads as work-in-flight until a restart reaps it" a
// guarantee of the helper rather than something every lane re-argues. `id` stays
// visible for callers that retract instead of stamping (deleteJobLog).
export async function openJob(db, fields) {
  const jobId = await jobLogWrite(() => addJobLog(db, fields), `${fields.kind} start`);
  let settled = false;
  return {
    id: jobId,
    // Publish progress onto the row while it runs. A job whose work is one
    // long pass — a feed run admitting hundreds — is otherwise a word
    // ("running") and a clock, which tells a watcher nothing about how much is
    // left or whether stopping it is worth it. Merged into detail like the
    // settle's, never-throw like the rest of the ledger, and a no-op once
    // settled so a late tick can't un-finish a row.
    progress: (detail) =>
      settled || jobId == null
        ? null
        : jobLogWrite(() => progressJobLog(db, jobId, detail), `${fields.kind} progress`),
    settle: (outcome) => {
      if (settled) return null;
      settled = true;
      return jobLogWrite(() => (jobId != null
        ? stampJobLog(db, jobId, outcome)
        : addJobLog(db, { ...fields, endedAt: Date.now(), ...outcome })),
      `${fields.kind} settle`);
    },
  };
}

// Progress on a row that is still running: detail merges, and the outcome
// fence means a settled row is never reopened.
export async function progressJobLog(db, id, detail) {
  await db.query(
    "UPDATE job_log SET detail = detail || $2 WHERE id=$1 AND outcome='running'",
    [id, JSON.stringify(detail || {})]
  );
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
// display, and it takes the display NAME alone: a card has a name of its own
// exactly when it has one, and the row's `target` (the frozen original
// filename) is what names the instance beside it — the client composes the two
// (instance-work-plan.md F3). Never `identity`: on a raw board that is the
// stored hex name, which is why this join used to need a fallback chain.
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
    `SELECT j.*, e.display_name AS entity_display
       FROM job_log j LEFT JOIN entities e ON e.id = j.entity_id
      WHERE ${cond.join(" AND ")}
      ORDER BY j.started_at DESC, j.id DESC LIMIT $${args.length}`,
    args
  );
  const last = rows[rows.length - 1];
  return { jobs: rows, nextCursor: rows.length === limit ? `${last.started_at}_${last.id}` : null };
}

// Served by idx_job_log_running, the partial index cut for exactly this
// predicate (migration 0053): every work read runs this — the delta poll per
// open tab, the signals tick, the jobs page, every per-card click — and
// without it the whole ledger was scanned to find a handful of transient rows.
// Exported as a string so its test pins the plan against the app's own SQL
// rather than a copy of it, the arrangement LATEST_JOB_FAILURE_SQL already has.
export const RUNNING_JOBS_SQL = `SELECT j.*, e.display_name AS entity_display
       FROM job_log j LEFT JOIN entities e ON e.id = j.entity_id
      WHERE j.board_id=$1 AND j.outcome='running'
      ORDER BY j.started_at ASC`;

export async function listRunningJobs(db, boardId) {
  const { rows } = await db.query(RUNNING_JOBS_SQL, [boardId]);
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

// The newest FAILED row's stamp — the jobs chip's attention dot, compared by the
// client against its own "last looked" watermark (public/seen-mark.js).
//
// `failed` ALONE, the other three non-ok outcomes excluded on purpose:
// `requeued` is the pipeline retrying, `discarded` is a stale result the fence
// dropped, and `interrupted` is a restart — which would put a dot on every
// header after each deploy. A signal that lights for self-healing states is one
// people learn to ignore.
//
// Keyed on started_at, the history list's ORDER BY too, so the dot and the row
// it sends you to agree about which failure is newest and a FOLDED repeat counts
// as no news. Cost: a job started before your last look that fails after it
// waits for the next distinct failure.
//
// Exported as one string so the plan test and the app run the same query — 0032
// cuts a partial index for this exact shape, and a divergent copy in the test
// would pass while a sequential scan here returned the right answer, slowly.
export const LATEST_JOB_FAILURE_SQL =
  "SELECT started_at FROM job_log WHERE board_id=$1 AND outcome='failed' ORDER BY started_at DESC LIMIT 1";

export async function latestJobFailureAt(db, boardId) {
  const { rows } = await db.query(LATEST_JOB_FAILURE_SQL, [boardId]);
  return rows[0]?.started_at ?? null;
}

// The same question across a set of boards, for the index's dots
// (boards-signals-plan.md). LATERAL over unnest rather than `board_id = ANY(...)
// GROUP BY board_id`: the aggregate form reaches every failed row of every board
// to take a MAX, while this walks each board's slice of idx_job_log_failed and
// stops at the first — the shape boardPreviewFaces uses, and why 0032 exists.
// CROSS JOIN, so a board with no failures returns no row and the caller's
// default stands, keeping the payload proportional to the news.
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
// (a field added/removed, turned live/idle, a cadence moved, the face turned
// on). `wanted` = the mapping's connector fields [{ key, every? }] — an entity
// missing one is stamped due-now (schedule.js's absent-key term), which is how
// a field added to the mapping backfills onto existing entities via the sweep;
// `faceSched` = the face's schedule from connectors/schedule.js ({ every }
// live / { first: true } one-shot / null none). Empty/null both clear that term.
export async function rescheduleEntityRefreshes(db, boardId, wanted, faceSched = null, now = Date.now()) {
  // No wanted fields and no face to render → every entity's next refresh is null.
  // Clear the whole board in one statement instead of a write per entity. This is
  // the common case on a file board, where no field can be wanted — so the mapping
  // save that used to fan out N no-op writes now does a single targeted one.
  if (!wanted.length && !faceSched) {
    await db.query("UPDATE entities SET refresh_at=NULL WHERE board_id=$1 AND refresh_at IS NOT NULL", [boardId]);
    return;
  }
  const { rows } = await db.query("SELECT id, fields, face_at FROM entities WHERE board_id=$1", [boardId]);
  const sched = [];
  for (const e of rows) {
    let next = nextRefreshAt(e.fields, wanted, now);
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

// Strip every entity on a board to the given field keys — the connector arm of
// the mapping-save reconcile (field-reconcile.js). The strip rule's ONE live
// encoding: keep mapped keys as stored, add nothing — absence is what makes
// the scheduler buy a newly-mapped key (migration 0045 carries a frozen copy,
// by migration policy). One statement; rows already inside the key set are
// left untouched (updated_at included — the WHERE is what keeps a no-op save
// from marking every entity changed to delta pollers).
export async function stripBoardEntityFields(db, boardId, keys, now = Date.now()) {
  await db.query(
    `UPDATE entities SET
       fields = COALESCE(
         (SELECT jsonb_object_agg(key, value) FROM jsonb_each(fields) WHERE key = ANY($2::text[])),
         '{}'::jsonb),
       updated_at = $3
     WHERE board_id = $1
       AND EXISTS (SELECT 1 FROM jsonb_each(fields) WHERE NOT key = ANY($2::text[]))`,
    [boardId, keys, now]
  );
}

// Resume's companion write (job-control-plan.md Stage 1): a board paused for
// days holds the oldest refresh_at in the system, and dueLiveEntities serves
// soonest-due first with no board fairness — so a resumed board would monopolize
// the refresh sweep for its whole drain. Stamping overdue rows to `now` costs
// nothing semantically (the entity is due either way, and nextRefreshAt
// recomputes from the fresh landing) and dissolves the head-of-line queue.
export async function floorOverdueRefreshes(db, boardId, now = Date.now()) {
  await db.query(
    "UPDATE entities SET refresh_at=$1 WHERE board_id=$2 AND refresh_at IS NOT NULL AND refresh_at < $1",
    [now, boardId]
  );
}

// Re-run the full pipeline for every instance of an entity (the card-level
// "reprocess"). User-initiated, so the CURRENT board mapping is re-stamped and
// applied — a mapping edited after upload, or added to a board that had none,
// takes effect here. Connector vehicles restart at the FETCH leg: a full redo
// re-buys the provider data and the fetch landing routes them onward, so fresh
// fields feed a fresh chart feed fresh tags. Other instances restart at the
// extract leg when there is AI work, else at tagging. Returns the touched rows'
// entity ids, or null when the entity is gone.
//
// Tags are cleared up front so the card shows a clean reprocessing state. The
// face arm still exists for the no-vehicle edge (a chart face in the applying
// mapping on a non-connector item); a vehicle is zero-files or generated-file,
// never a user upload.
//
// `- 'park'`: an explicit reprocess runs the full pipeline through tagging,
// even on an auto-tag-off board — park only gates the automatic ingest flow.
// `- 'transcript_error'`: a reprocess retries a failed transcription. A
// successful `transcript` is KEPT — same bytes in, same text out, so redoing
// it only re-bills — unless the engine that would transcribe today ($4, null
// when unknown) differs from the stamp the transcript carries: a different
// engine can genuinely answer differently, so the trio drops and the
// absence-keyed lane re-transcribes. Unstamped legacy transcripts and a null
// $4 never drop — no surprise re-billing.
// Shared by the entity and board forms of reprocess: the SET clause is one
// text, the scope is the caller's ($2), like reextractSql/retagSql above.
const REPROCESS_STRIPPED = `(CASE WHEN $4::text IS NOT NULL AND payload ? 'transcript_engine'
                             AND payload->>'transcript_engine' <> $4::text
                          THEN payload - 'transcript' - 'transcript_turns' - 'transcript_engine'
                          ELSE payload END) - 'park' - 'transcript_error'`;
const reprocessSql = (scope) => `UPDATE items
     SET payload = ${restamped(REPROCESS_STRIPPED)},
         status = ${routingCase({
           fetch: CONNECTOR_VEHICLE,
           face: `${APPLYING_MAPPING}->'face'->>'source' = 'connector'
                AND (jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0
                     OR payload->'files'->0->>'generated' = 'true')`,
           extract: `$3::jsonb IS NOT NULL OR payload ? 'mapping'`,
         })},
         ${CLEARED_VERDICT}, ${REQUEUE_RESET}
     WHERE ${scope}
     RETURNING entity_ids`;

export async function reprocessEntity(db, entityId, currentEngine = null) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM entities e JOIN boards b ON b.id = e.board_id WHERE e.id=$1", [entityId]);
  if (!rows.length) return null;
  return touched(await db.query(reprocessSql(ENTITY_SCOPE),
    [Date.now(), entityId, aiMappingJson(rows[0].mapping), currentEngine]));
}

// The board form (card-key-plan.md Stage 5): every instance on the board
// re-enters the pipeline — what the pane's "cards were generated from the
// old key" reminder offers. Same statement, board scope; returns the row
// count (a whole board's routed report would be the listing itself).
export async function reprocessBoard(db, boardId, currentEngine = null) {
  const { rows } = await db.query("SELECT mapping FROM boards WHERE id=$1", [boardId]);
  if (!rows.length) return null;
  const result = await db.query(reprocessSql(`board_id=$2`),
    [Date.now(), boardId, aiMappingJson(rows[0].mapping), currentEngine]);
  return result.rowCount;
}

// Value-fenced (`AND status='processing'`): the stamp lands only while the row is
// still this claim's in-flight status. A per-card route that re-routed the row
// mid-call wins — the stale result is discarded (returns false) and the snapshot
// skipped, so history never records a judgment that was never current. A row
// deleted mid-call discards the same way instead of FK-erroring. Sound
// single-process because a stale stamp always executes before any re-claim;
// across processes a value fence is NOT ownership (worker-queue audit, hole #7).
//
// `confidence` is the per-facet vote agreement; {} on a single-pass board means
// NOT MEASURED, never zero — readers must distinguish those.
//
// `scoped` says this pass only spoke for some of the item's facets (0030). Two
// consequences, and they must move together:
//   - `undecided` is NOT written. The verdict is a whole-item judgment a scoped
//     pass did not make; undecided while eight facets keep their tags is incoherent.
//   - the caller must pass the item's EXISTING flag, because addTagSnapshot
//     dedupes on it. A verdict that was never stored makes that test fiction.
export async function markTagged(db, id, tags, undecided = false, reasoning = {}, confidence = {}, scoped = false) {
  // Clearing the vector marks the item for the embedding sweep — the text it
  // was embedded from just changed.
  // tag_facets=NULL on EVERY landing, scoped or not: the scope is consumed here,
  // and a stale one would narrow the next pass.
  const vals = [JSON.stringify(tags), JSON.stringify(reasoning || {}), JSON.stringify(confidence || {}), Date.now()];
  const sets = [
    "status='tagged'", "tags=$1", "tag_reasoning=$2", "tag_confidence=$3",
    "tag_facets=NULL", "error=NULL", "retry_at=NULL",
    CLEAR_EMBEDDING, "updated_at=$4",
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

// The two lane-need predicates, shared between each lane's claim query and
// its backlog count (boardLaneQueues) so the two can never drift: what the
// lane will claim is exactly what the wire reports as waiting
// (first-class-work-plan.md). Both speak alias `i`; the embed one takes its
// model's placeholder index because the two users bind it at different
// positions.
const NEEDS_TRANSCRIPT_SQL = `i.payload->'files'->0->>'kind'='audio'
       AND NOT (i.payload ? 'transcript')
       AND NOT (i.payload ? 'transcript_error')`;
const needsEmbeddingSql = (p) => `i.embed_error IS NULL
       AND (i.embedding IS NULL OR i.embedding_model IS DISTINCT FROM $${p})
       AND (i.status='tagged'
            OR (i.payload->'files'->0->>'kind'='audio' AND i.payload ? 'transcript'))`;

// Each backlog lane's need-predicate, keyed by its job kind. The extra
// binding a lane's predicate consumes starts at $4 — $1-$3 are the shared
// frame below (board, in-flight statuses, excluded ids).
const LANE_NEED = {
  transcribe: { sql: NEEDS_TRANSCRIPT_SQL, args: () => [] },
  embed: { sql: needsEmbeddingSql(4), args: (lane) => [lane.model] },
};

// The lane backlogs item statuses can't see — the wire's `queued` half, one
// count per lane kind. The caller names which lanes are served (worker.js
// servedBacklogLanes): a backlog nothing will ever claim is a configuration
// gap, not work in progress. Excludes in-flight statuses and the ids running
// rows carry, so one unit of work is counted once.
// No pause gate: a paused board's backlog is intact, and "waiting" stays true.
export async function boardLaneQueues(db, boardId, lanes, excludeIds = []) {
  const counts = await Promise.all(lanes.map(async (lane) => {
    const need = LANE_NEED[lane.kind];
    if (!need) return null;
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM items i
       WHERE i.board_id=$1
         AND NOT (i.status = ANY($2::text[]))
         AND NOT (i.id = ANY($3::bigint[]))
         AND ${need.sql}`,
      [boardId, IN_FLIGHT_STATES, excludeIds, ...need.args(lane)]
    );
    return { kind: lane.kind, n: Number(rows[0].n) };
  }));
  return counts.filter((c) => c && c.n > 0);
}

// The pipeline legs as the wire's two halves (planning/instance-work-plan.md):
// every claimed instance is a `running` row wearing its leg's job kind and
// the file it is working on; every waiting one is a count under its leg.
// DERIVED from items.status at read time — the legs still write no `running`
// job_log rows (the ledger's rule) — and bounded by what the worker claims.
//
// Same exclusion frame as boardLaneQueues, and it is load-bearing here:
// `excludeIds` is the running job rows' items, and the tag/extract legs
// CLAIM an audio row before finding its transcript missing, so for a moment
// one clip is both a claimed row and the transcribe lane's running row. One
// unit of work, one record. No pause gate, like the lanes: a paused board's
// queue is intact and "waiting" stays true. `started_at` is the claim stamp
// — claimFairBatch writes updated_at, and nothing else touches a claimed row
// until it lands.
export async function pipelineWork(db, boardId, excludeIds = []) {
  const [{ rows: active }, { rows: waiting }] = await Promise.all([
    db.query(
      `SELECT i.id, i.entity_ids, i.status, i.updated_at,
              COALESCE(i.payload->'files'->0->>'original_name', i.payload->>'identity') AS target,
              e.display_name AS entity_display
         FROM items i LEFT JOIN entities e ON e.id = i.entity_ids[1]
        WHERE i.board_id=$1 AND i.status = ANY($2::text[]) AND NOT (i.id = ANY($3::bigint[]))
        ORDER BY i.updated_at ASC, i.id ASC`,
      [boardId, Object.keys(ACTIVE_KIND), excludeIds]
    ),
    db.query(
      `SELECT status, COUNT(*)::int AS n FROM items
        WHERE board_id=$1 AND status = ANY($2::text[]) AND NOT (id = ANY($3::bigint[]))
        GROUP BY status`,
      [boardId, Object.keys(LEG_KIND), excludeIds]
    ),
  ]);
  const byWait = new Map(waiting.map((r) => [r.status, r.n]));
  return {
    running: active.map((r) => ({
      id: null, kind: ACTIVE_KIND[r.status], item_id: r.id,
      entity_id: r.entity_ids?.[0] ?? null, target: r.target,
      entity_display: r.entity_display, started_at: r.updated_at,
    })),
    queued: Object.entries(LEG_KIND).flatMap(([wait, kind]) =>
      byWait.has(wait) ? [{ kind, n: byWait.get(wait) }] : []),
  };
}

// The embedding sweep's work queue: items whose vector is missing or from
// another model. Two sources become searchable — tagged items (embedded from
// their tags + reasoning) and transcribed audio (embedded from its transcript,
// even when the board doesn't tag). Newest first so fresh uploads become
// searchable before a long backfill finishes; items the embedder rejected
// (embed_error) are skipped until they get fresh text.
//
// `excludeIds` is the rows already being embedded. A row stops qualifying only
// when its vector lands, so without this a second tick would re-read rows the
// first one is still mid-call on and pay for them twice. The sweep this was
// written for ran one batch at a time and awaited it, which is why it could get
// away with asking the same question twice (queue-by-resource-plan.md Stage 4b).
export async function itemsNeedingEmbedding(db, model, limit, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT i.id, i.board_id, i.entity_ids, i.tags, i.tag_reasoning, i.payload FROM items i
     JOIN boards b ON b.id = i.board_id
     WHERE ${notPaused("b")}
       AND ${needsEmbeddingSql(1)}
       AND NOT (i.id = ANY($3::bigint[]))
     ORDER BY i.updated_at DESC, i.id DESC LIMIT $2`,
    [model, limit, excludeIds]
  );
  return rows;
}

// Audio items still needing a transcript — the transcription kind's work queue.
// Independent of tagging and status: any audio item with neither a `transcript`
// nor a permanent `transcript_error` qualifies, newest first.
//
// A BATCH, not the one newest clip (queue-by-resource-plan.md Stage 3c). The
// caller groups what comes back by the ENGINE each clip's board would use and
// launches what each engine has room for — so a whisper clip waiting on a busy
// sidecar cannot stand in front of a clip whose board pins a cloud transcriber.
// `LIMIT 1` made that head-of-line block structural: the newest clip was the
// only one anybody ever looked at.
// `payload ? 'key'` is the jsonb key-exists test, so an empty-string transcript
// for a silent clip still counts. excludeIds skips clips in the worker's
// in-memory retry backoff so one failing clip can't block the lane.
//
// `served` is the claim gate (sidecar-presence-plan.md): when nothing can serve
// the lane app-wide, only boards carrying their own pin qualify, filtered in SQL
// so unservable clips are never claimed. A pin OF the absent built-in cannot
// serve, so the floor's provider is excluded by name (from the capability
// registry); `IS DISTINCT FROM` keeps a null floorProvider admitting every pin.
// Coarse like the tag queue's key check: a pin that exists but can't resolve
// passes here and is handled per item, unfailed, by transcribeOne.
export async function audioNeedingTranscription(db, excludeIds = [], served = {}, limit = 1) {
  const { globally = true, pinCols = null, floorProvider = null } = served;
  // The floor's name is bound only where the SQL references it — a caller that
  // names no pin columns (the plain "give me the next clip" reads) would
  // otherwise send a parameter the statement never mentions, which Postgres
  // refuses outright.
  const params = [excludeIds, globally, limit];
  const pins = [];
  if (pinCols?.keyId) pins.push(`b.${pinCols.keyId} IS NOT NULL`);
  if (pinCols?.provider) {
    params.push(floorProvider);
    pins.push(`(b.${pinCols.provider} IS NOT NULL AND b.${pinCols.provider} IS DISTINCT FROM $${params.length})`);
  }
  const { rows } = await db.query(
    `SELECT i.id, i.board_id, i.entity_ids, i.payload FROM items i
     LEFT JOIN boards b ON b.id = i.board_id
     WHERE ${notPaused("b")}
       AND ${NEEDS_TRANSCRIPT_SQL}
       AND NOT (i.id = ANY($1::bigint[]))
       AND ($2 OR ${pins.length ? pins.join(" OR ") : "FALSE"})
     ORDER BY i.created_at DESC LIMIT $3`,
    params
  );
  return rows;
}

// Current-model vectors for one board (the search corpus). Stale vectors are
// excluded rather than compared wrongly; they reappear once re-embedded.
//
// entity_ids rides along WHOLE — an instance can belong to several entities
// (classify mode), and projecting one of them drops the rest from every
// consumer. Fanning out in SQL would duplicate the bytea per entity, and the
// bytea is the whole cost of this read (measured: 7,010 kB of vectors against
// 132 kB of arrays), so the fan-out is the caller's loop — entityIdsFor, below.
//
// No medoid-title columns: those named the INSTANCE, the wrong grain once a row
// can name two entities; the clusters route names entities from the entities table.
export async function boardEmbeddings(db, boardId, model) {
  const { rows } = await db.query(
    `SELECT id, entity_ids, embedding
     FROM items WHERE board_id=$1 AND embedding IS NOT NULL AND embedding_model=$2`,
    [boardId, model]
  );
  return rows;
}

// Identities for a set of entities, for callers that have collapsed instance
// rows into entity ids and now need something to CALL each one. Display name
// first — it is the AI's original casing ("Maya Chen") where the identity key
// is lowercased — falling back to the key itself.
export async function entityNames(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    "SELECT id, identity, display_name FROM entities WHERE id = ANY($1::bigint[])",
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r.display_name || r.identity || String(r.id)]));
}

// The stored vector, decoded once — the "this bytea is float32" fact has one
// home instead of one per route.
export const embeddingVec = (row) =>
  new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);

// The entity ids one vector row scores for. Four callers collapse instances
// into entities (/api/search, /api/search/similar, meaning-clusters, the MCP's
// rank()), so the rule lives here rather than four times over.
//
// The empty fallback is unreachable in production (insertItem always writes an
// entity; deleteEntity removes sole-home instances rather than emptying their
// arrays) but test fixtures make entity-less items freely.
//
// Know what it is, though: an ITEM id standing in an entity-id slot, and the two
// sequences OVERLAP — a caller that looks the result up in `entities` can match
// an unrelated row. Survivable only while the fallback stays unreachable. If a
// real path ever empties an array, this is the line to revisit first.
export const entityIdsFor = (row) => (row.entity_ids?.length ? row.entity_ids : [row.id]);

// Score every vector row against the probes and collapse to one score per
// ENTITY — its best instance's, because a card can hold several images and the
// strongest is what the card is about. Returns entityId -> score.
//
// One probe is a meaning query; several are the instances of a find-similar
// anchor. Not used by the MCP's rank(), which scores only the survivors of a
// facet filter and would waste most of a whole-board pass.
export function bestByEntity(rows, probes) {
  const best = new Map();
  for (const row of rows) {
    const v = embeddingVec(row);
    let s = -Infinity;
    for (const p of probes) {
      if (v.length !== p.length) continue; // stale dims mid-model-change
      let d = 0;
      for (let i = 0; i < v.length; i++) d += v[i] * p[i];
      if (d > s) s = d;
    }
    if (s === -Infinity) continue;
    for (const eid of entityIdsFor(row)) {
      if (!best.has(eid) || best.get(eid) < s) best.set(eid, s);
    }
  }
  return best;
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

// --- failure routing and crash recovery ---

const RETRY_BACKOFF_MS = [60000, 300000, 900000];
const TRANSIENT_EXTRA = 2;

// Route a failed work attempt by what the error says. Three classes:
//  - permanent (HTTP 4xx except 408/429): fail on the FIRST attempt; repeating
//    a rejected call just repeats the rejection. No err.status means we can't
//    prove it's permanent, so we retry.
//  - transient (429/408/5xx, network, anything else): requeue with a spaced
//    retry_at (1m, 5m, 15m, or a longer Retry-After) so attempts outlast a
//    rate-limit window, with TRANSIENT_EXTRA headroom over maxAttempts.
//  - configuration gaps (err.noCount): requeue without consuming an attempt —
//    the claim gate promises a missing key never fails an item.
// requeueStatus picks the queue the item returns to. Returns true if it failed.
// The leg map this fences on (IN_FLIGHT_FOR) lives at the top of the file.
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
  // user re-routed mid-flight. The fence also closes the attempts read-then-write
  // race — every writer that resets attempts also moves the row out of this status.
  //
  // A REQUEUE keeps any facet scope (0030) — same partial pass. A FAILURE clears
  // it, which is load-bearing: a 'failed' row is visible to retagBoard,
  // queueUntagged and requeueItemForTag, none of which filter on the scope, so a
  // surviving one would silently narrow the full retag that comes to rescue it.
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

// Recover items stranded mid-flight by a crash or a shutdown that outlived the
// 5s drain. Each recovery counts as an attempt — an interruption is evidence —
// and requeues to its own leg with the transient backoff, so a crash-looping
// poison item stops re-leading the FIFO on every boot and eventually fails.
// Nothing else can fail it: claims don't check attempts, and failOrRequeue only
// ever sees CAUGHT errors — a crash reaches neither. Returns rows touched.
//
// excludeIds: rows THIS worker is actively holding. A live in-flight call can
// outlast olderThanMs (research tagging runs minutes), so status + age alone
// can't tell "crashed" from "still working" — ownership can. An empty array
// excludes nothing (the single-flight / boot path).
export async function recoverStuck(db, olderThanMs, maxAttempts = 3, excludeIds = []) {
  const now = Date.now();
  const [b0, b1, b2] = RETRY_BACKOFF_MS;
  const { rowCount } = await db.query(
    `UPDATE items SET
       attempts = attempts + 1,
       -- No ELSE: the WHERE restricts to IN_FLIGHT_SQL and REQUEUE_ARMS is
       -- derived from the same map, so every row matches an arm today. A
       -- fifth leg whose author forgets the map then yields NULL into a NOT
       -- NULL column — a loud failure at its first recovery, instead of the
       -- silent wrong-queue routing an ELSE 'pending' fallback would hide.
       status = CASE
         WHEN attempts + 1 >= $2 THEN 'failed'
         ${REQUEUE_ARMS}
         END,
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

// The meter's "doesn't apply" sentinel, declared beside the writer that stamps
// it. Work with no board (a sweep, a connector's quota burn) files under it;
// readers filter to it as a value and take the English from this label (0040
// says why it is '' and never NULL).
export const APP_SCOPE = "";
export const APP_SCOPE_LABEL = "outside any board";
// The model-call axes' own '' has a different meaning and so its own name:
// work with no provider/model attribution — the pre-meter backfill (0040), or
// spend with no model call behind it. Named for the PROVIDER axis; a bare ''
// model under a named provider stays blank (the provider's name already
// carries the row, and "OpenAI · unattributed" would read as a claim).
export const UNATTRIBUTED_LABEL = "unattributed";

// What a rates map answers for ONE unit: its own rate, else the whole-subject
// '*' wildcard (pricing.js builds both axes; a '*' UNIT is honored here). One
// spelling, because two stampers now read it — meter() at write time and
// priceUnpricedMeter() over history — and a rate precedence that drifted
// between them would bill the same rate table two ways into a cost_micros
// nothing recomputes.
export const rateOf = (rates, unit) => rates[unit] ?? rates["*"];

// Record "N units of `unit` consumed by this subject" — the whole contract.
// The meter does not know AI exists: `units` is { unit: quantity } with any
// unit string a spender names, and the dimensions are plain text with '' —
// never NULL — for "doesn't apply" (0040 says why NULL breaks the upsert).
// Zero quantities are skipped. Throws like any db helper; route through
// meterWrite to make a failure survivable.
//
// `rates` is { unit: microsPerUnit }, caller data (metering.js joins pricing
// in). A unit WITH a rate stamps cost_micros = round(q × rate) and counts its
// whole quantity as priced — rate 0 is priced-at-zero, a knowledge claim, not
// an absence. A unit WITHOUT one leaves quantity − priced_quantity as the
// visible unpriced remainder. Cost is computed at write time and never
// recomputed: a later price edit must not rewrite history.
export async function meter(db, { boardId = "", capability, provider = "", model = "" }, units = {}, rates = {}) {
  const rows = Object.entries(units)
    .map(([unit, n]) => [unit, Math.round(Number(n)), rateOf(rates, unit)])
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

// Stamp rates onto history that metered before any rung knew one — the
// "price unpriced history" admin action (metering.js joins the rates in).
// ONLY the unpriced remainder moves: quantity − priced_quantity is multiplied
// at the handed-in rate and ADDED to cost_micros, and priced_quantity catches
// up. Rows already priced are untouched by construction, so write-time
// stamping stays the law for priced history.
//
// The money is computed ONCE, in `tgt`, and the UPDATE hands that same number
// back through RETURNING, so the report and the stamp are provably one figure.
export async function priceUnpricedMeter(db, rateRows) {
  if (!rateRows.length) return { rows: 0, micros: 0 };
  const { rows: [r] } = await db.query(
    `WITH tgt AS (
       SELECT m.day, m.board_id, m.capability, m.provider, m.model, m.unit,
              ROUND((m.quantity - m.priced_quantity) * r.micros) AS add_micros
       FROM usage_meter m
       JOIN jsonb_to_recordset($1::jsonb) AS r(provider text, model text, unit text, micros numeric)
         ON m.provider = r.provider AND m.model = r.model AND m.unit = r.unit
       WHERE m.quantity > m.priced_quantity
     ), upd AS (
       UPDATE usage_meter m
       SET cost_micros = m.cost_micros + t.add_micros,
           priced_quantity = m.quantity
       FROM tgt t
       WHERE m.day = t.day AND m.board_id = t.board_id AND m.capability = t.capability
         AND m.provider = t.provider AND m.model = t.model AND m.unit = t.unit
       RETURNING t.add_micros
     )
     SELECT COUNT(*) AS n, COALESCE(SUM(add_micros), 0) AS micros FROM upd`,
    [JSON.stringify(rateRows)]
  );
  return { rows: Number(r.n), micros: Number(r.micros) };
}

// The groupable dimensions, WITH their names. One resolver: the route
// validates against it AND serves it, so what a client can offer and what the
// server accepts are the same list by construction. A new dimension appears in
// the picker with no client edit.
//
// `emptyLabel` is what THIS axis's '' means, stated on the axis rather than
// branched on by whoever renders it — the sentinel is one schema fact with a
// different meaning per dimension (no board / no attribution). A dimension
// with no `emptyLabel` renders '' blank, which is the answer for `model`:
// under a named provider, "OpenAI · unattributed" would read as a claim.
export const USAGE_DIMS = {
  day: { column: "day", label: "Day" },
  board: { column: "board_id", label: "Board", emptyLabel: APP_SCOPE_LABEL },
  capability: { column: "capability", label: "Work" },
  provider: { column: "provider", label: "Provider", emptyLabel: UNATTRIBUTED_LABEL },
  model: { column: "model", label: "Model" },
};

// The dimensioned usage read (metering-plan.md, Mechanism 3): group by any
// subset of the meter's dimensions over any day window. `group` names are the
// API's, mapped onto columns here — the allowlist is what makes interpolating
// them into SQL safe. Rows always also group by unit (the meter's grain),
// folded into a per-unit object: quantities sum legally within a unit, cost
// sums across everything (one currency); nothing else is ever added together.
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

// Every (provider, model) the meter recorded usage for that nothing fully
// priced — the durable half of pricing.js's want list, so a restart can't
// orphan a new model's unpriced history (cost is write-time and never
// recomputed). The '' guard is about FETCHING a price, not about pricing: a
// bare model id is nothing to look up. metering.js's priceUnpricedHistory
// keeps no such guard — a connector's requests meter with no model at all and
// price by a provider-wide rate, so the two filters differ on purpose.
// Rides usageRows, the one dimensioned reader, like boardUsageSummary below.
export async function unpricedMeterModels(db) {
  return (await usageRows(db, { group: ["provider", "model"] }))
    .filter((r) => r.provider && r.model &&
      Object.values(r.units).some((u) => u.quantity > u.priced_quantity))
    .map(({ provider, model }) => ({ provider, model }));
}

// One board's units and spend, for its chip.
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
// baseline rows — for entities OUTSIDE the edited condition's matching set are
// stale under the new reading. Pending ones would deliver the old condition's
// backlog on the next sweep; baseline ones squat on the (alert, entity) key and
// swallow the entity's real entry into the new set forever. Deleted, not
// demoted: freeing the key keeps the entity announceable. Fired rows stay —
// history, announced under the reading of their day. `before` fences the
// concurrent sweep: a match landing mid-reseed is real news, not a stale claim.
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
// `excludeIds` is the deliveries already in flight, and it is load-bearing
// rather than an optimisation (queue-by-resource-plan.md Stage 4a). Delivery is
// send-THEN-stamp on purpose — at-least-once, because a crash between the two
// resends where the other order would silently lose a notification — so a
// firing stays `pending`, and therefore stays due, for the whole length of its
// own send. The old sweep got away with re-reading it because it was sequential
// and singular; a caller that launches without awaiting would hand the same
// firing out twice and post it twice.
export async function pendingWebhookFirings(db, now, limit = 10, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT f.id, f.alert_id, f.fired_at, f.entity_count, f.attempts,
       a.name, a.board_id, a.webhook_url, a.webhook_secret, a.condition
     FROM alert_firings f JOIN alerts a ON a.id = f.alert_id
     WHERE f.webhook_status = 'pending' AND a.enabled
       AND (f.retry_at IS NULL OR f.retry_at <= $1)
       AND NOT (f.id = ANY($3::bigint[]))
       AND ${ALERT_OWNER_ACCESS}
     ORDER BY f.fired_at ASC LIMIT $2`,
    [now, limit, excludeIds]
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

// listAlerts' unseen subquery, asked once for every board at a time — the index's
// alert dot (boards-signals-plan.md). Same number in the same vocabulary:
// new-match ENTITIES across unseen firings, not the firing count.
//
// The user filter is the whole security of this route's alert half. An alert is
// per-user by construction, so a GROUP BY that lost `a.user_id=$1` would hand one
// member another's counts on boards they legitimately share — which is why its
// test seeds two users on one board.
//
// An inner join, so a board with nothing unseen produces no row and reads as 0
// from the caller's default. Exported so the plan test pins the query the app
// runs (0037).
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

