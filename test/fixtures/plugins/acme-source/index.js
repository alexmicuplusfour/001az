// A `source` plugin (the 4th plugin kind) — a place files come FROM, installed
// from a URL. Returns the same { manifest, backend } shape a built-in source
// module (folder/ftp/s3) exports; the ingest modal + browse are already generic,
// so it needs no client code. manifest.name must equal the plugin id.
export default function (ctx) {
  return {
    manifest: {
      name: "acme.filedrop",
      label: "Acme File Drop",
      description: "A demo remote file source",
      browsable: true,
      needsConnection: false,
      sourceSchema: [],
    },
    // backend({ source, conn }) → { list, fetch, test }; a real one would talk to
    // the remote over ctx.fetchJson or an npm client (basic-ftp, aws-sdk, …).
    backend: () => ({
      async list() { return { entries: [], truncated: false }; },
      async fetch() { throw new Error("demo source has no files"); },
      async test() { return { ok: true }; },
    }),
  };
}
