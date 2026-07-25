// Alerts UI (planning/alerts-plan.md, Stage 3). Three surfaces:
//  - the plus-menu section (rows + "Alert on current filter…" footer) — the
//    plus corner is the arrivals cluster, and alerts are about arrivals;
//  - the create/edit modal (condition, delivery policy, webhook);
//  - the per-alert history modal (one row per firing; a row click swings the
//    gallery into that firing's ?event= view).
// Alerts are per-user like saved filters; state.alerts is the local mirror.
import { state } from './state.js';
import { ICONS, fmtDuration } from './utils.js';
import { toast } from './toast.js';
import { createModal, sectionHeadingEl } from './modal.js';
import { ddRow, ddSep } from './dropdown.js';
import { selectedAsConfig, applyFilterConfig } from './filters.js';
import { switchRow } from './board-modal.js';
import { openAlertEvent, clearAlertEvent } from './alert-event.js';

export const alertsUnseen = () => state.alerts.reduce((n, a) => n + (a.unseen || 0), 0);

const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

// ── the plus-menu section ──

export function appendAlertMenu(body, close) {
  body.appendChild(ddSep());
  if (!state.alerts.length) {
    const empty = document.createElement("div");
    empty.className = "dd-empty";
    // The saved-filters teaching trick: the empty state explains the flow.
    empty.textContent = Object.keys(selectedAsConfig()).length
      ? "No alerts yet — watch the current filter below."
      : "Pick some filters, then create an alert here.";
    body.appendChild(empty);
    return;
  }
  for (const a of state.alerts) {
    const actions = document.createElement("span");
    actions.className = "dd-actions";
    if (a.unseen > 0) {
      const badge = document.createElement("span");
      badge.className = "dd-unseen";
      badge.textContent = a.unseen > 99 ? "99+" : String(a.unseen);
      actions.appendChild(badge);
    }
    const edit = document.createElement("button");
    edit.className = "dd-vis";
    edit.title = "Edit alert";
    edit.innerHTML = ICONS.pencil;
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      openAlertEditor(a);
    });
    const del = document.createElement("button");
    del.className = "dd-del";
    del.title = "Delete alert";
    del.innerHTML = ICONS.trash;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete alert "${a.name}"? Its history goes with it.`)) return;
      try {
        const r = await fetch(`/api/alerts/${a.id}`, { method: "DELETE" });
        if (!r.ok) throw new Error();
        state.alerts = state.alerts.filter((x) => x.id !== a.id);
        close();
        document.dispatchEvent(new Event('app:render'));
      } catch {
        toast.error("Couldn't delete alert");
      }
    });
    actions.append(edit, del);
    const row = ddRow({
      label: a.name,
      trailing: actions,
      onClick: () => { close(); openAlertHistory(a); },
    });
    if (!a.enabled) row.classList.add("al-off");
    body.appendChild(row);
  }
}

// The create door, footer-pinned like the saved-filters input — and like it,
// only offered while facet pills are active (the condition IS the selection).
export function appendAlertFooter(foot, close) {
  if (!Object.keys(selectedAsConfig()).length) return;
  if (state.alerts.length) foot.appendChild(ddSep());
  foot.appendChild(ddRow({
    label: "Alert on current filter…",
    onClick: () => { close(); openAlertEditor(null); },
  }));
}

// ── the create/edit modal ──

const DELIVERY_LABELS = {
  immediate: "Immediately",
  daily: "Daily digest",
  record: "Record only",
};
const DELIVERY_HINTS = {
  immediate: "Notifies shortly after new matches settle — a bulk drop arrives as one notification, not hundreds.",
  daily: "One digest per day at the chosen time (nothing new = no notification).",
  record: "No notification — matches only show up in the alert's history here.",
};

export function openAlertEditor(existing) {
  const isNew = !existing;
  // The condition starts as the current pills (create) or the stored one
  // (edit); either way it's edited by removal only — adding means reopening
  // from a richer selection.
  let condition = structuredClone(isNew ? selectedAsConfig() : (existing.condition || {}));
  let enabled = isNew ? true : !!existing.enabled;
  let secretCleared = false;

  const { body, footer, close } = createModal({ title: isNew ? "New alert" : "Edit alert", id: "alert-modal" });

  // ── name ──
  const nameRow = document.createElement("div");
  nameRow.className = "im-row";
  const nameLbl = document.createElement("label");
  nameLbl.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "al-input";
  nameInput.maxLength = 64;
  nameInput.placeholder = "e.g. new logos";
  if (!isNew) nameInput.value = existing.name;
  nameRow.append(nameLbl, nameInput);
  body.appendChild(nameRow);

  // ── condition ──
  const condSection = document.createElement("div");
  condSection.className = "modal-section";
  const condHead = sectionHeadingEl("Condition", "New items matching every facet below (any of its values) trigger the alert.");
  condHead.style.marginBottom = "12px";
  condSection.appendChild(condHead);
  const condBox = document.createElement("div");
  condBox.className = "al-cond";
  condSection.appendChild(condBox);

  function renderCondition() {
    condBox.replaceChildren();
    const keys = Object.keys(condition);
    if (!keys.length) {
      const p = document.createElement("p");
      p.className = "im-hint";
      p.textContent = "The condition is empty — pick filters in the gallery, then reopen this dialog.";
      condBox.appendChild(p);
      return;
    }
    for (const key of keys) {
      const group = document.createElement("div");
      group.className = "al-cond-group";
      const k = document.createElement("span");
      k.className = "al-cond-key";
      k.textContent = key;
      group.appendChild(k);
      for (const v of condition[key]) {
        const chip = document.createElement("span");
        chip.className = "al-chip";
        const txt = document.createElement("span");
        txt.textContent = v;
        const rm = document.createElement("button");
        rm.type = "button";
        rm.title = "Remove";
        rm.textContent = "×";
        rm.addEventListener("click", () => {
          condition[key] = condition[key].filter((x) => x !== v);
          if (!condition[key].length) delete condition[key];
          renderCondition();
        });
        chip.append(txt, rm);
        group.appendChild(chip);
      }
      condBox.appendChild(group);
    }
  }
  renderCondition();

  // Editing an old alert while fresh pills are up: offer to adopt them —
  // removal-only editing can shrink a condition but never grow it.
  if (!isNew && Object.keys(selectedAsConfig()).length) {
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "im-btn";
    adopt.style.marginTop = "10px";
    adopt.textContent = "Replace with current filter";
    adopt.addEventListener("click", () => {
      condition = structuredClone(selectedAsConfig());
      renderCondition();
    });
    condSection.appendChild(adopt);
  }
  body.appendChild(condSection);

  // ── delivery ──
  const delSection = document.createElement("div");
  delSection.className = "modal-section";
  const delHead = sectionHeadingEl("Delivery");
  delHead.style.marginBottom = "12px";
  delSection.appendChild(delHead);
  const delRow = document.createElement("div");
  delRow.className = "im-row";
  const modeSel = document.createElement("select");
  modeSel.setAttribute("aria-label", "Delivery");
  for (const [m, label] of Object.entries(DELIVERY_LABELS)) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = label;
    if ((existing?.delivery || "immediate") === m) o.selected = true;
    modeSel.appendChild(o);
  }
  const atInput = document.createElement("input");
  atInput.type = "time";
  atInput.value = existing?.daily_at || "09:00";
  delRow.append(modeSel, atInput);
  const delHint = document.createElement("p");
  delHint.className = "im-hint";
  const syncDelivery = () => {
    atInput.style.display = modeSel.value === "daily" ? "" : "none";
    delHint.textContent = DELIVERY_HINTS[modeSel.value];
  };
  modeSel.addEventListener("change", syncDelivery);
  syncDelivery();
  delSection.append(delRow, delHint);
  body.appendChild(delSection);

  // ── webhook ──
  const hookSection = document.createElement("div");
  hookSection.className = "modal-section";
  const hookHead = sectionHeadingEl("Webhook", "A JSON POST per delivery — points at Discord/Slack/ntfy, an automation, or your own script.");
  hookHead.style.marginBottom = "12px";
  hookSection.appendChild(hookHead);
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.className = "al-input";
  urlInput.placeholder = "https://… (optional)";
  urlInput.autocomplete = "off";
  if (existing?.webhook_url) urlInput.value = existing.webhook_url;
  hookSection.appendChild(urlInput);

  const secretRow = document.createElement("div");
  secretRow.className = "im-row";
  secretRow.style.marginTop = "8px";
  const secretLbl = document.createElement("label");
  secretLbl.textContent = "Secret";
  const secretInput = document.createElement("input");
  secretInput.type = "password";
  secretInput.className = "al-input";
  secretInput.autocomplete = "new-password";
  secretInput.placeholder = existing?.has_secret ? "unchanged — type to replace" : "optional — signs the payload";
  secretInput.addEventListener("input", () => { secretCleared = false; syncSecret(); });
  secretRow.append(secretLbl, secretInput);
  let clearSecretBtn = null;
  if (existing?.has_secret) {
    clearSecretBtn = document.createElement("button");
    clearSecretBtn.type = "button";
    clearSecretBtn.className = "ghost";
    clearSecretBtn.addEventListener("click", () => {
      secretCleared = !secretCleared;
      if (secretCleared) secretInput.value = "";
      syncSecret();
    });
    secretRow.appendChild(clearSecretBtn);
  }
  const syncSecret = () => {
    if (!clearSecretBtn) return;
    clearSecretBtn.textContent = secretCleared ? "Keep secret" : "Remove secret";
    secretInput.placeholder = secretCleared ? "will be removed on save" : "unchanged — type to replace";
  };
  syncSecret();
  hookSection.appendChild(secretRow);

  const hookHint = document.createElement("p");
  hookHint.className = "im-hint";
  hookHint.textContent = "With a secret set, deliveries carry X-Alert-Signature (HMAC-SHA256 of the body).";
  hookSection.appendChild(hookHint);

  // Test fires the SAVED url server-side — a dirty field would test the
  // wrong thing, so it locks until the edit is saved.
  if (!isNew) {
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "im-btn";
    testBtn.style.marginTop = "10px";
    testBtn.textContent = "Send test notification";
    const syncTest = () => {
      const dirty = (urlInput.value.trim() || null) !== (existing.webhook_url || null);
      testBtn.disabled = dirty || !urlInput.value.trim();
      testBtn.title = dirty ? "Save the new URL first — the test fires the saved one" : "POSTs a sample payload to the webhook now";
    };
    urlInput.addEventListener("input", syncTest);
    syncTest();
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      try {
        const r = await fetch(`/api/alerts/${existing.id}/test`, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) toast("Webhook answered OK");
        else toast.error(`Webhook failed: ${data.error || r.status}`);
      } catch {
        toast.error("Webhook test failed");
      }
      testBtn.disabled = false;
    });
    hookSection.appendChild(testBtn);
  }
  body.appendChild(hookSection);

  // ── enabled (edit only — a new alert starts on) ──
  if (!isNew) {
    const enSection = document.createElement("div");
    enSection.className = "modal-section";
    enSection.appendChild(switchRow("Enabled", "off pauses matching and delivery; history stays.", enabled, (on) => { enabled = on; }));
    body.appendChild(enSection);
  }

  // ── save ──
  const saveBtn = document.createElement("button");
  saveBtn.textContent = isNew ? "Create alert" : "Save";
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) return toast.error("Give the alert a name");
    if (!Object.keys(condition).length) return toast.error("The condition is empty");
    if (modeSel.value === "daily" && !atInput.value) return toast.error("Pick a digest time");
    const payload = {
      name,
      condition,
      delivery: modeSel.value,
      daily_at: modeSel.value === "daily" ? atInput.value : null,
      webhook_url: urlInput.value.trim(),
      enabled,
    };
    // Secret: omitted = keep, "" = clear, value = set (has_secret is all the
    // client ever sees, so absent must not mean clear).
    if (secretInput.value) payload.webhook_secret = secretInput.value;
    else if (secretCleared) payload.webhook_secret = "";
    saveBtn.disabled = true;
    try {
      const r = isNew
        ? await fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board_id: state.boardId, ...payload }),
          })
        : await fetch(`/api/alerts/${existing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(data.error || "Couldn't save alert");
        saveBtn.disabled = false;
        return;
      }
      const saved = data.alert;
      const i = state.alerts.findIndex((a) => a.id === saved.id);
      if (i >= 0) state.alerts[i] = { ...state.alerts[i], ...saved };
      else state.alerts.push(saved);
      toast(isNew ? `Alert "${saved.name}" created` : "Alert saved");
      close();
      document.dispatchEvent(new Event('app:render'));
    } catch {
      toast.error("Couldn't save alert");
      saveBtn.disabled = false;
    }
  });
  footer.appendChild(saveBtn);
}

// ── the history modal ──

export function openAlertHistory(alert) {
  const { body, footer, close } = createModal({ title: alert.name, id: "alert-history-modal" });

  // Opening IS the acknowledgement — the caret dot and row badge clear now.
  if (alert.unseen > 0) {
    fetch(`/api/alerts/${alert.id}/seen`, { method: "POST" }).catch(() => {});
    alert.unseen = 0;
    document.dispatchEvent(new Event('app:render'));
  }

  const list = document.createElement("div");
  list.className = "jobs-list";
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "jobs-note";
    p.textContent = text;
    list.replaceChildren(p);
  };
  note("Loading…");
  body.appendChild(list);

  const HOOK_LABELS = { ok: "sent", failed: "webhook failed", pending: "sending…" };
  fetch(`/api/alerts/${alert.id}/firings`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((firings) => {
      if (!firings.length) return note("Nothing yet — new matches appear here as they arrive.");
      list.replaceChildren();
      for (const f of firings) {
        const row = document.createElement("div");
        row.className = "job-row al-firing" + (f.seen ? "" : " al-new");
        row.title = "Show these items in the gallery";
        const label = document.createElement("span");
        label.className = "job-label";
        label.textContent = `${f.entity_count} new item${f.entity_count === 1 ? "" : "s"}`;
        const status = document.createElement("span");
        status.className = "job-outcome" + (f.webhook_status === "failed" ? " job-outcome-failed" : "");
        status.textContent = f.webhook_status ? (HOOK_LABELS[f.webhook_status] || f.webhook_status) : "recorded";
        if (f.webhook_error) status.title = f.webhook_error;
        const when = document.createElement("span");
        when.className = "job-when";
        when.textContent = relTime(f.fired_at);
        when.title = new Date(f.fired_at).toLocaleString();
        row.append(label, status, when);
        row.addEventListener("click", () => { close(); openAlertEvent(f.id); });
        list.appendChild(row);
      }
    })
    .catch(() => note("Failed to load the history."));

  // The living view: everything currently matching, not just a firing's delta.
  const viewBtn = document.createElement("button");
  viewBtn.className = "ghost";
  viewBtn.textContent = "Show all matching items";
  viewBtn.addEventListener("click", () => {
    close();
    clearAlertEvent(); // a lingering ?event= view would intersect the filter
    applyFilterConfig(alert.condition);
  });
  footer.appendChild(viewBtn);
}
