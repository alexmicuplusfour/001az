// The ingestion registry: resolves a board's input type to its ingestion
// adapter, owns the trigger schedule math, and validates saved configs.
// An adapter declares a descriptor (source schema, filter catalog, sorts,
// trigger modes) and implements enumerate/admit — see folder.js for the
// pinned interface. Adding an ingestible domain = one adapter file here;
// the sweep, routes, modal, filter engine and ledger are all adapter-blind.
import * as folder from "./folder.js";
import { OPS_BY_KIND } from "./filter-engine.js";

// null input.connector = a file board → the folder adapter. Connector boards
// (crypto/stocks) get the generic feed adapter in the next slice; until then
// they resolve to null and the routes answer "not available for this board".
export function resolveIngestAdapter(board) {
  const name = board?.mapping?.input?.connector;
  return name ? null : folder;
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

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate a candidate ingest config against the adapter's descriptor.
// Returns an error string, or null when valid — sibling of validateMapping.
export function validateIngest(ingest, descriptor, { hasRoot = false } = {}) {
  if (!ingest || typeof ingest !== "object" || Array.isArray(ingest)) return "ingest must be an object";
  if (!descriptor) return "ingestion is not available for this board";
  if (typeof ingest.enabled !== "boolean") return "ingest.enabled must be a boolean";

  // Source, checked against the adapter's declared schema.
  const src = ingest.source || {};
  if (typeof src !== "object" || Array.isArray(src)) return "ingest.source must be an object";
  for (const s of descriptor.source || []) {
    const v = src[s.key];
    if (s.type === "folder") {
      if (!hasRoot) return "ingestion root is not configured on the server (INGEST_ROOT)";
      if (typeof v !== "string" || !v.trim()) return "ingest.source.folder is required";
      if (!folder.resolveJailed("/jail-check", v)) return "ingest.source.folder escapes the ingestion root";
    }
    if (s.type === "boolean" && v !== undefined && typeof v !== "boolean")
      return `ingest.source.${s.key} must be a boolean`;
  }
  for (const k of Object.keys(src)) {
    if (!(descriptor.source || []).some((s) => s.key === k)) return `unknown source option "${k}"`;
  }

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
    if (!Number.isInteger(ingest.limit) || ingest.limit < 1 || ingest.limit > 500) return "limit must be an integer between 1 and 500";
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
