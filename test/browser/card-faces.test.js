// Card faces, measured in a real browser off the real listing.
//
// This exists because the thing that matters about a card face — how TALL it
// turns out — is not visible anywhere else. Every other check in this repo
// either asserts on the JSON (which carries dimensions, not layout) or renders
// kinds.js against a stub (which has no box model and no CSS). Both passed
// happily while a connector's price-chart card stood 20px taller than the
// ticker placeholder sitting next to it on the same board, because the flag
// that distinguishes them was read off the wrong object server-side and the
// client silently got `undefined`.
//
// So: real Postgres, real thumbnails on disk, the real /api/items projection,
// the real stylesheet, and offsetHeight read out of Chromium.
//
// The claim under test is one sentence: every material type whose face the app
// controls occupies the SAME band, so a card never changes height when its real
// face replaces the placeholder that stood in for it — and an uploaded photo is
// exempt, because a masonry of photos at their own proportions is the point of
// the app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { openApp } from "./harness.js";
import { adminSession } from "../helpers.js";
import { setPassword, createBoard, createEntity, insertItem } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

// styles.css --face-h. Stated here as a literal on purpose: a test that read
// the value out of the page would agree with any change to it, including the
// one that broke this.
const FACE_H = 200;

let app, admin, boardId;

// A thumbnail that actually exists, at the dimensions the item claims — the
// client branches on w/h for "is there a rendered face", and the browser needs
// real bytes to lay the <img> out.
async function thumb(name, w, h) {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } } })
    .webp()
    .toBuffer();
  fs.writeFileSync(path.join(app.thumbsDir, `${name}.webp`), buf);
}

// One entity, one instance, one face file. `files: []` or a file with no w/h is
// how the app represents "nothing rendered (yet)" — the placeholder cases.
async function seed(label, { identity, displayName = null, symbol = null, file = null }) {
  const eid = await createEntity(app.db, boardId, { identity, displayName, symbol });
  const itemId = await insertItem(
    app.db,
    boardId,
    { identity, files: file ? [file] : [], fields: {} },
    "tagged",
    eid
  );
  // Keeps the board out of the embed lane, so the delta poll settles and
  // nothing re-renders underneath the measurement (see events.test.js).
  await app.db.query("UPDATE items SET embed_error='no embedder in tests' WHERE id=$1", [itemId]);
  if (file?.w) await thumb(file.name, file.w, file.h);
  return { label, eid };
}

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  await setPassword(app.db, admin.id, await hashPassword("faces-pw"));
  boardId = await createBoard(app.db, "Faces board", [], "");
});
after(() => app?.close());

test("every app-controlled face is one height; an uploaded photo keeps its own", async () => {
  const seeded = [
    // The two connector states, which is where the bug lived: a ticker
    // placeholder and the price chart that replaces it.
    await seed("connector-placeholder", { identity: "trx", displayName: "TRON", symbol: "TRX" }),
    await seed("connector-chart", {
      identity: "hype", displayName: "Hyperliquid", symbol: "HYPE",
      // exactly what server/faces/price-chart.js writes: 600x360, generated
      file: { name: "chart-hype", kind: "image", generated: true, w: 600, h: 360 },
    }),
    // Documents: a rendered page-1 peek, and the extension badge when poppler
    // produced nothing.
    await seed("doc-preview", {
      identity: "invoice", displayName: "Invoice 7",
      file: { name: "page-1", kind: "pdf", original_name: "invoice.pdf", w: 600, h: 776 },
    }),
    await seed("doc-badge", {
      identity: "unrendered", displayName: "unrendered.pdf",
      file: { name: "no-page", kind: "pdf", original_name: "unrendered.pdf" },
    }),
    // Audio: the ffmpeg waveform, and the ♪ when ffmpeg was absent.
    await seed("audio-wave", {
      identity: "lagoon", displayName: "Lovers Lagoon",
      // exactly what server/faces/waveform.js writes: 600x200
      file: { name: "wave-1", kind: "audio", original_name: "lagoon.mp3", w: 600, h: 200 },
    }),
    await seed("audio-badge", {
      identity: "silent", displayName: "silent.mp3",
      file: { name: "no-wave", kind: "audio", original_name: "silent.mp3" },
    }),
    // A photo carrying a mapped identity — titled like the others, but it is
    // the user's own picture and keeps its proportions.
    await seed("photo-mapped", {
      identity: "a-car", displayName: "A car",
      file: { name: "car-shot", kind: "image", original_name: "car.jpg", w: 1200, h: 800 },
    }),
    // A raw upload: identity IS the stored name, so no title strip at all.
    await seed("photo-bare", {
      identity: "bare-shot",
      file: { name: "bare-shot", kind: "image", original_name: "bare.jpg", w: 1000, h: 1500 },
    }),
  ];
  const byId = new Map(seeded.map((s) => [String(s.eid), s.label]));

  const page = await app.open(`/?board=${boardId}`, { sid: admin.sid });
  await page.waitForSelector(".card");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".card").length === n,
    seeded.length,
    { timeout: 10000 }
  );
  // Every thumbnail decoded — an <img> with no bytes yet measures 0.
  await page.waitForFunction(
    () => [...document.querySelectorAll(".card img")].every((i) => i.complete && i.naturalWidth > 0),
    undefined,
    { timeout: 10000 }
  );

  const measured = await page.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll(".card")) {
      const band = card.querySelector(".doc-preview, .face-fit, .face-badge");
      out[card.dataset.id] = {
        card: Math.round(card.getBoundingClientRect().height),
        band: band ? Math.round(band.getBoundingClientRect().height) : null,
        bandClass: band ? band.className : null,
        titled: !!card.querySelector(".face-title"),
      };
    }
    return out;
  });

  const face = {};
  for (const [id, m] of Object.entries(measured)) {
    const label = byId.get(id);
    assert.ok(label, `unexpected card on the board: ${id}`);
    face[label] = m;
  }
  assert.equal(Object.keys(face).length, seeded.length, "every seeded item drew a card");

  // 1. Every app-controlled face sits in the shared band, whatever it holds.
  for (const label of [
    "connector-placeholder", "connector-chart",
    "doc-preview", "doc-badge",
    "audio-wave", "audio-badge",
  ]) {
    assert.equal(face[label].band, FACE_H, `${label} band (${face[label].bandClass})`);
  }

  // 2. Which is the point: a placeholder and the face that replaces it are the
  //    same card. This is the assertion that fails when a producer's own
  //    proportions leak into the layout.
  for (const [placeholder, real] of [
    ["connector-placeholder", "connector-chart"],
    ["doc-badge", "doc-preview"],
    ["audio-badge", "audio-wave"],
  ]) {
    assert.equal(face[real].card, face[placeholder].card,
      `${real} must be exactly as tall as the ${placeholder} it replaces`);
  }

  // 3. And all six are the same card height as each other — one board, one row.
  const heights = new Set([
    face["connector-placeholder"].card, face["connector-chart"].card,
    face["doc-preview"].card, face["doc-badge"].card,
    face["audio-wave"].card, face["audio-badge"].card,
  ]);
  assert.equal(heights.size, 1, `mixed material must line up, got ${[...heights].join(", ")}`);

  // 4. The exemption, asserted so nobody "fixes" it into the band later: a
  //    photo is sized by its own ratio. 1200x800 and 1000x1500 at the same
  //    column width cannot both be 200px tall, and neither should be.
  assert.ok(face["photo-mapped"].band === null && face["photo-bare"].band === null,
    "a photo must not be wearing a fixed band");
  assert.notEqual(face["photo-mapped"].card, face["photo-bare"].card,
    "photos keep their own proportions");
  assert.ok(face["photo-bare"].card > face["photo-mapped"].card,
    "the taller original makes the taller card");

  // 5. The strip is what a title lives on: every derived-identity card has one,
  //    a raw upload has none.
  assert.equal(face["photo-bare"].titled, false, "a raw upload is bare media");
  for (const label of ["connector-chart", "doc-preview", "audio-wave", "photo-mapped"]) {
    assert.equal(face[label].titled, true, `${label} carries a title strip`);
  }

  // 6. One grey tile, not a theme per material. The connector ticker used to
  //    wear a navy gradient while documents and audio wore grey; asserting the
  //    computed fill (and that nothing painted an image over it) is what stops
  //    a future "finance cards should look like finance cards".
  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll(".face-badge")].map((b) => {
      const cs = getComputedStyle(b);
      return { cls: b.className, bg: cs.backgroundColor, img: cs.backgroundImage, ink: cs.color };
    })
  );
  assert.equal(tiles.length, 3, "three placeholders on this board");
  assert.equal(new Set(tiles.map((t) => t.bg)).size, 1, `one fill: ${tiles.map((t) => t.bg)}`);
  assert.equal(new Set(tiles.map((t) => t.ink)).size, 1, `one ink: ${tiles.map((t) => t.ink)}`);
  assert.ok(tiles.every((t) => t.img === "none"), `no gradients: ${tiles.map((t) => t.img)}`);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("the boards page restates the same grey tile for a connector board", async () => {
  // boards.css draws its own symbol tile at stack scale rather than reusing the
  // gallery's node, so it is a second place the navy gradient lived and a
  // second place it can come back.
  //
  // Its own board: the preview stack fills with file thumbnails first and only
  // tops up with symbols, and boards.js draws the first four — on a board with
  // files the ticker tile never reaches the stack at all.
  const connectorBoard = await createBoard(app.db, "Crypto", [], "");
  for (const [identity, symbol, name] of [["btc", "BTC", "Bitcoin"], ["xrp", "XRP", "XRP"]]) {
    const eid = await createEntity(app.db, connectorBoard, { identity, displayName: name, symbol });
    await insertItem(app.db, connectorBoard, { identity, files: [], fields: {} }, "tagged", eid);
  }

  const page = await app.open("/boards.html", { sid: admin.sid });
  await page.waitForSelector(".bc-thumb.sym");
  const tile = await page.evaluate(() => {
    const el = document.querySelector(".bc-thumb.sym");
    const cs = getComputedStyle(el);
    const ink = getComputedStyle(el.querySelector("span"));
    return { bg: cs.backgroundColor, img: cs.backgroundImage, ink: ink.color, text: el.textContent };
  });
  assert.equal(tile.img, "none", "no gradient on the boards-page tile either");
  assert.equal(tile.bg, "rgb(241, 242, 244)", "the gallery placeholder's grey");
  assert.equal(tile.ink, "rgb(154, 160, 170)", "the gallery placeholder's ink");
  assert.match(tile.text, /BTC|XRP/, "and it is showing a ticker");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
