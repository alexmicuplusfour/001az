// The lightbox's Comments view, a component (planning/comments-plan.md, D11).
// lightbox.js draws it into #lightbox-panel-body from its effect while the
// panel shows Comments, as it draws Details there, on every change to what it
// shows.
//
// One thread per card (D1): the card's name, its comments oldest first, and a
// text box under them. Only a comment's author edits or deletes it (D4). The
// server marks which are yours (`mine`), since the page doesn't know its own
// user id.
import { itemsChanged } from './state-signals.js';
import { signal, batch } from './vendor/signals.mjs';
import { html, render, useRef, useState, useLayoutEffect } from './vendor/preact.mjs';
import { Icon } from './icon.js';
import { ICONS, ago } from './utils.js';
import { getJson } from './api.js';
import { toast } from './toast.js';

// ── The thread ──────────────────────────────────────────────────────────────
// The one on screen: whose card it is, the card's updated_at it was asked for
// at, and its comments, null until an answer comes. Asked again when the
// card's updated_at moves, which every comment write stamps (D8), and until
// that answer lands it keeps what it shows.
const thread = signal({ card: null, at: null, comments: null, failed: false });
let asked = null; // the question out: { card, at }

function followThread(item) {
  const t = thread.peek();
  if (t.card === item.id && t.at === item.updated_at) {
    // This card's thread is on screen. A question still out for another
    // card's, as after paging away and straight back, is dropped, or its
    // answer would take the screen from this one.
    if (asked && asked.card !== item.id) asked = null;
    return;
  }
  if (asked?.card === item.id && asked.at === item.updated_at) return;
  fetchThread(item);
}

async function fetchThread(item) {
  const ask = (asked = { card: item.id, at: item.updated_at });
  const { data } = await getJson(`/api/items/${item.id}/comments`);
  if (asked !== ask) return; // asked again since, for this card or another
  asked = null;
  const t = thread.peek();
  // A failed answer leaves the comments shown, and is asked again when the
  // card next changes, or the view next comes to it (Comments, below).
  thread.value = data
    ? { card: item.id, at: ask.at, comments: data.comments, failed: false }
    : { card: item.id, at: ask.at, comments: t.card === item.id ? t.comments : null, failed: true };
}

// A write's answer, into the thread on screen if it's still this card's.
function rewrite(card, change) {
  const t = thread.peek();
  if (t.card === card && t.comments) thread.value = { ...t, comments: change(t.comments) };
}

// Your own post or delete moves the card's count at once, as a heart's click
// moves its own. The announcement's refetch then brings the server's.
function recount(item, by) {
  item.comments = Math.max(0, (item.comments || 0) + by);
  itemsChanged();
}

// A write to the thread. The session gone sends the page to sign in, as the
// heart's click does; any other refusal is an error toast, in the server's
// words when it sent some (D11). Answers the body, or null.
async function send(method, url, body, failMsg) {
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
      return null;
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    toast.error(data.error || failMsg);
  } catch {
    toast.error(failMsg);
  }
  return null;
}

// Unsent text, by card: it waits on its card while you page away or close the
// lightbox, until the page reloads (D11).
const drafts = new Map();

// ── The view ────────────────────────────────────────────────────────────────

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
const sends = (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey);

// Whether the keyboard is on nothing (the page itself), or still somewhere in
// `el`: as when the button it was on turned disabled while its request was
// out, which the browser takes it off a frame later, or went with its
// comment. Then, and only then, a box or button takes it back (D11), never
// from wherever it went meanwhile.
const keyboardHere = (el = null) => {
  const on = document.activeElement;
  return !on || on === document.body || !!el?.contains(on);
};

// A box grows with what's typed, up to the height its CSS caps it at, past
// which it scrolls.
function fit(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

export function drawComments(el, props) {
  followThread(props.item);
  // Made anew for each card (its key): another card's thread opens at its own
  // newest comment, with its own draft and nothing of the last one's open.
  render(html`<${Comments} key=${props.item.id} ...${props} />`, el);
}

function Comments({ item }) {
  const t = thread.value;
  const shown = t.card === item.id ? t : null;
  const list = shown?.comments ?? null;
  // What's open in the thread, one at a time: a comment's text in a box
  // ("edit") or the question about deleting it ("ask"). A request that lands
  // late closes its own, never one opened since.
  const [open, setOpen] = useState(null); // { id, as }
  const toggle = (id, as, on) => setOpen((cur) => (on ? { id, as } : cur?.id === id && cur.as === as ? null : cur));
  // At the newest comment: a thread opens there, and stays there as one
  // arrives, and as its own height changes (the text box under it growing
  // with what's typed, the window), unless you've scrolled up to read (D11).
  const scroller = useRef(null);
  const atNewest = useRef(true);
  const stick = () => {
    const el = scroller.current;
    if (el && atNewest.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => { stick(); });
  useLayoutEffect(() => {
    const watch = new ResizeObserver(stick);
    watch.observe(scroller.current);
    return () => watch.disconnect();
  }, []);
  const onScroll = (e) => {
    const el = e.currentTarget;
    atNewest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };
  // A thread that failed to load is asked again each time the view comes to
  // it: opened, paged back to, or switched to from Details.
  useLayoutEffect(() => {
    const now = thread.peek();
    if (now.card === item.id && now.failed) fetchThread(item);
  }, []);
  // The text box under the thread, which takes the keyboard from a comment
  // that's gone.
  const box = useRef(null);
  const gone = () => { if (keyboardHere()) box.current?.focus({ preventScroll: true }); };
  const files = item.instances?.length || 0;
  return [
    html`<div class="cm-thread" ref=${scroller} onScroll=${onScroll}>
      <div class="lbp-meta">
        <div class="lbp-meta-name" title=${item.displayLabel}>${item.displayLabel}</div>
        ${files >= 2 ? html`<div class="lbp-meta-row"><span>${files} files, one thread</span></div>` : null}
      </div>
      ${list === null
        ? html`<p class="lbp-hint">${shown?.failed ? "Couldn't load the comments." : "Loading…"}</p>`
        : list.length
          ? list.map((c) => html`<${Comment} key=${c.id} item=${item} c=${c}
              editing=${open?.id === c.id && open.as === "edit"} asking=${open?.id === c.id && open.as === "ask"}
              onOpen=${(as, on) => toggle(c.id, as, on)} onGone=${gone} />`)
          : html`<p class="lbp-hint">No comments yet.</p>`}
    </div>`,
    html`<${Composer} item=${item} box=${box} onPost=${() => { atNewest.current = true; }} />`,
  ];
}

// One comment, in the panel's light-gray cell.
function Comment({ item, c, editing, asking, onOpen, onGone }) {
  const pencil = useRef(null);
  const bin = useRef(null);
  const was = useRef({ editing, asking });
  // Back from the box or the question to the button that opened it, so the
  // keyboard carries on from the comment (D11). Not when it went somewhere
  // else meanwhile, as to another comment's box.
  useLayoutEffect(() => {
    const lost = keyboardHere();
    if (lost && was.current.editing && !editing) pencil.current?.focus({ preventScroll: true });
    if (lost && was.current.asking && !asking) bin.current?.focus({ preventScroll: true });
    was.current = { editing, asking };
  });
  const who = c.author == null
    ? html`<span class="cm-author gone" title="This account was deleted">Former member</span>`
    : html`<span class="cm-author">${c.author}</span>`;
  const full = new Date(c.created_at).toLocaleString() + (c.edited_at ? `, edited ${new Date(c.edited_at).toLocaleString()}` : "");
  return html`<div class="panel-cell cm">
    <div class="cm-head">
      ${who}
      <span class="cm-time" title=${full}>${ago(c.created_at)}${c.edited_at ? " · edited" : ""}</span>
      ${c.mine && !editing && !asking ? html`<span class="cm-acts">
        <button ref=${pencil} class="lbp-file-btn" title="Edit" aria-label="Edit your comment"
          onClick=${() => onOpen("edit", true)}><${Icon} svg=${ICONS.pencil} /></button>
        <button ref=${bin} class="lbp-file-btn lbp-file-remove" title="Delete" aria-label="Delete your comment"
          onClick=${() => onOpen("ask", true)}><${Icon} svg=${ICONS.trash} /></button>
      </span>` : null}
    </div>
    ${editing
      ? html`<${EditBox} item=${item} c=${c} onDone=${() => onOpen("edit", false)} />`
      : html`<p class="lbp-desc cm-text">${c.body}</p>`}
    ${asking ? html`<${DeleteAsk} item=${item} c=${c} onDone=${() => onOpen("ask", false)} onGone=${onGone} />` : null}
  </div>`;
}

// Your comment's text in a box, with Cancel and Save.
function EditBox({ item, c, onDone }) {
  const [text, setText] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const wrap = useRef(null);
  const box = useRef(null);
  useLayoutEffect(() => {
    const el = box.current;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => fit(box.current), [text]);
  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    const out = await send("PATCH", `/api/items/${item.id}/comments/${c.id}`, { body: text }, "Couldn't save the comment");
    setBusy(false);
    if (!out) {
      // Still editing, to try again, with the keyboard back in the box.
      if (keyboardHere(wrap.current)) box.current?.focus({ preventScroll: true });
      return;
    }
    rewrite(item.id, (list) => list.map((x) => (x.id === c.id ? out.comment : x)));
    onDone();
  };
  // Escape anywhere in the edit, its buttons too, cancels it, and goes no
  // further (D12).
  const onKeyDown = (e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };
  return html`<div ref=${wrap} onKeyDown=${onKeyDown}>
    <textarea class="cm-box" ref=${box} rows="1" aria-label="Edit your comment" value=${text} readOnly=${busy}
      onInput=${(e) => setText(e.currentTarget.value)}
      onKeyDown=${(e) => { if (sends(e)) { e.preventDefault(); save(); } }} />
    <div class="cm-row">
      <span class="lbp-hint">${MOD}+Enter to save</span>
      <button class="ghost" onClick=${onDone}>Cancel</button>
      <button disabled=${busy || !text.trim()} onClick=${save}>Save</button>
    </div>
  </div>`;
}

// "Delete this comment?", asked inside the comment, the safe answer first.
function DeleteAsk({ item, c, onDone, onGone }) {
  const [busy, setBusy] = useState(false);
  const row = useRef(null);
  const keep = useRef(null);
  useLayoutEffect(() => { keep.current.focus({ preventScroll: true }); }, []);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    const out = await send("DELETE", `/api/items/${item.id}/comments/${c.id}`, null, "Couldn't delete the comment");
    setBusy(false);
    if (!out) {
      // Still asking, with the keyboard back on the safe answer.
      if (keyboardHere(row.current)) keep.current?.focus({ preventScroll: true });
      return;
    }
    batch(() => {
      rewrite(item.id, (list) => list.filter((x) => x.id !== c.id));
      recount(item, -1);
    });
    onGone(); // gone with it, the keyboard goes to the text box
  };
  // Escape cancels the question, and goes no further (D12).
  const onKeyDown = (e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };
  // A group named by its question, so a screen reader landing on Cancel says
  // what it cancels.
  const label = `cm-ask-${c.id}`;
  return html`<div class="cm-row" ref=${row} role="group" aria-labelledby=${label} onKeyDown=${onKeyDown}>
    <span class="cm-ask" id=${label}>Delete this comment?</span>
    <button ref=${keep} class="ghost" onClick=${onDone}>Cancel</button>
    <button disabled=${busy} onClick=${remove}>Delete</button>
  </div>`;
}

// The text box under the thread, holding the card's draft.
function Composer({ item, box, onPost }) {
  const [text, setText] = useState(() => drafts.get(item.id) || "");
  const [busy, setBusy] = useState(false);
  const wrap = useRef(null);
  useLayoutEffect(() => fit(box.current), [text]);
  const type = (value) => {
    setText(value);
    if (value.trim()) drafts.set(item.id, value);
    else drafts.delete(item.id);
  };
  const post = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    // Out of the drafts while it's sent: a box made anew meanwhile, by paging
    // away and back, starts empty rather than offer it to be sent twice.
    drafts.delete(item.id);
    const out = await send("POST", `/api/items/${item.id}/comments`, { body: text }, "Couldn't post the comment");
    setBusy(false);
    if (keyboardHere(wrap.current)) box.current?.focus({ preventScroll: true }); // as Post lets go of it
    if (!out) {
      if (!drafts.has(item.id)) drafts.set(item.id, text); // the text stays, to send again
      return;
    }
    setText("");
    onPost();
    batch(() => {
      // Once: a refetch that crossed the post may have brought it already.
      rewrite(item.id, (list) => [...list.filter((x) => x.id !== out.comment.id), out.comment]);
      recount(item, 1);
    });
  };
  const onKeyDown = (e) => {
    // The first Escape leaves the box with the draft kept; the next closes
    // the panel, as from anywhere in it (D12).
    if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.blur(); }
    else if (sends(e)) { e.preventDefault(); post(); }
  };
  // Read-only while it's sent, so nothing typed meanwhile is emptied with it.
  return html`<div class="cm-compose" ref=${wrap}>
    <textarea class="cm-box" ref=${box} rows="1" placeholder="Add a comment" aria-label="Add a comment" value=${text}
      readOnly=${busy} onInput=${(e) => type(e.currentTarget.value)} onKeyDown=${onKeyDown} />
    <div class="cm-row">
      <span class="lbp-hint">${MOD}+Enter to post</span>
      <button disabled=${busy || !text.trim()} onClick=${post}>Post</button>
    </div>
  </div>`;
}
