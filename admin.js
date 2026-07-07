      import { toast } from "/toast.js";
      import { openBoardModal, switchRow, fillModelSelect, loadProviders, byName } from "/board-modal.js";

      const content = document.getElementById("content");
      const gate = document.getElementById("gate");
      const adminUi = document.getElementById("admin-ui");

      // --- Tabs ---
      const TAB_NAMES = ["members", "boards", "ai"];
      const tabBtns = [...document.querySelectorAll(".tab")];
      function selectTab(name) {
        tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
        document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
        history.replaceState(null, "", name === "members" ? location.pathname : "#" + name);
      }
      tabBtns.forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
      const initialTab = location.hash.slice(1);
      if (TAB_NAMES.includes(initialTab)) selectTab(initialTab);



      async function api(method, url, body) {
        const r = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        return r.json();
      }

      function copy(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
          const t = btn.textContent;
          btn.textContent = "copied!";
          setTimeout(() => (btn.textContent = t), 1200);
        });
      }

      async function render() {
        const me = await fetch("/api/me").then((r) => r.json());
        if (!me || !me.is_admin) {
          gate.innerHTML = 'Not authorized. <a href="/">Back to gallery</a>';
          return;
        }
        const users = await api("GET", "/api/admin/users");
        gate.hidden = true;
        adminUi.hidden = false;
        content.innerHTML = `
          <form id="add">
            <input id="name" placeholder="Name (optional)" />
            <input id="email" type="email" placeholder="member@email.com" required />
            <button type="submit">Add & make link</button>
          </form>
          <table>
            <thead><tr><th>Name</th><th>Last login</th><th>♥ given</th><th></th></tr></thead>
            <tbody id="rows"></tbody>
          </table>`;

        const rows = document.getElementById("rows");
        for (const u of users) {
          // The server stores only token hashes, so an existing link can't be
          // shown back. "copy link" mints a fresh one on first use (replacing
          // the user's previous link) and copies from cache after that;
          // "new link" forces a re-mint.
          u.link = null;

          const tr = document.createElement("tr");
          const last = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : '<span class="muted">never</span>';
          tr.innerHTML = `
            <td><div>${u.name || "—"} ${u.is_admin ? '<span class="badge">admin</span>' : ""}</div><div class="email">${u.email}</div></td>
            <td>${last}</td>
            <td>${u.hearts_given}</td>
            <td><div class="row-actions"></div></td>`;
          const act = tr.querySelector(".row-actions");

          const copyBtn = document.createElement("button");
          copyBtn.className = "ghost";
          copyBtn.textContent = "copy link";
          copyBtn.title = "Copies the login link (mints a fresh one first if needed — the previous link stops working)";
          copyBtn.onclick = async () => {
            copyBtn.disabled = true;
            try {
              if (!u.link) {
                const { link } = await api("POST", `/api/admin/users/${u.id}/link`);
                u.link = link;
              }
              copy(u.link, copyBtn);
            } catch (err) {
              toast.error(err.message);
            } finally {
              copyBtn.disabled = false;
            }
          };
          act.appendChild(copyBtn);

          if (!u.is_admin) {
            const del = document.createElement("button");
            del.className = "danger";
            del.textContent = "remove";
            del.onclick = async () => {
              if (!confirm(`Remove ${u.email}? They lose access immediately.`)) return;
              await api("DELETE", `/api/admin/users/${u.id}`);
              render();
            };
            act.appendChild(del);
          }
          rows.appendChild(tr);
        }

        document.getElementById("add").onsubmit = async (e) => {
          e.preventDefault();
          const email = document.getElementById("email").value.trim();
          const name = document.getElementById("name").value.trim();
          try {
            const { user, link } = await api("POST", "/api/admin/users", { email, name });
            await navigator.clipboard.writeText(link).catch(() => {});
            toast.info(`${user.email} added — login link copied`);
            render();
          } catch (err) {
            toast.error(err.message);
          }
        };
      }

      render().catch(() => (gate.innerHTML = 'Error loading. <a href="/">Back</a>'));

      // --- Boards ---
      const boardsContent = document.getElementById("boards-content");

      function boardUrl(id) {
        return `${location.origin}/?board=${id}`;
      }


      async function renderBoards() {
        const me = await fetch("/api/me").then((r) => r.json());
        if (!me || !me.is_admin) return;

        let boards;
        try {
          boards = await api("GET", "/api/admin/boards");
        } catch { return; }

        const sec = document.createElement("div");
        sec.className = "section";
        sec.innerHTML = `<h2>Boards</h2><p class="sub">Each board has its own items, taxonomy, and URL. Share the URL to give access.</p>`;

        // Board table
        const table = document.createElement("table");
        table.innerHTML = `<thead><tr><th>Name</th><th>Items</th><th>AI tokens</th><th></th></tr></thead>`;
        const tbody = document.createElement("tbody");

        const fmtTok = (n) =>
          n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
          : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K"
          : String(n);
        // Last 14 days as 2px bars, height = billable input tokens (cache
        // reads excluded), scaled to the board's busiest day in the window.
        // Idle days show a 1px baseline tick; bottom-aligned flex puts the
        // ticks exactly on the text baseline.
        function sparkline(days) {
          if (!days || !days.some((d) => d.input > 0)) return "";
          const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
          const max = Math.max(...days.map((d) => d.input));
          let bars = "";
          for (let i = 13; i >= 0; i--) {
            const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const d = byDay[day];
            const h = d && d.input ? Math.max(2, Math.round((d.input / max) * 12)) : 1;
            const tip = d
              ? `${day} — ${d.calls} call(s), ${fmtTok(d.input)} in / ${fmtTok(d.output)} out${d.searches ? `, ${d.searches} search(es)` : ""}`
              : `${day} — no tagging`;
            bars += `<span title="${tip}" style="width:2px;height:${h}px;background:#000"></span>`;
          }
          return `<span style="display:inline-flex;align-items:flex-end;gap:2px;margin-left:10px;cursor:default">${bars}</span>`;
        }
        function usageCell(u) {
          if (!u || !u.calls) return `<span style="color:#9aa0aa">—</span>`;
          const tip = [
            `${u.calls} call(s) all-time`,
            u.searches ? `${u.searches} web search(es)` : "",
            u.cacheRead ? `${fmtTok(u.cacheRead)} cached input reads` : "",
            u.today.calls ? `today: ${u.today.calls} call(s), ${fmtTok(u.today.input)} in / ${fmtTok(u.today.output)} out` : "",
          ].filter(Boolean).join(" · ");
          return `<span title="${tip}">${fmtTok(u.input)} in · ${fmtTok(u.output)} out</span>${sparkline(u.days)}`;
        }

        for (const b of boards) {
          const url = boardUrl(b.id);

          const tr = document.createElement("tr");
          tr.id = `board-row-${b.id}`;
          const nextRun = b.auto_tag_next_run_at
            ? `next scheduled run: ${new Date(b.auto_tag_next_run_at).toLocaleString()}`
            : "";
          tr.innerHTML = `
            <td><a href="${url}" target="_blank" style="color:inherit;text-decoration:none;font-weight:600">${b.name}</a></td>
            <td>${b.item_count}${b.pending_count ? ` <span style="color:#9aa0aa">(${b.pending_count} queued)</span>` : ""}${b.held_count ? ` <span style="color:#9aa0aa" title="uploads waiting while auto-tagging is off">(${b.held_count} held)</span>` : ""}</td>
            <td>${usageCell(b.ai_usage)}</td>
            <td></td>`;

          const actCell = tr.querySelector("td:last-child");
          const wrap = document.createElement("div");
          wrap.className = "row-actions-wrap";

          const editBtn = document.createElement("button");
          editBtn.className = "ghost";
          editBtn.textContent = "edit";
          editBtn.onclick = () => openBoardModal(b, { canEditAI: true, onSaved: renderBoards });
          wrap.appendChild(editBtn);

          const accessWrap = document.createElement("div");
          accessWrap.className = "access-wrap";
          const accessBtn = document.createElement("button");
          accessBtn.className = "ghost";
          accessBtn.textContent = "access ▾";
          accessBtn.onclick = (e) => { e.stopPropagation(); toggleAccessDrop(b, accessWrap); };
          accessWrap.appendChild(accessBtn);
          wrap.appendChild(accessWrap);

          const retagBtn = document.createElement("button");
          retagBtn.className = "danger";
          retagBtn.textContent = "retag ↺";
          retagBtn.title = "Re-queue all items in this board for AI tagging" + (nextRun ? ` (${nextRun})` : "");
          retagBtn.onclick = async () => {
            if (!confirm(`Re-tag all ${b.item_count} item(s) in "${b.name}"? Existing tags will be cleared and reprocessed.`)) return;
            try {
              retagBtn.disabled = true;
              retagBtn.textContent = "queuing…";
              const { queued } = await api("POST", `/api/admin/boards/${b.id}/retag`);
              retagBtn.textContent = `queued ${queued}`;
              toast(`Queued ${queued} item(s) for retagging`);
              setTimeout(renderBoards, 1500);
            } catch (err) {
              toast.error(err.message);
              retagBtn.textContent = "retag ↺";
              retagBtn.disabled = false;
            }
          };
          wrap.appendChild(retagBtn);

          if (b.held_count > 0) {
            const tagHeldBtn = document.createElement("button");
            tagHeldBtn.className = "ghost";
            tagHeldBtn.textContent = "tag held ▸";
            tagHeldBtn.title = `Tag the ${b.held_count} held item(s) now, without turning auto-tagging back on`;
            tagHeldBtn.onclick = async () => {
              try {
                tagHeldBtn.disabled = true;
                tagHeldBtn.textContent = "queuing…";
                const { released } = await api("POST", `/api/admin/boards/${b.id}/tag-held`);
                toast(`Queued ${released} held item(s) for tagging`);
                renderBoards();
              } catch (err) {
                toast.error(err.message);
                renderBoards();
              }
            };
            wrap.appendChild(tagHeldBtn);
          }

          if (b.pending_count > 0) {
            const stopBtn = document.createElement("button");
            stopBtn.className = "danger";
            stopBtn.textContent = "stop ■";
            stopBtn.title = "Cancel queued AI tagging for this board";
            stopBtn.onclick = async () => {
              if (!confirm(`Stop the tagging queue for "${b.name}"? ${b.pending_count} queued item(s) will be pulled out — ones with previous tags keep them, the rest show as untagged for review.`)) return;
              try {
                stopBtn.disabled = true;
                stopBtn.textContent = "stopping…";
                await api("POST", `/api/admin/boards/${b.id}/retag/cancel`);
                toast("Tagging queue stopped");
                renderBoards();
              } catch (err) {
                toast.error(err.message);
                renderBoards();
              }
            };
            wrap.appendChild(stopBtn);
          }

          const delBtn = document.createElement("button");
          delBtn.className = "danger";
          delBtn.textContent = "delete";
          delBtn.onclick = async () => {
            const msg = b.item_count > 0
              ? `Delete board "${b.name}" and its ${b.item_count} item(s)? This cannot be undone.`
              : `Delete board "${b.name}"?`;
            if (!confirm(msg)) return;
            try {
              await api("DELETE", `/api/admin/boards/${b.id}`);
              toast(`Board "${b.name}" deleted`);
              renderBoards();
            } catch (err) { toast.error(err.message); }
          };
          wrap.appendChild(delBtn);

          actCell.appendChild(wrap);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        sec.appendChild(table);

        // Create button — same modal as edit, in create mode
        const createSec = document.createElement("div");
        createSec.style.marginTop = "20px";
        const createBtn = document.createElement("button");
        createBtn.className = "ghost";
        createBtn.textContent = "+ New board";
        createBtn.onclick = () => openBoardModal(null, { canEditAI: true, onSaved: renderBoards });
        createSec.appendChild(createBtn);
        sec.appendChild(createSec);

        boardsContent.replaceChildren(sec);
      }

      async function toggleAccessDrop(board, container) {
        const existing = document.getElementById(`access-drop-${board.id}`);
        if (existing) { existing.remove(); return; }
        document.querySelectorAll(".access-drop").forEach((d) => d.remove());

        let users;
        try { users = await api("GET", "/api/admin/users"); }
        catch { return; }

        const drop = document.createElement("div");
        drop.className = "access-drop";
        drop.id = `access-drop-${board.id}`;

        const listEl = document.createElement("div");
        listEl.className = "access-drop-list";
        const memberSet = new Set(board.memberIds || []);
        const adminSet = new Set(board.adminIds || []);
        for (const u of users) {
          const row = document.createElement("div");
          row.className = "access-user";

          const lbl = document.createElement("label");
          lbl.className = "access-member-row" + (u.is_admin ? " is-admin" : "");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.className = "member-cb";
          cb.value = u.id;
          cb.checked = u.is_admin || memberSet.has(u.id);
          cb.disabled = !!u.is_admin;
          const nameEl = document.createElement("span");
          nameEl.textContent = (u.name || u.email) + (u.is_admin ? " (admin)" : "");
          lbl.append(cb, nameEl);
          row.appendChild(lbl);

          // Board-admin toggle: lets a member edit this board from the gallery.
          // Its own indented row + own <label> so it toggles natively; only for
          // non-global-admins (global admins already manage every board), and
          // only active once they're a member.
          if (!u.is_admin) {
            const adminLbl = document.createElement("label");
            adminLbl.className = "access-admin-row";
            adminLbl.title = "Can edit this board's settings from the gallery";
            const adminCb = document.createElement("input");
            adminCb.type = "checkbox";
            adminCb.className = "admin-cb";
            adminCb.value = u.id;
            adminCb.checked = adminSet.has(u.id);
            adminCb.disabled = !cb.checked;
            const adminTxt = document.createElement("span");
            adminTxt.textContent = "board admin";
            adminLbl.append(adminCb, adminTxt);
            cb.addEventListener("change", () => {
              adminCb.disabled = !cb.checked;
              if (!cb.checked) adminCb.checked = false;
            });
            row.appendChild(adminLbl);
          }
          listEl.appendChild(row);
        }
        drop.appendChild(listEl);

        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save";
        saveBtn.onclick = async () => {
          const memberIds = [...listEl.querySelectorAll("input.member-cb:not(:disabled):checked")].map((cb) => Number(cb.value));
          const adminIds = [...listEl.querySelectorAll("input.admin-cb:not(:disabled):checked")].map((cb) => Number(cb.value));
          try {
            await api("PATCH", `/api/admin/boards/${board.id}`, { memberIds, adminIds });
            board.memberIds = memberIds;
            board.adminIds = adminIds;
            drop.remove();
            toast("Access updated");
          } catch (err) { toast.error(err.message); }
        };
        drop.appendChild(saveBtn);
        container.appendChild(drop);

        function onOutside(e) {
          if (!container.contains(e.target)) {
            drop.remove();
            document.removeEventListener("click", onOutside);
          }
        }
        setTimeout(() => document.addEventListener("click", onOutside), 0);
      }


      renderBoards().catch(() => {});

      // --- AI Config: multi-provider key registry + app default ---

      async function renderAiConfig() {
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
              <td>${k.name} ${isDefault ? '<span class="badge">default</span>' : ""}</td>
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
        for (const p of catalog) {
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

        // Embed models come from the catalog's `embeds` block; a provider
        // without one (Anthropic, GLM) has no embeddings API.
        const embedKeys = keys.filter((k) => providers[k.provider]?.embeds);

        if (!embedKeys.length) {
          const note = document.createElement("p");
          note.className = "muted";
          note.style.margin = "0";
          note.textContent = "Needs an OpenAI or Gemini API key for embeddings — Anthropic doesn't offer an embeddings API. Add one above to configure this.";
          emSec.appendChild(note);
        } else {
          let embedOn = !!cfg.embed?.enabled;

          const emKeyRow = document.createElement("div");
          emKeyRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Embeddings key</label>`;
          const emKeySel = document.createElement("select");
          emKeySel.style.cssText = "width:100%;";
          for (const k of embedKeys) {
            const opt = document.createElement("option");
            opt.value = String(k.id);
            opt.textContent = `${k.name} — ${k.provider}`;
            emKeySel.appendChild(opt);
          }
          if (cfg.embed?.keyId && embedKeys.find((k) => k.id === cfg.embed.keyId)) {
            emKeySel.value = String(cfg.embed.keyId);
          }
          emKeyRow.appendChild(emKeySel);

          const emModelRow = document.createElement("div");
          emModelRow.innerHTML = `<label style="display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;">Embedding model</label>`;
          const emModelSel = document.createElement("select");
          emModelSel.style.cssText = "width:100%;";
          const emProviderOf = () => embedKeys.find((k) => String(k.id) === emKeySel.value)?.provider || "openai";
          const fillEmbedModels = (current) => {
            emModelSel.replaceChildren();
            const embeds = providers[emProviderOf()].embeds;
            for (const m of embeds.models) {
              const opt = document.createElement("option");
              opt.value = m.id;
              opt.textContent = `${m.id} — ${m.note}`;
              if (m.id === (current || embeds.default)) opt.selected = true;
              emModelSel.appendChild(opt);
            }
          };
          fillEmbedModels(cfg.embed?.model);
          emKeySel.onchange = () => fillEmbedModels(null);
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
            const changingModel = cfg.embed?.enabled && cfg.embed?.model && cfg.embed.model !== emModelSel.value;
            if (changingModel && !confirm("Changing the embedding model re-embeds every item (costs cents, takes a while). Continue?")) {
              emSave.disabled = false;
              emSave.textContent = "Save";
              return;
            }
            try {
              await api("POST", "/api/admin/ai-config", {
                embedKeyId: Number(emKeySel.value),
                embedModel: emModelSel.value,
                embedEnabled: embedOn,
              });
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

          emSec.append(emKeyRow, emModelRow, emSwitch, emActions);
          if (emStatus.textContent) emSec.appendChild(emStatus);
        }
        sec.appendChild(emSec);

        document.getElementById("ai-config-content").replaceChildren(sec);
      }

      renderAiConfig().catch(() => {});
