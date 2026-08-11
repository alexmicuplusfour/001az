// The process-wide sharp decode gate + the droplet-safe sharp globals
// (ai-image-input-plan.md, Slice 1). Extracted from sources/image.js so the
// tag-time AI renditions (ai-image.js) and ingest share ONE "who may decode
// right now" answer — AI_INFLIGHT defaults to 8 concurrent tag jobs, and 8
// simultaneous multi-MP decodes is how the droplet gets OOM-killed.
import sharp from "sharp";

// The droplet is small (1 vCPU / 458 MB, no swap — node got OOM-killed under
// a concurrent bulk upload). Keep libvips lean: no operation cache holding
// decoded images, single worker thread. Module scope, not a factory: any
// importer — ingest, the AI rendition, a test file — gets this config, not
// just processes that happened to construct the image source first.
sharp.cache(false);
sharp.concurrency(1);

// The one decode cap: a 40MP image is ~160 MB of raw pixels. Previously
// written independently by ingest (MAX_PIXELS) and the detector prep
// (DETECT_MAX_INPUT_PIXELS) — one OOM policy, imported by both.
export const MAX_DECODE_PIXELS = 40e6;

// All heavy image processing goes through this gate: decode strictly one
// image at a time process-wide, no matter how many requests or tag jobs are
// in flight. A rejected job propagates to ITS caller only — the chain itself
// swallows both outcomes, so one bad image never poisons the queue behind it.
//
// NOT REENTRANT — never call sharpGate inside a sharpGate job: the inner call
// chains behind the outer one, which is awaiting it, and the whole pipeline
// (ingest AND tagging) deadlocks. The exported helpers that gate internally
// (aiImageFor, imageForDetection, the image source's ingest) are leaf
// operations — call them directly, never wrapped in another gate.
let gate = Promise.resolve();
export function sharpGate(fn) {
  const run = gate.then(fn);
  gate = run.then(
    () => {},
    () => {}
  );
  return run;
}
