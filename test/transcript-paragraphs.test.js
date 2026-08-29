// Paragraph planning for the lightbox transcript — pure and node-testable with
// NO browser stub (transcript-paragraphs.js is import-free by design; the
// renderer's chain is browser-bound). jobs-row.test.js is the shape precedent:
// pin what the presentation layer SAYS, leave the DOM to the live pass.
import test from "node:test";
import assert from "node:assert/strict";
import { transcriptParagraphs } from "../public/transcript-paragraphs.js";

const T = (start, end, text, speaker) => ({ start, end, text, ...(speaker !== undefined ? { speaker } : {}) });

test("abutting turns under the cap are ONE paragraph (the slice-1 live-verify clip)", () => {
  // Real shape from the live verify: whisper's VAD absorbs short spoken pauses,
  // so these turns abut (1.8→1.8, 4.7→4.7) — no gap ever fires here.
  const turns = [
    T(0, 1.8, "Hello there."),
    T(1.8, 4.7, "This is the first sentence of the recording."),
    T(4.7, 9.5, "And after a short pause, this is the second sentence, spoken a moment later."),
  ];
  assert.deepEqual(transcriptParagraphs(turns), [{
    start: 0,
    text: "Hello there. This is the first sentence of the recording. And after a short pause, this is the second sentence, spoken a moment later.",
  }]);
});

test("a long silence (the only kind VAD exposes as a timestamp gap) breaks a paragraph", () => {
  assert.deepEqual(transcriptParagraphs([T(0, 2, "One."), T(4.5, 6, "Two.")]),
    [{ start: 0, text: "One." }, { start: 4.5, text: "Two." }]);
  // Under the threshold → still one paragraph.
  assert.equal(transcriptParagraphs([T(0, 2, "One."), T(3, 4, "Two.")]).length, 1);
});

test("the length cap paragraphs continuous speech, losing nothing", () => {
  const turns = Array.from({ length: 40 }, (_, i) => T(i, i + 1, "spoken words keep on coming without any pause at all."));
  const paras = transcriptParagraphs(turns);
  assert.ok(paras.length > 1, "a monologue does not become one giant block");
  assert.ok(paras.every((p) => p.text.length < 700), "each paragraph stays near the cap (one turn of spill)");
  assert.equal(paras.map((p) => p.text).join(" "), turns.map((t) => t.text).join(" "), "every word survives");
  assert.equal(paras[0].start, 0);
});

test("a speaker change breaks with no gap at all — the diarization seam, dormant today", () => {
  const paras = transcriptParagraphs([T(0, 1, "Hi.", "S1"), T(1, 2, "Hey.", "S2"), T(2, 3, "How are you?", "S2")]);
  assert.deepEqual(paras, [{ start: 0, text: "Hi." }, { start: 1, text: "Hey. How are you?" }]);
  // Speakerless turns (today's whisper output) never trip that rule.
  assert.equal(transcriptParagraphs([T(0, 1, "a"), T(1, 2, "b")]).length, 1);
});

test("empty and whitespace turns are skipped; null/[] plan nothing (caller falls back)", () => {
  assert.deepEqual(transcriptParagraphs([T(0, 1, "  "), T(1, 2, "Real."), T(2, 3, "")]),
    [{ start: 1, text: "Real." }]);
  assert.deepEqual(transcriptParagraphs(null), []);
  assert.deepEqual(transcriptParagraphs([]), []);
});

test("overlapping turns (a future diarizing wire) make a negative gap, which never breaks", () => {
  assert.equal(transcriptParagraphs([T(0, 5, "One speaker."), T(3, 8, "Overlapping, same speaker.")]).length, 1);
});
