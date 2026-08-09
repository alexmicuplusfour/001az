// The capabilities page's PRESENTER — pure data-in/data-out, no DOM, no
// imports, so it is testable from node the way det-geometry is. Takes one
// entry of GET /api/admin/capabilities and returns what the card should say;
// admin-capabilities.js only mounts the result.
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
  if (c.delegatesTo) lines.push({ k: "Uses", v: `each board's ${c.delegatesTo === "tag" ? "tagger" : c.delegatesTo}` });
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
