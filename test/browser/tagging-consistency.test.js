// The Tagging consistency modal while a retag is landing, in a real browser
// (planning/facet-diagnosis-rerun-plan.md D4). Half the board is queued and the
// half that has landed reads 80% where the finding was written at 40%: judged on
// those cards, the finding would give way to "Re-tagging this facet … A fresh
// reading follows." It is shown as it was instead, under the banner that says
// the figures are partial, until the queue empties.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { createBoard, setBoardMembers, updateBoard, createEntity, insertItem, setFacetDiagnostic } from "../../server/db.js";
import { facetStamp, questionOf } from "../../server/facet-diagnosis.js";

let app, alex, boardId;
const clean = [];

before(async () => {
  app = await openApp();
  const { user } = await app.signIn({ email: "consistency@test.local", boardName: "unused" });
  await app.db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [user.id]);
  alex = user;

  // 60 cards, 24 of them split on shape: 40%, and the finding written at that.
  const facets = [{ key: "shape", label: "Shape", single: true, description: "the silhouette", values: ["round", "wide"] }];
  boardId = await createBoard(app.db, "votes board", facets, "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, boardId, [user.id]);
  await updateBoard(app.db, boardId, { aiVotes: 3 });
  const d = facetStamp(facets[0], false);
  for (let i = 0; i < 60; i++) {
    const eid = await createEntity(app.db, boardId, { identity: `c${i}` });
    const id = await insertItem(app.db, boardId, { identity: `c${i}`, files: [], fields: {} }, "pending", eid);
    const split = i < 24;
    await app.db.query("UPDATE items SET status = 'tagged', updated_at = 0, tag_confidence = $1 WHERE id = $2", [
      JSON.stringify({ shape: { of: 3, agreed: split ? 2 : 3, votes: split ? { round: 2, wide: 1 } : { round: 3 }, d } }), id,
    ]);
    if (!split) clean.push(id);
  }
  await setFacetDiagnostic(app.db, boardId, "shape", {
    verdict: "overlapping-values", explanation: "round and wide overlap", values: ["round"], rewrite: "prefer wide",
    stats: { items: 60, unanimous: 36 }, split: ["wide"], d, scoped: false, k: questionOf({ d }), at: Date.now(),
  });
});
after(() => app?.close());

async function modalText() {
  const page = await app.open(`/?board=${boardId}`, { sid: alex.sid, device: { viewport: { width: 1200, height: 800 } } });
  await page.waitForSelector("#toolbar .board-diag-btn");
  await page.click("#toolbar .board-diag-btn");
  await page.waitForSelector("#facet-diagnostics-modal .fd-block, #facet-diagnostics-modal .fd-busy");
  const text = await page.$eval("#facet-diagnostics-modal", (el) => el.textContent);
  assert.deepEqual(page.errors, []);
  await page.context().close();
  return text;
}

test("mid-retag, the finding stays as it was under the banner, rather than judged on the cards landed so far", async () => {
  // Thirty clean cards queued: the thirty still tagged are 24 split, 80%.
  await app.db.query("UPDATE items SET status = 'pending' WHERE id = ANY($1::bigint[])", [clean.slice(0, 30)]);
  const during = await modalText();
  assert.match(during, /round and wide overlap/, "the finding is shown");
  assert.match(during, /contradicted itself on 40% of items/, "at the rate it was written at, not the landed cards' 80%");
  assert.match(during, /A re-tag is running on Shape — 30 items still queued/, "under the banner that says it is partial");
  assert.doesNotMatch(during, /A fresh reading follows/);

  // Landed, at the rate it was written at: the finding stands, and no banner.
  await app.db.query("UPDATE items SET status = 'tagged', updated_at = 0 WHERE id = ANY($1::bigint[])", [clean.slice(0, 30)]);
  const after = await modalText();
  assert.match(after, /round and wide overlap/);
  assert.doesNotMatch(after, /still queued/);
});
