const elFilters = document.getElementById("filters");
const elFilterDrawer = document.getElementById("filter-drawer");
const elFiltersMobile = document.getElementById("filters-mobile");
const elToolbar = document.getElementById("toolbar");
const elToolbarSub = document.getElementById("toolbar-sub");
const elGrid = document.getElementById("grid");
const elLightbox = document.getElementById("lightbox");
const elLightboxImg = document.getElementById("lightbox-img");
const elLightboxFav = document.getElementById("lightbox-fav");
const elLightboxCrate = document.getElementById("lightbox-crate");
const elLightboxPrev = document.getElementById("lightbox-prev");
const elLightboxNext = document.getElementById("lightbox-next");
const elLightboxTags = document.getElementById("lightbox-tags");
const elLightboxCount = document.getElementById("lightbox-count");
const elFileInput = document.getElementById("file-input");
const elDropOverlay = document.getElementById("drop-overlay");

let boardId = null; // UUID from ?board= param
let boardName = null;
let facets = []; // [{ key, label, values: [] }]
let images = []; // { id, name, status, tags, tagSet, hearts, favoritedByMe }
let uploading = []; // optimistic, pre-server: { tempId, objURL }
let selected = new Map(); // facetKey -> Set(values), within-facet OR, across-facet AND
let filtersHidden = false;
let uid = 0;
let me = null; // { email, name, is_admin } or null
let boards = []; // [{ id, name }] — boards accessible to current user
let crates = []; // [{id, name, image_count}]
let selectedCrateId = null;
let showFavorites = false;
let sortByHearts = false;
let lightboxImg = null;
let lightboxList = [];
let lightboxIndex = -1;

const GAP = 14;       // matches --gap
const COL_MIN = 320;  // minimum column width
let layoutTimer = null;

// Incremental grid rendering: only the first `renderLimit` filtered images get
// DOM cards; the sentinel below the grid appends more as the user scrolls.
const RENDER_BATCH = 60;
let renderLimit = RENDER_BATCH;
let renderedIds = new Set(); // ids of filtered images that currently have cards
let lastFilterKey = "";

function filterKey() {
  const sel = [...selected.entries()]
    .map(([k, v]) => [k, [...v].sort()])
    .filter(([, v]) => v.length)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([sel, showFavorites, sortByHearts, selectedCrateId, boardId]);
}

function layoutGrid() {
  const cards = [...elGrid.querySelectorAll(".card")];
  if (!cards.length) {
    elGrid.style.height = "";
    return;
  }
  const cs = getComputedStyle(elGrid);
  const pl = parseFloat(cs.paddingLeft);
  const pr = parseFloat(cs.paddingRight);
  const pt = parseFloat(cs.paddingTop);
  const pb = parseFloat(cs.paddingBottom);
  const inner = elGrid.clientWidth - pl - pr;
  const cols = Math.max(1, Math.floor((inner + GAP) / (COL_MIN + GAP)));
  const cardW = (inner - GAP * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);
  for (const card of cards) {
    card.style.width = cardW + "px";
    const col = heights.indexOf(Math.min(...heights));
    card.style.left = (pl + col * (cardW + GAP)) + "px";
    card.style.top  = (pt + heights[col]) + "px";
    heights[col] += card.offsetHeight + GAP;
  }
  elGrid.style.height = (pt + Math.max(...heights) - GAP + pb) + "px";
}

function scheduleLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(layoutGrid, 30);
}

function isAdmin() {
  return !!(me && me.is_admin);
}
function toImage(d) {
  const list = Array.isArray(d.tags) ? d.tags : [];
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    tags: list,
    tagSet: new Set(list),
    hearts: d.hearts || 0,
    favoritedByMe: !!d.favoritedByMe,
    crateIds: new Set(Array.isArray(d.crateIds) ? d.crateIds : []),
    w: d.w || 0,
    h: d.h || 0,
  };
}

function tag(facet, value) {
  return `${facet}/${value}`;
}
function thumbUrl(name) {
  return `thumbnails/${encodeURIComponent(name)}.webp`;
}
function fullUrl(name) {
  return `gallery/${encodeURIComponent(name)}`;
}

const ICONS = {
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8z"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="var(--hf, none)" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.7 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  crate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
};

function actionBtn(icon, cls, title, onClick) {
  const b = document.createElement("button");
  b.className = "act " + cls;
  b.title = title;
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function toolBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "tool-btn" + (cls ? " " + cls : "");
  b.innerHTML = label;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function onOutsideClick(pop, anchorEl, onDismiss) {
  const handler = (e) => {
    if (!pop.contains(e.target) && !anchorEl.contains(e.target)) onDismiss();
  };
  setTimeout(() => document.addEventListener("click", handler, true), 0);
  return handler;
}

async function doDelete(id) {
  if (!confirm("Delete this image?")) return;
  try {
    const r = await fetch(`/api/images/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    images = images.filter((i) => i.id !== id);
    render();
  } catch {
    toast("Delete failed");
  }
}

async function doReprocess(id) {
  try {
    const r = await fetch(`/api/images/${id}/reprocess`, { method: "POST" });
    if (!r.ok) throw new Error();
    const img = images.find((i) => i.id === id);
    if (img) {
      img.status = "pending";
      img.tags = [];
      img.tagSet = new Set();
    }
    render();
    ensurePolling();
    toast("Reprocessing…");
  } catch {
    toast("Reprocess failed");
  }
}

function cardActions(img) {
  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(actionBtn("redo", "reprocess", "Reprocess (re-tag with AI)", () => doReprocess(img.id)));
  actions.appendChild(actionBtn("trash", "delete", "Delete", () => doDelete(img.id)));
  const cb = document.createElement("button");
  cb.className = "act crate";
  cb.title = "Add to crate";
  cb.innerHTML = ICONS.crate;
  cb.addEventListener("click", (e) => { e.stopPropagation(); openCratePop(cb, img); });
  actions.appendChild(cb);
  return actions;
}

function heartControl(img) {
  const wrap = document.createElement("div");
  wrap.className = "heart" + (img.favoritedByMe ? " on" : "") + (img.hearts > 0 ? " has" : "");
  wrap.title = "Favorite";
  const icon = document.createElement("span");
  icon.className = "hi";
  icon.innerHTML = ICONS.heart;
  const count = document.createElement("span");
  count.className = "hc";
  count.textContent = img.hearts || "";
  wrap.append(icon, count);

  const pop = document.createElement("div");
  pop.className = "heart-pop";
  wrap.appendChild(pop);

  let loaded = false;
  wrap.addEventListener("mouseenter", async () => {
    if (loaded || !img.hearts) {
      if (!img.hearts) pop.textContent = "no hearts yet";
      return;
    }
    loaded = true;
    try {
      const { names } = await fetch(`/api/images/${img.id}/hearts`).then((r) => r.json());
      pop.textContent = names && names.length ? names.join(", ") : "no hearts yet";
    } catch {
      loaded = false;
    }
  });

  wrap.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/images/${img.id}/favorite`, { method: "POST" });
      if (r.status === 401) return toast("Sign in to favorite");
      const { favorited, count: n } = await r.json();
      img.favoritedByMe = favorited;
      img.hearts = n;
      if (showFavorites && !favorited) return render(); // card leaves the filtered view
      wrap.classList.toggle("on", favorited);
      wrap.classList.toggle("has", n > 0);
      count.textContent = n || "";
      loaded = false;
      pop.textContent = "";
    } catch {
      toast("Couldn't update favorite");
    }
  });
  return wrap;
}

// Does an image satisfy every selected facet except `exceptKey`?
function matchesExcept(img, exceptKey) {
  for (const [key, values] of selected) {
    if (key === exceptKey || values.size === 0) continue;
    let ok = false;
    for (const v of values) {
      if (img.tagSet.has(tag(key, v))) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

function isTagged(img) {
  return img.status === "tagged" || img.status === "failed" || !img.status;
}

// Tagged images that pass the active facet filters, favorites toggle, and crate filter.
function taggedFiltered() {
  const list = images.filter(
    (img) =>
      isTagged(img) &&
      (!showFavorites || img.favoritedByMe) &&
      (selectedCrateId == null || img.crateIds.has(selectedCrateId)) &&
      matchesExcept(img, null)
  );
  if (sortByHearts) list.sort((a, b) => b.hearts - a.hearts);
  return list;
}

// In-progress items shown at the top, always (not filtered).
function inProgress() {
  return [...uploading, ...images.filter((img) => img.status === "pending" || img.status === "processing")];
}

function valueCount(facetKey, value) {
  let n = 0;
  for (const img of images) {
    if (img.tagSet.has(tag(facetKey, value)) && matchesExcept(img, facetKey)) n++;
  }
  return n;
}

function facetHasData(facetKey) {
  return images.some((img) => img.tags.some((t) => t.startsWith(facetKey + "/")));
}

function activeCount() {
  let n = 0;
  for (const values of selected.values()) n += values.size;
  return n;
}

function toggle(facetKey, value) {
  const set = selected.get(facetKey) || new Set();
  if (set.has(value)) set.delete(value);
  else set.add(value);
  selected.set(facetKey, set);
  render();
}

function clearAll() {
  selected = new Map();
  render();
}

function pill(label, count, active, muted, onClick) {
  const b = document.createElement("button");
  b.className = "pill" + (active ? " active" : "") + (muted ? " muted" : "");
  b.textContent = label;
  if (count != null) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = count;
    b.appendChild(c);
  }
  b.addEventListener("click", onClick);
  return b;
}

let userMenuState = null;

function closeUserMenu() {
  if (!userMenuState) return;
  userMenuState.pop.remove();
  document.removeEventListener("click", userMenuState.outside, true);
  userMenuState = null;
}

function openUserMenu(anchorEl) {
  if (userMenuState && userMenuState.anchor === anchorEl) { closeUserMenu(); return; }
  closeUserMenu();
  const pop = document.createElement("div");
  pop.className = "float-menu user-menu-pop";
  if (me && me.is_admin) {
    const row = document.createElement("a");
    row.href = "/admin.html";
    row.className = "cp-row";
    row.textContent = "Admin";
    pop.appendChild(row);
    const sep = document.createElement("div");
    sep.className = "cp-sep";
    pop.appendChild(sep);
  }
  const signOut = document.createElement("div");
  signOut.className = "cp-row";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", async () => {
    closeUserMenu();
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  });
  pop.appendChild(signOut);
  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  const outside = onOutsideClick(pop, anchorEl, closeUserMenu);
  userMenuState = { pop, outside, anchor: anchorEl };
}

let boardPopState = null;

function closeBoardPop() {
  if (!boardPopState) return;
  boardPopState.pop.remove();
  document.removeEventListener("click", boardPopState.outside, true);
  boardPopState = null;
}

function openBoardPop(anchorEl) {
  if (boardPopState && boardPopState.anchor === anchorEl) { closeBoardPop(); return; }
  closeBoardPop();
  const pop = document.createElement("div");
  pop.className = "float-menu board-pop";
  for (const b of boards) {
    const row = document.createElement("div");
    row.className = "cp-row" + (b.id === boardId ? " active" : "");
    const name = document.createElement("span");
    name.className = "cp-name";
    name.textContent = b.name;
    row.appendChild(name);
    row.addEventListener("click", () => { location.href = `/?board=${b.id}`; });
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  const outside = onOutsideClick(pop, anchorEl, closeBoardPop);
  boardPopState = { pop, outside, anchor: anchorEl };
}

function renderToolbar(resultCount) {
  elToolbar.replaceChildren();
  elToolbarSub.replaceChildren();

  // ── row 1: identity + upload + auth ──
  const logo = document.createElement("span");
  logo.className = "toolbar-logo";
  logo.textContent = "001/";
  elToolbar.appendChild(logo);

  if (boardName) {
    if (me && boards.length > 1) {
      const boardBtn = document.createElement("button");
      boardBtn.className = "tool-btn board-btn";
      const nameEl = document.createElement("span");
      nameEl.textContent = boardName;
      const chev = document.createElement("span");
      chev.className = "board-chevron";
      chev.innerHTML = ICONS.chevron;
      boardBtn.append(nameEl, chev);
      boardBtn.addEventListener("click", () => openBoardPop(boardBtn));
      elToolbar.appendChild(boardBtn);
    } else {
      const name = document.createElement("span");
      name.className = "board-name";
      name.textContent = boardName;
      elToolbar.appendChild(name);
    }

    if (me) {
      elToolbar.appendChild(toolBtn("+", "upload", () => elFileInput.click()));
    }
  }

  const auth = document.createElement("div");
  auth.className = "auth";
  if (me) {
    const userBtn = document.createElement("button");
    userBtn.className = "tool-btn user-menu-btn";
    const nameSpan = document.createElement("span");
    nameSpan.className = "user-menu-name";
    nameSpan.textContent = me.name || me.email;
    const chev = document.createElement("span");
    chev.className = "user-menu-chev";
    chev.innerHTML = ICONS.chevron;
    userBtn.append(nameSpan, chev);
    userBtn.addEventListener("click", () => openUserMenu(userBtn));
    auth.appendChild(userBtn);
  }
  elToolbar.appendChild(auth);

  // ── row 2: filters / sort / count ──
  if (!boardName) return;

  const ac = activeCount();
  elToolbarSub.appendChild(toolBtn(
    ac > 0 ? `Filters (${ac})` : "Filters",
    ac > 0 ? "active" : "",
    () => {
      // Inline panel sits right below the sticky header only when the page
      // is scrolled to (or near) the top; otherwise bring filters to the
      // user in the drawer.
      const headerH = document.querySelector("header").offsetHeight;
      const inlineInView = elFilters.getBoundingClientRect().top >= headerH - 2;
      if (window.innerWidth <= 640 || !inlineInView) openFilterDrawer();
      else toggleFiltersDesktop();
    }
  ));

  if (me) {
    elToolbarSub.appendChild(toolBtn(
      `${ICONS.heart} Your favorites`,
      "fav" + (showFavorites ? " active" : ""),
      () => { showFavorites = !showFavorites; render(); }
    ));

    if (crates.length > 0) {
      const activeCrate = crates.find(c => c.id === selectedCrateId) || null;
      const cratesBtn = document.createElement("button");
      cratesBtn.className = "tool-btn crates-btn" + (activeCrate ? " active" : "");
      cratesBtn.innerHTML = ICONS.crate;
      const lbl = document.createElement("span");
      lbl.textContent = activeCrate ? activeCrate.name : "Crates";
      cratesBtn.appendChild(lbl);
      const chev = document.createElement("span");
      chev.className = "crates-chevron";
      chev.innerHTML = ICONS.chevron;
      cratesBtn.appendChild(chev);
      cratesBtn.addEventListener("click", () => openCratePop(cratesBtn));
      elToolbarSub.appendChild(cratesBtn);

      if (activeCrate) {
        const clearCrateBtn = toolBtn("×", "crates-clear", () => { selectedCrateId = null; render(); });
        clearCrateBtn.title = "Clear crate filter";
        elToolbarSub.appendChild(clearCrateBtn);
      }
    }
  }

  elToolbarSub.appendChild(toolBtn(
    `${ICONS.heart} Top`,
    "sort" + (sortByHearts ? " active" : ""),
    () => { sortByHearts = !sortByHearts; render(); }
  ));

  const count = document.createElement("span");
  count.className = "result-count";
  count.textContent = `${resultCount} image${resultCount === 1 ? "" : "s"}`;
  elToolbarSub.appendChild(count);

  const active = activeCount();
  if (active > 0) {
    elToolbarSub.appendChild(toolBtn(`Clear filters (${active})`, "clear", clearAll));
  }
}

function renderFacetsInto(container) {
  container.replaceChildren();
  for (const facet of facets) {
    if (!facetHasData(facet.key)) continue;
    const sel = selected.get(facet.key) || new Set();
    const row = document.createElement("div");
    row.className = "facet";
    const label = document.createElement("div");
    label.className = "facet-label";
    label.textContent = facet.label;
    row.appendChild(label);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const value of facet.values) {
      const total = images.filter((img) => img.tagSet.has(tag(facet.key, value))).length;
      if (total === 0) continue;
      const ctxCount = valueCount(facet.key, value);
      const active = sel.has(value);
      pills.appendChild(
        pill(value, ctxCount, active, !active && ctxCount === 0, () => toggle(facet.key, value))
      );
    }
    row.appendChild(pills);
    container.appendChild(row);
  }
}

function renderFacets() {
  elFilters.classList.toggle("is-hidden", filtersHidden);
  if (!filtersHidden) renderFacetsInto(elFilters);
  renderFacetsInto(elFiltersMobile);
}

function tagChip(img) {
  const chip = document.createElement("div");
  chip.className = "tag-chip";
  chip.addEventListener("click", (e) => e.stopPropagation());
  const icon = document.createElement("span");
  icon.className = "ti";
  icon.innerHTML = ICONS.tag;
  const count = document.createElement("span");
  count.className = "tc";
  count.textContent = img.tags.length;
  chip.append(icon, count);

  const pop = document.createElement("div");
  pop.className = "tag-pop";
  if (img.tags.length) {
    for (const t of img.tags) {
      const s = document.createElement("span");
      s.className = "tp";
      s.textContent = t;
      pop.appendChild(s);
    }
  } else {
    const s = document.createElement("span");
    s.className = "tp empty";
    s.textContent = "no tags";
    pop.appendChild(s);
  }
  if (me && facets.length) {
    const editBtn = document.createElement("button");
    editBtn.className = "tp-edit";
    editBtn.innerHTML = ICONS.pencil + "<span>Edit tags</span>";
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); openTagEditor(img); });
    pop.appendChild(editBtn);
  }
  chip.appendChild(pop);
  return chip;
}

function openTagEditor(img) {
  const overlay = document.createElement("div");
  overlay.className = "te-overlay";

  const dialog = document.createElement("div");
  dialog.className = "te-dialog";

  const header = document.createElement("div");
  header.className = "te-header";
  const thumb = document.createElement("img");
  thumb.src = thumbUrl(img.name);
  thumb.className = "te-thumb";
  const closeBtn = document.createElement("button");
  closeBtn.className = "te-close";
  closeBtn.textContent = "×";
  header.append(thumb, closeBtn);

  const body = document.createElement("div");
  body.className = "te-body";

  const checkMap = new Map();
  for (const f of facets) {
    const group = document.createElement("div");
    group.className = "te-group";
    const lbl = document.createElement("div");
    lbl.className = "te-group-label";
    lbl.textContent = f.label + (f.single ? " — pick one" : "");
    group.appendChild(lbl);
    const pills = document.createElement("div");
    pills.className = "te-pills";
    const cbMap = {};
    for (const v of f.values) {
      const pill = document.createElement("label");
      pill.className = "te-val";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = img.tagSet.has(`${f.key}/${v}`);
      if (f.single) {
        cb.addEventListener("change", () => {
          if (cb.checked) for (const [ov, ocb] of Object.entries(cbMap)) { if (ov !== v) ocb.checked = false; }
        });
      }
      const sp = document.createElement("span");
      sp.textContent = v;
      pill.append(cb, sp);
      pills.appendChild(pill);
      cbMap[v] = cb;
    }
    checkMap.set(f.key, cbMap);
    group.appendChild(pills);
    body.appendChild(group);
  }

  const footer = document.createElement("div");
  footer.className = "te-footer";
  const saveBtn = document.createElement("button");
  saveBtn.className = "te-save";
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "te-cancel";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  function close() { overlay.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); }
  closeBtn.onclick = close;
  cancelBtn.onclick = close;
  let mdOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => { mdOnOverlay = e.target === overlay; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay && mdOnOverlay) close(); });;
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  saveBtn.addEventListener("click", async () => {
    const tags = [];
    for (const f of facets) {
      const cbMap = checkMap.get(f.key) || {};
      for (const [v, cb] of Object.entries(cbMap)) if (cb.checked) tags.push(`${f.key}/${v}`);
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const r = await fetch(`/api/images/${img.id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!r.ok) throw new Error();
      const { tags: saved } = await r.json();
      img.tags = saved;
      img.tagSet = new Set(saved);
      img.status = "tagged";
      close();
      render();
    } catch {
      toast("Couldn't save tags");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}

function progressCard(p) {
  const card = document.createElement("div");
  card.className = "card loading";
  const im = document.createElement("img");
  im.src = p.objURL || thumbUrl(p.name);
  im.alt = p.name || "uploading";
  im.addEventListener("error", () => card.remove());
  im.addEventListener("load", () => scheduleLayout());
  card.appendChild(im);
  const sp = document.createElement("div");
  sp.className = "spinner";
  card.appendChild(sp);
  if (p.id && me) {
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.appendChild(actionBtn("trash", "delete", "Delete", () => doDelete(p.id)));
    card.appendChild(actions);
  }
  return card;
}

function teardownCardHover(card) {
  card.querySelector(".card-actions")?.remove();
  card.querySelector(".tag-chip")?.remove();
  const heart = card.querySelector(".heart");
  if (heart && !heart.classList.contains("on") && !heart.classList.contains("has")) {
    heart.remove();
  }
}

function cardFor(img) {
  const card = document.createElement("div");
  card.className = "card";
  const im = document.createElement("img");
  im.src = thumbUrl(img.name);
  im.loading = "lazy";
  im.decoding = "async";
  if (img.w && img.h) { im.width = img.w; im.height = img.h; }
  im.alt = img.tags.length ? img.tags.join(", ") : img.name;
  im.addEventListener("error", () => card.remove());
  im.addEventListener("load", () => { im.classList.add("loaded"); card.classList.add("loaded"); scheduleLayout(); });
  if (im.complete && im.naturalWidth > 0) { im.classList.add("loaded"); card.classList.add("loaded"); }
  card.appendChild(im);
  card.addEventListener("click", () => openLightbox(img));

  // Heart stays mounted at rest when the image has hearts or is favorited.
  if (me && (img.hearts > 0 || img.favoritedByMe)) card.appendChild(heartControl(img));

  // Hover elements are mounted on enter and removed on leave.
  card.addEventListener("pointerenter", () => {
    if (me && !card.querySelector(".card-actions")) card.appendChild(cardActions(img));
    if (!card.querySelector(".tag-chip")) card.appendChild(tagChip(img));
    if (me && !card.querySelector(".heart")) card.appendChild(heartControl(img));
  });
  card.addEventListener("pointerleave", () => {
    if (card.classList.contains("crate-open")) return;
    teardownCardHover(card);
  });
  return card;
}

function renderGrid(progressItems, items) {
  elGrid.replaceChildren();
  renderedIds = new Set();
  for (const p of progressItems) elGrid.appendChild(progressCard(p));

  if (!items.length && !progressItems.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No images match these filters.";
    elGrid.appendChild(e);
    return;
  }
  for (const img of items.slice(0, renderLimit)) {
    elGrid.appendChild(cardFor(img));
    renderedIds.add(img.id);
  }
}

async function doDeleteCrate(crate, onClose) {
  try {
    const r = await fetch(`/api/crates/${crate.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    crates = crates.filter((c) => c.id !== crate.id);
    for (const im of images) im.crateIds.delete(crate.id);
    if (selectedCrateId === crate.id) selectedCrateId = null;
    onClose();
    render();
  } catch {
    toast("Couldn't delete crate");
  }
}

// --- crate popover (filter mode when img=null, assign mode when img provided) ---

let cratePopState = null;

function closeCratePop(skipTeardown = false) {
  if (!cratePopState) return;
  const { card } = cratePopState;
  cratePopState.pop.remove();
  document.removeEventListener("click", cratePopState.outside, true);
  cratePopState = null;
  if (card) {
    card.classList.remove("crate-open");
    if (!skipTeardown && !card.matches(":hover")) teardownCardHover(card);
  }
}

function positionPop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const rect = pop.getBoundingClientRect();
  let left = r.right - rect.width; // right-align to anchor's right edge
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + rect.height > window.innerHeight - 8) top = r.top - rect.height - 6;
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, top) + "px";
}

async function toggleCrateImageApi(img, crateId, checkbox) {
  const prev = checkbox.checked;
  try {
    const r = await fetch(`/api/crates/${crateId}/images/${img.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    checkbox.checked = added;
    if (added) img.crateIds.add(crateId);
    else img.crateIds.delete(crateId);
    const crate = crates.find((c) => c.id === crateId);
    if (crate) crate.image_count = count;
    if (selectedCrateId === crateId && !added) render();
    else renderLightboxCrate();
  } catch {
    checkbox.checked = prev;
    toast("Couldn't update crate");
  }
}

function openCratePop(anchorEl, img = null) {
  if (cratePopState && cratePopState.anchor === anchorEl) {
    closeCratePop();
    return;
  }
  closeCratePop();

  const pop = document.createElement("div");
  pop.className = "float-menu crate-pop";

  if (img) {
    // assign mode: checkboxes to add/remove image from crates
    if (crates.length) {
      for (const crate of crates) {
        const row = document.createElement("div");
        row.className = "cp-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = img.crateIds.has(crate.id);

        const nameEl = document.createElement("span");
        nameEl.className = "cp-name";
        nameEl.textContent = crate.name;

        const del = document.createElement("button");
        del.className = "cd-del";
        del.title = "Delete crate";
        del.innerHTML = ICONS.trash;
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete crate "${crate.name}"?`)) return;
          await doDeleteCrate(crate, closeCratePop);
        });

        row.append(cb, nameEl, del);
        cb.addEventListener("change", () => toggleCrateImageApi(img, crate.id, cb));
        row.addEventListener("click", (e) => {
          if (e.target === cb || e.target === del) return;
          cb.checked = !cb.checked;
          toggleCrateImageApi(img, crate.id, cb);
        });
        pop.appendChild(row);
      }

      const sep = document.createElement("div");
      sep.className = "cp-sep";
      pop.appendChild(sep);
    }

    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "New crate…";
    inp.className = "cp-input";
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = inp.value.trim();
      if (!name) return;
      try {
        const r = await fetch("/api/crates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, board_id: boardId }),
        });
        if (!r.ok) { toast("Couldn't create crate"); return; }
        const { crate } = await r.json();
        if (!crates.find((c) => c.id === crate.id)) crates.push(crate);
        const r2 = await fetch(`/api/crates/${crate.id}/images/${img.id}`, { method: "POST" });
        if (r2.ok) {
          const { added, count } = await r2.json();
          if (added) img.crateIds.add(crate.id);
          const found = crates.find((c) => c.id === crate.id);
          if (found) found.image_count = count;
        }
        closeCratePop(true); // skip teardown — anchorEl must stay in DOM for repositioning
        openCratePop(anchorEl, img);
        renderToolbar(taggedFiltered().length);
      } catch {
        toast("Couldn't create crate");
      }
    });
    pop.appendChild(inp);
  } else {
    // filter mode: click a crate to filter the gallery
    for (const crate of crates) {
      const row = document.createElement("div");
      row.className = "cp-row" + (selectedCrateId === crate.id ? " active" : "");

      const name = document.createElement("span");
      name.className = "cp-name";
      name.textContent = crate.name;

      const del = document.createElement("button");
      del.className = "cd-del";
      del.title = "Delete crate";
      del.innerHTML = ICONS.trash;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await doDeleteCrate(crate, closeCratePop);
      });

      row.append(name, del);
      row.addEventListener("click", (e) => {
        if (del.contains(e.target)) return;
        selectedCrateId = selectedCrateId === crate.id ? null : crate.id;
        closeCratePop();
        render();
      });
      pop.appendChild(row);
    }
  }

  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  if (img) requestAnimationFrame(() => pop.querySelector(".cp-input")?.focus());

  const card = img ? anchorEl.closest(".card") : null;
  if (card) card.classList.add("crate-open");
  const outside = onOutsideClick(pop, anchorEl, closeCratePop);
  cratePopState = { pop, outside, anchor: anchorEl, card };
}

function render() {
  const key = filterKey();
  if (key !== lastFilterKey) {
    lastFilterKey = key;
    renderLimit = RENDER_BATCH;
  }
  const tagged = taggedFiltered();
  renderToolbar(tagged.length);
  renderFacets();
  renderGrid(inProgress(), tagged);
  // IntersectionObserver only fires on state transitions, so after replacing
  // the grid content, re-observe the sentinel to force a fresh check — it may
  // already be in range (short grid, tall viewport) with no transition coming.
  requestAnimationFrame(() => {
    layoutGrid();
    pokeSentinel();
  });
}

const elGridSentinel = document.getElementById("grid-sentinel");

function pokeSentinel() {
  sentinelObserver.unobserve(elGridSentinel);
  sentinelObserver.observe(elGridSentinel);
}

function appendMoreCards() {
  const items = taggedFiltered();
  // Walk the (possibly re-sorted) list and append the first BATCH not yet
  // rendered — immune to order shifts (e.g. hearts changing under "Top" sort).
  let appended = 0;
  for (const img of items) {
    if (appended >= RENDER_BATCH) break;
    if (renderedIds.has(img.id)) continue;
    elGrid.appendChild(cardFor(img));
    renderedIds.add(img.id);
    appended++;
  }
  if (!appended) return;
  renderLimit = renderedIds.size;
  layoutGrid(); // sync, so the grid height (and sentinel position) is correct now
  pokeSentinel(); // sentinel may still be in range — force another check
}

const sentinelObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) appendMoreCards();
  },
  { rootMargin: "1200px 0px" }
);
sentinelObserver.observe(elGridSentinel);

function renderLightboxFav() {
  if (!lightboxImg) return;
  elLightboxFav.className = "lightbox-action lightbox-fav" + (lightboxImg.favoritedByMe ? " on" : "");
  elLightboxFav.innerHTML = `${ICONS.heart}<span>${lightboxImg.hearts || 0}</span>`;
}

function renderLightboxCrate() {
  if (!lightboxImg) return;
  const n = lightboxImg.crateIds.size;
  elLightboxCrate.className = "lightbox-action lightbox-crate" + (n > 0 ? " on" : "");
  elLightboxCrate.innerHTML = `${ICONS.crate}<span>${n > 0 ? n : ""}</span>`;
}

function preloadFull(i) {
  if (i >= 0 && i < lightboxList.length) {
    const im = new Image();
    im.src = fullUrl(lightboxList[i].name);
  }
}

function showLightbox() {
  lightboxImg = lightboxList[lightboxIndex];
  elLightboxImg.style.opacity = "0";
  elLightbox.classList.add("loading");
  elLightboxImg.onload = () => {
    elLightbox.classList.remove("loading");
    elLightboxImg.style.opacity = "1";
  };
  elLightboxImg.src = fullUrl(lightboxImg.name);
  if (elLightboxImg.complete && elLightboxImg.naturalWidth > 0) {
    elLightbox.classList.remove("loading");
    elLightboxImg.style.opacity = "1";
  }
  elLightboxImg.alt = lightboxImg.tags.length ? lightboxImg.tags.join(", ") : lightboxImg.name;
  elLightboxTags.replaceChildren();
  for (const t of lightboxImg.tags) {
    const s = document.createElement("span");
    s.className = "ltp";
    s.textContent = t;
    elLightboxTags.appendChild(s);
  }
  if (me) {
    renderLightboxFav();
    elLightboxFav.hidden = false;
    renderLightboxCrate();
    elLightboxCrate.hidden = false;
  } else {
    elLightboxFav.hidden = true;
    elLightboxCrate.hidden = true;
  }
  elLightboxCount.textContent =
    lightboxList.length > 1 ? `${lightboxIndex + 1} / ${lightboxList.length}` : "";
  elLightboxPrev.style.visibility = lightboxIndex > 0 ? "visible" : "hidden";
  elLightboxNext.style.visibility = lightboxIndex < lightboxList.length - 1 ? "visible" : "hidden";
  for (let d = 1; d <= 2; d++) {
    preloadFull(lightboxIndex + d);
    preloadFull(lightboxIndex - d);
  }
}

function openLightbox(img) {
  lightboxList = taggedFiltered();
  lightboxIndex = lightboxList.indexOf(img);
  if (lightboxIndex < 0) {
    lightboxList = [img];
    lightboxIndex = 0;
  }
  showLightbox();
  elLightbox.hidden = false;
}

function navLightbox(delta) {
  const n = lightboxIndex + delta;
  if (n < 0 || n >= lightboxList.length) return;
  closeCratePop();
  lightboxIndex = n;
  showLightbox();
}

function closeLightbox() {
  closeCratePop();
  elLightbox.hidden = true;
  elLightbox.classList.remove("loading");
  elLightboxImg.onload = null;
  elLightboxImg.src = "";
  elLightboxImg.alt = "";
  elLightboxTags.replaceChildren();
  lightboxImg = null;
  lightboxList = [];
  lightboxIndex = -1;
}

elLightbox.addEventListener("click", closeLightbox);
elLightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  navLightbox(-1);
});
elLightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  navLightbox(1);
});

elLightboxFav.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!lightboxImg) return;
  try {
    const r = await fetch(`/api/images/${lightboxImg.id}/favorite`, { method: "POST" });
    if (r.status === 401) return toast("Sign in to favorite");
    const { favorited, count } = await r.json();
    lightboxImg.favoritedByMe = favorited;
    lightboxImg.hearts = count;
    renderLightboxFav();
    render(); // keep the grid card in sync
  } catch {
    toast("Couldn't update favorite");
  }
});

elLightboxCrate.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!lightboxImg) return;
  openCratePop(elLightboxCrate, lightboxImg);
});

document.addEventListener("keydown", (e) => {
  if (elLightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") navLightbox(-1);
  else if (e.key === "ArrowRight") navLightbox(1);
});

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ── Upload pipeline ─────────────────────────────────────────────────────────
// Drops are validated up front (type + size), split into small chunks, and
// uploaded with limited concurrency. Each chunk succeeds or fails on its own,
// with retries for transient errors, so one bad file or dropped connection
// never cancels the rest of the batch. Placeholder tiles exist only for
// in-flight chunks (bounded object URLs); overall progress lives in the pill.
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // keep in sync with server MAX_BYTES
const UPLOAD_CHUNK_FILES = 20; // max files per request
const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024; // max payload per request
const UPLOAD_CONCURRENCY = 3;
const UPLOAD_ATTEMPTS = 3;

let uploadQueue = []; // File[][] chunks not yet started
let uploadWorkers = 0;
let uploadStats = null; // progress for the current batch; null when idle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(avif|heif|heic)$/i.test(f.name));
  if (!files.length) return;

  // Drops during an active upload merge into the running batch.
  if (!uploadStats) uploadStats = { total: 0, done: 0, uploaded: 0, failed: 0, canceled: 0, failReason: "", skipped: new Map() };
  uploadStats.total += files.length;

  const valid = [];
  for (const f of files) {
    if (f.size === 0) bumpSkip("empty file");
    else if (f.size > UPLOAD_MAX_BYTES) bumpSkip("larger than 10 MB");
    else valid.push(f);
  }

  uploadQueue.push(...chunkFiles(valid));
  pumpUploads();
}

function bumpSkip(reason, n = 1) {
  uploadStats.skipped.set(reason, (uploadStats.skipped.get(reason) || 0) + n);
  uploadStats.done += n;
}

// Split by count and payload size, preserving drop order.
function chunkFiles(files) {
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= UPLOAD_CHUNK_FILES || curBytes + f.size > UPLOAD_CHUNK_BYTES)) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function pumpUploads() {
  while (uploadWorkers < UPLOAD_CONCURRENCY && uploadQueue.length) {
    uploadWorkers++;
    uploadWorker();
  }
  renderUploadStatus();
  maybeFinishUploads(); // covers drops where every file was pre-skipped
}

async function uploadWorker() {
  while (uploadQueue.length) {
    await uploadChunk(uploadQueue.shift());
    renderUploadStatus();
  }
  uploadWorkers--;
  maybeFinishUploads();
}

async function uploadChunk(chunk) {
  const batch = chunk.map((f) => ({ tempId: ++uid, objURL: URL.createObjectURL(f) }));
  uploading.push(...batch);
  render();

  const fd = new FormData();
  for (const f of chunk) fd.append("files", f);

  let data = null;
  let failReason = "network error";
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`/api/upload?board=${boardId}`, { method: "POST", body: fd });
      if (res.ok) {
        data = await res.json();
        break;
      }
      const body = await res.json().catch(() => null);
      failReason = (body && body.error) || `server error (${res.status})`;
      if (res.status < 500) break; // client errors won't get better on retry
    } catch {
      failReason = "network error";
    }
    if (attempt < UPLOAD_ATTEMPTS) await sleep(1000 * attempt);
  }

  for (const b of batch) URL.revokeObjectURL(b.objURL);
  uploading = uploading.filter((u) => !batch.includes(u));

  uploadStats.done += chunk.length;
  if (data) {
    const rows = Array.isArray(data.uploaded) ? data.uploaded : [];
    for (const row of [...rows].reverse()) {
      images.unshift({ id: row.id, name: row.name, status: "pending", tags: [], tagSet: new Set() });
    }
    uploadStats.uploaded += rows.length;
    for (const r of data.rejected || []) {
      uploadStats.skipped.set(r.reason, (uploadStats.skipped.get(r.reason) || 0) + 1);
    }
  } else {
    uploadStats.failed += chunk.length;
    uploadStats.failReason = failReason;
  }
  render();
  ensurePolling();
}

function cancelQueuedUploads() {
  const dropped = uploadQueue.splice(0).reduce((n, c) => n + c.length, 0);
  if (!uploadStats || !dropped) return;
  uploadStats.canceled += dropped;
  uploadStats.done += dropped;
  renderUploadStatus();
  maybeFinishUploads();
}

function maybeFinishUploads() {
  if (!uploadStats || uploadWorkers > 0 || uploadQueue.length) return;
  if (uploadStats.done < uploadStats.total) return;
  const s = uploadStats;
  uploadStats = null;
  renderUploadStatus();

  const parts = [];
  if (s.uploaded) parts.push(`Uploaded ${s.uploaded} image${s.uploaded === 1 ? "" : "s"}`);
  for (const [reason, n] of s.skipped) parts.push(`${n} skipped (${reason})`);
  if (s.failed) parts.push(`${s.failed} failed (${s.failReason}) — drop them again to retry`);
  if (s.canceled) parts.push(`${s.canceled} canceled`);
  if (parts.length) toast(parts.join(" · "));
}

const elUploadStatus = (() => {
  const el = document.createElement("div");
  el.className = "upload-status";
  el.hidden = true;
  const text = document.createElement("span");
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.appendChild(document.createElement("div"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", cancelQueuedUploads);
  el.append(text, bar, cancel);
  document.body.appendChild(el);
  return el;
})();

function renderUploadStatus() {
  if (!uploadStats) {
    elUploadStatus.hidden = true;
    return;
  }
  const { done, total } = uploadStats;
  elUploadStatus.hidden = false;
  elUploadStatus.querySelector("span").textContent = `Uploading ${Math.min(done, total)} / ${total}`;
  elUploadStatus.querySelector(".bar > div").style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  elUploadStatus.querySelector("button").hidden = uploadQueue.length === 0;
}

// Merge fresh server state into `images` by id (status/tags updates + new rows).
function reconcile(data) {
  const byId = new Map(images.map((i) => [i.id, i]));
  for (const d of data) {
    const ex = byId.get(d.id);
    if (ex) {
      const list = Array.isArray(d.tags) ? d.tags : [];
      ex.status = d.status;
      ex.tags = list;
      ex.tagSet = new Set(list);
      ex.hearts = d.hearts || 0;
      ex.favoritedByMe = !!d.favoritedByMe;
      ex.crateIds = new Set(Array.isArray(d.crateIds) ? d.crateIds : []);
    } else {
      images.unshift(toImage(d));
    }
  }
}

let polling = false;
async function pollTick() {
  if (inProgress().length === 0) {
    polling = false;
    return;
  }
  try {
    const data = await fetch(`/api/images?board=${boardId}`, { cache: "no-store" }).then((r) => r.json());
    reconcile(data);
    render();
  } catch {
    /* keep polling */
  }
  setTimeout(pollTick, 4000);
}
function ensurePolling() {
  if (!polling && inProgress().length > 0) {
    polling = true;
    setTimeout(pollTick, 4000);
  }
}

function toggleFiltersDesktop() {
  // At the top of the page the panel can animate open/closed naturally.
  // When scrolled, animate nothing: swap height and compensate scroll in the
  // same frame so the grid never visibly moves under the sticky header.
  if (window.scrollY <= 4) {
    filtersHidden = !filtersHidden;
    render();
    return;
  }
  elFilters.style.transition = "none";
  const before = elFilters.offsetHeight;
  filtersHidden = !filtersHidden;
  render();
  const after = elFilters.offsetHeight;
  window.scrollBy(0, after - before);
  void elFilters.offsetHeight; // flush styles before re-enabling the transition
  elFilters.style.transition = "";
}

function openFilterDrawer() {
  elFilterDrawer.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeFilterDrawer() {
  elFilterDrawer.classList.remove("is-open");
  document.body.style.overflow = "";
}

document.getElementById("filter-drawer-scrim").addEventListener("click", closeFilterDrawer);
document.getElementById("filter-drawer-close").addEventListener("click", closeFilterDrawer);

elFileInput.addEventListener("change", () => {
  handleFiles(elFileInput.files);
  elFileInput.value = "";
});

window.addEventListener("resize", scheduleLayout);

let dragDepth = 0;
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (!me) return;
  dragDepth++;
  elDropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    elDropOverlay.hidden = true;
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  elDropOverlay.hidden = true;
  if (me && e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
});

async function main() {
  const params = new URLSearchParams(location.search);
  boardId = params.get("board");

  if (!boardId) {
    const accessible = await fetch("/api/boards", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : []).catch(() => []);
    if (accessible.length > 0) {
      location.replace(`/?board=${accessible[0].id}`);
      return;
    }
  }

  const [boardData, imagesData, meData, cratesData, boardsData] = await Promise.all([
    boardId
      ? fetch(`/api/boards/${boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
    boardId
      ? fetch(`/api/images?board=${boardId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => [])
      : Promise.resolve([]),
    fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    boardId ? fetch(`/api/crates?board=${boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),
    fetch("/api/boards", { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => []),
  ]);
  facets = boardData ? boardData.facets : [];
  boardName = boardData ? boardData.name : null;
  me = meData;
  images = imagesData.map(toImage);
  crates = Array.isArray(cratesData) ? cratesData : [];
  boards = Array.isArray(boardsData) ? boardsData : [];
  render();
  ensurePolling();
  const loginErr = params.get("login");
  if (loginErr === "invalid") {
    toast("Login link has expired or already been used — ask for a new one.");
    history.replaceState(null, "", boardId ? `/?board=${boardId}` : "/");
  }
}

main();
