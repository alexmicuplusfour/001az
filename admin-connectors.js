// Connectors tab: choose the data provider for each connector (e.g. Crypto ->
// CoinGecko or CoinMarketCap) and store its API key. The domain is fixed by a
// board's mapping; this only swaps the backend that supplies the numbers.
// Mirrors the AI tagger's save/test pattern. Self-guards on /api/me.
import { toast } from "/toast.js";
import { api } from "/api.js";

export async function renderConnectors() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let connectors;
  try {
    connectors = await api("GET", "/api/admin/connectors");
  } catch {
    return;
  }

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Connectors</h2><p class="sub">Data sources for connector boards. A board's mapping fixes the domain (e.g. Crypto); here you pick which provider supplies the values. Boards and their <code>domain:field</code> mappings stay put when you switch.</p>`;

  if (!connectors.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No connectors available.";
    sec.appendChild(none);
  }
  for (const c of connectors) sec.appendChild(connectorRow(c));

  document.getElementById("connectors-content").replaceChildren(sec);
}

function connectorRow(c) {
  const box = document.createElement("div");
  box.style.cssText = "margin-top:20px;max-width:480px;display:flex;flex-direction:column;gap:12px;";

  const cat = c.category ? `${c.category} · ` : "";
  const head = document.createElement("div");
  head.innerHTML = `<h2 style="font-size:14px;margin:0 0 2px;">${c.label}</h2><p class="sub" style="margin:0;">${cat}${c.description || ""}</p>`;
  box.appendChild(head);

  const provRow = document.createElement("div");
  provRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Provider</label>`;
  const provSel = document.createElement("select");
  provSel.style.cssText = "width:100%;";
  for (const p of c.providers) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.label + (p.needsKey ? "" : " — no key needed");
    provSel.appendChild(opt);
  }
  provSel.value = c.activeProvider || c.providers[0]?.name || "";
  provRow.appendChild(provSel);
  box.appendChild(provRow);

  const keyRow = document.createElement("div");
  keyRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">API key</label>`;
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  keyIn.autocomplete = "off";
  keyIn.style.cssText = "width:100%;box-sizing:border-box;font-family:'SF Mono',Consolas,monospace;font-size:13px;";
  keyRow.appendChild(keyIn);
  box.appendChild(keyRow);

  // The key field is always shown — a keyless provider (CoinGecko) still takes
  // an optional key for higher rate limits. Keys are per provider, so the
  // "stored" hint follows the selected provider.
  const desc = () => c.providers.find((p) => p.name === provSel.value);
  const needsKey = () => !!desc()?.needsKey;
  const syncKeyRow = () => {
    if (c.keys?.[provSel.value]) keyIn.placeholder = "•••• stored — leave blank to keep";
    else keyIn.placeholder = needsKey() ? "paste key" : "optional — raises rate limits";
  };
  syncKeyRow();
  provSel.onchange = syncKeyRow;

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const body = { provider: provSel.value };
      if (keyIn.value.trim()) body.api_key = keyIn.value.trim();
      await api("POST", `/api/admin/connectors/${c.name}`, body);
      toast(`${c.label}: ${provSel.value} saved`);
      renderConnectors();
    } catch (err) {
      toast.error(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  };

  // Test checks the selected provider with the typed key (or its stored key),
  // so it reflects the form without needing a Save first.
  const testBtn = document.createElement("button");
  testBtn.className = "ghost";
  testBtn.textContent = "Test";
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    try {
      const body = { provider: provSel.value };
      if (keyIn.value.trim()) body.api_key = keyIn.value.trim();
      const { provider } = await api("POST", `/api/admin/connectors/${c.name}/test`, body);
      toast(`✓ ${provider} reachable`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test";
    }
  };

  actions.append(saveBtn, testBtn);
  box.appendChild(actions);
  return box;
}
