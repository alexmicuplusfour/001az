// Document file fields — pdf / docx / txt / md / csv. The values come from work
// the media source handlers (server/sources/{pdf,docx,text}.js) already do at
// ingest: the PDF page count + title from pdfinfo, and word/line counts from
// the text they extract (docx sidecar / plain-text buffer), surfaced on `meta`.
// `pages`/`title` are pdf-only; word/line counts apply to text-bearing docs —
// any field the handler didn't fill is simply null on that instance.
export const group = "Documents";
export const appliesTo = ["pdf", "docx", "text"];

export const fields = [
  { key: "pages", fn: "pages", kind: "number", label: "Pages" },
  { key: "title", fn: "title", kind: "text", label: "Title" },
  { key: "word_count", fn: "word_count", kind: "number", label: "Word count" },
  { key: "line_count", fn: "line_count", kind: "number", label: "Line count" },
];

export function extract(ctx) {
  return {
    pages: ctx.meta?.pages ?? null,
    title: ctx.meta?.title || null,
    word_count: ctx.meta?.word_count ?? null,
    line_count: ctx.meta?.line_count ?? null,
  };
}
