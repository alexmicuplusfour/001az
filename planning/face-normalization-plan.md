# Face normalization — a Face row on every board (file boards get one too)

**Status: SHIPPED — committed + pushed to main 2026-07-19 as `ea3da92` (both phases, +4 new
tests; the only red in a full run is a pre-existing ingest-sweep timing flake). Design
agreed 2026-07-18. As-built notes below; the rest is the design.**

## As-built (small deviations from the plan)

- **The read-only "File preview" label reuses the existing `.mm-locked-badge`** pill
  (muted, [`modal.css:244`](../public/modal.css#L244)) rather than a new class — it already
  reads as a locked value, parallel to the identity connector badge.
- **`listItems` gained one small query.** The listing didn't previously load the board row,
  so a single-board view now runs `SELECT mapping FROM boards WHERE id=$1` once to get
  `mapping.face` ([`db.js`](../server/db.js)). The **cross-board** listing (`boardId` null,
  entities spanning boards) leaves `faceCfg` null → `selectFace`'s first-instance default,
  identical to legacy — we don't per-row join each entity's board.
- **A file face carries no `input`.** File boards omit `mapping.input` entirely, and
  `validateMapping`'s guard (`mapping.input && mapping.input !== "files"`) passes on the
  undefined case, so a `{ from: "file" }` face validates without the board setting
  `input: "files"`. No change needed there.
- **Prefer labels** render as `Any type / Image / Document / Audio`; **pick** as
  `First added / Latest added` (clearer than bare First/Latest next to a type select).
- Tests: `selectFace` unit suite, `validateMapping` file-face accept/reject, a `listItems`
  parity test proving the item face follows `mapping.face` over a two-instance entity, and a
  **source-level mirror guard** that extracts `selectFace`/`FACE_FAMILY` from both
  server/faces/select.js and public/lightbox.js and asserts they're byte-identical — all in
  [`test/faces.test.js`](../test/faces.test.js).

## What this ships

Today the **Face** slot in the mapping modal is a connector-only feature. Crypto/stocks
boards get a Face row (Symbol tile / Price chart + period + cadence,
[`slice-5d-connector-faces-plan.md`](slice-5d-connector-faces-plan.md)); file boards
(images/docs/audio) get **no** Face row at all — their card face is picked implicitly at
ingest (image→thumbnail, pdf→page-1, docx/text→peek, audio→waveform) with a badge
fallback, and nothing is configurable.

This plan **normalizes the Face segment across all board types**: every board shows a Face
row under identity. The change is deliberately asymmetric in weight, matching where a face
actually has parameters worth choosing:

- **File board, raw identity** — the Face row is a **read-only label, "File preview"**,
  mirroring how the identity row shows a locked `filename (raw)`. One entity = one file =
  one face; there is nothing to pick, so we only *communicate* the face, we don't configure
  it. **Behavior-identical to today.**
- **File board, derived (AI) identity** — an entity can bundle several instances (the count
  chip), possibly of different kinds (a board is kind-blind — a PDF, a JPG and an MP3 can
  share one board, and one derived entity can bundle instances across kinds). Here the Face
  row grows **two light selects** that decide *which instance* supplies the card face:
  - **Prefer** `[ Any · Image · Document · Audio ]` — a *preference*, not a filter.
  - **Instance** `[ First · Latest ]` — which one, when several qualify.
- **Connector board** — unchanged. Its single-kind Face row is the one-row special case of
  the same "face is a per-kind choice" idea.

The **pretty face stays the default** everywhere; the badge/tile remains the automatic
fallback when a render is absent (no user control for it). Both new selects **default to
today's behavior** (`Any` + `First` = the current oldest-instance pick), so an unconfigured
derived board looks exactly as it does now — the controls only *change* anything if a user
reaches for them.

Out of scope: any new face *producer* (this is selection, not rendering — the existing
producers in [`server/faces/`](../server/faces/index.js) are untouched); a per-kind
producer choice (e.g. "page preview vs badge" as an explicit option) — the badge stays a
pure fallback; connector-face changes.

## The model

The card face for an entity is **one instance's rendered face**. That selection lives in
exactly two mirrored places today, both hardcoding `instances[0]`:

- **Server, the board listing** — [`db.js:177`](../server/db.js#L177):
  `const face = instances[0] || null;`, where instances are ordered
  `created_at ASC, id ASC` ([`db.js:149,152`](../server/db.js#L149)) → `instances[0]` is the
  **oldest** instance. Its `name/w/h/kind/label` become the item's top-level face fields
  ([`db.js:186-204`](../server/db.js#L186)).
- **Client, the lightbox mirror** — [`lightbox.js:248-249`](../public/lightbox.js#L248):
  re-derives the same `instances[0]` face after a client-side instance change.

`prefer`/`pick` is a pure function `selectFace(instances, faceCfg)` that replaces
those two `instances[0]` reads with the **same rule in both spots**. Nothing else in the
face pipeline moves — `kinds.js` still renders whatever face it's handed generically
([`kinds.js:217-221`](../public/kinds.js#L217)).

```js
// The prefer families group the granular kinds into the three face shapes.
const FACE_FAMILY = { image: "image", pdf: "document", docx: "document", text: "document", audio: "audio" };

// instances are pre-ordered created_at ASC (oldest→newest).
function selectFace(instances, faceCfg) {
  if (!instances.length) return null;
  const prefer = faceCfg?.from === "file" ? (faceCfg.prefer || "any") : "any";
  const pick   = faceCfg?.from === "file" ? (faceCfg.pick   || "first") : "first";
  let pool = instances;
  if (prefer !== "any") {
    const matched = instances.filter((i) => FACE_FAMILY[i.kind] === prefer);
    if (matched.length) pool = matched;          // preference, not filter — else fall through to all
  }
  if (pick === "latest") return pool[pool.length - 1];
  return pool[0];                                 // first (oldest) — today's behavior
}
```

`selectFace` is deterministic — same instances + same `faceCfg` always yield the same face,
so the listing re-running on every page/delta/poll never changes the card.

## Mapping shape (additions)

```js
mapping.face =
    { from: "raw" }                                        // connector: symbol tile (unchanged)
  | { from: "connector", producer, period, live, every }   // connector: chart (unchanged)
  | { from: "file" }                                       // file board: File preview, default pick
  | { from: "file", prefer: "image", pick: "latest" }      // file board, derived: configured
```

**Back-compat / clean saves.** A file board today carries **no** `mapping.face`, and that
must keep meaning "File preview, first instance, any kind". So:
- `selectFace` treats absent `mapping.face` and `{ from: "file" }` identically to
  `{ prefer: "any", pick: "first" }` → **zero migration**, today's oldest-instance pick.
- The modal **only serializes** `mapping.face` for a file board when it **diverges from the
  default** (`prefer !== "any"` or `pick !== "first"`). The read-only "File preview" state
  writes nothing — mirroring how connector `{ from: "raw" }` is "same as absent".

## `validateMapping` additions ([server.js:807-824](../server/server.js#L807))

The face block currently allows `from ∈ { "raw", "connector" }`. Add `"file"`:

- `fc.from === "file"` requires `mapping.input === "files"` (reject a file face on a
  connector board — the mirror of the existing "connector face requires a connector input"
  check at [`server.js:813`](../server/server.js#L813)).
- `fc.prefer`, when present, ∈ `{ "any", "image", "document", "audio" }`.
- `fc.pick`, when present, ∈ `{ "first", "latest" }`.
- A file face carries **no** `producer`/`period`/`live`/`every` — reject those if present
  (a static file face has nothing to refresh; stay strict like the rest of the validator).

## Server — the selection seam

- **`selectFace` + `FACE_FAMILY`** land as a small pure helper (co-located
  with the listing in [`db.js`](../server/db.js), or a tiny `server/faces/select.js` if we
  want it importable by tests without pulling in the db module).
- **[`db.js:177`](../server/db.js#L177)** becomes
  `const face = selectFace(instances, board.mapping?.face);`. The listing already loads
  the board mapping for the live-cadence math ([`db.js:40-42`](../server/db.js#L40)) and
  already fetches **all** of an entity's instances even on a partial page
  ([`db.js:141-153`](../server/db.js#L141)) precisely so the face can be chosen from the
  full set — so the input is already in hand; only the pick rule changes.
- Everything downstream (`name/w/h/kind/label` projection, `kindFor`, URLs) is unchanged —
  it still receives one resolved face.

## Client

- **[`lightbox.js:248`](../public/lightbox.js#L248)** — the mirror re-derives the face from
  `instances[0]`; change it to the same `selectFace(img.instances, faceCfg)`. The
  board's `mapping.face` is already available client-side (the mapping modal reads it), so
  thread it to the lightbox. **Keep the client `selectFace` a byte-for-byte mirror of the
  server's** — build-less frontend, no shared import, so this is a maintained pair (call it
  out in both with a cross-reference comment, as the repo does for other mirrors).
- **[`mapping-modal.js`](../public/mapping-modal.js)** — the Face row. Today `renderFaceRow`
  ([`mapping-modal.js:182-253`](../public/mapping-modal.js#L182)) early-returns hidden unless
  `inputConnector && connectorFaces.length` ([`:184`](../public/mapping-modal.js#L184)).
  Rework so it also renders for **file boards** (`input === "files"`):
  - **Not derived** (`identityFrom !== "ai"`): render a locked row — the `face` key + a
    static **"File preview"** label, styled like the connector identity's `mm-key-locked`
    span. No controls, serializes nothing.
  - **Derived** (`identityFrom === "ai"`): render the **Prefer** and **Instance** selects,
    seeded from `faceCfg`, writing `{ from: "file", prefer, pick }` (omitting the object when
    both are default).
  - **Reveal wiring**: the derived-vs-not toggle keys off `identityFrom` — the *same signal*
    the identity hint textarea already keys off ([`mapping-modal.js:156,165-168`](../public/mapping-modal.js#L156)).
    Extend the existing `idSrcSel` change handler ([`:165`](../public/mapping-modal.js#L165))
    to also re-render the Face row when identity flips to/from `ai`, so the two selects appear
    and vanish alongside the hint.
  - Connector boards keep the existing producer/period/cadence branch verbatim.

## Tests (`test/faces.test.js` + a mapping-validation test)

- **`selectFace` (pure)** — the heart of it:
  - default (`{}`/absent/`{from:"file"}`) → `instances[0]` (oldest) for a mixed set.
  - `pick: latest` → newest instance.
  - `prefer: image` with a mixed PDF+image entity → the image instance; `prefer: audio`
    with **no** audio instance → falls back to the full pool (preference, not filter).
  - empty instances → null.
- **`validateMapping`** — `{ from: "file" }` and `{ from: "file", prefer, pick }` accepted on
  a `files` board; rejected: file face on a connector board, unknown `prefer`/`pick`,
  stray `producer`/`period` on a file face.
- **Listing parity** — a derived board with a mixed-kind entity: the item's top-level
  `name/w/h/kind` match `selectFace` under a given `mapping.face` (proves the seam is wired,
  not just the helper).
- **Server/client mirror** — a shared fixture of instances + faceCfg asserted to produce the
  same chosen name on both sides (guards the maintained pair from drifting).

## Verify (compose stack, throwaway board)

1. **File preview default.** An images board (raw filename identity) → open mapping → the
   Face row shows a locked **"File preview"**; no controls; Save writes no `mapping.face`.
   Cards look exactly as before.
2. **Derived reveal.** Flip identity to **AI instruction** → the **Prefer** + **Instance**
   selects appear next to the hint; flip back → they vanish. (Same show/hide as the hint.)
3. **Instance pick.** A derived board where one entity bundles two files added at different
   times → set **Instance: Latest** → the card face switches to the newer file; **First**
   restores the older.
4. **Prefer.** An entity bundling a PDF + a photo → **Prefer: Image** → the photo is the
   face; remove the photo → it falls back to the PDF page (preference, not a hard filter).
5. Lightbox agrees with the grid after an instance is added/removed (the mirror matches).
6. Connector boards unchanged; `npm test` green.

## Phases

1. **Selection core + server seam** — `selectFace`/`FACE_FAMILY`,
   `validateMapping` `file` branch, wire [`db.js:177`](../server/db.js#L177). Behavior-
   identical for every existing board (default pick reproduces `instances[0]`). Ships with
   its unit tests; no UI yet.
2. **Modal Face row + lightbox mirror** — the file-board row (read-only label + the two
   selects under derived identity), the reveal wiring, the mirrored client `selectFace`.

## Risks / notes

- **The mirrored `selectFace` is the maintenance hazard** — two copies (server db.js, client
  lightbox.js) must stay identical, exactly like the existing `instances[0]` pair they
  replace. Cross-reference comments both ways; the parity test is the backstop.
- **Kind-blind boards make this worth doing** — because a file board can hold mixed kinds and
  a derived entity can bundle across them, `prefer` is not cosmetic; it's the only way to say
  "represent this invoice by its scan, not its cover photo".
- **UX weight** — two selects, only on derived boards, defaulting to no-op. If even that reads
  heavy in practice, `Instance` (first/latest) is the more universal of the two and
  `Prefer` could be dropped to a follow-up; keeping both for now per the design call.
- **No producer changes, no new faces, no migration** — this is pure selection over existing
  rendered instances, which is why it's small despite touching identity semantics.

## Pointer

Completes the "Face on every board" arc: connector faces shipped in
[`slice-5d-connector-faces-plan.md`](slice-5d-connector-faces-plan.md) on top of the
[face pipeline](face-pipeline-plan.md) registry; the audio waveform face landed with
[`audio-media-plan.md`](audio-media-plan.md). This plan is the file-board half of the same
Face slot — selection rather than rendering — and leaves the door open to a later per-kind
producer *choice* (badge-vs-preview as an explicit option) if a board ever wants it.
