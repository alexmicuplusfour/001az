// Universal file fields — metadata every file carries, regardless of kind.
// Pure data (a field catalog) + a pure extractor over the ctx the registry
// builds from a stored file entry. `appliesTo: "*"` = always applicable.
//
// Dates read from the ctx timestamps, which the ingest path stamps onto the
// file entry (capture-once, project-many). A browser upload can only supply
// `modified` (from File.lastModified) and leaves `created` null — the web
// platform exposes no creation date. A future folder / fs.stat ingestion fills
// both from mtimeMs/birthtimeMs with no change here.
export const group = "All files";
export const appliesTo = "*";

export const fields = [
  { key: "file_size", fn: "file_size", kind: "number", label: "File size" },
  { key: "extension", fn: "extension", kind: "text", label: "Extension" },
  { key: "file_type", fn: "file_type", kind: "text", label: "Type" },
  { key: "added", fn: "added", kind: "date", label: "Added to board" },
  { key: "modified", fn: "modified", kind: "date", label: "Modified" },
  {
    key: "created", fn: "created", kind: "date", label: "Created",
    note: "Unavailable for browser uploads; populated by folder ingestion.",
  },
];

const isoDate = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

export function extract(ctx) {
  return {
    file_size: ctx.size ?? null,
    extension: ctx.ext || null,
    file_type: ctx.kind || null,
    added: isoDate(ctx.addedAt),
    modified: isoDate(ctx.modifiedAt),
    created: isoDate(ctx.createdAt),
  };
}
