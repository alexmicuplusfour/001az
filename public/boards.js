// Boards page (planning/boards-page-plan.md): every board the signed-in user
// can reach, rendered as cards. A standalone page, but it wears the gallery's
// chrome — same tinted body, same floating header, same #toolbar row — so the
// index and a board read as one product. One GET feeds the whole page.
//
// It deliberately does NOT import toolbar.js: that module is the per-board
// toolbar and pulls in the whole app (filters, upload, lightbox, modals). The
// two rudimentary pieces this page needs — the logo and the user menu — are
// rebuilt here from the same shared parts (dropdown.js, utils.js ICONS) and
// the same classes, so styles.css dresses them identically.
//
// Relative specifiers, not the root-absolute `/x.js` form the admin pages still
// use. An ES module specifier resolves against the URL of the module doing the
// importing, never the document's, so `./api.js` inside `/boards.js` is
// `/api.js` whether the page was reached as `/boards` or `/boards.html` — the
// root-absolute form guards a hazard modules do not have. It belongs on
// `<script src>`, which IS document-relative, and boards.html keeps it there.
//
// It also costs: root-absolute specifiers resolve to the filesystem root under
// Node, so this file could not be imported by a test at all. That is the same
// change and the same argument board-modal.js was given for announce.test.js.
import { api } from "./api.js";
import { openDropdown, ddRow, ddSep } from "./dropdown.js";
import { ICONS, fmtDuration } from "./utils.js";
import { openBoardModal } from "./board-modal.js";
import { applyBoardDot } from "./board-signal.js";
import { createTicker } from "./ticker.js";

const LOGIN = "/login.html?next=%2Fboards";

const me = await fetch("/api/me", { cache: "no-store" })
  .then((r) => r.json())
  .catch(() => null);

if (!me) {
  location.replace(LOGIN);
} else if (me.needs_password) {
  // Fresh invite, no password set yet → the set-password screen, the same gate
  // app.js applies (~123). This page is a landing surface (the gallery logo
  // points here), so it can't be the way around it.
  location.replace("/login.html");
} else {
  document.getElementById("gate").hidden = true;
  document.querySelector("header").hidden = false;
  document.getElementById("boards-grid").hidden = false;
  renderToolbar();
  // In parallel, and deliberately not awaited together: the grid renders on the
  // overview and the dots attach when signals land. The gallery's own precedent
  // — "the button is drawn immediately either way, and only the dot waits."
  render().then(() => { if (wraps().length) signalsTicker.start(); });
  refreshSignals();
}

// --- toolbar: row 1 only, logo left, user menu right ---

function renderToolbar() {
  const bar = document.getElementById("toolbar");

  const logo = document.createElement("span");
  logo.className = "toolbar-logo";
  logo.textContent = "001az/";

  const auth = document.createElement("div");
  auth.className = "auth"; // margin-left:auto pushes it to the right edge

  // Creating a board is a global-admin power (POST /api/admin/boards), same as
  // the gallery dropdown's footer action — and it lands you in the new board,
  // which is where you'd go next anyway.
  if (me.is_admin) {
    const newBtn = document.createElement("button");
    newBtn.className = "tool-btn";
    newBtn.innerHTML = ICONS.plus + "<span>New board</span>";
    newBtn.addEventListener("click", () =>
      openBoardModal(null, {
        canEditAI: true,
        onSaved: (saved) => { location.href = `/?board=${encodeURIComponent(saved.id)}`; },
      })
    );
    auth.appendChild(newBtn);
  }

  const userBtn = document.createElement("button");
  userBtn.className = "tool-btn user-menu-btn";
  const name = document.createElement("span");
  name.className = "user-menu-name";
  name.textContent = me.name || me.email;
  const chev = document.createElement("span");
  chev.className = "dd-caret";
  chev.innerHTML = ICONS.chevron;
  userBtn.append(name, chev);
  userBtn.addEventListener("click", () => openUserMenu(userBtn));

  auth.appendChild(userBtn);
  bar.replaceChildren(logo, auth);
}

// The gallery's user menu, minus nothing — same rows, same order.
function openUserMenu(anchorEl) {
  openDropdown(anchorEl, {
    className: "user-menu-pop",
    build: (body, { close }) => {
      if (me.is_admin) body.appendChild(ddRow({ label: "Admin", href: "/admin.html" }));
      body.appendChild(ddRow({ label: "Profile", href: "/profile.html" }));
      body.appendChild(ddSep());
      body.appendChild(ddRow({
        label: "Sign out",
        onClick: async () => {
          close();
          await fetch("/api/logout", { method: "POST" });
          location.replace(LOGIN);
        },
      }));
    },
  });
}

// --- the board grid ---

async function render() {
  const grid = document.getElementById("boards-grid");
  let boards;
  try {
    boards = await api("GET", "/api/boards/overview");
  } catch (err) {
    // Inline, not a toast: on an otherwise blank page the failure IS the content.
    grid.replaceChildren(note(`Couldn't load boards: ${err.message}`));
    return;
  }
  if (!boards.length) {
    grid.replaceChildren(note("No boards yet — ask an admin for access."));
    return;
  }
  grid.replaceChildren(...boards.map(cardFor));
}

// ── the attention dots (planning/boards-signals-plan.md) ─────────────────────
//
// One map and one rule. `signals` is the last response from
// /api/boards/signals and is the ONLY source a dot is ever computed from; the
// rendered cards are their own index, each carrying its board id in a data
// attribute, so there is nothing to keep in step with them.
//
// The rule is that a full render and a paint must produce the same DOM, and it
// is load-bearing rather than tidy. render() runs on a path that has nothing to
// do with signals — the manage pencil passes it as `onSaved` — so it rebuilds
// every card the moment anyone edits a board's settings. Dots attached once when
// the fetch landed would vanish there, silently, until the next tick. Both paths
// therefore go through applyDot, and cardFor calls it while building.
const signals = new Map();

// The cards on screen. Also the answer to "is there anything to poll for" —
// which is why nothing tracks that separately: a second structure saying how
// many boards exist is a second thing to clear on every exit from render().
const wraps = () => document.querySelectorAll("#boards-grid .bc-wrap");

// 60 s, not the gallery's 20 s, and the same ticker so the two pages cannot
// disagree about what a hidden tab does. This page is a lobby rather than a
// dashboard — its own plan shipped it with no poll at all — and the freshness
// argument these dots rest on is almost entirely about RETURNING to a tab, which
// the ticker's visibilitychange catch-up covers outright. One request a minute
// against the gallery's six or seven.
const SIGNAL_MS = 60000;
const signalsTicker = createTicker({
  tickMs: SIGNAL_MS,
  signals: [{ name: "boardSignals", every: SIGNAL_MS, run: refreshSignals }],
  // Nothing on screen, nothing to fetch for: a member with no boards gets the
  // empty state, and polling for signals about nothing is the purest form of the
  // background cost this cadence is already spending carefully. Same shape as
  // signals.js's `if (!state.boardId) return`, one altitude up.
  ready: () => wraps().length > 0,
});

async function refreshSignals() {
  let rows;
  try {
    rows = await api("GET", "/api/boards/signals");
  } catch {
    // Keep the last known signals — the rule refreshAlerts already states as
    // "keep the last known counts". Nothing here goes dark because a request
    // failed; a dot that vanishes on a network blip is the failing direction
    // this feature has consistently refused. On the FIRST load there is nothing
    // to keep, and the page is simply the page, dotless.
    return;
  }
  // Validated BEFORE the clear, not after. The clear is the destructive step,
  // and a response that is 200 but not a list would otherwise empty the map and
  // dark every dot on the page — the one failure direction this feature refuses
  // — with the throw swallowed by the ticker's own backstop, so nothing would
  // say why. `Array.isArray` is the house guard; app.js applies it to every list
  // it boots from.
  if (!Array.isArray(rows)) return;
  signals.clear();
  for (const r of rows) signals.set(r.board_id, r);
  paintDots();
}

// In place, over the cards already on screen — NOT a re-render. Rebuilding every
// card once a minute would churn the whole <img> set, re-running lazy loading,
// re-triggering the thumbnail slot handover and re-animating the fan, to move a
// red circle.
function paintDots() {
  for (const wrap of wraps()) applyDot(wrap);
}

// A card the signals response doesn't mention gets `undefined` and goes dark,
// which is how the two fetches being a moment apart resolves itself: a board
// created or deleted between them needs no reconciliation step, in either
// direction.
const applyDot = (wrap) => applyBoardDot(wrap, signals.get(wrap.dataset.board));

// A whole-card link: middle-click and cmd-click work without any JS, and it
// lands on the same URL the toolbar's board switcher uses. A manager's pencil
// rides alongside it in the wrapper — see .bc-wrap in boards.css for why it
// can't live inside the link.
function cardFor(b) {
  const card = document.createElement("a");
  card.className = "board-card";
  card.href = `/?board=${encodeURIComponent(b.id)}`;

  const name = document.createElement("div");
  name.className = "bc-name";
  name.textContent = b.name;
  name.title = b.name; // the name ellipsizes; hover gives the full one back

  const count = document.createElement("span");
  count.className = "bc-count";
  count.textContent = countLabel(b.count);

  const meta = document.createElement("div");
  meta.className = "bc-meta";
  meta.append(count, chipsFor(b));

  const body = document.createElement("div");
  body.className = "bc-body";
  body.append(name, meta);

  card.append(faceFor(b), body);

  const wrap = document.createElement("div");
  wrap.className = "bc-wrap";
  wrap.dataset.board = b.id; // what lets paintDots find its way back to the row
  wrap.appendChild(card);
  if (b.manage) wrap.appendChild(editBtn(b));
  applyDot(wrap);
  return wrap;
}

// Board settings. `canEditAI` gates the admin-only half of the modal (AI keys,
// models, the mapping pane); a board-admin gets the content-only editor, which
// is the same split the gallery toolbar's pencil applies.
function editBtn(b) {
  const btn = document.createElement("button");
  btn.className = "bc-edit";
  btn.type = "button";
  btn.title = `Board settings — ${b.name}`;
  btn.setAttribute("aria-label", `Board settings — ${b.name}`);
  btn.innerHTML = ICONS.pencil;
  btn.addEventListener("click", (e) => {
    e.preventDefault(); // the pencil sits over a link; don't follow it
    e.stopPropagation();
    openBoardModal(b.id, { canEditAI: !!me.is_admin, onSaved: render });
  });
  return btn;
}

// Capability chips: present = the board has it. Order matches the pipeline —
// what comes in (ingestion), what's pulled out (mapping), how it's organised
// (taxonomy).
function chipsFor(b) {
  const chips = document.createElement("div");
  chips.className = "bc-chips";

  if (b.ingest_mode) {
    // A pending stamp outranks the mode: a hand-fired run on a manual or paused
    // board is a run, and saying "on demand" while one is queued would be a lie.
    // No stamp on a "scheduled" board just means the sweep hasn't armed it yet.
    const left = b.ingest_next_run_at ? b.ingest_next_run_at - Date.now() : null;
    const when = left != null
      ? (left <= 0 ? " — next run due" : ` — next run in ${fmtDuration(left)}`)
      : { manual: " — off", paused: " — paused" }[b.ingest_mode] ?? "";
    chips.appendChild(chip(ICONS.redo, "", `Automatic ingestion${when}`));
  }
  if (b.has_mapping) {
    // A connector-backed board names its data source, the same chip vocabulary
    // the gallery toolbar uses (.mapping-chip); otherwise the icon alone.
    const c = b.mapping_connector;
    chips.appendChild(chip(
      ICONS.sparkle,
      c ? c.charAt(0).toUpperCase() + c.slice(1) : "",
      c ? `AI-extracted fields — ${c} template` : "AI-extracted fields"
    ));
  }
  const n = b.facet_count;
  if (n > 0) chips.appendChild(chip(ICONS.tag, "", `Tagging — ${n} ${n === 1 ? "facet" : "facets"}`));
  return chips;
}

function chip(icon, text, title) {
  const el = document.createElement("span");
  el.className = "bc-chip";
  el.title = title;
  el.innerHTML = icon;
  if (text) {
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);
  }
  return el;
}

// The empty board says it once, on the count line — the face's dashed
// placeholder carries the same message visually, so it stays wordless.
const countLabel = (n) => (n === 0 ? "No items yet" : n === 1 ? "1 item" : `${n} items`);

// --- the preview stack ---

const MAX_TILES = 4;
const thumbUrl = (name) => `/thumbnails/${encodeURIComponent(name)}.webp`;

// A preview entry can be drawn if it's a connector symbol tile, or a file whose
// face actually produced a thumbnail. w/h are stamped only when storeFace ran
// (server/faces/index.js), so they double as "a thumbnail exists" — the same
// test kinds.js's docKind.previewUrl uses for its badge fallback.
// The name is checked too: it's projected out of the payload, so a malformed
// file entry could carry dimensions with nothing to build a URL from.
const drawable = (e) => !!e.symbol || !!(e.name && e.w && e.h);

// The face holds up to MAX_TILES tiles; the endpoint sends 8, and the surplus
// is the spare pool that undrawable and broken entries draw from. A board with
// items but nothing drawable falls back to the same dashed placeholder as an
// empty one — the count line still tells the truth about how many items exist.
function faceFor(b) {
  const face = document.createElement("div");
  face.className = "bc-face";
  const spares = (b.preview || []).filter(drawable);
  if (!spares.length) {
    face.classList.add("empty");
    return face;
  }
  const stack = document.createElement("div");
  stack.className = "bc-stack";
  for (let slot = 0; slot < MAX_TILES && spares.length; slot++) {
    stack.appendChild(tileFor(spares.shift(), slot, spares, face));
  }
  face.appendChild(stack);
  return face;
}

function tileFor(entry, slot, spares, face) {
  if (entry.symbol) {
    const el = document.createElement("div");
    el.className = `bc-thumb sym slot-${slot}`;
    el.title = entry.display_name || entry.symbol;
    const label = document.createElement("span");
    label.textContent = entry.symbol;
    el.appendChild(label);
    return el;
  }
  const img = document.createElement("img");
  img.className = `bc-thumb slot-${slot}`;
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = ""; // decorative: the card's name and count carry the meaning
  img.src = thumbUrl(entry.name);
  // A thumbnail can go missing (pruned file, lost render). Take over the slot
  // with the next spare so the pile keeps its shape; if the pile empties
  // entirely, fall back to the placeholder.
  img.addEventListener("error", () => {
    const next = spares.shift();
    if (next) img.replaceWith(tileFor(next, slot, spares, face));
    else {
      const stack = img.parentElement;
      img.remove();
      if (stack && !stack.children.length) {
        stack.remove();
        face.classList.add("empty");
      }
    }
  });
  return img;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "boards-note";
  p.textContent = text;
  return p;
}
