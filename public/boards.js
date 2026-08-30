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
import { toast } from "./toast.js";

const LOGIN = "/login.html?next=%2Fboards";

const gridEl = () => document.getElementById("boards-grid");

// Arrangement state — the section that uses it is "rearranging the grid",
// far below. Declared UP HERE because the boot block runs during module
// evaluation and render() reads `saveTimer` synchronously: a `let` further down
// would still be in its temporal dead zone at that moment. That is the hazard
// boards-page.test.js exists to catch, and it has caught it once already.
let savedOrder = [];  // the sequence the server last confirmed
let dragging = null;  // the card in flight
let home = null;      // …and the sibling it was sitting in front of, for Escape
let saveTimer = null;

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
  gridEl().hidden = false;
  renderToolbar();
  initArrange();
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
  const grid = gridEl();
  // A save still queued from a drag is about the cards that are about to be
  // replaced. Dropping it is what keeps "the DOM is the model" honest — the
  // model is the cards on screen, and these are on their way out.
  clearTimeout(saveTimer);
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
  // The response IS the reader's arrangement — the server sorts it (server.js
  // arrangeFor), so this page never sorts. Remembering it is what lets a drag
  // that lands back where it started cost nothing.
  savedOrder = boards.map((b) => b.id);
  grid.replaceChildren(...boards.map((b) => cardFor(b, boards.length > 1)));
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
// An array rather than the live NodeList: the arrange path needs indexOf and
// map off the same accessor, and one answer to "the cards on screen, in order"
// is the whole point of there being an accessor at all.
const wraps = () => [...document.querySelectorAll("#boards-grid .bc-wrap")];

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
function cardFor(b, arrangeable) {
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
  // A link is draggable by default, and that default would eat the rearrange:
  // grabbing anywhere on a card would start a URL drag instead. The wrapper is
  // the draggable one, and only while the grip is held (gripFor).
  card.draggable = false;

  const wrap = document.createElement("div");
  wrap.className = "bc-wrap";
  wrap.dataset.board = b.id; // what lets paintDots find its way back to the row
  wrap.appendChild(card);

  // The card's controls, as one cluster rather than each button positioning
  // itself: the grip only exists for a reader with more than one board and the
  // pencil only for a manager, so any of the four combinations can occur, and
  // absolute coordinates per button would have to encode every one of them.
  const tools = document.createElement("div");
  tools.className = "bc-tools";
  if (arrangeable) tools.appendChild(gripFor(b.name, wrap));
  if (b.manage) tools.appendChild(editBtn(b));
  if (tools.children.length) wrap.appendChild(tools);

  applyDot(wrap);
  return wrap;
}

// The two card controls share a stylesheet rule (.bc-tools > button) because
// they are one kind of thing: an icon button sitting ON a link, which is what
// the swallowed click is for — without it, pressing either would navigate to
// the board. Built here so a third control cannot drift from the pair.
function cardToolBtn(className, icon, label, onClick) {
  const btn = document.createElement("button");
  btn.className = className;
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = icon;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.(e);
  });
  return btn;
}

// Board settings. `canEditAI` gates the admin-only half of the modal (AI keys,
// models, the mapping pane); a board-admin gets the content-only editor, which
// is the same split the gallery toolbar's pencil applies.
const editBtn = (b) =>
  cardToolBtn("bc-edit", ICONS.pencil, `Board settings — ${b.name}`, () =>
    openBoardModal(b.id, { canEditAI: !!me.is_admin, onSaved: render })
  );

// ── rearranging the grid (planning/board-arrangement-plan.md) ────────────────
//
// The order is the READER's, kept on their account, and the server hands it back
// already applied (server.js arrangeFor) — so this section only has to produce a
// new sequence and post it. Nothing here sorts, and the gallery's board switcher
// gets the same arrangement without knowing this feature exists.
//
// The DOM is the model. A drag reorders the grid live and the saved order is
// read back off it, which is why there is no array of ids to keep in step with
// the cards — the same reason the dots keep no card index (see `wraps` above).
//
// Handle-only, and the handle is a <button>: a card is a link first, so making
// the whole card draggable would put a rearrange in the way of the thing the
// page is for. The button is also the keyboard path — arrows move the focused
// card — which a bare `draggable` attribute could never be.
//
// Touch is the honest gap: HTML5 drag-and-drop does not fire for touch, so on a
// phone the cards are read-only. Accepted rather than papered over with a
// pointer-event reimplementation — that would mean hand-rolling the drag image,
// the edge autoscroll and the escape-to-cancel this gets from the browser, for
// a one-column layout where the arrangement matters least.
//
// The state this runs on is declared at the top of the file; see why there.
const orderNow = () => wraps().map((el) => el.dataset.board);

// Every drag event bound once, to the container. render() replaces every card
// whenever a board is edited, so per-card handlers would be rebuilt under a
// drag in flight — and drag events bubble, while the wrapper already carries
// its board id for paintDots, so the target resolves to all a handler needs.
function initArrange() {
  const grid = gridEl();

  grid.addEventListener("dragstart", (e) => {
    const wrap = e.target?.closest?.(".bc-wrap");
    // Ours only. The link and the tiles opt out of being drag sources (cardFor,
    // tileFor), and the wrapper is draggable only while its grip is held — so
    // anything else arriving here is a drag this page did not start.
    if (!wrap?.draggable) return;
    dragging = wrap;
    home = wrap.nextSibling; // exactly one card moves, so its old neighbour is the undo
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag with an empty dataTransfer, so it gets
    // one — but a PRIVATE type, deliberately not text/plain or a URL. Those
    // would make the card droppable into other apps, and into this page's own
    // chrome, as a link the browser then navigates to.
    e.dataTransfer.setData("application/x-board-id", wrap.dataset.board);
    // Next tick: the browser snapshots the drag image after this handler
    // returns, and dimming the card here would dim the ghost too. Re-checked
    // when it fires — a drag that ends inside that gap has already run dragend,
    // and this would otherwise dim a card that is no longer moving, for good.
    setTimeout(() => { if (dragging === wrap) wrap.classList.add("dragging"); }, 0);
  });

  grid.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault(); // the only way to say "you may drop here"
    e.dataTransfer.dropEffect = "move";
    const over = e.target?.closest?.(".bc-wrap");
    if (!over || over === dragging) return;
    // One axis is enough. dragover fires on the card actually under the
    // pointer, so which ROW we're in is already decided by which card that is;
    // all that's left is whether we're before or after it in reading order.
    const box = over.getBoundingClientRect();
    const ref = e.clientX > box.left + box.width / 2 ? over.nextSibling : over;
    // Usually the card is already exactly there: this fires tens of times a
    // second, most of them over the same half of the same card. insertBefore
    // re-inserts even when nothing moves, and that write dirties the layout
    // which the getBoundingClientRect above then has to flush — so the idle
    // case would pay a full grid reflow per event to change nothing.
    if (ref === dragging || dragging.nextSibling === ref) return;
    grid.insertBefore(dragging, ref);
  });

  // Without this the browser applies its own default to the drop.
  grid.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });

  grid.addEventListener("dragend", (e) => {
    const wrap = dragging;
    if (!wrap) return;
    dragging = null;
    wrap.draggable = false;
    wrap.classList.remove("dragging");
    // Escape (and a drop off the grid) reports "none" — put the card back in
    // front of the neighbour it was picked up from, `null` meaning it was last.
    // The preview was a real DOM move, so cancelling has to be a real move
    // back; leaving it would save an arrangement the reader walked away from.
    if (e.dataTransfer?.dropEffect === "none") grid.insertBefore(wrap, home);
    else scheduleSave();
    home = null;
  });
}

function gripFor(name, wrap) {
  const btn = cardToolBtn("bc-grip", ICONS.grip, `Rearrange ${name}`);
  // `draggable` goes on only while the grip is held, and comes off on dragend.
  // Left on permanently it would make the whole card a drag source, since the
  // pointer inherits it wherever inside the wrapper it lands.
  btn.addEventListener("pointerdown", () => { wrap.draggable = true; });
  btn.addEventListener("pointerup", () => { wrap.draggable = false; });
  btn.addEventListener("pointercancel", () => { wrap.draggable = false; });
  btn.addEventListener("keydown", (e) => onGripKey(e, name, wrap, btn));
  return btn;
}

// Arrows move the focused card one place along the sequence. Up/Down are bound
// to the same step as Left/Right rather than a row's worth: the column count is
// a viewport accident, and a key that moves by a number the reader can't see is
// worse than one that moves by one.
function onGripKey(e, name, wrap, btn) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  const all = wraps();
  const to = all.indexOf(wrap) + step;
  if (to < 0 || to >= all.length) return; // at the end: nothing to do, and no wrap-around
  e.preventDefault(); // …only now, so an arrow that can't move still scrolls
  // Same phrasing as the dragover move above: the card is what travels.
  gridEl().insertBefore(wrap, step > 0 ? all[to].nextSibling : all[to]);
  btn.focus(); // moving a node can drop focus; the reader is mid-gesture
  document.getElementById("arrange-note").textContent =
    `${name} moved to position ${to + 1} of ${all.length}`;
  scheduleSave();
}

// Coalesced, because the keyboard path can fire several moves a second while a
// held arrow walks a card across the grid. A drag produces exactly one move and
// pays only the delay.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveOrder, 300);
}

async function saveOrder() {
  const ids = orderNow();
  // Backstop for a render that lands between this being queued and firing:
  // an empty grid is the note element, not an empty arrangement, and storing
  // [] would wipe the order this feature exists to keep. render() drops the
  // timer for exactly this reason; this covers the sliver where it can't.
  if (!ids.length) return;
  // A drag that ends where it began is not an edit — and after a failed save
  // this is what still knows there is something to say, since the retry is
  // measured against what the SERVER confirmed rather than the last attempt.
  if (ids.join() === savedOrder.join()) return;
  try {
    await api("PATCH", "/api/account", { board_order: ids });
    savedOrder = ids;
  } catch (err) {
    // The grid on screen is now a claim the server never accepted. Say so, and
    // re-render — which redraws from the stored arrangement, so the cards go
    // back to the last order that is actually true.
    toast.error(`Couldn't save the arrangement: ${err.message}`);
    render();
  }
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
    // Failing outranks the countdown in words (the countdown is the retry),
    // and tints the chip — the gallery toolbar's ingest chip does the same.
    const c = chip(ICONS.redo, "", b.ingest_error
      ? "Automatic ingestion — failing (it retries on its own; open the board for the error)"
      : `Automatic ingestion${when}`);
    if (b.ingest_error) c.classList.add("error");
    chips.appendChild(c);
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
  // Images are natively draggable too, and the tile is decoration — grabbing
  // one must not start an image drag over a card whose own drag is the grip's.
  img.draggable = false;
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
