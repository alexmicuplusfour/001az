// Per-plugin configuration modal, opened from the Plugins tab. Sections vary
// by kind: connectors get their schema-driven config form (key, rate limits)
// plus Test and the domain-default star; AI providers get their key registry
// (this provider's slice of ai_keys) plus the default-tagger / embeddings
// slots they can serve; media types are informational (the row toggle is
// their substance). All writes go through the plugins API + the existing
// ai-keys/ai-config routes — this file owns no state of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal } from "/modal.js";
import { fillModelSelect, switchRow } from "/board-modal.js";

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

  if (p.kind === "connector") {
    body.appendChild(connectorSection(p, ctx, done));
  } else if (p.kind === "ai") {
    if (!p.ai.keyless) body.appendChild(keysSection(p, ctx, done));
    if (p.capabilities.tag) body.appendChild(taggerSection(p, ctx, done));
    if (p.capabilities.embed) body.appendChild(embedSection(p, ctx, done));
  } else {
    body.appendChild(mediaSection(p));
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
  sec.appendChild(actions);
  return sec;
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
  return sec;
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
    return sec;
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
  sec.appendChild(actions);
  return sec;
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
    return sec;
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
  sec.appendChild(actions);
  return sec;
}

// --- media: informational ---

function mediaSection(p) {
  const sec = section("File types", null);
  const list = document.createElement("p");
  list.style.cssText = "margin:0;" + MONO_CSS;
  list.textContent = p.capabilities.extensions.map((e) => "." + e).join("  ");
  sec.appendChild(list);
  const note = document.createElement("p");
  note.className = "muted";
  note.style.margin = "0";
  note.textContent = p.core
    ? "Core plugin — image ingestion is always on (previews for every media type render through it)."
    : "Turning this plugin off stops NEW uploads and feed ingestion of these types. Existing items keep their files and previews.";
  sec.appendChild(note);
  return sec;
}
