// cluster-core.js — the pure spherical k-means under BOTH cluster flavors
// (planning/pattern-surfaces-plan.md, Stage 3 + 3-meaning): patterns.js runs
// it in the browser over chip vectors; the meaning-clusters route runs it in
// node over embeddings. Dependency-free on purpose — the determinism rules
// have exactly one home (the tests already import public modules into node;
// the server doing the same for a pure module is the same move).
//
// Everything about the seeding serves one requirement: THE SAME DATA MUST
// ALWAYS GIVE THE SAME PARTITION, whatever order the rows arrived in. Seeds
// come from the data — first the row farthest from the global centroid, then
// repeatedly the row farthest from every chosen seed — with ties broken by
// the caller's stable key strings, never by array position.

export const K = 8;         // level 1
export const K_STEP = 4;    // centers bought per "more" step
export const LEVEL_MAX = 5; // K 8..24
export const MIN_GROUP = 8;   // a group smaller than this is not a cluster on any board
export const MIN_SHARE = 0.03; // …nor one under 3% of participants —
export const FLOOR_CAP = 30;   // — but 3% uncapped scales with the board and was measured
                               // executing a real 29-member cluster at N=1853, so it stops here.

export const kFor = (level, n) => Math.min(K + K_STEP * (level - 1), n);
export const floorFor = (n) => Math.max(MIN_GROUP, Math.min(n * MIN_SHARE, FLOOR_CAP));

// vecs: Float64Array(n*d) of UNIT rows; keys: n stable identity strings.
// Returns the partition and `dotSeed(i, c)` — row i against converged
// centroid c — which is all a medoid pick needs: Σₒ dot(i,o) = dot(i, Σₒ o)
// by bilinearity, and the converged seeds row IS that sum, normalized by a
// positive scalar that can't move an argmax.
export function clusterVectors(vecs, n, d, keys, k) {
  const dot = (ao, B, bo) => {
    let s = 0;
    for (let j = 0; j < d; j++) s += vecs[ao + j] * B[bo + j];
    return s;
  };
  const pick = (score) => {
    let best = 0, bs = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = score(i);
      if (s > bs || (s === bs && keys[i] < keys[best])) { bs = s; best = i; }
    }
    return best;
  };

  const centroid = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) centroid[j] += vecs[i * d + j];
  {
    let s = 0;
    for (let j = 0; j < d; j++) s += centroid[j] ** 2;
    s = Math.sqrt(s) || 1;
    for (let j = 0; j < d; j++) centroid[j] /= s;
  }
  // `best[i]` carries row i's similarity to its nearest chosen seed, updated
  // once per new seed — the same scores (and so the same argmaxes and ties)
  // as re-dotting every candidate against every prior seed, at 1/k the work.
  const seeds = new Float64Array(k * d);
  const best = new Float64Array(n);
  const s0 = pick((i) => 1 - dot(i * d, centroid, 0));
  for (let j = 0; j < d; j++) seeds[j] = vecs[s0 * d + j];
  for (let i = 0; i < n; i++) best[i] = dot(i * d, seeds, 0);
  for (let c = 1; c < k; c++) {
    const si = pick((i) => 1 - best[i]);
    for (let j = 0; j < d; j++) seeds[c * d + j] = vecs[si * d + j];
    for (let i = 0; i < n; i++) { const dd = dot(i * d, seeds, c * d); if (dd > best[i]) best[i] = dd; }
  }

  const assign = new Int32Array(n);
  for (let iter = 0; iter < 30; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bi = 0, bs = -1;
      for (let c = 0; c < k; c++) { const s = dot(i * d, seeds, c * d); if (s > bs) { bs = s; bi = c; } }
      if (assign[i] !== bi) { assign[i] = bi; moved++; }
    }
    seeds.fill(0);
    for (let i = 0; i < n; i++) { const o = assign[i] * d; for (let j = 0; j < d; j++) seeds[o + j] += vecs[i * d + j]; }
    for (let c = 0; c < k; c++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += seeds[c * d + j] ** 2;
      s = Math.sqrt(s) || 1; // an emptied group's zero centroid stays zero
      for (let j = 0; j < d; j++) seeds[c * d + j] /= s;
    }
    if (!moved) break;
  }
  return { assign, dotSeed: (i, c) => dot(i * d, seeds, c * d) };
}

// The medoid — the group's most typical row — shared by both flavors and
// deterministic by the same key tie-break as the seeding.
export function medoidOf(mem, dotSeed, c, keys) {
  let best = mem[0], bs = -Infinity;
  for (const i of mem) {
    const s = dotSeed(i, c);
    if (s > bs || (s === bs && keys[i] < keys[best])) { bs = s; best = i; }
  }
  return best;
}

// The carving's shared semantics — what it means to be a GROUP in the rail,
// regardless of flavor: the floor decides who is shown, an unshown group's
// members go unplaced (the caller's "unclassified"), groups sort biggest
// first with a value tie-break, and every shown group knows its medoid.
// `describe(mem, medoid, c)` is the flavor: it returns the group's
// { value, label, title } — or null to reject a SIZED group (the chip
// flavor's no-signature rule), which also unplaces its members.
export function carve(assign, n, k, floor, keys, dotSeed, describe) {
  const groups = [];
  const unplaced = [];
  for (let c = 0; c < k; c++) {
    const mem = [];
    for (let i = 0; i < n; i++) if (assign[i] === c) mem.push(i);
    if (!mem.length) continue;
    const d = mem.length >= floor ? describe(mem, medoidOf(mem, dotSeed, c, keys), c) : null;
    if (!d) { unplaced.push(...mem); continue; }
    groups.push({ ...d, mem, size: mem.length });
  }
  groups.sort((a, b) => b.size - a.size || (a.value < b.value ? -1 : 1));
  return { groups, unplaced };
}

// A gibberish HANDLE from a stable string (3-meaning's labels): pronounceable
// syllables that mean nothing, so they can't lie and can't drift — you learn
// what "damok" is by looking at what's in it. FNV-1a, then consonant/vowel
// alternation. `taken` keeps one carving's handles distinct: on a collision
// the hash rolls until free (deterministic because callers visit groups in
// the partition's own deterministic order), and the chosen handle registers
// ITSELF — a caller that had to remember the add could forget it, which is
// exactly the duplicate the set exists to prevent.
export function handleFor(str, taken) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const C = "bdgklmnprstvz", V = "aeiou";
  for (;;) {
    let x = h, out = "";
    for (let s = 0; s < 3; s++) {
      out += C[x % 13]; x = (x / 13) | 0;
      if (s < 2) { out += V[x % 5]; x = (x / 5) | 0; }
    }
    if (!taken || !taken.has(out)) {
      taken?.add(out);
      return out;
    }
    h = (Math.imul(h, 31) + 1) >>> 0;
  }
}
