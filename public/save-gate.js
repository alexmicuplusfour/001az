// A commit button that is dead until something has actually changed.
//
// Every editor in this app opened with its commit live: a button promising to
// act over a request that would have written back exactly what it read. The
// gate holds a BASELINE — a snapshot of what the editor contained once it
// finished loading — and turns the commit off while the current snapshot
// matches it.
//
//   const gate = saveGate({ root: dialog, read: draft, buttons: [saveBtn] });
//
//   read     a pure function returning what the reader has CHOSEN, as plain
//            JSON-able data: every setting on the form, including one the
//            request can't carry yet. Comparing values rather than events is
//            the point: typing a character and deleting it again, or
//            re-picking the value that was already picked, leaves the button
//            dead. But "the save would send the same body" is not "nothing
//            changed", and reading the body instead has shipped twice: the
//            ingest modal (a board with no source sends {ingest: null} whatever
//            else is on the form) and the alert editor's webhook switch (on,
//            URL still empty, sends what off sends) both sat dead through real
//            edits. A live Save that lands on a refusal is an answer; a button
//            that never lights is not. A read that THROWS counts as changed;
//            an editor whose draft can't even be built is not in the state it
//            opened in, and "changed" is the safe direction to be wrong in
//            (the user can still save the fix).
//   root     the element edits happen inside. Every `input`, `change` and
//            `click` under it re-reads. Capture phase, so a handler that stops
//            propagation can't hide an edit from us; on a timeout, so those
//            handlers have run before we look. Over-signalling is FREE — a
//            re-read that finds nothing new changes nothing — which is why the
//            listeners are three blunt event types rather than a list of the
//            controls that happen to exist this month. So a new control is
//            RE-READ without anyone remembering it exists — but it is only
//            COMPARED if `read` includes it, and that half is the caller's.
//   buttons  the commits to gate.
//   baseline optional: what counts as unchanged, made from the draft at the
//            open and at every rebase. Left out, it's the draft itself. The
//            board editor's new board leaves its name out, so a board that
//            arrives named (a template's) can be created at once, and a name
//            typed before a late load isn't taken into that load's rebase.
//
// Two things a caller still has to say, because nothing generic can know them:
//
//   gate.rebase()   "what is on screen now is the new baseline" — for state
//                   that lands AFTER the open (a capability feed filling the
//                   pickers, a row list arriving in a popover) and for a save
//                   that succeeded without closing. Skip it and the editor
//                   reads as edited by its own loading. This is the single
//                   most common way to get a dirty check wrong; react-hook-form
//                   has carried the same bug against async defaultValues for
//                   years (their issue #3562).
//   a `gate:rebase` event bubbling out of a control that MOVED ITSELF does the
//                   same thing without the site holding the gate — for the
//                   pickers whose live model list can disprove their own
//                   pre-render guess (board-modal.js). A move nobody made is
//                   not an edit.
//
// And one obligation that runs the other way, on anything an editor does AFTER
// an await. The listeners below fire on the click, and read one task later —
// so a handler that writes state once a clipboard, a fetch or a permission
// prompt has answered has already missed its own signal. Such a write must
// announce itself: `input` on the control it wrote (setting `.value` from code
// raises nothing on its own), or `gate:rebase` if it was the editor correcting
// its own arrival rather than a change anyone asked for. Both halves of that
// have now been shipped broken once — Paste JSON writing a taxonomy Save never
// noticed, and a connector catalog coercing a face into looking like an edit —
// so the rule is: if it happens after an await, say so.
//
// ─── Why aria-disabled and not `disabled` ────────────────────────────────────
// A `disabled` button is removed from the accessibility tree and cannot take
// focus, so a screen-reader user tabbing an untouched editor finds no Save
// button AT ALL — and the one thing that makes a dimmed button acceptable,
// saying why it is dim, is exactly what `disabled` blocks: no focus, and no
// tooltip on hover in most browsers. `aria-disabled="true"` keeps the button
// present, focusable and titled, and announces the state. The cost is that
// suppressing the action becomes ours, which the capture-phase listener below
// does centrally, so no call site changes.
//
// The two states stay separate on purpose, and the split is the whole tidiness
// of it: `disabled` means WORKING (busy() owns it — double-submit prevention
// is the one use of the attribute nobody argues with), `aria-disabled` means
// NOTHING TO SAVE (this file owns it). Different attributes, so neither can
// clobber the other's answer and busy()'s restore needs to know nothing about
// gates.

// The string a draft compares by. Key order is normalized because these drafts
// are assembled by spreading, and a key added by one edit and removed by
// another would otherwise come back in a different slot and read as a change.
//
// It is JSON, so it inherits JSON's blind spots — `undefined` is dropped, NaN
// and Infinity flatten to null, a Date and its own ISO string compare equal.
// That is not a hazard HERE and it is worth saying why rather than reaching for
// a deep-equal: every `read` in this app returns the request body, which is
// about to be JSON.stringify'd onto the wire anyway. The comparison therefore
// collapses exactly what the server would never have been told apart either.
// A caller that ever compares something which is NOT destined for JSON is the
// one that has to think again.
export const draftKey = (value) => JSON.stringify(value, (_k, v) =>
  (v && typeof v === "object" && !Array.isArray(v))
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v);

let unreadableSeq = 0;

// ── The tests' check (globalThis.__checkGate — the __checkCached pattern) ──
// The gate compares only what `read` returns, so a choice the caller left out
// can move while the gate sees nothing, and Save sits dead through a real edit.
// With the flag on (jsdom-stub.js and the browser harness set it), a switch,
// checkbox, radio, select or pressed button under `root` that changed while
// `read` didn't THROWS, so any test that touches it fails. Only a control that
// changed counts: one built or removed since the last read (a pane built on
// first visit, a row added) is structure, not an edit. Text isn't watched —
// `read` may fairly normalise it (a trimmed name, parsed JSON). Skipped: a
// dialog nested inside `root` (a drawer stages its choices until its own
// commit) and anything under [data-gate-skip], for a control that honestly
// isn't an edit. One blind spot: a read covers a burst, so a switch flipped in
// the same task as another edit that does move `read` passes unseen. A person
// can't click twice in one task; a test that batches edits without awaiting can.
const CHOICES = "input[type=checkbox], input[type=radio], select, [role=switch], [role=checkbox], [aria-pressed]";
function choicesUnder(root) {
  const out = new Map();
  for (const el of root.querySelectorAll(CHOICES)) {
    const inner = el.closest("[role=dialog]");
    if ((inner && inner !== root && root.contains(inner)) || el.closest("[data-gate-skip]")) continue;
    out.set(el, el.matches("input") ? el.checked : el.matches("select") ? el.value
      : el.getAttribute(el.hasAttribute("aria-pressed") ? "aria-pressed" : "aria-checked"));
  }
  return out;
}
const nameOf = (el) => (el.getAttribute("aria-label") || el.closest("label, .switch-row")?.textContent.trim()
  || el.outerHTML).slice(0, 80);

export function saveGate({ root, read, buttons = [], baseline: baselineOf = null, cleanTitle = "Nothing to save — no changes yet" } = {}) {
  const gated = [].concat(buttons).filter(Boolean);
  // A draft that won't build gets a value equal to nothing, not even to the
  // last unbuildable one — half-typed JSON must not count as "back where we
  // started" just because it is still broken.
  //
  // The sentinel leads with a character JSON.stringify can never emit first, so
  // it cannot collide with a real draft key. It led with an escaped NUL for one
  // commit, which is worse than it looks: a NUL byte in a source file makes git
  // treat the whole file as BINARY, so it ships with no diff to review.
  const snapshot = () => {
    try { return draftKey(read()); }
    catch { return `!unreadable-draft-${++unreadableSeq}`; }
  };
  // The same, through the caller's `baseline`: what counts as unchanged.
  const baseOf = () => {
    if (!baselineOf) return snapshot();
    try { return draftKey(baselineOf(read())); }
    catch { return `!unreadable-draft-${++unreadableSeq}`; }
  };

  let baseline = baseOf();
  let dirty = false;
  let rebasing = false;
  let timer = null;

  // The check compares each read with the one before it, not with the
  // baseline: a forgotten switch is caught on the event that moved it, even
  // when another edit has already made the draft differ from the open.
  const checking = !!(globalThis.__checkGate && root);
  let lastRead = snapshot();
  let lastChoices = checking ? choicesUnder(root) : null;

  function sync() {
    const rebased = rebasing;
    if (rebasing) { rebasing = false; baseline = baseOf(); }
    const now = snapshot();
    if (checking) {
      const choices = choicesUnder(root);
      const moved = [...choices].find(([el, v]) => lastChoices.has(el) && lastChoices.get(el) !== v);
      const readMoved = now !== lastRead;
      lastChoices = choices;
      lastRead = now;
      // A rebase is a move nobody made, so it answers for itself.
      if (moved && !readMoved && !rebased) {
        throw new Error(`save gate: "${nameOf(moved[0])}" changed but read() didn't — put it in the draft, or mark it data-gate-skip if it isn't an edit`);
      }
    }
    dirty = now !== baseline;
    for (const b of gated) {
      if (dirty) b.removeAttribute("aria-disabled");
      else b.setAttribute("aria-disabled", "true");
      // Reachable on hover AND on focus, which is the argument for holding the
      // button open in the first place. Only ever our own text is cleared, so a
      // button that came with a title of its own keeps it.
      if (!dirty) b.title = cleanTitle;
      else if (b.title === cleanTitle) b.title = "";
    }
  }

  // One read per burst: a click on a checkbox fires change AND click, and a
  // drawer commit fires a dozen things at once. The timeout also puts us after
  // the handlers the event is still on its way to, which is the only reason
  // the blunt `click` listener can see what a click DID.
  //
  // Coalescing, never throttling. A throttle that decides on the LEADING edge
  // drops the last change of a fast burst and leaves the button contradicting
  // the form — GitLab shipped exactly that in its own dirty_submit and spent an
  // issue on it. Here the first signal schedules and the rest are free, and the
  // read happens at the END, off live state, so the answer is whatever the form
  // finally settled on.
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; sync(); }, 0);
  }

  if (root) {
    for (const type of ["input", "change", "click"]) root.addEventListener(type, schedule, true);
    // Capture, so it is caught whether or not the dispatcher made it bubble.
    root.addEventListener("gate:rebase", () => { rebasing = true; schedule(); }, true);
  }

  // aria-disabled suppresses nothing on its own — that is the trade. Capture on
  // the button itself, so this runs before the site's own click handler however
  // it was attached (addEventListener, .onclick) and cancels it. preventDefault
  // covers the case where the button is a form's submit: its default action is
  // the submission, including the implicit one from Enter in a text field.
  for (const b of gated) {
    b.addEventListener("click", (e) => {
      if (dirty) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  sync();

  return {
    isDirty: () => dirty,
    sync,
    rebase() { rebasing = true; sync(); },
  };
}
