// Helpers shared by the text-bearing source handlers (text, docx). Pure —
// no handler state; each handler owns its own storage dirs and lifecycle.
// (The page-peek face renderer moved to server/faces/text-peek.js.)

// Word + line counts for text-bearing documents (txt/md/csv and docx's
// extracted text). Pure — the handler already has the string in memory.
export function textCounts(text) {
  const s = text || "";
  return {
    word_count: (s.match(/\S+/g) || []).length,
    line_count: s ? s.split(/\r\n|\r|\n/).length : 0,
  };
}
