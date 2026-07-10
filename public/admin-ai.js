// AI Tagger tab: the multi-provider key registry (add/test/remove keys), the
// app-wide default tagger (key + model), and semantic-search embeddings config.
// Model/embedding options come from the served provider catalog. Self-guards on
// /api/me, so it no-ops for non-admins.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { fillModelSelect, loadProviders, byName, switchRow } from "/board-modal.js";

export async function renderAiConfig() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let cfg, keys, catalog;
  try {
    [cfg, keys, catalog] = await Promise.all([
      api("GET", "/api/admin/ai-config"),
      api("GET", "/api/admin/ai-keys"),
      loadProviders(),
    ]);
  } catch { return; }
  const providers = byName(catalog);

  const sec = document.createElement("div");
  sec.className = "section";
  sec.id = "ai-config-section";
  sec.innerHTML = `<h2>AI Tagger</h2><p class="sub">API keys for automatic tagging. The default applies to every board; a board can pick a different key in its settings.</p>`;

  // --- keys table ---
  if (keys.length) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Name</th><th>Provider</th><th>Key</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const k of keys) {
      const tr = document.createElement("tr");
      const isDefault = cfg.defaultKeyId === k.id;
      tr.innerHTML = `
        <td><span class="name-cell"><svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="3.2"/><path d="M12 9.2V19"/><path d="M12 14h3.2"/><path d="M12 16.6h4"/></svg><span>${k.name} ${isDefault ? '<span class="badge">default</span>' : ""}</span></span></td>
        <td>${k.provider}</td>
        <td style="font-family:'SF Mono',Consolas,monospace;color:#9aa0aa">${k.hint}</td>
        <td><div class="row-actions"></div></td>`;
      const act = tr.querySelector(".row-actions");

      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = "testing…";
        try {
          await api("POST", `/api/admin/ai-keys/${k.id}/test`);
          toast(`✓ "${k.name}" key works`);
        } catch (err) {
          toast.error(`"${k.name}": ${err.message}`);
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = "test";
        }
      };
      act.appendChild(testBtn);

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
          renderAiConfig();
        } catch (err) { toast.error(err.message); }
      };
      act.appendChild(delBtn);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  } else {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = cfg.envKey
      ? "No keys stored — tagging runs on the ANTHROPIC_API_KEY env var."
      : "No keys yet — add one to enable tagging.";
    sec.appendChild(none);
  }

  // --- add key form ---
  const addForm = document.createElement("form");
  addForm.style.cssText = "margin-top:14px;";
  const nameIn = document.createElement("input");
  nameIn.placeholder = "Name (e.g. Personal Anthropic)";
  nameIn.required = true;
  const provSel = document.createElement("select");
  provSel.style.cssText = "flex:none;";
  for (const p of catalog.filter((p) => !p.keyless)) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    provSel.appendChild(opt);
  }
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  keyIn.placeholder = "sk-…";
  keyIn.autocomplete = "off";
  keyIn.required = true;
  keyIn.style.cssText = "font-family:'SF Mono',Consolas,monospace;font-size:13px;";
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.textContent = "Add key";
  addForm.append(nameIn, provSel, keyIn, addBtn);
  addForm.onsubmit = async (e) => {
    e.preventDefault();
    addBtn.disabled = true;
    try {
      await api("POST", "/api/admin/ai-keys", { name: nameIn.value.trim(), provider: provSel.value, key: keyIn.value.trim() });
      toast(`Key "${nameIn.value.trim()}" added`);
      renderAiConfig();
    } catch (err) {
      toast.error(err.message);
      addBtn.disabled = false;
    }
  };
  sec.appendChild(addForm);

  // --- default tagger ---
  const defSec = document.createElement("div");
  defSec.style.cssText = "margin-top:28px;max-width:480px;display:flex;flex-direction:column;gap:14px;";
  defSec.innerHTML = `<div><h2 style="font-size:14px;margin:0 0 2px;">Default tagger</h2><p class="sub" style="margin:0;">Used by every board that doesn't set its own.</p></div>`;

  const keyRow = document.createElement("div");
  keyRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Key</label>`;
  const keySel = document.createElement("select");
  keySel.style.cssText = "width:100%;";
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = String(k.id);
    opt.textContent = `${k.name} — ${k.provider}`;
    keySel.appendChild(opt);
  }
  if (cfg.envKey) {
    const opt = document.createElement("option");
    opt.value = "env";
    opt.textContent = "ANTHROPIC_API_KEY env var — anthropic";
    keySel.appendChild(opt);
  }
  if (!keys.length && !cfg.envKey) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "none — tagging disabled";
    keySel.appendChild(opt);
  }
  keySel.value = cfg.defaultKeyId ? String(cfg.defaultKeyId) : cfg.envKey ? "env" : "";
  keyRow.appendChild(keySel);
  defSec.appendChild(keyRow);

  const modelRow = document.createElement("div");
  modelRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Model</label>`;
  const modelSel = document.createElement("select");
  modelSel.style.cssText = "width:100%;";
  const providerOf = () => {
    if (keySel.value === "env") return "anthropic";
    const k = keys.find((x) => String(x.id) === keySel.value);
    return k ? k.provider : "anthropic";
  };
  fillModelSelect(modelSel, providers[providerOf()], cfg.model);
  keySel.onchange = () => fillModelSelect(modelSel, providers[providerOf()], null);
  modelRow.appendChild(modelSel);
  defSec.appendChild(modelRow);

  const actionRow = document.createElement("div");
  actionRow.style.cssText = "display:flex;gap:8px;align-items:center;";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await api("POST", "/api/admin/ai-config", {
        defaultKeyId: keySel.value && keySel.value !== "env" ? Number(keySel.value) : null,
        model: modelSel.value,
      });
      toast("Default tagger saved");
      await renderAiConfig();
    } catch (err) {
      toast.error(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  };

  const testBtn = document.createElement("button");
  testBtn.className = "ghost";
  testBtn.textContent = "Test";
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    try {
      const { model: m, provider: p } = await api("POST", "/api/admin/ai-config/test");
      toast(`✓ ${p}/${m} reachable`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test";
    }
  };

  actionRow.append(saveBtn, testBtn);
  defSec.appendChild(actionRow);
  sec.appendChild(defSec);

  // --- semantic search (embeddings) ---
  const emSec = document.createElement("div");
  emSec.style.cssText = "margin-top:28px;max-width:480px;display:flex;flex-direction:column;gap:14px;";
  emSec.innerHTML = `<div><h2 style="font-size:14px;margin:0 0 2px;">Semantic search</h2><p class="sub" style="margin:0;">Free-text search that ranks a board's items by meaning, built from the tagger's reasoning and descriptions.</p></div>`;

  const embedKeys = keys.filter((k) => providers[k.provider]?.embeds);
  let embedOn = !!cfg.embed?.enabled;

  // Provider selector: local (always first, no key needed) then API key options.
  const emProvRow = document.createElement("div");
  emProvRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Embedding provider</label>`;
  const emProvSel = document.createElement("select");
  emProvSel.style.cssText = "width:100%;";
  const localOpt = document.createElement("option");
  localOpt.value = "local";
  localOpt.textContent = "Local — Xenova/bge-small-en-v1.5 · runs on-server, no key needed";
  emProvSel.appendChild(localOpt);
  if (embedKeys.length) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "──────────────────";
    emProvSel.appendChild(sep);
    for (const k of embedKeys) {
      const opt = document.createElement("option");
      opt.value = String(k.id);
      opt.textContent = `${k.name} — ${k.provider}`;
      emProvSel.appendChild(opt);
    }
  }
  const initSel = cfg.embed?.provider === "local" ? "local"
    : cfg.embed?.keyId && embedKeys.find((k) => k.id === cfg.embed.keyId) ? String(cfg.embed.keyId)
    : "local";
  emProvSel.value = initSel;
  emProvRow.appendChild(emProvSel);

  // Model selector — only shown for API key providers.
  const emModelRow = document.createElement("div");
  emModelRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Embedding model</label>`;
  const emModelSel = document.createElement("select");
  emModelSel.style.cssText = "width:100%;";
  const emProviderOf = () => embedKeys.find((k) => String(k.id) === emProvSel.value)?.provider || "openai";
  const fillEmbedModels = (current) => {
    emModelSel.replaceChildren();
    const embeds = providers[emProviderOf()]?.embeds;
    if (!embeds) return;
    for (const m of embeds.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.id} — ${m.note}`;
      if (m.id === (current || embeds.default)) opt.selected = true;
      emModelSel.appendChild(opt);
    }
  };
  const updateModelRow = () => {
    const isLocal = emProvSel.value === "local";
    emModelRow.style.display = isLocal ? "none" : "";
    if (!isLocal) fillEmbedModels(null);
  };
  if (emProvSel.value !== "local") fillEmbedModels(cfg.embed?.model);
  updateModelRow();
  emProvSel.onchange = updateModelRow;
  emModelRow.appendChild(emModelSel);

  const emSwitch = switchRow("Enable semantic search", "(items are embedded in the background; a search box appears on boards)", embedOn, (on) => { embedOn = on; });

  const emStatus = document.createElement("p");
  emStatus.className = "muted";
  emStatus.style.margin = "0";
  if (cfg.embed?.enabled) {
    const { embedded, tagged } = cfg.embed.stats || {};
    emStatus.textContent =
      tagged && embedded < tagged
        ? `${embedded} of ${tagged} tagged items embedded — the rest backfill in the background.`
        : `All ${tagged || 0} tagged items embedded.`;
  }

  const emActions = document.createElement("div");
  emActions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const emSave = document.createElement("button");
  emSave.textContent = "Save";
  emSave.onclick = async () => {
    emSave.disabled = true;
    emSave.textContent = "Saving…";
    const isLocal = emProvSel.value === "local";
    const changingModel = !isLocal && cfg.embed?.enabled && cfg.embed?.model && cfg.embed.model !== emModelSel.value;
    if (changingModel && !confirm("Changing the embedding model re-embeds every item (costs cents, takes a while). Continue?")) {
      emSave.disabled = false;
      emSave.textContent = "Save";
      return;
    }
    try {
      await api("POST", "/api/admin/ai-config", isLocal
        ? { embedProvider: "local", embedEnabled: embedOn }
        : { embedProvider: null, embedKeyId: Number(emProvSel.value), embedModel: emModelSel.value, embedEnabled: embedOn }
      );
      toast("Semantic search settings saved");
      await renderAiConfig();
    } catch (err) {
      toast.error(err.message);
      emSave.disabled = false;
      emSave.textContent = "Save";
    }
  };
  const emTest = document.createElement("button");
  emTest.className = "ghost";
  emTest.textContent = "Test";
  emTest.onclick = async () => {
    emTest.disabled = true;
    emTest.textContent = "Testing…";
    try {
      const { model: m, provider: p } = await api("POST", "/api/admin/ai-config/embed-test");
      toast(`✓ ${p}/${m} reachable`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      emTest.disabled = false;
      emTest.textContent = "Test";
    }
  };
  emActions.append(emSave, emTest);

  emSec.append(emProvRow, emModelRow, emSwitch, emActions);
  if (emStatus.textContent) emSec.appendChild(emStatus);
  sec.appendChild(emSec);

  document.getElementById("ai-config-content").replaceChildren(sec);
}
