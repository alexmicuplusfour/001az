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

// A provider name → its display label, via the entry's own roster — the
// payload ships names in bound/running and labels in supportedBy, so the
// lookup stays inside one entry. Exported: the plugin modal's section planner
// resolves the same names.
export const labelIn = (c, name) => (c.supportedBy || []).find((p) => p.name === name)?.label || name;

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
  const boundNames = (b) => {
    if (!b?.provider) return null;
    return labelIn(c, b.provider) + (b.model ? ` · ${b.model}` : "");
  };

  // "Configured" only when it differs from what runs — while healthy, the
  // running line IS the configured line and saying it twice is noise.
  const showBound = c.bound && c.bound.provider && (c.state === "degraded" || c.state === "off");
  if (showBound) lines.push({ k: "Configured", v: boundNames(c.bound) });

  if (c.running) {
    const via = c.viaFloor ? " — built-in, always on" : c.running.keyId === "env" ? " — via the server's env key" : "";
    lines.push({ k: "Running", v: (labelIn(c, c.running.provider) + (c.running.model ? ` · ${c.running.model}` : "")) + via });
  }
  if (c.reason) lines.push({ k: "Why", v: c.reason });
  if (c.demand?.waiting) lines.push({ k: "Waiting", v: `${c.demand.waiting} item${c.demand.waiting === 1 ? "" : "s"}` });
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
  const inherit = cap.running
    ? labelIn(cap, cap.running.provider) + (cap.running.model ? ` · ${cap.running.model}` : "")
    : "none configured";
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
    // sentence ("Using none configured"). The bands ask this first. Kept
    // separate from `chosenLabel` because the ROW must still name the state:
    // "App default (none configured)" is exactly what that row should read.
    configured(sel) {
      return sel ? true : !!cap.running;
    },
    // What the current selection is called mid-sentence — the "Using …" bands
    // read off this. The unset delegate answers with its relationship, not a
    // model; shells that need the resolved model follow delegatesTo themselves.
    chosenLabel(sel, model) {
      if (!sel) return delegated ? unsetLabel : inherit;
      const key = keyFor(sel);
      if (key) return `${key.name} — ${key.provider}${model ? ` · ${model}` : ""}`;
      // A named engine names its model too when it had one to choose — the
      // "Using …" bands must not go quieter than a keyed pin's for the same act.
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

// --- the plugin modal's section planner ---
// One capability section per (capability, provider) pair, planned here as pure
// data and mounted by a thin DOM shell in plugin-modal.js. Everything the four
// hand-written sections used to disagree on is now a field: which rows the
// picker offers (including the env rung's), which buttons exist, and EXACTLY
// what each button saves — the payload closures are the part worth testing,
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

  const base = { title: cap.label, subtitle: cap.blurb };
  if (!onDevice && !keys.length && !envRow) {
    return { ...base, guard: `Add a ${connWord} above to serve ${cap.noun} with this provider.` };
  }

  // Connection rows: this provider's keys, plus the env rung where it applies.
  // On-device engines are picked by name — no row, no picker.
  const rows = onDevice
    ? null
    : [...keys.map((k) => ({ value: String(k.id), label: k.name })),
       ...(envRow ? [{ value: "env", label: `${cap.env.var} env var` }] : [])];
  const preselect = holder && rows ? (cap.bound?.keyId ? String(cap.bound.keyId) : envRow ? "env" : null) : null;
  // The one-key-hidden rule: a single row already holding the slot asks no
  // question, so the picker stays out of the way.
  const ask = !!rows && (rows.length > 1 || !holder);

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

  const buttons = [];
  buttons.push({
    kind: "apply",
    label: `Make default ${cap.agent}`,
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
  });
  if (cap.probeable && holder) buttons.push({ kind: "probe" });
  if (cap.binding.enable && holder) {
    buttons.push({ kind: "off", label: "Turn off", toast: `${cap.label} turned off`, payload: () => ({ enabled: false }) });
  }
  // …and only toward an engine that is actually running — a revert to an
  // absent sidecar would bind the capability to nothing (the other half of
  // removalStory's promise, hence the shared predicate).
  if (holder && floorPromises(cap) && cap.floor.provider !== provider.name) {
    buttons.push({
      kind: "revert",
      label: `Use the built-in ${cap.noun} instead`,
      toast: `${cap.label} reverted to the built-in ${cap.noun}`,
      payload: () => ({ provider: cap.floor.provider }),
    });
  }

  return {
    ...base,
    guard: null,
    rows,
    preselect,
    ask,
    model,
    holder,
    savedModel: holder ? cap.bound?.model ?? null : null,
    buttons,
    // The costly-rebind confirm, armed only while the capability is live and a
    // model is actually pinned — the DOM compares the select against priorModel.
    confirm: cap.rebindWarning && cap.bound?.enabled && cap.bound?.model
      ? { message: cap.rebindWarning, priorModel: cap.bound.model }
      : null,
    // Beside a proposal button: what you'd be replacing.
    currentDefault: holder ? null : {
      label: cap.running ? labelIn(cap, cap.running.provider) : "none",
      model: cap.running?.model ?? null,
    },
    progressLine: cap.progress ? fmtProgress(cap.progress) : null,
  };
}
