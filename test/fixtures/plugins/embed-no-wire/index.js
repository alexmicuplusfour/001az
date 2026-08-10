// Fixture: advertises embed with NO wire.embed — acme-embed's pre-7a shape. It
// used to load and then throw at the first embedTexts call (desc.wire.embed on
// null); the loader now rejects it at install, where the error can name the fix.
export default function () {
  return {
    label: "No Wire",
    description: "embed advertiser without an embed wire (fixture)",
    wire: null,
    keyless: true,
    onDevice: true,
    embeds: { default: "now-1", models: [{ id: "now-1", note: "test" }] },
  };
}
