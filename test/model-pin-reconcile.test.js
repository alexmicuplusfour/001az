// Stored model pins reconciled against the deployed image's catalog — the
// mechanism that makes a pin/deployment mismatch impossible to PERSIST by
// design (no job has to trip over it). The write path guarantees fresh picks
// are real; what it can't see is the store and the deployment changing
// independently — a restored backup, a re-tagged image. Both funnel through
// the catalog landing (sweepSidecars' onCatalog: boot, post-restore boot,
// any changed answer), where stale pins are DELETED where they live.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, jsonBox } from "./helpers.js";
import { setSetting, getSetting, getBoard, updateBoard } from "../server/db.js";
import { reconcileModelPins } from "../server/capability-bind.js";
import { sweepSidecars, clearSidecarHealth, sidecarPresent } from "../server/sidecar-catalog.js";

let srv, db;

before(async () => {
  srv = await startServer();
  db = srv.db;
});
after(() => srv.close());

test("a stale app-level pin dies when the catalog lands; a valid one survives", async () => {
  await setSetting(db, "transcribe_provider", "whisper");
  await setSetting(db, "transcribe_model", "small");

  // The deployed image bakes medium only → the stored 'small' is a fossil no
  // chooser can even show (pickers render the live catalog) — deleted.
  await reconcileModelPins(db, "whisper", "transcribe", ["medium"]);
  assert.equal(await getSetting(db, "transcribe_model"), null, "the fossil is deleted, not skipped");

  // A multi-bake image that DOES serve the pin keeps it — the model axis's
  // picker choice is a real choice.
  await setSetting(db, "transcribe_model", "small");
  await reconcileModelPins(db, "whisper", "transcribe", ["small", "medium"]);
  assert.equal(await getSetting(db, "transcribe_model"), "small", "a served pin is a choice, not drift");

  await setSetting(db, "transcribe_model", null);
  await setSetting(db, "transcribe_provider", null);
});

test("a keyed provider's model rides the same keys and is never judged against a sidecar", async () => {
  // Stored provider names OpenAI; transcribe_model belongs to IT, whatever
  // the whisper image bakes.
  await setSetting(db, "transcribe_provider", "openai");
  await setSetting(db, "transcribe_model", "gpt-4o-transcribe");
  await reconcileModelPins(db, "whisper", "transcribe", ["medium"]);
  assert.equal(await getSetting(db, "transcribe_model"), "gpt-4o-transcribe",
    "the sidecar only owns the pin when the stored provider names it");
  await setSetting(db, "transcribe_model", null);
  await setSetting(db, "transcribe_provider", null);
});

test("board pins heal in their own columns, only where the board names the sidecar", async () => {
  const stale = await seedBoard(db, "pin-stale");
  const fine = await seedBoard(db, "pin-fine");
  const keyed = await seedBoard(db, "pin-keyed");
  await updateBoard(db, stale, { boardBindings: { transcribe_provider: "whisper", transcribe_model: "small" } });
  await updateBoard(db, fine, { boardBindings: { transcribe_provider: "whisper", transcribe_model: "medium" } });
  // A keyed board pin (keyId, no provider name) with its own model — not the sidecar's to touch.
  await updateBoard(db, keyed, { boardBindings: { transcribe_model: "whisper-1" } });

  const cleared = await reconcileModelPins(db, "whisper", "transcribe", ["medium"]);

  assert.deepEqual(cleared.map((b) => b.id), [stale], "the cleared rows come back — the caller owns cache invalidation");
  assert.equal((await getBoard(db, stale)).transcribe_model, null, "the board's fossil clears");
  assert.equal((await getBoard(db, fine)).transcribe_model, "medium", "a served board pin survives");
  assert.equal((await getBoard(db, keyed)).transcribe_model, "whisper-1", "a keyed pin is never judged here");
});

test("the sweep notifies on first answer and real change — never on absence, recovery, or an empty catalog", async (t) => {
  // The transcriber answers from a box; the detector stays at the dead-port
  // default (refused = absent) — the jsonBox pattern sidecar-latency.test.js
  // uses, which keeps the two providers genuinely distinct.
  const box = await jsonBox({ ok: true, model: "medium", models: ["medium"], queued: 0 });
  const saved = process.env.TRANSCRIBER_URL;
  process.env.TRANSCRIBER_URL = box.url();
  t.after(async () => {
    process.env.TRANSCRIBER_URL = saved;
    clearSidecarHealth();
    await new Promise((r) => box.close(r));
  });
  clearSidecarHealth();

  const seen = [];
  const hook = (provider, cap, models) => { seen.push({ provider, cap, models }); };

  // First answer after boot → notify (this is the post-restore heal moment).
  await sweepSidecars(hook);
  assert.deepEqual(seen, [{ provider: "whisper", cap: "transcribe", models: ["medium"] }],
    "the capability rides the descriptor; the absent detector stays silent");

  // Same answer again → quiet.
  await sweepSidecars(hook);
  assert.equal(seen.length, 1, "an unchanged catalog is not an event");

  // Down, then back with the SAME bake → quiet both times: absence hides a
  // choice (never destroys one), and a recovery is not news — the baseline
  // remembers the last ANSWER, not the last probe.
  box.status = 500;
  await sweepSidecars(hook);
  assert.equal(await sidecarPresent("whisper"), false, "presence itself flips on absence");
  box.status = 200;
  await sweepSidecars(hook);
  assert.equal(seen.length, 1, "a flapping sidecar re-fires nothing");

  // A DIFFERENT bake → notify.
  box.payload = { ok: true, model: "small", models: ["small"], queued: 0 };
  await sweepSidecars(hook);
  assert.deepEqual(seen[1], { provider: "whisper", cap: "transcribe", models: ["small"] });

  // A body that names no model is not a catalog — pins are never judged
  // against an empty list.
  box.payload = { ok: true, queued: 0 };
  await sweepSidecars(hook);
  assert.equal(seen.length, 2, "an empty catalog never fires the hook");

  // A failing hook doesn't advance the baseline — the landing retries on the
  // next sweep instead of being lost (a db hiccup at boot must not eat the
  // one heal moment a restore gets).
  box.payload = { ok: true, model: "large", models: ["large"], queued: 0 };
  await sweepSidecars(() => { throw new Error("boom"); });
  await sweepSidecars(hook);
  assert.deepEqual(seen[2], { provider: "whisper", cap: "transcribe", models: ["large"] },
    "the missed landing re-fires once the hook can act");
});
