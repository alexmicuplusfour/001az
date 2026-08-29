// What a job-log row SAYS — the presentation half of the jobs view, pure and
// node-testable (public/capability-present.js's planners are the precedent).
//
// The case that matters here is the AI image rendition (ai-image-input-plan.md).
// Its ladder is built to be invisible: on a missing original, a corrupt file,
// or a payload over the provider's cap it quietly sends the ≤600px card face
// and tags anyway. That is the right behaviour and it is exactly why a board
// running on the OLD input is indistinguishable from a working one — unless
// this row says so. These tests pin the two halves of that: when it speaks up,
// and when it must stay quiet.
import test from "node:test";
import assert from "node:assert/strict";
import "./browser-stub.js"; // globals first — jobs-modal.js pulls in client modules

const { summaryFor, imageTitle } = await import("../public/jobs-modal.js");

const tagRow = (image) => ({ kind: "tag", outcome: "ok", detail: { tags: 7, model: "gpt-5-mini", ...(image ? { image } : {}) } });

// --- the visible line: speak up only on deviation ---

test("a row whose model got the full rendition says nothing about it", () => {
  const s = summaryFor(tagRow({ source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 }));
  assert.equal(s, "7 tags", "the normal case spends no width");
});

test("a legitimately small image is not a warning", () => {
  // An original no bigger than the card face has nothing to gain from a render,
  // and that is a FIFTH of a real gallery (measured: 8 of 40 sampled files).
  // Surfacing `source: "thumb"` as trouble would cry wolf on one row in five
  // until the field is worth nothing.
  assert.equal(summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 1 })), "7 tags");
});

test("a rendition that fell back says so, and why", () => {
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" })),
    "7 tags · thumbnail fallback (render failed)"
  );
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 512, fallback: "byte-cap" })),
    "7 tags · thumbnail fallback (too large to send)"
  );
});

test("an unrecognized fallback reason is shown, not swallowed", () => {
  // A reason this client doesn't know is still the news; dropping it would
  // hide the one thing the row exists to report.
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 10, ms: 1, fallback: "some-new-rung" })),
    "7 tags · thumbnail fallback (some-new-rung)"
  );
});

test("rows from before the rendition shipped still summarize", () => {
  assert.equal(summaryFor(tagRow(null)), "7 tags");
  assert.equal(summaryFor({ kind: "tag", outcome: "ok", detail: { tags: 1 } }), "1 tag");
});

test("a transcribe row counts turns only when the engine produced them", () => {
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134, turns: 3 } }),
    "134 chars · 3 turns");
  // 0 is real news (structure produced, no speech) — not the same as absent.
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 0, turns: 0 } }),
    "0 chars · 0 turns");
  // Rows from a turnless engine (older sidecar, plain provider model) stay as before.
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134 } }), "134 chars");
});

// --- the hover: the full facts, and the cache's measurement ---

test("the title names the resolution actually sent, its size, and its cost", () => {
  assert.equal(
    imageTitle({ preset: "high", source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 }),
    "high · 1568px q82 · 92 KB · 130ms"
  );
});

test("the preset asked for rides the title, because the size can't imply it", () => {
  // Same 1568px on the wire, two different board settings — on a provider
  // whose ceiling is 1568, `max` clamps to exactly what `high` requests. The
  // outcome is identical; the setting is not.
  const shot = { source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 };
  assert.equal(imageTitle({ ...shot, preset: "high" }), "high · 1568px q82 · 92 KB · 130ms");
  assert.equal(imageTitle({ ...shot, preset: "max" }), "max · 1568px q82 · 92 KB · 130ms");
  // And the pairing that matters: asked high, sent the card face.
  assert.equal(
    imageTitle({ preset: "high", source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" }),
    "high · thumbnail (render failed) · 8 KB · 44ms"
  );
});

test("a queue behind the decode gate rides the title — the rendition cache's evidence", () => {
  // ms is the WHOLE call, so the queued portion has to be named or a slow row
  // is ambiguous between "sharp is slow" and "eight jobs are waiting" — and
  // only the second one argues for the cache.
  assert.equal(
    imageTitle({ source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 740, waitMs: 610 }),
    "1568px q82 · 92 KB · 740ms (610ms queued)"
  );
});

test("the title tells a deliberate thumbnail from a failed one", () => {
  assert.equal(imageTitle({ source: "thumb", bytes: 8400, ms: 1 }), "thumbnail · 8 KB · 1ms");
  assert.equal(
    imageTitle({ source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" }),
    "thumbnail (render failed) · 8 KB · 44ms"
  );
});

test("a row with no image gets no title of its own", () => {
  // Text items, PDFs, transcriptions — the hover must stay free for `engine`.
  assert.equal(imageTitle(undefined), "");
  assert.equal(imageTitle(null), "");
});
