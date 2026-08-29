// Paragraph planning for the lightbox transcript — pure and node-testable with
// NO browser stub (transcript-paragraphs.js is import-free by design; the
// renderer's chain is browser-bound). jobs-row.test.js is the shape precedent:
// pin what the presentation layer SAYS, leave the DOM to the live pass.
import test from "node:test";
import assert from "node:assert/strict";
import { transcriptParagraphs, speakerBands } from "../public/transcript-paragraphs.js";

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
    speaker: null,
  }]);
});

test("a long silence (the only kind VAD exposes as a timestamp gap) breaks a paragraph", () => {
  assert.deepEqual(transcriptParagraphs([T(0, 2, "One."), T(4.5, 6, "Two.")]),
    [{ start: 0, text: "One.", speaker: null }, { start: 4.5, text: "Two.", speaker: null }]);
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

test("a speaker change breaks with no gap at all, and each paragraph carries its slot", () => {
  const paras = transcriptParagraphs([T(0, 1, "Hi.", "S1"), T(1, 2, "Hey.", "S2"), T(2, 3, "How are you?", "S2")]);
  assert.deepEqual(paras, [
    { start: 0, text: "Hi.", speaker: "S1" },
    { start: 1, text: "Hey. How are you?", speaker: "S2" },
  ]);
  // Speakerless turns never trip that rule (an undiarized engine's output).
  assert.equal(transcriptParagraphs([T(0, 1, "a"), T(1, 2, "b")]).length, 1);
});

test("empty and whitespace turns are skipped; null/[] plan nothing (caller falls back)", () => {
  assert.deepEqual(transcriptParagraphs([T(0, 1, "  "), T(1, 2, "Real."), T(2, 3, "")]),
    [{ start: 1, text: "Real.", speaker: null }]);
  assert.deepEqual(transcriptParagraphs(null), []);
  assert.deepEqual(transcriptParagraphs([]), []);
});

test("overlapping turns (a future diarizing wire) make a negative gap, which never breaks", () => {
  assert.equal(transcriptParagraphs([T(0, 5, "One speaker."), T(3, 8, "Overlapping, same speaker.")]).length, 1);
});

test("speakerBands: same-speaker runs merge; a change or an unattributed turn ends the band", () => {
  const bands = speakerBands([
    T(0, 2, "a", "S1"), T(2, 5, "b", "S1"),   // one run despite two turns
    T(5, 8, "c", "S2"),                        // speaker change → new band
    T(8, 9, "d"),                              // unattributed speech → no band spans it
    T(9, 12, "e", "S2"),                       // same speaker again, but a fresh band
  ]);
  assert.deepEqual(bands, [
    { start: 0, end: 5, speaker: "S1" },
    { start: 5, end: 8, speaker: "S2" },
    { start: 9, end: 12, speaker: "S2" },
  ]);
  assert.deepEqual(speakerBands(null), []);
  assert.deepEqual(speakerBands([T(0, 1, "x")]), [], "no diarization → no strip at all");
});
