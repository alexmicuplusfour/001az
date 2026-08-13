// The ingestion registry: resolves a board's input type to its ingestion
// adapter, owns the trigger schedule math, and validates saved configs.
// An adapter declares a descriptor (source schema, filter catalog, sorts,
// trigger modes) and implements enumerate/admit — see files.js for the file
// adapter (folder/ftp/s3 via pluggable source backends) and connector.js for
// the catalog-feed adapter. The sweep, routes, modal, filter engine and ledger
// are all adapter-blind.
//
// Four optional pieces an adapter may add, each a no-op when absent, and each
// there because the two adapters have genuinely different cost shapes:
//   validateSource(db, source, opts)  reject a bad source at save time
//   windowCap()                       enumeration depth (preview and run share it)
//   prewarm(db, board, batch)         batch-warm a provider before admitting;
//                                     a file adapter has nothing to warm
//   descriptor().runCap               admissions per tick — per-ITEM cost (files,
//                                     25) vs per-TICK cost (feeds, 250)
// enumerate also takes an options bag: { limit } bounds the window (the preview
// route), { extend } marks a drain tick continuing a run already in flight.
import * as files from "./files.js";
import { forBoard as connectorFeed } from "./connector.js";
import { OPS_BY_KIND } from "./filter-engine.js";
import { SAFETY_CAP } from "./window-cache.js";

// The shared enumeration bound (window depth for feeds AND the preview route,
// so a preview count and a real run can never disagree). Per-connector via
// the adapter's windowCap — a snapshot-served catalog affords more depth than
// a metered one; the bare call is the file adapter's preview bound.
export { ENUM_CAP } from "./connector.js";

// Admissions per ingest tick, resolved like ENUM_CAP above and living beside it
// for the same reason: the operator's env knob first, then the adapter's own
// declaration, then the shared default. The adapters differ in COST SHAPE — a
// file admission decodes an image (per-ITEM, so 25 is a tick-latency budget);
// a feed tick pays one catalog walk and one batched provider warm however many
// it admits (per-TICK, and connector.js declares 250) — so a single number
// could only ever be right for one of them. A non-positive env value is a typo,
// not an intent: 0 admissions would wedge every drain.
export const RUN_CAP = (declared) => {
  const env = Number(process.env.INGEST_RUN_CAP);
  return env > 0 ? env : Math.max(1, Number(declared) || 25);
};

// null input.connector = a file board → the shared file adapter (its source
// backend is picked per-board by ingest.source.type, default folder). Connector
// boards (crypto/stocks) get a per-board feed adapter built from their manifest's
// `browse` block; an unknown connector (or one without a catalog) resolves to
// null and the routes answer "not available for this board".
export function resolveIngestAdapter(board) {
  const name = board?.mapping?.input?.connector;
  return name ? connectorFeed(board) : files;
}

// Next run after `from` per the trigger config (sibling of nextAutoTagRun,
// worker.js — same server-local time convention, so TZ moves "daily" too).
// manual → null: the timer stays disarmed until "Run now" arms it once.
export function nextIngestRunAt(trigger, from = Date.now(), { continuousMs = 30000 } = {}) {
  switch (trigger?.mode) {
    case "continuous":
      return from + continuousMs;
    case "interval":
      return from + trigger.every * 60000;
    case "daily": {
      const [h, m] = String(trigger.at).split(":").map(Number);
      const d = new Date(from);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= from) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    default:
      return null;
  }
}

// What a board's ingestion is doing, for the toolbar chip and the poll cadence.
// "manual" and "paused" both sit at no-next-run, but they mean opposite things:
// manual is armed-on-demand (nothing to count down to, so no chip), paused is a
// schedule deliberately held (a chip that says so). Manual wins over `enabled`
// — a manual board has no timer to pause, so the flag is moot there. Carries no
// folder paths, which is why plain members can have it.
export function ingestMode(ingest) {
  if (!ingest) return null;
  if (ingest.trigger?.mode === "manual") return "manual";
  return ingest.enabled === false ? "paused" : "scheduled";
}

// When the SCHEDULE next fires — i.e. nextIngestRunAt with the one rule that
// isn't trigger math: only a live schedule re-arms itself. A manual board never
// did, and a paused one must not, or "Run now" on it would silently resume the
// watch it was holding. Kept here rather than in the sweep so the whole "will
// this fire again" rule reads in one place; nextIngestRunAt stays pure trigger
// math, which is what alerts.js models its own cadence on.
export function nextScheduledIngestRun(cfg, from = Date.now(), opts = {}) {
  return ingestMode(cfg) === "scheduled" ? nextIngestRunAt(cfg.trigger, from, opts) : null;
}

// The ingestion pair every board payload ships: what it's doing, and when the
// next run lands. They travel together — a stamp means nothing without the mode
// to read it against — so they're derived together in exactly one place.
export function ingestStatus(board) {
  return {
    ingest_mode: ingestMode(board.ingest),
    ingest_next_run_at: board.ingest ? board.ingest_next_run_at ?? null : null,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate a candidate ingest config against the adapter's descriptor.
// Returns an error string, or null when valid — sibling of validateMapping.
export function validateIngest(ingest, descriptor, { hasRoot = false } = {}) {
  if (!ingest || typeof ingest !== "object" || Array.isArray(ingest)) return "ingest must be an object";
  if (!descriptor) return "ingestion is not available for this board";
  if (typeof ingest.enabled !== "boolean") return "ingest.enabled must be a boolean";

  // Source shape only — the concrete per-source rules (folder jail, connection
  // reference, install gate) depend on the chosen source type and live in the
  // adapter's async validateSource, which the routes call alongside this.
  if (ingest.source !== undefined && (typeof ingest.source !== "object" || Array.isArray(ingest.source)))
    return "ingest.source must be an object";

  // Filters against the catalog + the shared op table.
  const filters = ingest.filters ?? [];
  if (!Array.isArray(filters)) return "ingest.filters must be an array";
  if (filters.length > 20) return "too many filters (max 20)";
  for (const f of filters) {
    const cat = (descriptor.filters || []).find((c) => c.fn === f?.fn);
    if (!cat) return `unknown filter field "${f?.fn}"`;
    if (!(OPS_BY_KIND[cat.kind] || []).includes(f.op)) return `operator "${f.op}" is not valid for ${cat.kind} field "${f.fn}"`;
    if (cat.kind === "text") {
      if (typeof f.value !== "string" || f.value.length > 200) return `filter "${f.fn}" needs a text value (max 200 chars)`;
    } else if (cat.kind === "number") {
      if (f.value === "" || f.value === null || !Number.isFinite(Number(f.value)))
        return `filter "${f.fn}" needs a numeric value`;
    } else if (cat.kind === "date") {
      if (f.op === "within_days") {
        const d = Number(f.value);
        if (!Number.isInteger(d) || d < 1 || d > 3650) return `filter "${f.fn}" needs a day count between 1 and 3650`;
      } else if (!DATE_RE.test(String(f.value))) {
        return `filter "${f.fn}" needs a YYYY-MM-DD date`;
      }
    }
  }

  // Sort + limit.
  if (ingest.sort !== undefined && ingest.sort !== null) {
    if (typeof ingest.sort !== "object") return "ingest.sort must be an object";
    if (!(descriptor.sorts || []).some((s) => s.by === ingest.sort.by)) return `unknown sort field "${ingest.sort?.by}"`;
    if (ingest.sort.order !== undefined && !["asc", "desc"].includes(ingest.sort.order)) return "sort order must be asc or desc";
  }
  if (ingest.limit !== undefined && ingest.limit !== null) {
    // A per-run admission count, not a ration: it says how fast a board fills,
    // and the drain machinery spreads a big one across ticks. The only bound
    // is the enumeration safety cap itself — past that a limit couldn't be
    // honored anyway, so a number that large is a typo, not an intent. Read
    // from the same constant the adapters enumerate to, so the validator can
    // never accept a limit they can't serve. (null = "all", the default, stays
    // unbounded.)
    if (!Number.isInteger(ingest.limit) || ingest.limit < 1 || ingest.limit > SAFETY_CAP)
      return `limit must be an integer between 1 and ${SAFETY_CAP}`;
  }

  // Trigger.
  const trig = ingest.trigger;
  if (!trig || typeof trig !== "object") return "ingest.trigger is required";
  if (!(descriptor.triggerModes || []).includes(trig.mode)) return `unknown trigger mode "${trig?.mode}"`;
  if (trig.mode === "interval" && !(Number.isInteger(trig.every) && trig.every >= 1 && trig.every <= 43200))
    return "trigger.every must be an integer between 1 and 43200 minutes";
  if (trig.mode === "daily" && !TIME_RE.test(String(trig.at))) return "trigger.at must be HH:MM";

  return null;
}
