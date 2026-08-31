// Fixture: an ON-DEVICE object detector — advertises `detects`, carries its own
// wire.detect, and is selected by NAME rather than by a key row. That is the
// shape that made `detect_provider` a dangling pointer: no ai_keys row exists,
// so no deleteAiKey cascade reaches it, and uninstall used to clear the embed
// and transcribe pointers while forgetting this one.
export default function (ctx) {
  return {
    label: "Acme Detector",
    description: "on-device object detection test provider (fixture)",
    wire: { tag: null, testKey: null, detect: async () => ({ objects: [], usage: {} }) },
    defaultModel: null,
    models: [],
    research: false,
    keyless: true,
    onDevice: true, // in-process: no connections to register, no pacing
    detects: { default: "acme-detect-1", models: [{ id: "acme-detect-1", note: "test" }] },
  };
}
