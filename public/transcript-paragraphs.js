// Paragraphs from transcript turns — the pure half of the lightbox transcript
// (detail-view.js renders what this plans; capability-present.js is the
// precedent for presentation logic kept import-free and node-testable — the
// renderer's import chain is browser-bound, this module is not).
//
// Where breaks actually come from: whisper's VAD only exposes silences longer
// than ~2s as timestamp gaps — shorter spoken pauses are absorbed into
// abutting segments (measured on a live clip: a deliberate pause produced
// 4.7 → 4.7). So on continuous speech the LENGTH CAP does most of the
// paragraphing, and the gap rule fires on real, long pauses. A speaker change
// also breaks — dormant until diarization lands (structured-transcripts-plan.md
// slice 3): today's turns carry no speaker, and null === null never breaks.
//
// turns: payload.transcript_turns as stored — [{ start, end, text, speaker? }].
// Returns [{ start, text }]: text space-joined across the paragraph's turns,
// start = its first turn's (for click-to-seek). Empty/whitespace turns are
// skipped; null/[] in → [] out (the caller falls back to the flat transcript,
// then the waveform). Overlapping turns (a future diarizing wire) make the
// gap negative, which simply never breaks.
export function transcriptParagraphs(turns, { gap = 1.25, maxChars = 600 } = {}) {
  const out = [];
  let cur = null; // { start, text, speaker } — speaker held for the break rule only
  let prevEnd = 0;
  for (const t of turns || []) {
    const text = (t?.text || "").trim();
    if (!text) continue;
    const speaker = t.speaker ?? null;
    if (cur && (Number(t.start) - prevEnd >= gap || speaker !== cur.speaker || cur.text.length >= maxChars)) {
      out.push({ start: cur.start, text: cur.text });
      cur = null;
    }
    if (cur) cur.text += " " + text;
    else cur = { start: Number(t.start) || 0, text, speaker };
    prevEnd = Number(t.end) || prevEnd;
  }
  if (cur) out.push({ start: cur.start, text: cur.text });
  return out;
}
