// The capabilities PRESENTER — pure data-in/data-out, no DOM, no imports, so
// it is testable from node the way det-geometry is. Takes entries of
// GET /api/admin/capabilities and returns what a surface should say; three
// thin shells mount the results: admin-capabilities.js (the page's cards),
// plugin-modal.js (planSection), and board-modal.js (planBoardPicker).
//
// Nothing in here names a capability. Every line derives from fields the
// payload declares, which is the page's whole contract: a capability added to
// the registry renders without a client edit.

// state → the chip. `active` splits on viaFloor: the built-in serving is worth
// saying, since it is the difference between "your key works" and "the fallback
// is carrying you by design".
export function presentChip(c) {
  if (c.state === "active") return { cls: "ok", text: c.viaFloor ? "active · built-in" : "active" };
  if (c.state === "degraded") return { cls: "warn", text: "degraded" };
  if (c.state === "blocked") return { cls: "warn", text: "needs a key" };
  if (c.state === "off") return { cls: "dim", text: "off" };
  return { cls: "dim", text: "unavailable" };
}

// What a capability's outage costs, in the one noun this file uses for it.
// Two readers, both below — the card's Waiting line and the strip's clause.
const items = (n) => `${n} item${n === 1 ? "" : "s"}`;

// Is this capability worth interrupting someone's page about, and in whose
// words? The boards page's setup strip (welcome-plan.md 3b) is the reader;
// null means "say nothing", which is the answer almost every time. It returns
// the WHOLE clause, not a bag of parts — wording is what this module is for,
// and a caller assembling one is a caller that can word it differently.
//
// The states that mean "not working" are all three of blocked, degraded and
// unavailable. `off` is excluded on purpose — someone turned it off, which is
// news about a decision rather than about a fault. `unavailable` joined the
// list when Stage 4 retired the pre-added provider: with nothing installed that
// advertises tagging, a fresh instance reads `unavailable` where it used to
// read `blocked`, and a predicate that named only the old one would have gone
// silent for exactly the reader 3b was built for.
//
// Then a fourth condition, and it is the one that made this a function rather
// than a `state` check at the call site: **resolving, and failing anyway**,
// which has NO state of its own and must not be given one. A stored binding
// that resolves IS active; whether the far end answers is a separate fact kept
// by the health ledger, and the two disagreeing is not a contradiction. It is
// also what a failed first-run connect leaves behind, so it is the case most
// likely to be read — and until this, the only surface that showed it was the
// banner inside the offending plugin's own modal. `failCount` is a live streak
// (db.js recordPluginHealth zeroes it on success), so non-zero means now.
//
// The text is never authored here: it is the chip, or the provider's own last
// error. A fourth spelling of a state is what this module exists to prevent,
// and a condition with no chip of its own does not get invented words either.
export function presentTrouble(c) {
  const failing = c.state === "active" && c.running
    ? (c.supportedBy || []).find((p) => p.name === c.running.provider && p.health?.failCount)
    : null;
  const said = ["blocked", "degraded", "unavailable"].includes(c.state)
    ? presentChip(c).text
    : failing?.health?.lastError?.message;
  if (!said) return null;
  return said + (c.demand?.waiting ? ` · ${items(c.demand.waiting)} waiting` : "");
}

// A provider name → its display label, via the entry's own roster — the
// payload ships names in bound/running and labels in supportedBy, so the
// lookup stays inside one entry. Exported: the plugin modal's section planner
// resolves the same names.
export const labelIn = (c, name) => (c.supportedBy || []).find((p) => p.name === name)?.label || name;

// A binding or a resolution, named the ONE way: the provider's label, then the
// model it pins. Null when there is no provider to name — a binding can lose
// its provider (a restored backup resurrects the pointer without the row), and
// a sentence built from parts must drop the clause rather than say "null".
// Four readers had re-typed this concatenation; the guard came with only one
// of them, which is the whole argument for naming it.
const named = (c, b) => (b?.provider ? labelIn(c, b.provider) + (b.model ? ` · ${b.model}` : "") : null);

// A probe answer's one-line toast, shared by the page's Test button and the
// modal section's — one string, or the two drift.
export const fmtProbe = (r) =>
  `✓ ${r.provider}${r.model ? `/${r.model}` : ""} reachable${r.count !== undefined ? ` (${r.count} found in probe)` : ""}`;

// A backfill's one-line story, shared by the page card and the modal section.
export function fmtProgress({ done, total, failed }) {
  const base = done < total
    ? `${done} of ${total} items processed — the rest continue in the background.`
    : `All ${total} items processed.`;
  return base + (failed ? ` ${failed} failed — they retry when their items re-process.` : "");
}

// The card's fact lines, in reading order: what you chose, what is actually
// serving, why they differ, what the outage costs. Only lines that carry
// information render — an unbound floor-served capability says one thing, not
// four.
export function presentLines(c) {
  const lines = [];

  // "Configured" only when it differs from what runs — while healthy, the
  // running line IS the configured line and saying it twice is noise.
  const showBound = c.bound && c.bound.provider && (c.state === "degraded" || c.state === "off");
  if (showBound) lines.push({ k: "Configured", v: named(c, c.bound) });

  if (c.running) {
    const via = c.viaFloor ? " — built-in, always on" : c.running.keyId === "env" ? " — via the server's env key" : "";
    lines.push({ k: "Running", v: named(c, c.running) + via });
  }
  if (c.reason) lines.push({ k: "Why", v: c.reason });
  if (c.demand?.waiting) lines.push({ k: "Waiting", v: items(c.demand.waiting) });
  // Delegation is the story only while nothing of this capability's OWN is
  // bound (isDelegating) — with an app-wide default stored (slice 5), the
  // Running line already tells the truth and "uses each board's tagger" would
  // contradict it. The agent noun comes from the feed (delegatesToAgent) —
  // nothing here names a capability.
  if (isDelegating(c)) lines.push({ k: "Uses", v: `each board's ${c.delegatesToAgent || c.delegatesTo}` });
  if (c.boardOverrides) lines.push({ k: "Overrides", v: `${c.boardOverrides} board${c.boardOverrides === 1 ? "" : "s"} pin their own` });
  for (const m of c.modifiers || []) {
    lines.push({ k: m.label, v: m.availableNow ? "available with the current provider" : `needs ${m.supportedBy.join(" / ")}` });
  }
  if (c.progress) lines.push({ k: "Progress", v: fmtProgress(c.progress) });
  return lines;
}

// A supportedBy roster entry → its chip: the label plus the one fact that says
// how far it is from serving. Installed-with-keys says nothing extra — being
// listed is the message.
export function presentSupported(p) {
  if (!p.installed) return { text: `${p.label} — not added`, dim: true, link: true };
  // A sidecar-backed engine whose sidecar isn't on this host. Dim like "not
  // added" — this is a statement about supply, not an alarm, and the remedy
  // is a deploy, not a click (so no link either).
  if (engineAbsent(p)) return { text: `${p.label} — not running on this server`, dim: true, link: false };
  if (p.onDevice) return { text: `${p.label} — built-in`, dim: false, link: false };
  if (p.needsKey !== undefined) {
    // a connector provider: key presence is a boolean, not a count
    return p.needsKey && !p.hasKey
      ? { text: `${p.label} — no key yet`, dim: false, warn: true, link: false }
      : { text: p.label, dim: false, link: false };
  }
  // Keyed OR keyless-networked: both need a stored row to serve (a keyless
  // connection is where the server URL lives), so zero rows warns either way —
  // only the noun differs.
  if (!p.keyCount) return { text: `${p.label} — no ${p.keyless ? "connection" : "key"} yet`, dim: false, warn: true, link: false };
  return { text: p.label, dim: false, link: false };
}

// Which provider's settings the Configure button should open: what runs, else
// what is configured, else the floor — the same precedence a reader follows.
export const configureTarget = (c) => c.running?.provider || c.bound?.provider || c.floor?.provider || null;

// The connector modal's one sentence — the domain analog of the AI rows'
// status line. Domains carry no floor-fill (`bound.provider` is the raw
// stored star), so default-here is the same stored-first precedence the
// slots always read; the trouble states arrive PRE-WORDED from the runtime
// (domainState: "TMDB can't serve — OMDb took over", "X needs an API key")
// and ride through verbatim — a fourth spelling is what this module exists
// to prevent. `d` may be missing (a stale feed): the base sentence still
// stands, off the label the caller already has. Both of the shell's call
// sites — render and the post-promote in-place write — read THIS, which is
// what ended the subtitle being authored twice.
// The domain's effective default — the stored star, else what the sibling
// scan resolved. ONE home for the precedence: domainStatus words it and the
// connector modal's star button gates on it, and spelled twice they could
// offer a star under "Currently the default for new adds."
export const domainDefault = (d) => d?.bound?.provider || d?.running?.provider || null;

export function domainStatus(d, providerName, fallbackLabel) {
  const base = `${d?.label || fallbackLabel} data provider.`;
  if (!d) return base;
  if (d.reason) return `${base} ${d.reason}.`;
  const def = domainDefault(d);
  if (def === providerName) return `${base} Currently the default for new adds.`;
  if (def) return `${base} Default for new adds: ${labelIn(d, def)}.`;
  return base;
}

// Is this capability actually DELEGATING right now? The feed ships
// `delegatesTo` for anything whose floor is a delegate — unconditionally, since
// that's a fact about the descriptor. Whether delegation is the STORY is a
// second question: the moment an app-wide default of the capability's own is
// stored, it answers for itself and following the target would name the wrong
// model. Both halves, in one place.
//
// Four readers asked this and each kept its own copy of the pair. Three agreed;
// the board modal's strip and provenance bands — two more copies, a file away —
// dropped the second half, so a board with an app-wide extract default showed
// extraction's own model over the TAGGER's as its source, and told the Mapping
// pane the tagger was doing the extracting. A predicate cannot be half-copied.
export const isDelegating = (c) => !!c.delegatesTo && !c.bound?.keyId;

// --- presence (sidecar-presence-plan.md) ---
// `present` rides ONLY entries the server actually probed — a sidecar-backed
// engine's roster row and the floor payload. Absent field = the question does
// not apply (a networked provider, the in-process embedder), which is why
// every test is `=== false` and never `!p.present`: the latter reads every
// keyed provider as missing. Named here so that rule can't be half-copied.
export const engineAbsent = (p) => p.present === false;

// Is the built-in floor a promise this host can keep? Both readers of that
// question — the removal confirm's consequence clause and the plugin card's
// "use the built-in instead" button — are two halves of ONE offer: promise a
// fallback in one and withhold the button in the other and the admin is told
// two different stories. (See isDelegating above for what happens when a
// two-clause predicate gets copied instead of named.)
export const floorPromises = (c) => c.floor?.kind === "builtin" && !engineAbsent(c.floor);

// A provider's declared slice for one capability, or null when it advertises
// nothing there. `provides` carries a capability-keyed object per the 7b wire
// shape; the typeof guard is for feeds that predate it.
const capCatalog = (provides, cap) => {
  const slice = provides?.[cap.declaredBy];
  return slice && typeof slice === "object" ? slice : null;
};

// Does an ON-DEVICE engine have a model question to ask? A select holding a
// single option asks none, so a one-baked-model sidecar keeps its "baked at
// deploy" note instead — and the axis stays invisible until an engine reports
// a second model. The same rule serves the board picker and the Plugins card
// (see isDelegating above for what happens when a rule like this is copied).
// Keyed rows are exempt: a live listing can always offer more than the
// curated set, so they get the picker at any size.
const offersChoice = (models) => (models?.length || 0) > 1;

// --- who serves what (7c) — the Plugins tab's badges, tags, and warnings ---
// These used to be four hand-lists over the legacy `slots` payload, and the
// removal warning's copy forgot the transcriber — the exact omission class the
// registry exists to kill. Derived from the feed, a capability cannot be
// skipped.

// The capabilities this provider is CURRENTLY SERVING — the effective view
// (`running`), the rule the connector badges always followed: badge what
// resolves, not the stored star. A delegate serving through its target's
// binding is the TARGET's role, not a second one (unbound extract runs on the
// tagger's own binding — only its own stored key makes it a role here). An
// `off` capability never has `running`, so disabled needs no special case.
export const servingRoles = (caps, providerName) =>
  (caps || []).filter((c) =>
    c.kind === "ai" && c.running?.provider === providerName && !isDelegating(c));

// One serving entry → its card badge: names the role, links to the capability
// card, and carries the env qualifier the tagger's badge always had.
export const roleBadge = (c) => ({
  capId: c.id,
  text: `default ${c.agent}` + (c.running?.keyId === "env" ? " · env" : ""),
});

// The capabilities BOUND to this key row — the stored view: a key table's
// badge marks the admin's choice, whether or not it is what currently serves.
// An explicitly disabled binding (embed off) stays quiet — the pointer is
// real, but "default embedder" on a feature that is off reads as a lie.
export const keyRoles = (caps, keyId) =>
  (caps || []).filter((c) => c.kind === "ai" && c.bound?.keyId === keyId && c.bound?.enabled !== false);

// What deleting a capability's bound key leaves serving — the remove-confirm's
// consequence clause, derived from the same fields the card renders. (The
// server clears the WHOLE binding namespace with the key, so the story is
// always the next rung's.)
export function removalStory(c) {
  if (c.env?.configured) return `${c.noun} falls back to the ${c.env.var} env var`;
  // A builtin floor is only a promise where its engine is running — on a host
  // without it, the truthful consequence is the tail line, not a fallback to
  // nothing.
  if (floorPromises(c)) return `${c.noun} falls back to ${c.floor.label}`;
  if (c.floor?.kind === "delegate") return `${c.noun} falls back to each board's ${c.delegatesToAgent || c.delegatesTo}`;
  if (c.floor?.kind === "off") return `${c.label} turns off`;
  return `${c.noun} stops until another key is bound`;
}

// --- the board modal's per-board pin picker planner (slice 5b) ---
// One picker per capability the feed says boards may pin (`boardBinding`
// present) — all of them rows in the modal's AI-models strip. Pure data:
// the rows, the preselect, the model axis, and EXACTLY what a selection saves —
// the payload speaks the column names the feed shipped, so nothing here (or in
// the shell that mounts this) names a capability.
//
//   cap     one entry of GET /api/admin/capabilities
//   keys    ALL connection rows, [{ id, name, provider }] — filtered here to
//           providers that advertise the capability, because the write path
//           refuses the rest and a picker must not offer what a save rejects
//   board   the board row (column-named fields, admin settings payload), or
//           null for a new board
//   catalog provider name → /api/admin/ai-providers entry (model catalogs)
export function planBoardPicker(cap, keys, board, catalog) {
  const bb = cap.boardBinding;
  if (!bb) return null;
  const roster = cap.supportedBy || [];
  const advertisers = new Set(roster.map((p) => p.name));
  const notInstalled = new Set(roster.filter((p) => !p.installed).map((p) => p.name));

  // What "App default" currently means, so the unset row answers the question
  // instead of raising it. A delegate capability with nothing of its OWN bound
  // app-wide doesn't inherit a provider — it follows another capability — so
  // its unset row says that ("Same as the tagger") instead of a false default;
  // what that resolves to live is the shell's to add, since only the shell
  // sees unsaved edits to the target's picker.
  const delegated = isDelegating(cap);
  const inherit = named(cap, cap.running) || "none configured";
  const unsetLabel = delegated
    ? `Same as the ${cap.delegatesToAgent || cap.delegatesTo}`
    : `App default (${inherit})`;

  // Rows: the inherited default, every INSTALLED and PRESENT on-device engine
  // (pinned by name — the built-in floor arrives via this same rule, no
  // special case; an engine whose sidecar isn't on this host is not offered,
  // the no-implied-choices rule), then every key whose provider advertises. A
  // not-installed provider's key stays pickable (defaults, not laws) but says
  // so. A STORED pin of a now-absent engine degrades like any vanished offer:
  // preselect falls to the default row below, the pin column is never written.
  const rows = [{ value: "", label: unsetLabel }];
  for (const p of roster.filter((p) => p.onDevice && p.installed && !engineAbsent(p))) {
    rows.push({ value: p.name, label: `${p.label} — built-in` });
  }
  for (const k of keys.filter((k) => advertisers.has(k.provider))) {
    rows.push({ value: String(k.id), label: `${k.name} — ${k.provider}` + (notInstalled.has(k.provider) ? " · not installed" : "") });
  }

  // Preselect from the board's stored columns; a pin whose row/engine vanished
  // from the offer falls to the default row rather than sending a dead value
  // back on save (the mapping pane's rule).
  const savedProvider = (bb.provider && board?.[bb.provider]) || null;
  const savedKey = board?.[bb.keyId] != null ? String(board[bb.keyId]) : null;
  const stored = savedProvider || savedKey || "";
  const preselect = rows.some((r) => r.value === stored) ? stored : "";

  const keyFor = (sel) => (/^\d+$/.test(sel || "") ? keys.find((k) => String(k.id) === sel) : null);

  return {
    rows,
    preselect,
    // Whether the unset row FOLLOWS another capability rather than inheriting an
    // app default — the planner's answer, published so its shell stops deriving
    // its own. The shell needs it because the live resolution (what the target's
    // picker holds right now, unsaved edits included) is the one part of this
    // that a pure function cannot see; what it must NOT do is re-decide whether
    // to look.
    delegated,
    // The model axis for a selection — a keyed row's provider, or an on-device
    // engine picked by NAME. `kind` addresses the live per-connection listing
    // (keyed rows only; a sidecar reports its own list through the catalog);
    // the entry is the provider's declared slice for THIS capability, not its
    // tagging catalog.
    //
    // An on-device engine offers the axis only when it actually serves more
    // than one model: a select holding a single option asks no question, and a
    // one-model engine keeps its "baked at deploy" note. This is also what
    // makes the axis invisible until an engine reports a second model —
    // nothing here names a provider or a capability.
    modelAxis(sel) {
      const key = keyFor(sel);
      const provider = key ? key.provider : sel || null;
      if (!provider) return null; // the inherited-default row
      const slice = capCatalog(catalog?.[provider]?.provides, cap);
      const entry = slice ? { defaultModel: slice.default ?? null, models: slice.models || [] } : null;
      if (!key && !offersChoice(entry?.models)) return null;
      return {
        entry,
        keyId: key?.id ?? null,
        kind: cap.declaredBy,
        // The board's persisted model belongs to its persisted SELECTION —
        // a pinned key or a pinned engine name, whichever is stored.
        saved: sel && sel === (savedKey || savedProvider) && bb.model ? board?.[bb.model] ?? null : null,
      };
    },
    // Is there anything BEHIND a given selection, or would naming it be a
    // claim about nothing? A pinned key or engine is a choice by definition;
    // only the app-default row can come up empty, and `chosenLabel` answers
    // that case with "none configured" — fine in a status list, a lie in a
    // sentence. The board modal's capability marks ask this first, to decide
    // which of them warn. Kept separate from `chosenLabel` because the ROW
    // must still name the state:
    // "App default (none configured)" is exactly what that row should read.
    configured(sel) {
      return sel ? true : !!cap.running;
    },
    // What the current selection is called mid-sentence — a strip row's value
    // and a capability mark's tooltip read off this. The unset delegate answers
    // with its relationship, not a model; shells that need the resolved model
    // follow delegatesTo themselves.
    chosenLabel(sel, model) {
      if (!sel) return delegated ? unsetLabel : inherit;
      const key = keyFor(sel);
      if (key) return `${key.name} — ${key.provider}${model ? ` · ${model}` : ""}`;
      // A named engine names its model too when it had one to choose — it must
      // not go quieter than a keyed pin's for the same act.
      return `${rows.find((r) => r.value === sel)?.label || sel}${model ? ` · ${model}` : ""}`;
    },
    // The save body, in the feed's column names. Full-state per capability:
    // every column written on every save, so a cleared picker clears the pin.
    payload(sel, model) {
      const out = {};
      if (bb.provider) out[bb.provider] = null;
      out[bb.keyId] = null;
      if (bb.model) out[bb.model] = null;
      const key = keyFor(sel);
      if (key) {
        out[bb.keyId] = key.id;
        if (bb.model) out[bb.model] = model || null;
      } else if (sel && bb.provider) {
        // A name row only exists where the capability has a provider column.
        out[bb.provider] = sel;
        // An on-device engine carries a model too when it serves several; the
        // server clears it when the engine has nothing to choose from.
        if (bb.model) out[bb.model] = model || null;
      }
      return out;
    },
  };
}

// --- the board modal's capability-CONFIG planner (ai-image-input-plan.md §7) ---
// A capability knob a board may override (tagging's image detail). Distinct
// from planBoardPicker above, which plans a BINDING (which key, which model):
// this plans a value, so there is no roster, no model axis, and nothing to
// disqualify — just "inherit the app default, or pick one of the declared
// options".
//
// Takes the field descriptors directly — `board.capability_config` from the
// board settings payload (any manager can read it), or the same shape lifted
// off the admin capabilities feed when creating a board, which has no settings
// payload yet. One entry per board-scopable field, so a second such knob
// renders with no edit here; [] when there are none. Pure — the modal mounts.
export function planBoardConfig(fields, board) {
  return (fields || [])
    // Dropdown knobs only. The server's write path and board payload take any
    // field with a boardColumn, so a NUMERIC one would save and serialize but
    // never get a row here — a capabilities.test.js pin fails the moment the
    // registry declares one, naming this function and mountCapConfigs as the
    // two places that need the numeric branch.
    .filter((f) => f.boardColumn && f.options?.length)
    .map((f) => {
      // What blank MEANS, spelled out — the unset row answers the question
      // rather than raising it (planBoardPicker's rule). `f.value` is the
      // app-wide effective value, already defaulted server-side.
      const appOption = f.options.find((o) => o.value === f.value);
      const rows = [
        { value: "", label: `App default (${appOption?.label || f.value})` },
        ...f.options.map((o) => ({ value: o.value, label: o.label || o.value })),
      ];
      // A stored value that is no longer a declared option (a preset retired
      // between releases) falls to the default row instead of being sent back
      // on save — the same rule the pin planner applies to a vanished key.
      const stored = board?.[f.boardColumn] || "";
      return {
        key: f.key,
        column: f.boardColumn,
        label: f.label || f.key.replace(/_/g, " "),
        // One line for the whole field, fixed — NOT per selection. A note that
        // tracked the dropdown had to be re-synced on every change and every
        // failed save, and the admin page's copy of that rule was already
        // wrong; a constant cannot be.
        hint: f.hint || "",
        rows,
        preselect: rows.some((r) => r.value === stored) ? stored : "",
        // What the collapsed Advanced summary says about this knob — "" when
        // the board inherits, since an app default is not state the fold is
        // hiding. The whole rule lives here rather than in the modal: the
        // summary loops over N knobs, and a caller assembling the string
        // itself is a caller that hardcodes the first knob's name for all of
        // them. `label` is the fallback so a knob shipped without `chip` still
        // reports honestly, just verbosely.
        chipFor: (sel) => (sel ? `${f.chip || f.label}: ${rows.find((r) => r.value === sel)?.label || sel}` : ""),
        // Blank clears the column — the board falls back to the app default.
        payload: (sel) => ({ [f.boardColumn]: sel || null }),
      };
    });
}

// The modal row's one-line status (plugin-modal-drawer-plan.md §2):
// presentLines' Configured/Running precedence compressed to a sum line. While
// healthy the running line IS the configured line; degraded and off are where
// they part, and both halves get said. Spellings reuse what other surfaces
// already own ("built-in", the env rung's var, "each board's {agent}") — a
// fourth spelling of a state is what this module exists to prevent.
function rowStatus(cap, keys, { connWord, holder, isDefaultHere, offersModel }) {
  const b = cap.bound;
  const r = cap.running;
  // Clauses join one way, and a clause with nothing to say DROPS OUT — the
  // degrade-by-parts rule applied at the composition rather than at one call
  // site, which is what keeps a vanished key row or a provider-less binding
  // from rendering "undefined" into a sentence.
  const dot = (...parts) => parts.filter(Boolean).join(" · ");
  const mine = (...parts) => { const said = dot(...parts); return `App default${said ? ` — ${said}` : ""}`; };
  // THIS card's binding, named by the row it points at — the key names come
  // from the rows the card is already showing.
  const keyClause = (x) => {
    const row = x?.keyId != null && x.keyId !== "env" ? keys.find((k) => String(k.id) === String(x.keyId)) : null;
    return dot(row && `"${row.name}" ${connWord}`, x?.model);
  };
  // The qualifier the RESOLUTION carries when it is not a plain keyed call —
  // closed over `r` so it structurally CANNOT be asked of this card's
  // binding: the fallback rung being the env key once printed "built-in" at
  // a networked provider. (`viaFloor` answers a different question — whether
  // the FLOOR caught the fall — and is false for an explicitly bound
  // on-device engine.)
  const via = () => (r?.keyId === "env" ? " — env"
    : (cap.supportedBy || []).find((p) => p.name === r?.provider)?.onDevice ? " — built-in" : "");

  // Delegation first: while extract rides the tagger there is no default of
  // ITS OWN to report, whoever happens to serve.
  if (isDelegating(cap)) return `Follows each board's ${cap.delegatesToAgent || cap.delegatesTo}`;
  if (cap.state === "off") {
    if (!isDefaultHere) return `Off — ${cap.noun} disabled`;
    const kept = keyClause(b);
    return `Off — binding kept${kept ? ` (${kept})` : ""}`;
  }
  if (cap.state === "degraded") {
    // The serving clause renders only when something actually serves — a
    // blocked-floor capability's degraded line ends at "failing".
    if (isDefaultHere) return `${mine(keyClause(b))} — failing${r ? `; ${labelIn(cap, r.provider)} serving` : ""}`;
    // The card of whoever picked the work up names the default it stands in
    // for — when there is a name to give.
    const owner = b?.provider ? labelIn(cap, b.provider) : null;
    if (holder) return `Serving as the fallback${via()}${owner ? ` (${owner} is the app default)` : ""}`;
    const n = named(cap, b);
    return n ? `App default: ${n} — degraded` : "The app default is failing";
  }
  if (!r) return "No app default yet"; // blocked / unavailable — nothing resolves
  if (isDefaultHere) {
    if (r.keyId === "env") return mine(`${cap.env.var} env var`, r.model);
    if (via()) return mine("built-in", offersModel && r.model);
    return mine(keyClause(r));
  }
  return `App default: ${dot(labelIn(cap, r.provider), r.model)}${via()}`;
}

// --- the plugin modal's row/drawer planner ---
// One capability ROW per (capability, provider) pair — status line, open
// plan, primary, row actions — planned here as pure data and mounted by a
// thin DOM shell in plugin-modal.js. Everything the four hand-written
// sections used to disagree on is now a field: which rows the drawer's
// picker offers (including the env rung's), which acts exist, and EXACTLY
// what each one saves — the payload closures are the part worth testing,
// because a wrong body here writes a wrong binding server-side.
//
//   cap      one entry of GET /api/admin/capabilities
//   provider the plugin-catalog card: { name, label, ai: { onDevice, keyless,
//            provides }, capabilities }
//   keys     this provider's connection rows, [{ id, name }]
export function planSection(cap, provider, keys) {
  const onDevice = !!provider.ai?.onDevice;
  const connWord = provider.ai?.keyless ? "connection" : "key";
  // The env rung's row appears only on the card of the provider it belongs to,
  // and only while the server actually holds the secret.
  const envRow = !!(cap.env?.configured && cap.env.provider === provider.name);
  const holder = cap.running?.provider === provider.name;
  // Have the stored choice and the running one PARTED? Named once, because
  // three readers below ask it and an inverted second spelling is how they
  // start disagreeing: a state that still resolves would have rendered the
  // active status line beside the wrong primary label.
  const parted = cap.state === "degraded" || cap.state === "off";
  // Is THIS provider the admin's stored choice? Not `bound.provider === name`:
  // capabilityBinding FLOOR-FILLS the provider, so a capability with nothing
  // bound reads back as its own floor's engine. The server keeps the same
  // guard for the same reason (capability-status.js `storedNonFloor`, which
  // is not on the wire) — and without it a fresh instance's disabled embedder
  // claimed the Local Embedder card as a stored choice: "binding kept" over a
  // binding nobody made, with no button left to turn embeddings back on. A
  // stored keyId needs no clause of its own; the binding's provider is always
  // that row's provider.
  const storedHere = cap.bound?.provider === provider.name
    && provider.name !== (cap.floor?.kind === "builtin" ? cap.floor.provider : null);
  // The stored/resolving default points HERE — split from `holder` (what
  // SERVES) because the two part company exactly when a card most needs to
  // be honest: a degraded default is still the default while the floor
  // serves, and conflated they presented that card as a bystander ("Make
  // default …" over blank pickers). Active resolves without a bound row on
  // the env rung, so it asks `running`. A delegating capability has no
  // default of its own to be (isDelegating's rule). Probe / Turn off / revert
  // stay on `holder`: they act on what runs.
  const isDefaultHere = !isDelegating(cap) && (parted ? storedHere : holder);

  const base = { title: cap.label, subtitle: cap.blurb };
  if (!onDevice && !keys.length && !envRow) {
    // The guard doubles as the row's status: nothing to act on, no action.
    // It answers the whole row contract (status + open + actions) rather than
    // half of it, so the shell renders every row one way instead of keeping a
    // guard branch alive — and a field added later can't forget this return.
    const guard = `Add a ${connWord} above to serve ${cap.noun} with this provider.`;
    return { ...base, guard, status: guard, open: null, primary: null, rowActions: [], progressLine: null };
  }

  // Connection rows: this provider's keys, plus the env rung where it applies.
  // On-device engines are picked by name — no row, no picker.
  const rows = onDevice
    ? null
    : [...keys.map((k) => ({ value: String(k.id), label: k.name })),
       ...(envRow ? [{ value: "env", label: `${cap.env.var} env var` }] : [])];
  const preselect = isDefaultHere && rows ? (cap.bound?.keyId ? String(cap.bound.keyId) : envRow ? "env" : null) : null;

  // The model axis: a networked provider gets the picker (live listings can
  // offer more than the curated set). An on-device engine gets one too WHEN it
  // reports serving several models; a single baked model is a note, not a
  // question — which keeps this invisible for the one-model engines that are
  // the norm today.
  const catalog = capCatalog(provider.ai?.provides, cap);
  const model = !catalog || (onDevice && !offersChoice(catalog.models))
    ? { note: catalog?.models?.[0]
        // The engine's note when it carries one (a live sidecar catalog), else
        // the model's own (a descriptor's curated list).
        ? [catalog.models[0].id, catalog.note || catalog.models[0].note].filter(Boolean).join(" — ")
        : "model baked at deploy — the sidecar names it when reachable" }
    : { catalog: { models: catalog.models, defaultModel: catalog.default } };

  // The one act that stages a choice (and so earns the drawer), and the
  // one-click acts on live state that stay on the row beside it. Built as the
  // two they are rather than sliced back out of one array by position, so
  // nothing can quietly land in front of the apply entry.
  const applyLabel = `Make default ${cap.agent}`;
  const primary = {
    kind: "apply",
    label: applyLabel,
    toast: `Default ${cap.agent} saved`,
    payload: (sel) =>
      onDevice
        ? { provider: provider.name, ...(model.catalog ? { model: sel.model } : {}),
            ...(cap.binding.enable ? { enabled: true } : {}) }
        : {
            ...(cap.binding.provider ? { provider: provider.name } : {}),
            keyId: sel.key === "env" ? null : Number(sel.key),
            model: sel.model,
            ...(cap.binding.enable ? { enabled: true } : {}),
          },
  };
  const rowActions = [];
  if (cap.probeable && holder) rowActions.push({ kind: "probe" });
  if (cap.binding.enable && holder) {
    rowActions.push({ kind: "off", label: "Turn off", toast: `${cap.label} turned off`, payload: () => ({ enabled: false }) });
  }
  // …and only toward an engine that is actually running — a revert to an
  // absent sidecar would bind the capability to nothing (the other half of
  // removalStory's promise, hence the shared predicate).
  if (holder && floorPromises(cap) && cap.floor.provider !== provider.name) {
    rowActions.push({
      kind: "revert",
      label: `Use the built-in ${cap.noun} instead`,
      toast: `${cap.label} reverted to the built-in ${cap.noun}`,
      payload: () => ({ provider: cap.floor.provider }),
    });
  }

  // The row/drawer split (plugin-modal-drawer-plan.md §3). Whether an act
  // needs the drawer is STRUCTURAL: offered iff a group would render — a key
  // question (two rows or more), or a model catalog. One key and one baked
  // model ask nothing, so that promote stays a single click; default-here
  // with nothing to ask needs no button at all — the status line already
  // says it, where a disabled "Make default …" used to sit as a marker.
  const hasChoices = rows?.length > 1 || !!model.catalog;
  const open = hasChoices
    ? {
        label: isDefaultHere ? "Change…" : "Make default…",
        drawer: true,
        // The task's head — the same phrase family as applyLabel, planned
        // here so the drawer's title can't drift from the planner's
        // vocabulary when the family gets reworded.
        title: `Default ${cap.agent}`,
        // "Save changes" only for the healthy default repointing itself; the
        // off drawer's primary genuinely re-elects (binds + enables), so it
        // keeps the verbatim label.
        primaryLabel: isDefaultHere && !parted ? "Save changes" : applyLabel,
        // Re-posting an active or degraded binding is a no-op, so those
        // drawers demand a change from the open-time snapshot before the
        // primary arms. The OFF drawer's re-post IS the act — enabled:true
        // rides it — so it opens armed with the kept binding preselected.
        requiresChange: isDefaultHere && cap.state !== "off",
      }
    : isDefaultHere ? null : { label: applyLabel, drawer: false };

  return {
    ...base,
    guard: null,
    status: rowStatus(cap, keys, { connWord, holder, isDefaultHere, offersModel: !!model.catalog }),
    open,
    rows,
    preselect,
    model,
    holder,
    isDefaultHere,
    savedModel: isDefaultHere ? cap.bound?.model ?? null : null,
    primary,
    rowActions,
    // The costly-rebind confirm, armed only while the capability is live and a
    // model is actually pinned — the DOM compares the select against priorModel.
    confirm: cap.rebindWarning && cap.bound?.enabled && cap.bound?.model
      ? { message: cap.rebindWarning, priorModel: cap.bound.model }
      : null,
    // Beside the drawer's primary: what you'd be replacing. Absent for the
    // default itself (a repair replaces nothing) and when nothing runs (the
    // row already says "No app default yet" — "Replacing: none" is a lie).
    currentDefault: isDefaultHere ? null : named(cap, cap.running),
    progressLine: cap.progress ? fmtProgress(cap.progress) : null,
  };
}
