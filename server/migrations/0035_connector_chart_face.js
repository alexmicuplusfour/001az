// Finance boards default to the price chart. The symbol tile was never a face —
// it's what a card draws when it has no rendered face at all — but it used to be
// offered as a peer choice in the mapping modal, and it was the DEFAULT: neither
// connector template declared `mapping.face`, so every crypto/stocks board was
// born tile-faced and the chart was opt-in. The templates now ship the chart face
// and the modal offers no tile option; this carries existing boards across.
//
//  1. Boards on a built-in finance connector whose face is absent or an explicit
//     {from:"raw"} (the two spellings of "no face") get the chart face.
//  2. Their entities that never rendered a face are marked due NOW, so the
//     liveness sweep renders each chart on its next tick. Deliberately NOT the
//     item pipeline: re-routing to `pending_face` would flow every already-tagged
//     vehicle back into the tag leg afterwards and re-bill the whole board's
//     tagging for a purely visual backfill.
//
// The domain list and the producer/period are a one-time snapshot of what those
// two manifests declare today (both accept "1y"); a domain added later ships its
// own template face and needs no migration. File boards never match — they carry
// no `mapping.input.connector`. Fresh installs have no boards: a no-op.
const DOMAINS = ["crypto", "stocks"];
const CHART_FACE = '{"from":"connector","producer":"chart","period":"1y"}';

export async function up(client) {
  const { rowCount } = await client.query(
    `UPDATE boards
     SET mapping = jsonb_set(mapping, '{face}', $1::jsonb, true)
     WHERE mapping->'input'->>'connector' = ANY($2::text[])
       AND COALESCE(mapping->'face'->>'from', 'raw') = 'raw'`,
    [CHART_FACE, DOMAINS]
  );
  if (!rowCount) return;
  console.log(`migration 0035: chart face set on ${rowCount} finance board(s)`);

  // Every unrendered entity on a chart-faced finance board — including boards
  // that already had the face configured but never rendered it (cadence Off had
  // no sweep term before this ships, so those were stuck too).
  const { rowCount: due } = await client.query(
    `UPDATE entities e SET refresh_at = $1
     FROM boards b
     WHERE b.id = e.board_id
       AND b.mapping->'input'->>'connector' = ANY($2::text[])
       AND b.mapping->'face'->>'from' = 'connector'
       AND e.face_at IS NULL`,
    [Date.now(), DOMAINS]
  );
  if (due) console.log(`migration 0035: ${due} entit${due === 1 ? "y" : "ies"} queued for a first chart render`);
}
