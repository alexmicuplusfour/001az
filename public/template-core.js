// template-core.js — the two sections of a board that travel as JSON, and the
// rules their Copy/Paste share (planning/templates-plan.md, C2): Tagging
// Guidance, `{ context, facets }`, and the AI-extracted fields, a bare list of
// `{ key, source: "extract", kind, instruction?, options? }`. And the board
// template's file, which carries both (C1). Pure: no DOM, no fetch, no
// storage, so the server can import it the way it imports sort-core.js and
// facet-match.js, and the board templates are checked by the same rules their
// Paste buttons apply.
//
// A Paste checks a document's SHAPE, not whether its values are valid. Whether
// a field's key, kind or instruction is allowed is checked at Save, by the
// Mapping pane's collect() and by the server's validateMapping, which already
// name the field. A third copy of those rules here would only drift from them
// (templates-plan.md, Stage 1 close look, finding 2). The one save rule that
// lives here is the reserved facet key, which a save reads from this file, so
// that a template is held to it too. And the two write-outs, how a board
// stores a facet and an AI-extracted field: the board editor and the Mapping
// pane write through them, and so does the template check, so a template is
// what a board made from it holds (Stage 3b close look, finding 1).

// `~` prefixes are reserved for system facets (~objects, ~uploaders — the
// client's filter router shadows them, and alert conditions/saved configs
// store them durably), so a user facet may not claim one. The only facet-key
// constraint a save enforces (server.js reads it from here); everything else
// about facets stays free. Here so a template is held to it too.
export function facetsReservedKeyError(facets) {
  const clash = facets.find((f) => typeof f?.key === "string" && f.key.startsWith("~"));
  return clash ? `facet key "${clash.key}" is reserved (~ prefixes belong to system facets)` : null;
}

// A facet's key, derived from its label: lowercase, spaces to dashes, nothing
// else survives. Derived exactly twice — while a new facet's label is still
// being typed, and for a pasted facet that arrived without one.
export const facetKey = (label) =>
  String(label || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

// What guidance Paste accepts, and what it means. This is the only place that
// decides what a pasted guidance document is allowed to be.
//
// A document replaces what it MENTIONS and leaves the rest alone. The two keys
// are independently useful — re-wording what a board is for shouldn't require
// carrying its taxonomy along, and a taxonomy shouldn't blank a context it
// says nothing about. A bare array is read as facets-only: that is the shape
// this button emitted before the guidance became one document, and the shape
// an AI hands back when asked for "the taxonomy".
//
// Two fields are filled in rather than demanded, because both are things a
// hand-written or AI-drafted document leaves out and neither is optional
// downstream. The editor supplies them as you type; paste never went through
// that path, which is why it could write shapes the editor cannot produce.
//   key    — every tag the worker writes and every filter the gallery builds is
//            keyed, so a keyless facet saves fine and then matches nothing,
//            forever. Derived from the label.
//   values — `for (const v of f.values)` runs unguarded in the tagging pass,
//            the manual-tag route and the gallery's filter build, so a facet
//            with no values list doesn't degrade, it throws — on a board the
//            user has already saved and walked away from.
//
// Throws on anything else; the caller turns that into the warn toast.
export function normalizeGuidance(parsed) {
  const doc = Array.isArray(parsed) ? { facets: parsed } : parsed;
  if (!doc || typeof doc !== "object") throw new Error("not a guidance document");
  const out = {};
  if ("context" in doc) {
    if (typeof doc.context !== "string") throw new Error("context must be a string");
    out.context = doc.context;
  }
  if ("facets" in doc) {
    if (!Array.isArray(doc.facets)) throw new Error("facets must be an array");
    out.facets = doc.facets.map((f) => {
      if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("each facet must be an object");
      // Extract Fields' Copy writes a bare list of keyed objects too, which
      // would pass for facets with no label and no values and wipe the
      // taxonomy they replaced. A field names its source; a facet never does.
      if ("source" in f) throw new Error("a list of fields, not facets");
      // The editor trims a description as it syncs, so one that isn't text
      // throws there, after the paste, leaving a taxonomy on screen that Save
      // never sees.
      if (f.description != null && typeof f.description !== "string") throw new Error("a facet's description must be text");
      return { ...f, key: f.key || facetKey(f.label), values: Array.isArray(f.values) ? f.values : [] };
    });
  }
  if (out.context === undefined && out.facets === undefined) throw new Error("no context or facets");
  return out;
}

// A facet as a board stores it: its key, label and values, `single` only when
// it's on, a description only when there is one, trimmed. The board editor
// writes every facet through this, so the guidance Copy writes it too, and a
// template's facets are checked into it (checkTemplate): the templates page
// shows and copies a taxonomy exactly as a board made from it holds it.
export function facetOut(f) {
  const out = { key: f.key, label: f.label, values: f.values };
  if (f.single) out.single = true;
  if (f.description && f.description.trim()) out.description = f.description.trim();
  return out;
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// What fields Paste accepts: a list of AI-extracted fields, each reduced to
// what an extracted field carries. A missing `source` is filled in, the way
// guidance Paste fills in a facet's key; any other source is refused, since
// live data, file metadata and detection belong to the board, not to the
// document. The types are checked so that nothing after the paste throws: an
// instruction that isn't text, for one, makes collect() throw at Save. The
// values themselves (a key's spelling, a known kind, an instruction's length)
// are Save's to judge.
//
// Throws, naming the field where there is one; the caller turns that into
// the warn toast.
export function normalizeFields(parsed) {
  if (!Array.isArray(parsed)) throw new Error("not a list of fields");
  return parsed.map((f) => {
    if (!isObject(f)) throw new Error("each field must be an object");
    // A taxonomy is a bare list of keyed objects too. Its values give it
    // away: a field's list is its `options`.
    if ("values" in f) throw new Error("that's a taxonomy, not a list of fields");
    if (typeof f.key !== "string" || !f.key) throw new Error("each field needs a key");
    const source = f.source ?? "extract";
    if (source !== "extract") throw new Error(`"${f.key}" isn't an AI-extracted field`);
    if (f.kind !== undefined && typeof f.kind !== "string") throw new Error(`the kind of "${f.key}" must be text`);
    if (f.instruction !== undefined && typeof f.instruction !== "string")
      throw new Error(`the instruction of "${f.key}" must be text`);
    if (f.options !== undefined && !(Array.isArray(f.options) && f.options.every((o) =>
      isObject(o) && typeof o.value === "string" && (o.hint === undefined || typeof o.hint === "string"))))
      throw new Error(`the options of "${f.key}" must be a list of { value, hint }`);
    const out = { key: f.key, source: "extract" };
    if (f.kind !== undefined) out.kind = f.kind;
    if (f.instruction !== undefined) out.instruction = f.instruction;
    if (f.options !== undefined) out.options = f.options.map((o) => (o.hint === undefined ? { value: o.value } : { value: o.value, hint: o.hint }));
    return out;
  });
}

// A match list as a save sends it: each value trimmed, a row with no value
// dropped, a hint only where there is one, every option `{ value, hint? }`.
// The Mapping pane's collect() checks what's left.
export const cleanOptions = (options) => (Array.isArray(options) ? options : [])
  .map((o) => ({ value: (o.value || "").trim(), ...(o.hint && o.hint.trim() ? { hint: o.hint.trim() } : {}) }))
  .filter((o) => o.value);

// An AI-extracted field as a board stores it: its key, source and kind, its
// instruction trimmed and only when there is one, its match list cleaned and
// only when something is left. The Mapping pane writes extracted fields
// through this (emitField), so its Copy and its save do, and a template's
// fields are checked into it, so they're what a board made from it holds.
export function extractedFieldOut(f) {
  const out = { key: f.key, source: "extract", kind: f.kind };
  if (f.instruction?.trim()) out.instruction = f.instruction.trim();
  const options = cleanOptions(f.options);
  if (options.length) out.options = options;
  return out;
}

// The paste itself (templates-plan.md, D16): the pasted fields replace the
// board's AI-extracted ones, every other field stays in its order, and the
// pasted ones follow in theirs. `cap` is the extract source's own, passed in
// so the number lives where the source table declares it.
//
// Refused, and nothing changes, when the paste holds more than the cap, or
// when two fields would share a key: one the board keeps, or one the paste
// names twice. The card key survives only if its field is in the paste;
// `cleared` names it when it doesn't.
//
//   → { fields, cardBy, cleared }  or  { refused: "cap" | "key", key? }
export function mergeExtracted(fields, pasted, { cardBy = null, cap }) {
  if (pasted.length > cap) return { refused: "cap" };
  const kept = fields.filter((f) => f.source !== "extract");
  const taken = new Set(kept.map((f) => f.key));
  for (const f of pasted) {
    if (taken.has(f.key)) return { refused: "key", key: f.key };
    taken.add(f.key);
  }
  const keepsCard = !cardBy || pasted.some((f) => f.key === cardBy);
  return { fields: [...kept, ...pasted], cardBy: keepsCard ? cardBy : null, cleared: keepsCard ? null : cardBy };
}

// ── A template's file (C1) ─────────────────────────────────────────────────
// templates/<slug>/template.json: a name and a line about it, the two
// sections above, the board type they're for, a card key, screenshots. This
// checks the JSON. The folder's images are server/templates.js's to check,
// since this module never touches a disk, and so is the mapping a board made
// from it would save, which takes the server's own rule (validateMapping).
//
// Throws on the first thing wrong, naming it. Returns the template as
// checked: both sections as a board made from it stores them (facetOut,
// extractedFieldOut), the guidance whole, `{ context, facets }`, the way its
// Copy writes it, and the rest trimmed.

// The keys C1 names. Any other is refused rather than ignored: a typo like
// "boardtype" would otherwise make a Files template without a word. So is a
// key inside a section that a board doesn't keep, or in a screenshot: a
// misspelled "singel" would load and then do nothing.
const TEMPLATE_KEYS = ["name", "description", "author", "boardType", "cardKey", "guidance", "fields", "screenshots"];
const GUIDANCE_KEYS = ["context", "facets"];
const FACET_KEYS = ["key", "label", "values", "single", "description"];
const FIELD_KEYS = ["key", "source", "kind", "instruction", "options"];
const SCREENSHOT_KEYS = ["file", "caption"];
const onlyKeys = (obj, keys, what) => {
  const unknown = Object.keys(obj).find((k) => !keys.includes(k));
  if (unknown) throw new Error(`"${unknown}" isn't a ${what} key`);
};
// The folder's name, which is the template's address (/templates?template=…).
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A screenshot's file: a plain lowercase name, WebP or JPEG by its extension.
// Its bytes and its size are checked where the file is read.
const SCREENSHOT_FILE = /^[a-z0-9][a-z0-9_-]*\.(?:webp|jpe?g)$/;
const SCREENSHOTS_MAX = 3;

// What a template's facets must be on top of what Paste takes. A paste lands
// in the board editor, where a facet with no values shows and gets fixed; a
// template goes straight into a board, so a facet that would load and never
// be tagged is refused here. The tagger asks for each facet by its key, with
// its values as the only answers (worker.js buildPrompt), a tag is stored as
// "key/value", and the tagger's own verdict on an item takes the key "fit".
function checkFacets(facets) {
  const keys = new Set();
  for (const f of facets) {
    if (typeof f.key !== "string" || !f.key) throw new Error("each facet needs a key, as text");
    if (f.key.includes("/")) throw new Error(`the facet key "${f.key}" can't hold a "/"`);
    if (f.key === "fit") throw new Error(`the facet key "fit" is the tagger's own verdict, so that facet would never be asked`);
    if (keys.has(f.key)) throw new Error(`two facets have the key "${f.key}"`);
    keys.add(f.key);
    if (typeof f.label !== "string" || !f.label.trim()) throw new Error(`facet "${f.key}" needs a label, as text`);
    if (!f.values.length || !f.values.every((v) => typeof v === "string" && v.trim()))
      throw new Error(`facet "${f.key}" needs its values, a list of text`);
    if (new Set(f.values).size < f.values.length) throw new Error(`facet "${f.key}" lists a value twice`);
    if (f.single !== undefined && typeof f.single !== "boolean") throw new Error(`"single" on facet "${f.key}" must be true or false`);
  }
}

export function checkTemplate(doc, slug) {
  if (!SLUG.test(slug)) throw new Error("the folder's name must be lowercase letters, digits and dashes");
  if (!isObject(doc)) throw new Error("template.json must hold an object");
  onlyKeys(doc, TEMPLATE_KEYS, "template");
  const text = (key) => {
    if (typeof doc[key] !== "string" || !doc[key].trim()) throw new Error(`"${key}" must be text`);
    return doc[key].trim();
  };
  const out = { slug, name: text("name"), description: text("description") };
  if (doc.author !== undefined) out.author = text("author");
  // Each section's own words come back prefixed with its name, since the
  // Paste rules were written for one section at a time.
  const section = (name, check) => {
    try { return check(doc[name]); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  };
  if (doc.guidance !== undefined) {
    const guidance = section("guidance", (g) => {
      if (isObject(g)) onlyKeys(g, GUIDANCE_KEYS, "guidance");
      const read = normalizeGuidance(g);
      const facets = read.facets || [];
      for (const f of facets) onlyKeys(f, FACET_KEYS, "facet");
      const reserved = facetsReservedKeyError(facets);
      if (reserved) throw new Error(reserved);
      checkFacets(facets);
      return read;
    });
    out.guidance = { context: (guidance.context || "").trim(), facets: (guidance.facets || []).map(facetOut) };
  }
  if (doc.fields !== undefined) {
    out.fields = section("fields", (list) => {
      const fields = normalizeFields(list);
      for (const f of list) onlyKeys(f, FIELD_KEYS, "field");
      // A match list with nothing usable in it: the Mapping pane refuses one
      // at Save (collect()), and the write-out would drop it, leaving a plain
      // text field where the file asked for a list.
      for (const f of fields) if (f.options && !cleanOptions(f.options).length) throw new Error(`the options of "${f.key}" are empty`);
      return fields.map(extractedFieldOut);
    });
  }
  // Something to set up: sections with nothing in them would make a blank
  // board with a name.
  if (!out.guidance?.context && !out.guidance?.facets.length && !out.fields?.length)
    throw new Error("a template needs a context, a facet or a field to set up");
  if (doc.boardType !== undefined) out.boardType = text("boardType");
  if (doc.cardKey !== undefined) {
    // A data board's cards are its type's entries; a save refuses a card key
    // there (mapping-rules.js), so a template can't name one.
    if (out.boardType) throw new Error("a card key is for a Files board, and this one has a boardType");
    out.cardKey = text("cardKey");
    if (!out.fields?.some((f) => f.key === out.cardKey)) throw new Error(`the card key "${out.cardKey}" names none of the fields`);
  }
  out.screenshots = [];
  if (doc.screenshots !== undefined) {
    if (!Array.isArray(doc.screenshots)) throw new Error("screenshots must be a list");
    if (doc.screenshots.length > SCREENSHOTS_MAX) throw new Error(`a template has ${SCREENSHOTS_MAX} screenshots at most`);
    for (const s of doc.screenshots) {
      if (!isObject(s) || typeof s.file !== "string" || !SCREENSHOT_FILE.test(s.file))
        throw new Error("each screenshot is { file, caption }, its file a lowercase .webp, .jpg or .jpeg name");
      onlyKeys(s, SCREENSHOT_KEYS, "screenshot");
      if (s.caption !== undefined && typeof s.caption !== "string") throw new Error(`the caption of ${s.file} must be text`);
      if (out.screenshots.some((x) => x.file === s.file)) throw new Error(`${s.file} is listed twice`);
      const caption = s.caption?.trim();
      out.screenshots.push(caption ? { file: s.file, caption } : { file: s.file });
    }
  }
  return out;
}
