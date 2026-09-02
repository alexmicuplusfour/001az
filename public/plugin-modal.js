// Per-plugin configuration modal, opened from the Plugins tab gear. Sections
// vary by kind: connectors get their schema-driven config form (key, rate
// limits) plus Test and the domain-default star; AI providers get their key
// registry (this provider's slice of ai_keys) plus ONE generic section per
// capability they advertise — planned by capability-present.js from the
// capabilities payload, so a new capability needs no edit here; media types
// are informational (built-ins, nothing to configure). The last
// recorded health error surfaces at the top. Writes go through the plugins
// API, the ai-keys routes, and /api/admin/capabilities/:id/{bind,probe} —
// this file owns no state of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal, sectionHeading, sectionHeadingEl, busy } from "/modal.js";
import { syncModelPicker, switchRow } from "/board-modal.js";
import { fillSelect, isUnset } from "/select.js";
import { fmtDuration, relTime } from "/utils.js";
import { planSection, fmtProbe, keyRoles, removalStory } from "/capability-present.js";


const LABEL_CSS = "display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;";
const MONO_CSS = "font-family:'SF Mono',Consolas,monospace;font-size:13px;";

function section(title, sub) {
  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;gap:12px;";
  box.innerHTML = sectionHeading(title, sub);
  return box;
}

function labeled(label, el) {
  const row = document.createElement("div");
  row.innerHTML = `<label style="${LABEL_CSS}">${label}</label>`;
  row.appendChild(el);
  return row;
}

// A slot's promote button, always labelled "Make default {slot}" and always
// ghost — the same weight as the connector's "Make default for {domain}".
// Enabled when this provider isn't the default; when it already IS, it sits
// disabled as a status marker and re-enables only once you change the key or
// model, so you can still repoint the running default. `sels` are the selects
// to watch; `apply` runs the write.
//
// A picker still on its empty state is not an answer, so it holds the button
// down too — which is also what keeps `apply` from posting the placeholder's ""
// as a key id. Note the ordering this relies on: each section wires the key
// select's model-refill listener BEFORE building this button, so by the time
// `sync` runs the model picker has already been emptied for the new connection.
function slotButton(label, isDefault, sels, apply) {
  const btn = document.createElement("button");
  btn.className = "ghost";
  btn.textContent = label;
  const initial = sels.map((s) => s.value);
  const sync = () => {
    btn.disabled = sels.some(isUnset)
      || (isDefault && !sels.some((s, i) => s.value !== initial[i]));
  };
  sels.forEach((s) => s.addEventListener("change", sync));
  sync();
  btn.onclick = busy(btn, apply);
  return btn;
}

// What a slot's pickers say before they have been answered. The key one echoes
// the label above it — a keyless provider has connections, not keys — and both
// read as instructions, so an untouched slot section can't be mistaken for a
// configured one.
const pickKey = (p) => `Select a ${p.ai.keyless ? "connection" : "key"}`;
// …and the model select's empty state NAMES what leaving it alone will use.
// Saving without a pick has always fallen back to the catalog's default (see
// selVals below), so "Select a model" was the one label here that wasn't true:
// it read as "nothing will happen until you choose" while a choice was already
// implied. Naming it keeps the placeholder honest without pre-selecting a
// suggestion as though it were a decision — the board modal's "App default
// (…)" row says the same thing the same way.
const pickModel = (defaultModel) => (defaultModel ? `Default (${defaultModel})` : "Select a model");

// Live commit for a SETTINGS control — the plugin modals carry no Save
// buttons; each field commits itself on `change` (blur for typed input,
// instant for steppers/toggles). Success is QUIET — a toast per blur is
// noise; `commit` only speaks when it has something to say (a key landed, a
// value will be clamped). Failure toasts the error and puts the last-saved
// value back — except `revertOnError: false` (secrets), where wiping the
// field would mean re-pasting the key just to retry. An unchanged blur is a
// no-op, which also means an empty secret field can never blur-clear a
// stored key. Commits are serialized per field, NOT gated by disabling the
// control — a stepper/Enter `change` fires with focus still in the field,
// and disabling it would steal that focus and eat clicks mid-commit.
// Settings only: creation forms (keys, source connections) and the slot
// promotions stay explicit buttons — those change WHAT something is, not
// how it's tuned.
function autosave(el, commit, { revertOnError = true } = {}) {
  let saved = el.value;
  let chain = Promise.resolve();
  el.addEventListener("change", () => {
    if (el.value === saved) return;
    chain = chain.then(async () => {
      if (el.value === saved) return; // a queued change already settled here
      try {
        await commit();
        saved = el.value;
      } catch (err) {
        toast.error(err.message);
        if (revertOnError) el.value = saved;
      }
    });
  });
}

export function openPluginModal(p, ctx) {
  const { body, footer, close } = createModal({
    title: p.label,
    bodyStyle: "display:flex;flex-direction:column;gap:26px;",
  });

  // Every mutating action re-fetches state and rebuilds the modal in place
  // rather than closing it — only Close dismisses the modal. So a "Make default
  // …", a saved slot, or an added key reflects immediately (the button flips,
  // status text updates) and the cards behind stay in sync. Builders get this
  // `reload` where they used to get a `done` that closed.
  async function reload() {
    let state;
    try { state = await ctx.getState(); } catch { return; }
    p = state.plugins.find((x) => x.id === p.id) || p;
    ctx = { ...ctx, plugins: state.plugins, keys: state.keys, connections: state.connections, capabilities: state.capabilities };
    render();
    ctx.refresh(state); // repaint the cards behind, reusing the state we just fetched
  }

  // Builders return their section node; every action lives inside its
  // section — autosaving fields, slot buttons, per-row actions, add/edit
  // forms — so the footer holds just Close, for every plugin kind. There is
  // deliberately no footer-level commit: one once saved only the rate-limit
  // section while looking modal-wide, and the reload it triggered discarded
  // a model choice staged in the section above it.
  function render() {
    body.replaceChildren();
    footer.replaceChildren();

    // Health lives here now (the row has no status dot): surface the last
    // recorded error, if any, so a failing integration is legible where you'd fix it.
    const health = p.state.health;
    if (health?.lastError?.message) {
      const banner = document.createElement("div");
      banner.style.cssText = "background:#fdf0f0;border:1px solid #f3d3d3;color:#8a3535;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.4;";
      const when = health.lastFailAt ? ` · ${relTime(health.lastFailAt)}` : "";
      banner.textContent = `Last error${when}: ${health.lastError.message}`;
      body.appendChild(banner);
    }

    const built = [];
    if (p.kind === "connector") {
      built.push(connectorSection(p, ctx, reload));
    } else if (p.kind === "ai") {
      // On-device providers (local embedder, whisper sidecar) have no accounts
      // — nothing to register. Keyless-NETWORKED providers still get the
      // section: their rows are connections without a secret.
      if (!p.ai.onDevice) built.push(keysSection(p, ctx, reload));
      // One generic section per capability this provider advertises, planned
      // from the capabilities payload (capability-present.js) — a capability
      // added to the server's registry gets its section with no edit here.
      // `binding.global` gates: a capability with an app-wide default gets a
      // section (extract's arrived in slice 5), a modifier (research) has none.
      // `declaredBy`, not `id`: extract rides tagging's advertisement, so the
      // provider flag to check is the declarer's.
      for (const cap of ctx.capabilities || []) {
        if (cap.kind === "ai" && cap.binding.global && p.capabilities[cap.declaredBy]) built.push(capabilitySection(cap, p, ctx, reload));
      }
      if (p.configSchema.length) built.push(pacingSection(p)); // rpm/burst — networked providers only
    } else if (p.kind === "source") {
      built.push(sourceSection(p, ctx, reload));
    } else {
      built.push(mediaSection(p));
    }
    for (const b of built) body.appendChild(b);

    const closeBtn = document.createElement("button");
    closeBtn.className = "ghost";
    closeBtn.textContent = "Close";
    closeBtn.onclick = close;
    footer.appendChild(closeBtn);
  }

  render();
}

// --- connector: schema-driven config + test + domain default ---

function connectorSection(p, ctx, reload) {
  // The domain's star state off the capabilities feed — bound is the stored
  // star, running what actually resolves; same precedence the old slots read
  // (`setting || effective`) applied.
  const d = (ctx.capabilities || []).find((c) => c.kind === "domain" && c.id === p.connector.domain);
  const isDefault = (d?.bound?.provider || d?.running?.provider) === p.name;
  const sec = section(
    "Configuration",
    `${p.connector.domainLabel} data provider.` + (isDefault ? " Currently the default for new adds." : "")
  );
  // Held by reference because there is nothing to query it back by: section()
  // renders the subtitle from sectionHeading's inline-styled markup, which
  // carries no class. A `.sub` lookup here borrowed the page's OTHER subtitle
  // convention (`<p class="sub">`, the tab headings in admin-plugins) and so
  // found null inside the modal — see the star below for what that cost.
  const subLine = sec.firstElementChild.querySelector("p"); // sectionHeading's wrapper: h2 + sub

  // One input per schema field; the plugin declares them, we just render.
  // Every field autosaves itself (the PATCH merges per key) — no Save button.
  const saveField = (key, v) => api("PATCH", `/api/admin/plugins/${p.id}`, { config: { [key]: v } });
  let secretInput = null; // Test sends the typed key so it works pre-blur
  for (const f of p.configSchema) {
    if (f.type === "secret") {
      const input = document.createElement("input");
      input.type = "password";
      // "new-password", not "off": Chrome ignores "off" on password fields once
      // a login is saved for the site, and autofills credentials into key forms.
      input.autocomplete = "new-password";
      input.style.cssText = `width:100%;box-sizing:border-box;${MONO_CSS}`;
      input.placeholder = p.state.hasKey
        ? "•••• stored — leave blank to keep"
        : f.required ? "paste key" : f.help || "optional";
      const row = labeled(f.label, input);
      // Paste → blur = saved. autosave's unchanged-guard means an empty blur
      // can never write, so a stored key is cleared ONLY by the explicit
      // confirmed remove below. reload() after a key write: hasKey flips, and
      // blur already happened so the rebuild steals no focus. On failure the
      // typed key stays put (revertOnError: false) — wiping it would mean
      // re-pasting just to retry.
      autosave(input, async () => {
        const v = input.value.trim();
        if (!v) return;
        await saveField(f.key, v);
        toast(`${p.label} ${f.label.toLowerCase()} saved`);
        reload();
      }, { revertOnError: false });
      if (p.state.hasKey) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "danger";
        rm.style.cssText = "margin-top:6px;padding:4px 10px;font-size:12px;";
        rm.textContent = "remove stored key";
        rm.onclick = busy(rm, async () => {
          if (!confirm(`Remove the stored ${f.label}?`)) return;
          try {
            await saveField(f.key, ""); // "" clears the secret store
            toast(`${p.label} ${f.label.toLowerCase()} removed`);
            reload();
          } catch (err) { toast.error(err.message); }
        });
        row.appendChild(rm);
      }
      secretInput = input;
      sec.appendChild(row);
    } else if (f.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      if (f.min !== undefined) input.min = String(f.min);
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      autosave(input, async () => {
        const v = input.value === "" ? null : Number(input.value); // empty = back to the plugin's default
        await saveField(f.key, v);
        p.state.config[f.key] = v;
      });
      sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
    } else if (f.type === "toggle") {
      // switchRow owns its visual state; a failed write reloads to restore truth.
      sec.appendChild(switchRow(f.label, f.help || "", !!p.state.config[f.key], async (v) => {
        try {
          await saveField(f.key, v);
          p.state.config[f.key] = v;
        } catch (err) { toast.error(err.message); reload(); }
      }));
    } else {
      const input = document.createElement("input");
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      autosave(input, async () => {
        const v = input.value.trim() || null;
        await saveField(f.key, v);
        p.state.config[f.key] = v;
      });
      sec.appendChild(labeled(f.label, input));
    }
  }

  // "Make default for {domain}" is a role toggle, separate from saving this
  // provider's config, so it sits at the bottom of the section (not the footer)
  // and never closes the modal. We flip it in place rather than reload() so any
  // unsaved edits in the fields above survive the click.
  if (!isDefault) {
    const star = document.createElement("button");
    star.className = "ghost";
    star.style.alignSelf = "flex-start";
    star.textContent = `Make default for ${p.connector.domainLabel}`;
    // The repaint goes FIRST, ahead of the cosmetic in-modal updates. It used
    // to go last, behind a subtitle write that threw on a null lookup — so
    // every promote failed after the POST had already landed: the new default
    // was stored, an error toast claimed otherwise, and both cards' badges kept
    // naming the old provider until a page reload. Nothing that only redresses
    // this modal should be able to strand the page on a state the server no
    // longer holds.
    star.onclick = busy(star, async () => {
      try {
        await api("POST", `/api/admin/plugins/slots/${p.connector.domain}`, { provider: p.name });
        ctx.refresh(); // repaint the default badge on every card behind the modal
        toast(`${p.label} is now the ${p.connector.domainLabel} default`);
        star.remove();
        subLine.textContent = `${p.connector.domainLabel} data provider. Currently the default for new adds.`;
      } catch (err) { toast.error(err.message); }
    });
    sec.appendChild(star);
  }

  // Test lives in the section like every other action (the footer holds just
  // Close). The typed key rides along when present, so Test works even before
  // the blur that saves it; otherwise it tests the stored one.
  const test = document.createElement("button");
  test.className = "ghost";
  test.style.alignSelf = "flex-start";
  test.textContent = "Test";
  test.onclick = busy(test, async () => {
    const typed = secretInput?.value.trim();
    try {
      const body = typed ? { api_key: typed } : undefined;
      const { provider } = await api("POST", `/api/admin/plugins/${p.id}/test`, body);
      toast(`✓ ${provider} reachable`);
    } catch (err) { toast.error(err.message); }
  });
  sec.appendChild(test);

  return sec;
}

// --- ai: per-provider request pacing (rpm/burst) — mirrors the connector config ---
// Same number-field shape as connectorSection, scoped to the rate-limit
// fields the ai plugin declares. On-device providers declare none, so the
// dispatch above skips this section for them; keyless-networked ones pace like
// any other. Empty input = back to the descriptor default. No Save button:
// each field autosaves itself per key (the PATCH merges), and nothing
// rebuilds the modal — a rebuild here once discarded a model choice staged
// in the tagger section above.
function pacingSection(p) {
  const sec = section(
    "Rate limit",
    "How fast the worker calls this provider's API, per key. Raise it to match your account tier; blank uses the default. Saves as you edit."
  );
  for (const f of p.configSchema) {
    const input = document.createElement("input");
    input.type = "number";
    if (f.min !== undefined) input.min = String(f.min);
    input.value = p.state.config[f.key] ?? "";
    input.placeholder = `default ${f.default}`;
    input.style.cssText = "width:100%;box-sizing:border-box;";
    autosave(input, async () => {
      const v = input.value === "" ? null : Number(input.value); // null = clear the override, back to default
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { [f.key]: v } });
      p.state.config[f.key] = v; // local truth without a rebuild
    });
    sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
  }
  return sec;
}

// --- ai: this provider's keys (add / test / remove) ---

function keysSection(p, ctx, reload) {
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  // A keyless provider (self-hosted — no account secret) registers the same
  // rows as connections: the row is what boards and the default slots point
  // at, it just carries no key. Same section, softened language + optional input.
  const keyless = p.ai.keyless;
  const noun = keyless ? "connection" : "key";
  const sec = section(
    keyless ? "Connections" : "API keys",
    `Named ${noun}s for this provider. Boards can pick any of them; one can be the app default below.`
  );

  // Self-hosted providers (needsBase): a connection IS a server, so show where
  // each row points — its own URL, or the plugin's default base.
  const needsBase = p.ai.needsBase;
  if (mine.length) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Name</th>${needsBase ? "<th>Server</th>" : ""}<th>Key</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const k of mine) {
      // Every capability whose stored binding is this row — the old check knew
      // only tagging's slot, so a key serving as the default embedder (or
      // transcriber, or detector) carried no badge at all. The badge also
      // names its role now: "default" alone stopped being an answer the
      // moment one row could hold several.
      const roles = keyRoles(ctx.capabilities, k.id);
      const roleBadges = roles.map((c) => `<span class="badge">default ${c.agent}</span>`).join(" ");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${k.name} ${roleBadges}</td>
        ${needsBase ? `<td style="${MONO_CSS}color:#9aa0aa"></td>` : ""}
        <td style="${MONO_CSS}color:#9aa0aa">${k.hint}</td>
        <td><div class="row-actions"></div></td>`;
      if (needsBase) tr.children[1].textContent = k.base_url || `${p.ai.base || "?"} (default)`;
      const act = tr.querySelector(".row-actions");

      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = busy(testBtn, async () => {
        try {
          await api("POST", `/api/admin/ai-keys/${k.id}/test`);
          toast(`✓ "${k.name}" ${noun} works`);
        } catch (err) { toast.error(`"${k.name}": ${err.message}`); }
      });

      const editBtn = document.createElement("button");
      editBtn.className = "ghost";
      editBtn.textContent = "edit";
      editBtn.onclick = () => beginEdit(k);

      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "remove";
      delBtn.onclick = async () => {
        const uses = Number(k.boards_using) || 0;
        const extra = uses ? ` ${uses} board(s) use it and will fall back to the default.` : "";
        // One consequence sentence per capability this row backs, from the
        // feed — instead of the old copy that claimed tagging's fallback
        // story for every key.
        const impact = roles.map((c) => ` It is the default ${c.agent} — ${removalStory(c)}.`).join("");
        if (!confirm(`Remove ${noun} "${k.name}"?${extra}${impact}`)) return;
        try {
          await api("DELETE", `/api/admin/ai-keys/${k.id}`);
          toast(`${keyless ? "Connection" : "Key"} "${k.name}" removed`);
          reload();
        } catch (err) { toast.error(err.message); }
      };
      act.append(testBtn, editBtn, delBtn);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  } else {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    // A capability's env rung belongs to a specific provider — when the server
    // holds that secret and THIS is the provider, an empty key list is not
    // "unconfigured". All three literals (provider, capability, env var) come
    // from the feed now.
    const envCap = (ctx.capabilities || []).find((c) => c.env?.configured && c.env.provider === p.name);
    none.textContent = envCap
      ? `No ${noun}s stored — ${envCap.noun} runs on the ${envCap.env.var} env var.`
      : `No ${noun}s yet.`;
    sec.appendChild(none);
  }

  const addForm = document.createElement("form");
  addForm.style.cssText = "margin:0;";
  const nameIn = document.createElement("input");
  nameIn.placeholder = keyless ? "Name (e.g. Homelab)" : "Name (e.g. Personal)";
  nameIn.required = true;
  nameIn.autocomplete = "off";
  // Self-hosted: the server URL is the connection's identity. Blank keeps the
  // plugin's default base (shown as the placeholder).
  let baseIn = null;
  if (needsBase) {
    baseIn = document.createElement("input");
    baseIn.type = "text";
    baseIn.placeholder = p.ai.base || "http://host:port/v1";
    baseIn.autocomplete = "off";
    baseIn.spellcheck = false;
    baseIn.style.cssText = MONO_CSS;
  }
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  // Keyless: the token is optional (e.g. a reverse proxy in front of the box).
  keyIn.placeholder = keyless ? "token (optional)" : "sk-…";
  // "new-password", not "off": Chrome ignores "off" on password fields once a
  // login is saved for the site, and autofills email+password into name+key.
  keyIn.autocomplete = "new-password";
  keyIn.required = !keyless;
  keyIn.style.cssText = MONO_CSS;
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.textContent = `Add ${noun}`;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost";
  cancelBtn.textContent = "Cancel";
  cancelBtn.hidden = true;
  addForm.append(nameIn, ...(baseIn ? [baseIn] : []), keyIn, addBtn, cancelBtn);

  // Edit-in-place reuses the add form (the sourceSection pattern): prefill,
  // flip the button to Save, PATCH on submit. The row id never changes, so
  // boards and the default slots ride through a rename / repoint / rotation.
  let editingId = null;
  function beginEdit(k) {
    editingId = k.id;
    nameIn.value = k.name;
    if (baseIn) baseIn.value = k.base_url || "";
    keyIn.value = "";
    keyIn.required = false;
    keyIn.placeholder = k.hint === "no key" ? "token (optional)" : "•••• stored — leave blank to keep";
    addBtn.textContent = "Save changes";
    cancelBtn.hidden = false;
    nameIn.focus();
  }
  cancelBtn.onclick = () => {
    editingId = null;
    addForm.reset();
    keyIn.required = !keyless;
    keyIn.placeholder = keyless ? "token (optional)" : "sk-…";
    addBtn.textContent = `Add ${noun}`;
    cancelBtn.hidden = true;
  };

  addForm.onsubmit = busy(addBtn, async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        await api("PATCH", `/api/admin/ai-keys/${editingId}`, {
          name: nameIn.value.trim(),
          ...(keyIn.value.trim() ? { key: keyIn.value.trim() } : {}), // blank = keep the stored one
          ...(baseIn ? { base_url: baseIn.value.trim() } : {}), // blank = back to the default
        });
        toast(`${keyless ? "Connection" : "Key"} "${nameIn.value.trim()}" saved`);
      } else {
        await api("POST", "/api/admin/ai-keys", {
          name: nameIn.value.trim(),
          provider: p.name,
          key: keyIn.value.trim(),
          ...(baseIn?.value.trim() ? { base_url: baseIn.value.trim() } : {}),
        });
        toast(`${keyless ? "Connection" : "Key"} "${nameIn.value.trim()}" added`);
      }
      // awaited so the button stays held until the rebuild replaces it
      await reload(); // rebuilds the section — form state resets with it
    } catch (err) {
      toast.error(err.message);
    }
  });
  sec.appendChild(addForm);
  return sec;
}

// --- ai: one generic capability section (capabilities-plan.md, slice 4b) ---
// The tagger/embedder/transcriber/detector sections used to be four ~110-line
// copies of this, each free to disagree. Every DECISION now comes from
// planSection (capability-present.js, pure and node-tested — including the
// exact bind bodies); this shell only mounts the plan onto the shared pieces
// (section/fillSelect/syncModelPicker/slotButton) and posts to the
// capability-native routes.
function capabilitySection(cap, p, ctx, reload) {
  const plan = planSection(cap, p, ctx.keys.filter((k) => k.provider === p.name));
  const sec = section(plan.title, plan.subtitle);
  const muted = (text) => {
    const el = document.createElement("p");
    el.className = "muted";
    el.style.margin = "0";
    el.textContent = text;
    return el;
  };
  if (plan.guard) {
    sec.appendChild(muted(plan.guard));
    return sec;
  }

  let keySel = null;
  if (plan.rows) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    fillSelect(keySel, plan.rows, { value: plan.preselect, placeholder: plan.ask ? pickKey(p) : null });
    if (plan.ask) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  let modelSel = null;
  if (plan.model.catalog) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    // Live options carved to this capability (kind = its declaring id); the
    // slot's persisted model rides as `saved` only while the selected
    // connection IS the slot's own.
    const syncLive = () => syncModelPicker(modelSel, plan.model.catalog, keySel ? (keySel.value === "env" ? "env" : Number(keySel.value) || null) : null, {
      kind: cap.declaredBy,
      saved: plan.holder && (!keySel || keySel.value === plan.preselect) ? plan.savedModel : null,
      placeholder: pickModel(plan.model.catalog.defaultModel),
    });
    if (keySel) keySel.addEventListener("change", syncLive);
    syncLive();
    sec.appendChild(labeled("Model", modelSel));
  } else {
    sec.appendChild(muted(plan.model.note));
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const selVals = () => ({
    key: keySel?.value ?? null,
    model: modelSel?.value || plan.model.catalog?.defaultModel || null,
  });
  const post = (payload, okToast) => async () => {
    try {
      await api("POST", `/api/admin/capabilities/${cap.id}/bind`, payload());
      toast(okToast);
      reload();
    } catch (err) { toast.error(err.message); }
  };

  for (const b of plan.buttons) {
    if (b.kind === "apply") {
      const apply = async () => {
        const sel = selVals();
        // The costly-rebind confirm (embed: a model change re-embeds everything)
        // arms only while live with a pinned model — planned as data.
        if (plan.confirm && sel.model && sel.model !== plan.confirm.priorModel && !confirm(plan.confirm.message)) return;
        await post(() => b.payload(sel), b.toast)();
      };
      actions.appendChild(slotButton(b.label, plan.holder, [keySel, modelSel].filter(Boolean), apply));
    } else if (b.kind === "probe") {
      const t = document.createElement("button");
      t.className = "ghost";
      t.textContent = "Test";
      t.onclick = busy(t, async () => {
        try {
          const r = await api("POST", `/api/admin/capabilities/${cap.id}/probe`);
          toast(fmtProbe(r));
        } catch (err) { toast.error(err.message); }
      });
      actions.appendChild(t);
    } else {
      // off | revert: a fixed-payload write, styled as the destructive half.
      const btn = document.createElement("button");
      btn.className = "danger";
      btn.textContent = b.label;
      btn.onclick = busy(btn, post(b.payload, b.toast));
      actions.appendChild(btn);
    }
  }
  if (plan.currentDefault) {
    const span = document.createElement("span");
    span.className = "muted";
    span.style.cssText = "font-size:12px;";
    span.textContent = `Current default: ${plan.currentDefault.label}${plan.currentDefault.model ? ` · ${plan.currentDefault.model}` : ""}`;
    actions.appendChild(span);
  }
  // When the row is tight, the NOTE does the shrinking (it wraps onto more
  // lines) — never the buttons, whose labels would break mid-phrase ("Make
  // default embedder" on two lines). Flex items shrink by default, so opt the
  // buttons out.
  for (const el of actions.children) {
    if (el.tagName === "BUTTON") { el.style.flexShrink = "0"; el.style.whiteSpace = "nowrap"; }
  }
  if (actions.children.length) sec.appendChild(actions);
  if (plan.progressLine) sec.appendChild(muted(plan.progressLine));
  return sec;
}

// --- source: saved connections (add / edit / test / remove) ---

function sourceSection(p, ctx, reload) {
  // The local folder is built in — no saved connection, boards pick a
  // subfolder in their own ingestion settings.
  if (!p.capabilities.needsConnection) {
    const sec = section("Local folder", null);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Built-in — files under the server's ingest root (INGEST_ROOT). Boards choose a subfolder in their own ingestion settings; there's nothing to configure here.";
    sec.appendChild(note);
    return sec;
  }

  const mine = (ctx.connections || []).filter((c) => c.type === p.name);
  const sec = section("Connections", `Saved ${p.label} servers. A board picks one plus a subpath — the credentials never leave here.`);

  if (mine.length) {
    const table = document.createElement("table");
    const head = document.createElement("thead");
    head.innerHTML = "<tr><th>Name</th><th>Server</th><th></th></tr>";
    table.appendChild(head);
    const tbody = document.createElement("tbody");
    for (const c of mine) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = c.label;
      if (c.boards_using) {
        const b = document.createElement("span");
        b.className = "badge";
        b.style.marginLeft = "6px";
        b.textContent = `${c.boards_using} board${c.boards_using > 1 ? "s" : ""}`;
        nameTd.appendChild(b);
      }

      const hintTd = document.createElement("td");
      hintTd.style.cssText = `${MONO_CSS}color:#9aa0aa`;
      hintTd.textContent = p.connectionSchema.filter((f) => f.type === "text").map((f) => c.config?.[f.key]).filter(Boolean)[0] || "";

      const actTd = document.createElement("td");
      const act = document.createElement("div");
      act.className = "row-actions";
      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = busy(testBtn, async () => {
        try { await api("POST", "/api/admin/source-connections/test", { id: c.id }); toast(`✓ "${c.label}" reachable`); }
        catch (err) { toast.error(`"${c.label}": ${err.message}`); }
      });
      const editBtn = document.createElement("button");
      editBtn.className = "ghost";
      editBtn.textContent = "edit";
      editBtn.onclick = () => renderForm(c);
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "remove";
      delBtn.onclick = async () => {
        const extra = c.boards_using ? ` ${c.boards_using} board(s) use it and will stop refreshing until re-pointed.` : "";
        if (!confirm(`Remove connection "${c.label}"?${extra}`)) return;
        try { await api("DELETE", `/api/admin/source-connections/${c.id}`); toast(`"${c.label}" removed`); reload(); }
        catch (err) { toast.error(err.message); }
      };
      act.append(testBtn, editBtn, delBtn);
      actTd.appendChild(act);

      tr.append(nameTd, hintTd, actTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  }

  // Add / edit form. Rebuilt on mode switch so toggle rows get the right initial
  // state (switchRow captures its value at construction).
  const formHost = document.createElement("div");
  sec.appendChild(formHost);

  function renderForm(editing) {
    formHost.replaceChildren();
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:10px;border-top:1px solid #eee;padding-top:12px;";
    box.appendChild(sectionHeadingEl(editing ? `Edit "${editing.label}"` : "Add a connection"));

    const labelIn = document.createElement("input");
    labelIn.placeholder = "Name (e.g. Client server)";
    labelIn.style.cssText = "width:100%;box-sizing:border-box;";
    labelIn.value = editing?.label || "";
    box.appendChild(labeled("Name", labelIn));

    const getters = [];
    for (const f of p.connectionSchema) {
      if (f.type === "toggle") {
        let on = editing ? !!editing.config?.[f.key] : !!f.default;
        box.appendChild(switchRow(f.label, f.help || "", on, (v) => { on = v; }));
        getters.push({ f, get: () => on });
        continue;
      }
      const input = document.createElement("input");
      input.style.cssText = `width:100%;box-sizing:border-box;${f.type === "secret" ? MONO_CSS : ""}`;
      if (f.type === "number") { input.type = "number"; if (f.min !== undefined) input.min = String(f.min); }
      if (f.type === "secret") {
        input.type = "password";
        input.autocomplete = "new-password"; // "off" is ignored for password fields
        input.placeholder = editing?.hasSecret?.[f.key] ? "•••• stored — leave blank to keep" : (f.required ? "required" : f.help || "");
      } else {
        input.value = editing?.config?.[f.key] ?? (f.default ?? "");
        input.placeholder = f.help || "";
      }
      box.appendChild(labeled(f.label, input));
      getters.push({ f, get: () => (f.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value.trim()) });
    }

    const collect = () => {
      const config = {};
      for (const { f, get } of getters) {
        const v = get();
        if (f.type === "secret") { if (v) config[f.key] = v; } // blank = keep the stored one
        else if (f.type === "toggle") config[f.key] = v;
        else if (v !== undefined && v !== "") config[f.key] = v;
      }
      return { label: labelIn.value.trim(), config };
    };

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;align-items:center;";
    const saveBtn = document.createElement("button");
    saveBtn.textContent = editing ? "Save changes" : "Add connection";
    saveBtn.onclick = busy(saveBtn, async () => {
      const { label, config } = collect();
      if (!label) { toast.error("Name required"); return; }
      try {
        if (editing) await api("PATCH", `/api/admin/source-connections/${editing.id}`, { label, config });
        else await api("POST", "/api/admin/source-connections", { type: p.name, label, config });
        toast(editing ? "Connection saved" : `"${label}" added`);
        reload();
      } catch (err) { toast.error(err.message); }
    });
    const testBtn = document.createElement("button");
    testBtn.className = "ghost";
    testBtn.textContent = "Test";
    testBtn.onclick = busy(testBtn, async () => {
      const { config } = collect();
      try {
        await api("POST", "/api/admin/source-connections/test", editing ? { id: editing.id, config } : { type: p.name, config });
        toast("✓ reachable");
      } catch (err) { toast.error(err.message); }
    });
    actions.append(saveBtn, testBtn);
    if (editing) {
      const cancel = document.createElement("button");
      cancel.className = "ghost";
      cancel.textContent = "Cancel";
      cancel.onclick = () => renderForm(null);
      actions.appendChild(cancel);
    }
    box.appendChild(actions);
    formHost.appendChild(box);
  }
  renderForm(null);

  // The add/edit form is rebuilt on demand and carries its own Save/Test/Cancel,
  // so there's nothing for the footer — it holds just Close.
  return sec;
}

// --- media: accepted extensions + the adjustable per-type upload limit ---

function mediaSection(p) {
  const sec = section("File types", null);
  const list = document.createElement("p");
  list.style.cssText = "margin:0;" + MONO_CSS;
  list.textContent = p.capabilities.extensions.map((e) => "." + e).join("  ");
  sec.appendChild(list);
  const note = document.createElement("p");
  note.className = "muted";
  note.style.margin = "0";
  note.textContent = "Built-in — always installed; it's how the app reads these file types.";
  sec.appendChild(note);

  // Per-type upload limit: the manifest default, overridable here. Shown in MB;
  // stored as bytes in the plugin config, which the server reads in mediaLimits.
  const MB = 1024 * 1024;
  const defaultMB = Math.round((p.capabilities.maxBytes || 0) / MB);
  const ceilingMB = Math.round((p.capabilities.ceilingBytes || 0) / MB);
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.style.cssText = "width:100%;box-sizing:border-box;";
  input.value = p.state.config.maxBytes != null ? String(Math.round(p.state.config.maxBytes / MB)) : "";
  input.placeholder = `${defaultMB} (default)`;
  sec.appendChild(labeled(
    `Max upload size (MB) <span style="color:#b6b6bd;font-weight:400;">· blank = default (${defaultMB} MB)${ceilingMB ? ` · server ceiling ${ceilingMB} MB` : ""}</span>`,
    input,
  ));

  // Autosaves on change; a bad value throws into the helper's revert path.
  autosave(input, async () => {
    const raw = input.value.trim();
    let maxBytes = null; // blank → clear the override (back to the manifest default)
    if (raw !== "") {
      const mbVal = Number(raw);
      if (!Number.isFinite(mbVal) || mbVal < 1) throw new Error("Enter at least 1 MB, or leave blank for the default");
      maxBytes = Math.round(mbVal * MB);
    }
    await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { maxBytes } });
    p.state.config.maxBytes = maxBytes;
    // Quiet on success — except an over-ceiling override, which stores as-is
    // (it takes effect if the env ceiling is later raised) but is clamped by
    // the server in mediaLimits: say what actually applies rather than
    // silently accepting a bigger number.
    if (ceilingMB && maxBytes > p.capabilities.ceilingBytes)
      toast(`Uploads cap at the ${ceilingMB} MB server ceiling (UPLOAD_HARD_CEILING)`);
  });
  return sec;
}
