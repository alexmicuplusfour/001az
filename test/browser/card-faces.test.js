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
    // How much of the band an <img> inside it actually covers. object-fit
    // leaves the element full-size and paints a smaller picture inside it, so
    // the box tells you nothing — this recomputes what `contain` drew. A
    // producer whose ratio matches the band covers it exactly; one that
    // doesn't leaves the slack that reads as a thumbnail sitting off its card.
    const painted = (band) => {
      const img = band?.querySelector("img");
      if (!img) return null;
      const bw = band.clientWidth, bh = band.clientHeight;
      const s = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      return { w: Math.round(img.naturalWidth * s), h: Math.round(img.naturalHeight * s), bw, bh };
    };
    const out = {};
    for (const card of document.querySelectorAll(".card")) {
      const band = card.querySelector(".doc-preview, .face-fit, .face-badge");
      out[card.dataset.id] = {
        card: Math.round(card.getBoundingClientRect().height),
        band: band ? Math.round(band.getBoundingClientRect().height) : null,
        bandClass: band ? band.className : null,
        titled: !!card.querySelector(".face-title"),
        fit: painted(band),
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

  // The six faces the app controls, in placeholder/real pairs.
  const banded = [
    "connector-placeholder", "connector-chart",
    "doc-badge", "doc-preview",
    "audio-badge", "audio-wave",
  ];
  const spread = (pick) => banded.map((l) => `${l}=${pick(face[l])}`).join(" ");

  // 1. One SHAPE, so — every card in a column layout being one width — one
  //    height, placeholder and real face alike. Compared against each other
  //    rather than a pixel constant: the band is a ratio, so a hardcoded
  //    number would only be asserting this viewport.
  assert.equal(new Set(banded.map((l) => face[l].band)).size, 1,
    `one band height across mixed material: ${spread((f) => f.band)}`);
  assert.equal(new Set(banded.map((l) => face[l].card)).size, 1,
    `and so one card height — a placeholder is as tall as the face that replaces it: ${spread((f) => f.card)}`);
  assert.ok(face["doc-badge"].band > 0, "the band has a height at all");

  // 2. And the chart FILLS its band. The complaint that sent me back here was
  //    a chart floating inside its own card with its area fill stopping short
  //    of the edges: price-chart.js draws 5:3 and --face-ratio is 5:3, so
  //    `contain` paints the whole box. Fails the moment either side moves.
  const chart = face["connector-chart"].fit;
  assert.deepEqual({ w: chart.w, h: chart.h }, { w: chart.bw, h: chart.bh },
    "the price chart must reach every edge of its band");

  // 3. The exemption, asserted so nobody "fixes" it into the band later: a
  //    photo is sized by its own ratio. 1200x800 and 1000x1500 at one column
  //    width cannot both be band-shaped, and neither should be.
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
  // Against the TOKENS, not two rgb literals — a third copy of the colours is
  // the very thing the tokens exist to prevent.
  const tile = await page.evaluate(() => {
    const el = document.querySelector(".bc-thumb.sym");
    const cs = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const hex = (c) => "#" + c.match(/\d+/g).map((n) => (+n).toString(16).padStart(2, "0")).join("");
    return {
      bg: hex(cs.backgroundColor),
      img: cs.backgroundImage,
      ink: hex(getComputedStyle(el.querySelector("span")).color),
      wantBg: root.getPropertyValue("--face-badge-bg").trim(),
      wantInk: root.getPropertyValue("--face-badge-ink").trim(),
      text: el.textContent,
    };
  });
  assert.equal(tile.img, "none", "no gradient on the boards-page tile either");
  assert.equal(tile.bg, tile.wantBg, "the gallery placeholder's grey");
  assert.equal(tile.ink, tile.wantInk, "the gallery placeholder's ink");
  assert.match(tile.text, /BTC|XRP/, "and it is showing a ticker");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("the lightbox panel is the chart's shape too, so the chart fills it", async () => {
  // Same claim as the card, one surface over. The lightbox's chart panel had a
  // fixed height clamp against a 5:3 picture, so the face sat inset with the
  // area fill stopping short of the panel's edges — invisible until the card
  // was made flush and the two stopped agreeing.
  //
  // The panel shows this static face whenever the live chart isn't there yet:
  // while it loads, and permanently in bare mode. A test deployment has no
  // stocks provider, so the series 404s and bare mode is exactly what renders.
  const boardId2 = await createBoard(app.db, "Stocks", [], "");
  // chartDetail only claims the stage on a connector-FACED board.
  await app.db.query("UPDATE boards SET mapping = $1 WHERE id = $2", [JSON.stringify({
    input: { connector: "stocks" },
    face: { source: "connector", producer: "price-chart", period: "5y" }, fields: [],
  }), boardId2]);

  const eid = await createEntity(app.db, boardId2, { identity: "amzn", displayName: "Amazon.com, Inc.", symbol: "AMZN" });
  const itemId = await insertItem(app.db, boardId2,
    { identity: "amzn", files: [{ name: "amzn", kind: "image", generated: true, w: 600, h: 360 }], fields: {} },
    "tagged", eid);
  await app.db.query("UPDATE items SET embed_error='none' WHERE id=$1", [itemId]);
  // price-chart.js's own proportions; the lightbox loads the ORIGINAL, so the
  // face has to exist in the gallery as well as the thumbnails.
  const buf = await sharp({ create: { width: 600, height: 360, channels: 3, background: { r: 250, g: 250, b: 250 } } })
    .webp().toBuffer();
  fs.writeFileSync(path.join(app.thumbsDir, "amzn.webp"), buf);
  fs.writeFileSync(path.join(app.galleryDir, "amzn"), buf);

  const page = await app.open(`/?board=${boardId2}`, { sid: admin.sid });

  // TWO viewports, and the tall one is the one that matters. The old rule was
  // `height: clamp(280px, 52vh, 520px)` against a width capped by that same
  // 52vh, so wherever the middle term binds the two agree by construction and
  // the panel is 5:3 either way — a check at one ordinary window size passes
  // against the bug. They only diverge where the clamp hits a bound: at 1400
  // tall, 52vh is 728, the clamp pins 520, and the panel goes wide and insets.
  for (const [width, height, why] of [
    [1500, 1400, "tall: the height cap is what used to square the panel off"],
    [1500, 620, "short: without a width capped by the height budget, the panel overflows the stage"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForSelector(".card img");
    if (!(await page.$(".lb-chart-face"))) await page.click(".card .face-media");
    await page.waitForSelector(".lb-chart-face");
    await page.waitForFunction(() => {
      const i = document.querySelector(".lb-chart-face");
      return i && i.complete && i.naturalWidth > 0;
    }, undefined, { timeout: 10000 });

    const fit = await page.evaluate(() => {
      const media = document.querySelector(".lb-chart-media");
      const img = document.querySelector(".lb-chart-face");
      const s = Math.min(media.clientWidth / img.naturalWidth, media.clientHeight / img.naturalHeight);
      // The WHOLE panel, not just the picture: the stage is overflow:clip, so
      // a panel taller than it loses its controls off the bottom silently.
      const panel = document.querySelector(".lb-chart").getBoundingClientRect();
      const stage = document.querySelector(".lightbox-stage").getBoundingClientRect();
      return {
        box: `${media.clientWidth}x${media.clientHeight}`,
        gapX: media.clientWidth - Math.round(img.naturalWidth * s),
        gapY: media.clientHeight - Math.round(img.naturalHeight * s),
        overflow: Math.round(Math.max(0, stage.top - panel.top) + Math.max(0, panel.bottom - stage.bottom)),
      };
    });
    assert.deepEqual({ gapX: fit.gapX, gapY: fit.gapY }, { gapX: 0, gapY: 0 },
      `the chart must reach every edge of the lightbox panel — ${why} (panel ${fit.box})`);
    assert.equal(fit.overflow, 0, `and the whole panel must fit the stage — ${why} (panel ${fit.box})`);
  }
});
