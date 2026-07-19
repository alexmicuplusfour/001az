// Per-plugin configuration modal, opened from the Plugins tab gear. Sections
// vary by kind: connectors get their schema-driven config form (key, rate
// limits) plus Test and the domain-default star; AI providers get their key
// registry (this provider's slice of ai_keys) plus the default-tagger /
// embeddings slots they can serve; media types are informational (core
// capabilities, nothing to configure). The last recorded health error surfaces
// at the top. All writes go through the plugins API + the existing
// ai-keys/ai-config routes — this file owns no state of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal } from "/modal.js";
import { fillModelSelect, switchRow } from "/board-modal.js";
import { fmtDuration } from "/utils.js";

const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

const LABEL_CSS = "display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;";
const MONO_CSS = "font-family:'SF Mono',Consolas,monospace;font-size:13px;";

function section(title, sub) {
  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;gap:12px;";
  box.innerHTML = `<div><h2 style="font-size:14px;margin:0 0 2px;">${title}</h2>${sub ? `<p class="sub" style="margin:0;">${sub}</p>` : ""}</div>`;
  return box;
}

function labeled(label, el) {
  const row = document.createElement("div");
  row.innerHTML = `<label style="${LABEL_CSS}">${label}</label>`;
  row.appendChild(el);
  return row;
}

const busy = (btn, label, fn) => async () => {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
};

export function openPluginModal(p, ctx) {
  const { body, footer, close } = createModal({
    title: p.label,
    bodyStyle: "display:flex;flex-direction:column;gap:26px;",
  });
  const done = () => { close(); ctx.refresh(); };

  // Health lives here now (the row has no status dot): surface the last recorded
  // error, if any, so a failing integration is legible where you'd fix it.
  const health = p.state.health;
  if (health?.lastError?.message) {
    const banner = document.createElement("div");
    banner.style.cssText = "background:#fdf0f0;border:1px solid #f3d3d3;color:#8a3535;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.4;";
    const when = health.lastFailAt ? ` · ${relTime(health.lastFailAt)}` : "";
    banner.textContent = `Last error${when}: ${health.lastError.message}`;
    body.appendChild(banner);
  }

  // Each builder returns { node, actions }: the section's content plus its
  // primary action bar (or null). We collect them so the buttons can live in
  // the footer rather than floating at the bottom of the scrollable body.
  const built = [];
  if (p.kind === "connector") {
    built.push(connectorSection(p, ctx, done));
  } else if (p.kind === "ai") {
    if (!p.ai.keyless) built.push(keysSection(p, ctx, done));
    if (p.capabilities.tag) built.push(taggerSection(p, ctx, done));
    if (p.capabilities.embed) built.push(embedSection(p, ctx, done));
    if (p.capabilities.transcribe) built.push(transcribeSection(p, ctx, done));
  } else if (p.kind === "source") {
    built.push(sourceSection(p, ctx, done));
  } else {
    built.push(mediaSection(p, done));
  }
  for (const b of built) body.appendChild(b.node);

  // One action group → lift it into the footer next to Close. Two or more
  // (e.g. an AI provider serving both tagger and embedder) stay inline, since
  // each Save is scoped to its own section and collapsing them would be
  // ambiguous.
  const groups = built.map((b) => b.actions).filter(Boolean);
  if (groups.length === 1) {
    footer.appendChild(groups[0]);
  } else {
    for (const b of built) if (b.actions) b.node.appendChild(b.actions);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "ghost";
  closeBtn.textContent = "Close";
  closeBtn.onclick = close;
  footer.appendChild(closeBtn);
}

// --- connector: schema-driven config + test + domain default ---

function connectorSection(p, ctx, done) {
  const d = ctx.slots.domains[p.connector.domain] || {};
  const isDefault = (d.setting || d.effective) === p.name;
  const sec = section(
    "Configuration",
    `${p.connector.domainLabel} data provider.` + (isDefault ? " Currently the default for new adds." : "")
  );

  // One input per schema field; the plugin declares them, we just render.
  const fields = [];
  for (const f of p.configSchema) {
    if (f.type === "secret") {
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.style.cssText = `width:100%;box-sizing:border-box;${MONO_CSS}`;
      input.placeholder = p.state.hasKey
        ? "•••• stored — leave blank to keep"
        : f.required ? "paste key" : f.help || "optional";
      const row = labeled(f.label, input);
      let clear = false;
      if (p.state.hasKey) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "danger";
        rm.style.cssText = "margin-top:6px;padding:4px 10px;font-size:12px;";
        rm.textContent = "remove stored key";
        rm.onclick = () => {
          clear = !clear;
          rm.textContent = clear ? "will remove on save" : "remove stored key";
          input.disabled = clear;
        };
        row.appendChild(rm);
      }
      fields.push({ f, value: () => (clear ? "" : input.value.trim() || undefined) });
      sec.appendChild(row);
    } else if (f.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      if (f.min !== undefined) input.min = String(f.min);
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      // empty = back to the plugin's default
      fields.push({ f, value: () => (input.value === "" ? null : Number(input.value)) });
      sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
    } else if (f.type === "toggle") {
      let on = !!p.state.config[f.key];
      fields.push({ f, value: () => on });
      sec.appendChild(switchRow(f.label, f.help || "", on, (v) => { on = v; }));
    } else {
      const input = document.createElement("input");
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      fields.push({ f, value: () => input.value.trim() || null });
      sec.appendChild(labeled(f.label, input));
    }
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const save = document.createElement("button");
  save.textContent = "Save";
  save.onclick = busy(save, "Saving…", async () => {
    const config = {};
    for (const { f, value } of fields) {
      const v = value();
      if (v !== undefined) config[f.key] = v; // undefined = leave stored secret alone
    }
    try {
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config });
      toast(`${p.label} saved`);
      done();
    } catch (err) { toast.error(err.message); }
  });

  // Test pings the provider with the typed key (or its stored one), so it
  // reflects the form without needing a Save first.
  const test = document.createElement("button");
  test.className = "ghost";
  test.textContent = "Test";
  test.onclick = busy(test, "Testing…", async () => {
    const typed = fields.find(({ f }) => f.type === "secret")?.value();
    try {
      const body = typed !== undefined ? { api_key: typed } : undefined;
      const { provider } = await api("POST", `/api/admin/plugins/${p.id}/test`, body);
      toast(`✓ ${provider} reachable`);
    } catch (err) { toast.error(err.message); }
  });
  actions.append(save, test);

  if (!isDefault) {
    const star = document.createElement("button");
    star.className = "ghost";
    star.textContent = `Make default for ${p.connector.domainLabel}`;
    star.onclick = busy(star, "Saving…", async () => {
      try {
        await api("POST", `/api/admin/plugins/slots/${p.connector.domain}`, { provider: p.name });
        toast(`${p.label} is now the ${p.connector.domainLabel} default`);
        done();
      } catch (err) { toast.error(err.message); }
    });
    actions.appendChild(star);
  }
  return { node: sec, actions };
}

// --- ai: this provider's keys (add / test / remove) ---

function keysSection(p, ctx, done) {
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("API keys", "Named keys for this provider. Boards can pick any of them; one can be the app default below.");

  if (mine.length) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Name</th><th>Key</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const k of mine) {
      const isDefault = ctx.slots.tagger.keyId === k.id;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${k.name} ${isDefault ? '<span class="badge">default</span>' : ""}</td>
        <td style="${MONO_CSS}color:#9aa0aa">${k.hint}</td>
        <td><div class="row-actions"></div></td>`;
      const act = tr.querySelector(".row-actions");

      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = busy(testBtn, "testing…", async () => {
        try {
          await api("POST", `/api/admin/ai-keys/${k.id}/test`);
          toast(`✓ "${k.name}" key works`);
        } catch (err) { toast.error(`"${k.name}": ${err.message}`); }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "remove";
      delBtn.onclick = async () => {
        const uses = Number(k.boards_using) || 0;
        const extra = uses ? ` ${uses} board(s) use it and will fall back to the default.` : "";
        if (!confirm(`Remove key "${k.name}"?${extra}${isDefault ? " It is the current default — tagging falls back to the env var (or stops)." : ""}`)) return;
        try {
          await api("DELETE", `/api/admin/ai-keys/${k.id}`);
          toast(`Key "${k.name}" removed`);
          done();
        } catch (err) { toast.error(err.message); }
      };
      act.append(testBtn, delBtn);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  } else {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent =
      p.name === "anthropic" && ctx.slots.tagger.envKey
        ? "No keys stored — tagging runs on the ANTHROPIC_API_KEY env var."
        : "No keys yet.";
    sec.appendChild(none);
  }

  const addForm = document.createElement("form");
  addForm.style.cssText = "margin:0;";
  const nameIn = document.createElement("input");
  nameIn.placeholder = "Name (e.g. Personal)";
  nameIn.required = true;
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  keyIn.placeholder = "sk-…";
  keyIn.autocomplete = "off";
  keyIn.required = true;
  keyIn.style.cssText = MONO_CSS;
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.textContent = "Add key";
  addForm.append(nameIn, keyIn, addBtn);
  addForm.onsubmit = async (e) => {
    e.preventDefault();
    addBtn.disabled = true;
    try {
      await api("POST", "/api/admin/ai-keys", { name: nameIn.value.trim(), provider: p.name, key: keyIn.value.trim() });
      toast(`Key "${nameIn.value.trim()}" added`);
      done();
    } catch (err) {
      toast.error(err.message);
      addBtn.disabled = false;
    }
  };
  sec.appendChild(addForm);
  return { node: sec, actions: null };
}

// --- ai: the default-tagger slot ---

function taggerSection(p, ctx, done) {
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const isDefault = ctx.defaults.tagger === p.name;
  const sec = section("Default tagger", "Used by every board that doesn't set its own key.");

  const envOption = p.name === "anthropic" && ctx.slots.tagger.envKey;
  if (!mine.length && !envOption) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = "Add a key above to make this provider the default tagger.";
    sec.appendChild(none);
    return { node: sec, actions: null };
  }

  const keySel = document.createElement("select");
  keySel.style.cssText = "width:100%;";
  for (const k of mine) {
    const opt = document.createElement("option");
    opt.value = String(k.id);
    opt.textContent = k.name;
    keySel.appendChild(opt);
  }
  if (envOption) {
    const opt = document.createElement("option");
    opt.value = "env";
    opt.textContent = "ANTHROPIC_API_KEY env var";
    keySel.appendChild(opt);
  }
  if (isDefault) keySel.value = ctx.slots.tagger.keyId ? String(ctx.slots.tagger.keyId) : "env";
  sec.appendChild(labeled("Key", keySel));

  const modelSel = document.createElement("select");
  modelSel.style.cssText = "width:100%;";
  fillModelSelect(modelSel, p.ai, isDefault ? ctx.slots.tagger.model : null);
  sec.appendChild(labeled("Model", modelSel));

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const save = document.createElement("button");
  save.textContent = isDefault ? "Save" : "Make default tagger";
  save.onclick = busy(save, "Saving…", async () => {
    try {
      await api("POST", "/api/admin/ai-config", {
        defaultKeyId: keySel.value === "env" ? null : Number(keySel.value),
        model: modelSel.value,
      });
      toast("Default tagger saved");
      done();
    } catch (err) { toast.error(err.message); }
  });
  actions.appendChild(save);

  if (isDefault) {
    const test = document.createElement("button");
    test.className = "ghost";
    test.textContent = "Test";
    test.onclick = busy(test, "Testing…", async () => {
      try {
        const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/test");
        toast(`✓ ${pr}/${m} reachable`);
      } catch (err) { toast.error(err.message); }
    });
    actions.appendChild(test);
  }
  return { node: sec, actions };
}

// --- ai: the embedder slot (semantic search) ---

function embedSection(p, ctx, done) {
  const em = ctx.slots.embedder;
  const active = ctx.defaults.embedder === p.name;
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("Semantic search", "Free-text search that ranks a board's items by meaning. One embedder serves the whole app — vectors only compare within a model.");

  if (!p.ai.keyless && !mine.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = "Add a key above to embed with this provider.";
    sec.appendChild(none);
    return { node: sec, actions: null };
  }

  let keySel = null;
  if (!p.ai.keyless) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    for (const k of mine) {
      const opt = document.createElement("option");
      opt.value = String(k.id);
      opt.textContent = k.name;
      keySel.appendChild(opt);
    }
    if (active && em.keyId) keySel.value = String(em.keyId);
    if (mine.length > 1 || !active) sec.appendChild(labeled("Key", keySel));
  }

  let modelSel = null;
  if (p.ai.embeds.models.length > 1 || !p.ai.keyless) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    fillModelSelect(modelSel, { models: p.ai.embeds.models, defaultModel: p.ai.embeds.default }, active ? em.model : null);
    sec.appendChild(labeled("Embedding model", modelSel));
  } else {
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = p.ai.embeds.models[0].id + " — " + p.ai.embeds.models[0].note;
    sec.appendChild(note);
  }

  if (active && em.enabled) {
    // the backfill status line, honest about skipped items (they don't retry
    // on their own — re-tagging does)
    const { embedded = 0, tagged = 0, failed = 0 } = em.stats || {};
    const remaining = tagged - embedded - failed;
    const status = document.createElement("p");
    status.className = "muted";
    status.style.margin = "0";
    status.textContent =
      tagged && embedded < tagged
        ? `${embedded} of ${tagged} tagged items embedded${remaining > 0 ? " — the rest backfill in the background" : ""}.`
        : `All ${tagged} tagged items embedded.`;
    if (failed) status.textContent += ` ${failed} skipped after embedding errors — re-tagging retries them.`;
    sec.appendChild(status);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  const save = document.createElement("button");
  save.textContent = active && em.enabled ? "Save" : "Make default embedder";
  save.onclick = busy(save, "Saving…", async () => {
    const model = modelSel?.value || p.ai.embeds.default;
    if (active && em.enabled && em.model && em.model !== model &&
        !confirm("Changing the embedding model re-embeds every item (costs cents, takes a while). Continue?")) return;
    try {
      await api("POST", "/api/admin/ai-config", p.ai.keyless
        ? { embedProvider: "local", embedEnabled: true }
        : { embedProvider: null, embedKeyId: Number(keySel.value), embedModel: model, embedEnabled: true });
      toast("Semantic search settings saved");
      done();
    } catch (err) { toast.error(err.message); }
  });
  actions.appendChild(save);

  if (active && em.enabled) {
    const test = document.createElement("button");
    test.className = "ghost";
    test.textContent = "Test";
    test.onclick = busy(test, "Testing…", async () => {
      try {
        const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/embed-test");
        toast(`✓ ${pr}/${m} reachable`);
      } catch (err) { toast.error(err.message); }
    });
    const off = document.createElement("button");
    off.className = "danger";
    off.textContent = "Turn off";
    off.onclick = busy(off, "Saving…", async () => {
      try {
        await api("POST", "/api/admin/ai-config", { embedEnabled: false });
        toast("Semantic search turned off");
        done();
      } catch (err) { toast.error(err.message); }
    });
    actions.append(test, off);
  }
  return { node: sec, actions };
}

// Transcription slot — audio → text so recordings can be tagged. Mirrors
// embedSection, but transcription is always on (the local sidecar is the
// default), so there's no enable toggle: the provider choice IS the toggle.
// A provider advertises this via `transcribes`; the keyless local sidecar shows
// its baked model as a note (WHISPER_MODEL is a deploy knob, not a runtime pick).
function transcribeSection(p, ctx, done) {
  const tr = ctx.slots.transcriber;
  const active = ctx.defaults.transcriber === p.name;
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("Transcription", "Audio → text so recordings can be tagged. One transcriber serves the whole app; the on-server whisper sidecar is the default.");

  if (!p.ai.keyless && !mine.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = "Add a key above to transcribe with this provider.";
    sec.appendChild(none);
    return { node: sec, actions: null };
  }

  // Key picker (non-keyless providers).
  let keySel = null;
  if (!p.ai.keyless) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    for (const k of mine) {
      const opt = document.createElement("option");
      opt.value = String(k.id);
      opt.textContent = k.name;
      keySel.appendChild(opt);
    }
    if (active && tr.keyId) keySel.value = String(tr.keyId);
    if (mine.length > 1 || !active) sec.appendChild(labeled("Key", keySel));
  }

  // Model picker — a provider gets a dropdown of its transcribes.models; the
  // keyless local sidecar shows its single baked model as a note.
  let modelSel = null;
  if (!p.ai.keyless && p.ai.transcribes.models.length > 1) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    fillModelSelect(modelSel, { models: p.ai.transcribes.models, defaultModel: p.ai.transcribes.default }, active ? tr.model : null);
    sec.appendChild(labeled("Transcription model", modelSel));
  } else {
    const one = p.ai.transcribes.models[0];
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = one.id + " — " + one.note;
    sec.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  if (p.ai.keyless) {
    // The on-device whisper sidecar is the default. Offer the switch-back only
    // when a provider is currently overriding it.
    if (active) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.margin = "0";
      note.textContent = "On-server · always available · the default transcriber.";
      sec.appendChild(note);
    } else {
      const use = document.createElement("button");
      use.textContent = "Use Whisper";
      use.onclick = busy(use, "Saving…", async () => {
        try {
          await api("POST", "/api/admin/ai-config", { transcribeProvider: "whisper" });
          toast("Transcription set to the on-device Whisper sidecar");
          done();
        } catch (err) { toast.error(err.message); }
      });
      actions.appendChild(use);
    }
  } else {
    const save = document.createElement("button");
    save.textContent = active ? "Save" : "Make default transcriber";
    save.onclick = busy(save, "Saving…", async () => {
      const model = modelSel?.value || p.ai.transcribes.default;
      try {
        await api("POST", "/api/admin/ai-config", {
          transcribeProvider: p.name,
          transcribeKeyId: Number(keySel.value),
          transcribeModel: model,
        });
        toast("Transcription settings saved");
        done();
      } catch (err) { toast.error(err.message); }
    });
    actions.appendChild(save);

    if (active) {
      const test = document.createElement("button");
      test.className = "ghost";
      test.textContent = "Test";
      test.onclick = busy(test, "Testing…", async () => {
        try {
          const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/transcribe-test");
          toast(`✓ ${pr}/${m} reachable`);
        } catch (err) { toast.error(err.message); }
      });
      const off = document.createElement("button");
      off.className = "danger";
      off.textContent = "Use Whisper instead";
      off.onclick = busy(off, "Saving…", async () => {
        try {
          await api("POST", "/api/admin/ai-config", { transcribeProvider: "whisper" });
          toast("Transcription reverted to the on-device Whisper sidecar");
          done();
        } catch (err) { toast.error(err.message); }
      });
      actions.append(test, off);
    }
  }

  return { node: sec, actions: actions.children.length ? actions : null };
}

// --- source: saved connections (add / edit / test / remove) ---

function sourceSection(p, ctx, done) {
  // The local folder is a core capability — no saved connection, boards pick a
  // subfolder in their own ingestion settings.
  if (!p.capabilities.needsConnection) {
    const sec = section("Local folder", null);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Core capability — files under the server's ingest root (INGEST_ROOT). Boards choose a subfolder in their own ingestion settings; there's nothing to configure here.";
    sec.appendChild(note);
    return { node: sec, actions: null };
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
      testBtn.onclick = busy(testBtn, "testing…", async () => {
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
        try { await api("DELETE", `/api/admin/source-connections/${c.id}`); toast(`"${c.label}" removed`); done(); }
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
    const title = document.createElement("div");
    title.style.cssText = "font-size:13px;font-weight:600;";
    title.textContent = editing ? `Edit "${editing.label}"` : "Add a connection";
    box.appendChild(title);

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
        input.autocomplete = "off";
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
    saveBtn.onclick = busy(saveBtn, "Saving…", async () => {
      const { label, config } = collect();
      if (!label) { toast.error("Name required"); return; }
      try {
        if (editing) await api("PATCH", `/api/admin/source-connections/${editing.id}`, { label, config });
        else await api("POST", "/api/admin/source-connections", { type: p.name, label, config });
        toast(editing ? "Connection saved" : `"${label}" added`);
        done();
      } catch (err) { toast.error(err.message); }
    });
    const testBtn = document.createElement("button");
    testBtn.className = "ghost";
    testBtn.textContent = "Test";
    testBtn.onclick = busy(testBtn, "Testing…", async () => {
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
  // so there's no single primary action to hoist into the footer.
  return { node: sec, actions: null };
}

// --- media: accepted extensions + the adjustable per-type upload limit ---

function mediaSection(p, done) {
  const sec = section("File types", null);
  const list = document.createElement("p");
  list.style.cssText = "margin:0;" + MONO_CSS;
  list.textContent = p.capabilities.extensions.map((e) => "." + e).join("  ");
  sec.appendChild(list);
  const note = document.createElement("p");
  note.className = "muted";
  note.style.margin = "0";
  note.textContent = "Core capability — always installed; it's how the app reads these file types.";
  sec.appendChild(note);

  // Per-type upload limit: the manifest default, overridable here. Shown in MB;
  // stored as bytes in the plugin config, which the server reads in mediaLimits.
  const MB = 1024 * 1024;
  const defaultMB = Math.round((p.capabilities.maxBytes || 0) / MB);
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.style.cssText = "width:100%;box-sizing:border-box;";
  input.value = p.state.config.maxBytes != null ? String(Math.round(p.state.config.maxBytes / MB)) : "";
  input.placeholder = `${defaultMB} (default)`;
  sec.appendChild(labeled(
    `Max upload size (MB) <span style="color:#b6b6bd;font-weight:400;">· blank = default (${defaultMB} MB)</span>`,
    input,
  ));

  const save = document.createElement("button");
  save.textContent = "Save";
  save.onclick = busy(save, "Saving…", async () => {
    const raw = input.value.trim();
    let maxBytes = null; // blank → clear the override (back to the manifest default)
    if (raw !== "") {
      const mbVal = Number(raw);
      if (!Number.isFinite(mbVal) || mbVal < 1) return toast.error("Enter at least 1 MB, or leave blank for the default");
      maxBytes = Math.round(mbVal * MB);
    }
    try {
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { maxBytes } });
      toast(`${p.label} saved`);
      done();
    } catch (err) { toast.error(err.message); }
  });
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  actions.appendChild(save);
  return { node: sec, actions };
}
