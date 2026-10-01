// Board templates on the server (planning/templates-plan.md, C1 and C6): the
// folders under templates/, one per template, read once when the server
// starts. Templates ship in the image beside the code that reads them (D7),
// so there's nothing to reload: a new one comes with the next image.
//
// Each folder is checked three ways, and one that fails any of them is left
// out with its reason, never taking the server or the other templates with
// it, the way plugin-loader.js's loadAll treats a plugin that won't load:
//   - its JSON, by template-core.js: the rules its Paste buttons apply, and
//     what a template needs on top of them;
//   - its images, here, since this is the side that reads the disk;
//   - the mapping a board made from it would save, by validateMapping, the
//     rule a save applies, so a template that's listed can be made. Except
//     against a plugin type's own starting fields (mappingFor, below).
// test/templates.test.js runs this on the real folder, so a template that
// fails fails CI.
import fs from "node:fs";
import path from "node:path";
import { checkTemplate } from "../public/template-core.js";
import { validateMapping } from "./mapping-rules.js";
import { getConnector, BUILT_IN_TYPES } from "./connectors/index.js";

// About three to a template at most (template-core.js counts them) keeps 30
// templates under ~20 MB in the repo and the image (D6).
export const SCREENSHOT_BYTES_MAX = 200 * 1024;

// What a file's first bytes say it is: a WebP or a JPEG image, or neither.
function imageFormat(head) {
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

// The folder's images: every listed one there, every file there listed
// (dotfiles aside), each the format its name says, and small enough.
function checkScreenshots(folder, t) {
  const listed = new Set(t.screenshots.map((s) => s.file));
  for (const name of fs.readdirSync(folder)) {
    if (name === "template.json" || name.startsWith(".")) continue;
    if (!listed.has(name)) throw new Error(`${name} is in the folder but not in screenshots`);
  }
  for (const { file } of t.screenshots) {
    const p = path.join(folder, file);
    if (!fs.existsSync(p)) throw new Error(`${file} is in screenshots but not in the folder`);
    const bytes = fs.readFileSync(p);
    if (bytes.length > SCREENSHOT_BYTES_MAX)
      throw new Error(`${file} is ${Math.ceil(bytes.length / 1024)} KB, over the ${SCREENSHOT_BYTES_MAX / 1024} KB a screenshot may be`);
    const want = file.endsWith(".webp") ? "webp" : "jpeg";
    if (imageFormat(bytes) !== want) throw new Error(`${file} isn't a ${want === "webp" ? "WebP" : "JPEG"} image`);
  }
}

// The mapping a board made from this template would save (C5). A built-in
// type's starting mapping with the template's fields after its own, so a key
// that clashes with a starting field is caught here. A plugin's type exists
// only where its plugin is installed, and checking against it would list a
// template on one server and drop it on another, so its fields are checked
// alone, and a clash with its starting fields is the save's to name. A Files
// board's mapping is the fields and the card key.
function mappingFor(t) {
  const fields = t.fields || [];
  if (!t.boardType) return { fields, ...(t.cardKey ? { card: { by: t.cardKey } } : {}) };
  if (!BUILT_IN_TYPES.has(t.boardType)) return { fields };
  const start = getConnector(t.boardType).manifest.template;
  return { ...start, fields: [...start.fields, ...fields] };
}

// Every template under `dir`, in the order of their folders' names, as
// checked (template-core.js checkTemplate), and every one left out, with why.
// No folder at all is no templates.
//   → { templates: [template…], failures: [{ slug, error }…] }
export function loadTemplates(dir) {
  const templates = [];
  const failures = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { templates, failures }; }
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const slug of folders) {
    const folder = path.join(dir, slug);
    try {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(folder, "template.json"), "utf8")); }
      catch (e) { throw new Error(e.code === "ENOENT" ? "there's no template.json" : `template.json isn't JSON (${e.message})`); }
      const t = checkTemplate(doc, slug);
      checkScreenshots(folder, t);
      const err = validateMapping(mappingFor(t));
      if (err) throw new Error(err);
      templates.push(t);
    } catch (e) {
      failures.push({ slug, error: e.message });
    }
  }
  return { templates, failures };
}
