// Repair upload names multer decoded as Latin-1. Browsers send a filename as
// raw UTF-8 and multer read it byte-per-char until ingest.js set
// defParamCharset, so "this？" (EF BC 9F) was stored as "thisï¼\x9F".
//
// Uploads only. A file-ingested item (folder, S3, FTP) carries
// payload.provenance, and its name came from a listing, never through multer.
// Such a name can be a genuine Latin-1 one that passes both checks in
// repairName — "3×½ scale.png" is D7 BD as bytes, valid UTF-8 — and a repair
// would mangle it for good. An upload made before this migration went through
// the misreading multer, whatever its name.
//
// The name was kept in three places: each file entry's original_name (the
// card title, the download name), job_log.target (History), and
// alert_matches.label (frozen at match time). The two copies are repaired
// only where they are the repaired item's and still read the misread name, so
// a connector identity or any other label is never touched. Rows for items
// since deleted can't be tied to an upload and keep their name.
//
// Re-encoding a misread name as Latin-1 gives back the bytes the browser
// sent, and those decode as UTF-8. A name that was never misread fails one of
// the two checks in repairName and is left alone: a genuine "café" is E9 as a
// byte, which isn't valid UTF-8 on its own, and anything past U+00FF can't
// have come from a byte at all.
const LATIN1_HIGH = /[\u0080-ÿ]/;
const BEYOND_LATIN1 = /[^\u0000-ÿ]/;

export function repairName(name) {
  if (typeof name !== "string" || !LATIN1_HIGH.test(name) || BEYOND_LATIN1.test(name)) return name;
  const bytes = Buffer.from(name, "latin1");
  const fixed = bytes.toString("utf8");
  // Invalid UTF-8 decodes to U+FFFD, which doesn't encode back to the same bytes.
  return Buffer.from(fixed, "utf8").equals(bytes) ? fixed : name;
}

export async function up(client) {
  // The candidates only: an upload with a name holding a char in
  // U+0080-U+00FF. The pattern rides as a parameter so the range is real
  // characters, not an escape the regex dialect might read differently. The
  // CASE, not a jsonb_typeof test beside it: Postgres doesn't promise to
  // evaluate that first, and jsonb_array_elements on a non-array throws —
  // which here would fail the boot.
  const { rows: items } = await client.query(
    `SELECT id, payload->'files' AS files FROM items
      WHERE NOT (payload ? 'provenance')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(payload->'files') = 'array' THEN payload->'files' ELSE '[]'::jsonb END) f
            WHERE f->>'original_name' ~ $1)`,
    ["[\u0080-ÿ]"]
  );
  for (const { id, files } of items) {
    for (let i = 0; i < files.length; i++) {
      const old = files[i]?.original_name;
      const name = repairName(old);
      if (name === old) continue;
      // The one key, in place — not the entry round-tripped through JSON.
      await client.query(
        "UPDATE items SET payload = jsonb_set(payload, ARRAY['files', $2, 'original_name'], to_jsonb($3::text)) WHERE id=$1",
        [id, String(i), name]
      );
      await client.query("UPDATE job_log SET target=$3 WHERE item_id=$1 AND target=$2", [id, old, name]);
      await client.query("UPDATE alert_matches SET label=$3 WHERE item_id=$1 AND label=$2", [id, old, name]);
    }
  }
}
