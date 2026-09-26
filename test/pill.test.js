// pill() — the chip for surfaces that still build their elements by hand (the
// job log's kind filter, the admin usage tab's window picker). Since Stage 1
// of planning/ui-updates-plan.md it draws the same Pill component the filter
// rail uses, into a spare element, and hands that element back. Nothing else
// checks what those two callers get (work-cadence.test.js reads the job log's
// pill text, no more), so this pins it: the markup the old hand-built pill()
// produced, byte for byte, and a click that still reaches its handler once
// the element has moved into its row.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./jsdom-stub.js";

const { pill } = await import("../public/pill.js");

test("pill() hands back the chip the old builder made: the label first, then the count", () => {
  const el = pill("Tagging", 3, true, false, () => {});
  assert.equal(el.outerHTML,
    '<button class="pill active" title="Tagging"><span class="pill-label">Tagging</span><span class="count">3</span></button>');
});

test("a count of 0 is still a count; no count at all draws no count", () => {
  assert.equal(pill("Failed", 0, false, true, () => {}).outerHTML,
    '<button class="pill muted" title="Failed"><span class="pill-label">Failed</span><span class="count">0</span></button>');
  assert.equal(pill("All", null, false, false, () => {}).outerHTML,
    '<button class="pill" title="All"><span class="pill-label">All</span></button>');
});

test("its click reaches the handler after it has moved into its row", () => {
  let clicks = 0;
  const el = pill("7 days", null, false, false, () => clicks++);
  const row = document.createElement("div");
  row.appendChild(el);
  el.click();
  assert.equal(clicks, 1);
});
