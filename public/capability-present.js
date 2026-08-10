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
  // bound — with an app-wide default stored (slice 5), the Running line already
  // tells the truth and "uses each board's tagger" would contradict it. The
  // agent noun comes from the feed (delegatesToAgent) — nothing here names a
  // capability.
  if (c.delegatesTo && !c.bound?.keyId) lines.push({ k: "Uses", v: `each board's ${c.delegatesToAgent || c.delegatesTo}` });
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
    c.kind === "ai" && c.running?.provider === providerName && !(c.delegatesTo && !c.bound?.keyId));

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
  if (c.floor?.kind === "builtin") return `${c.noun} falls back to ${c.floor.label}`;
  if (c.floor?.kind === "delegate") return `${c.noun} falls back to each board's ${c.delegatesToAgent || c.delegatesTo}`;
  if (c.floor?.kind === "off") return `${c.label} turns off`;
  return `${c.noun} stops until another key is bound`;
}

// --- the board modal's per-board pin picker planner (slice 5b) ---
// One picker per capability the feed says boards may pin (`boardBinding`
// present, and no other surface claiming it via `boardPickerHome`). Pure data:
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
  // instead of raising it.
  const inherit = cap.running
    ? labelIn(cap, cap.running.provider) + (cap.running.model ? ` · ${cap.running.model}` : "")
    : "none configured";

  // Rows: the inherited default, every INSTALLED on-device engine (pinned by
  // name — the built-in floor arrives via this same rule, no special case),
  // then every key whose provider advertises. A not-installed provider's key
  // stays pickable (defaults, not laws) but says so.
  const rows = [{ value: "", label: `App default (${inherit})` }];
  for (const p of roster.filter((p) => p.onDevice && p.installed)) {
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
    // "AI tagger" / "AI transcriber" / … — the registry's agent noun, same
    // source as the modal's button labels.
    title: `AI ${cap.agent}`,
    hint: `(this board's own ${cap.noun} provider; the app default when unset)`,
    rows,
    preselect,
    // The model axis exists only for a keyed selection — an on-device engine's
    // model is baked, the default row inherits. `kind` addresses the live
    // per-connection listing; the entry is the provider's declared slice for
    // THIS capability, not its tagging catalog.
    modelAxis(sel) {
      const key = keyFor(sel);
      if (!key) return null;
      const slice = catalog?.[key.provider]?.provides?.[cap.declaredBy];
      return {
        entry: slice && typeof slice === "object"
          ? { defaultModel: slice.default ?? null, models: slice.models || [] }
          : null,
        keyId: key.id,
        kind: cap.declaredBy,
        // The board's persisted model belongs to its persisted key only.
        saved: savedKey && sel === savedKey && bb.model ? board?.[bb.model] ?? null : null,
      };
    },
    // What the current selection is called mid-sentence — the mapping pane's
    // "Board default" note reads the tagger's off this.
    chosenLabel(sel, model) {
      if (!sel) return inherit;
      const key = keyFor(sel);
      if (key) return `${key.name} — ${key.provider}${model ? ` · ${model}` : ""}`;
      return rows.find((r) => r.value === sel)?.label || sel;
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
      }
      return out;
    },
  };
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
  // offer more than the curated set); an on-device engine's model is baked, so
  // it reads as a note — live-reported when the sidecar answered.
  const cat = provider.ai?.provides?.[cap.declaredBy];
  const catalog = cat && typeof cat === "object" ? cat : null;
  const model = onDevice || !catalog
    ? { note: catalog?.models?.[0]
        ? `${catalog.models[0].id} — ${catalog.models[0].note}`
        : "model baked at deploy — the sidecar names it when reachable" }
    : { catalog: { models: catalog.models, defaultModel: catalog.default } };

  const buttons = [];
  buttons.push({
    kind: "apply",
    label: `Make default ${cap.agent}`,
    toast: `Default ${cap.agent} saved`,
    payload: (sel) =>
      onDevice
        ? { provider: provider.name, ...(cap.binding.enable ? { enabled: true } : {}) }
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
  if (holder && cap.floor?.kind === "builtin" && cap.floor.provider !== provider.name) {
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
