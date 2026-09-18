// saveGate (save-gate.js) — the rule that a Save button is dead until saving
// would do something.
//
// Every editor in this app used to open with its commit live: a button
// promising to act over a request that would have written back exactly what it
// read. The gate is a value comparison, not a "was anything touched" flag, and
// that distinction is the whole point — the flag version (which the mapping
// pane carried, privately) latched on a select re-picked to the value it
// already held and never un-latched when an edit was undone, so a pane that was
// opened, poked and put back told the server to reschedule and backfill.
//
// What is pinned here: the comparison itself, the two ways a baseline moves
// (an explicit rebase, and a control that announces its own self-move), and
// the aria-disabled contract — the gate holds the button FOCUSABLE and present
// in the accessibility tree and suppresses the action itself, so `disabled` is
// left to mean one thing only, "this button is working".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './jsdom-stub.js';

const { saveGate, draftKey } = await import('../public/save-gate.js');
const { busy } = await import('../public/modal.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
// The gate's "no". Never `.disabled` — that is busy()'s word for something else.
const off = (b) => b.getAttribute('aria-disabled') === 'true';

// A root, an input inside it, and a button — the shape of every call site.
function rig(read) {
  const root = document.createElement('form');
  const input = document.createElement('input');
  const btn = document.createElement('button');
  root.append(input, btn);
  document.body.appendChild(root);
  const gate = saveGate({ root, read: read || (() => input.value.trim()), buttons: [btn] });
  const type = async (v) => {
    input.value = v;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  };
  return { root, input, btn, gate, type };
}

test('dead on open, live on a change, dead again when the change is undone', async () => {
  const { btn, gate, type } = rig();
  assert.equal(off(btn), true, 'nothing has changed yet');
  assert.equal(gate.isDirty(), false);

  await type('hello');
  assert.equal(off(btn), false);
  assert.equal(gate.isDirty(), true);

  // The flag version could not do this line.
  await type('');
  assert.equal(off(btn), true, 'typed back to where it started');
  assert.equal(gate.isDirty(), false);
});

test('the comparison is of the PAYLOAD, so a no-op edit is not an edit', () => {
  // Two controls, one saved value: unticking `a` and ticking `b` where the
  // draft sorts them is two events and no change. (The tag editor's
  // single-value facets are exactly this — re-picking the value already
  // picked fires one change on each box.)
  let picked = ['a', 'b'];
  const root = document.createElement('div');
  const btn = document.createElement('button');
  root.appendChild(btn);
  const gate = saveGate({ root, read: () => [...picked].sort(), buttons: [btn] });
  picked = ['b', 'a'];
  gate.sync();
  assert.equal(off(btn), true, 'same set, different order — nothing to save');
  picked = ['b'];
  gate.sync();
  assert.equal(off(btn), false);
});

test('key order never counts as a change — drafts are assembled by spreading', () => {
  assert.equal(draftKey({ a: 1, b: { d: 4, c: 3 } }), draftKey({ b: { c: 3, d: 4 }, a: 1 }));
  assert.notEqual(draftKey({ a: 1 }), draftKey({ a: 2 }));
  // Arrays keep their order: a reordered list of fields IS a different mapping.
  assert.notEqual(draftKey([1, 2]), draftKey([2, 1]));
});

test('a draft that will not build counts as changed — and stays changed', () => {
  // The board editor's taxonomy box: half-typed JSON throws out of draft().
  // "Broken" must never compare equal to "broken", or the fix would be
  // unsaveable.
  let text = '[]';
  const root = document.createElement('div');
  const btn = document.createElement('button');
  root.appendChild(btn);
  const gate = saveGate({ root, read: () => JSON.parse(text), buttons: [btn] });
  assert.equal(off(btn), true);

  text = '[{';
  gate.sync();
  assert.equal(off(btn), false, 'unbuildable — Save is available for the fix');
  gate.sync();
  assert.equal(off(btn), false, 'still unbuildable — still not "back where we started"');

  text = '[]';
  gate.sync();
  assert.equal(off(btn), true, 'parses again, to the same value — dead');
});

test('rebase moves the baseline: state that lands after the open is not an edit', async () => {
  const { btn, gate, type } = rig();
  await type('filled in by a feed');
  assert.equal(off(btn), false);
  gate.rebase();
  assert.equal(off(btn), true, 'this is what the editor opened with, just late');
  await type('and now a person typed');
  assert.equal(off(btn), false);
});

test('a control that moved ITSELF says so, and the baseline follows it', async () => {
  // board-modal's model pickers: the provider's live list can disprove the
  // pre-render guess and move the selection. It fires `change` (so everything
  // downstream hears) AND `gate:rebase` (so this is not read as an edit) — in
  // that order, which the gate has to survive.
  const { input, btn } = rig();
  input.value = 'moved by the live list';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  input.dispatchEvent(new window.Event('gate:rebase', { bubbles: true }));
  await tick();
  assert.equal(off(btn), true, 'a move nobody made is not an edit');
});

test('an edit a handler hides by stopping propagation still reaches the gate', async () => {
  // The switch control stops propagation on its own click, and tiles stop it
  // on their ×. Capture phase is why those edits are not invisible here.
  let on = false;
  const root = document.createElement('div');
  const sw = document.createElement('button');
  const btn = document.createElement('button');
  root.append(sw, btn);
  document.body.appendChild(root);
  sw.addEventListener('click', (e) => { e.stopPropagation(); on = !on; });
  const gate = saveGate({ root, read: () => on, buttons: [btn] });
  sw.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(gate.isDirty(), true);
  assert.equal(off(btn), false);
});

// ─── the accessibility contract ──────────────────────────────────────────────

test('a gated button stays in the accessibility tree, focusable and titled', async () => {
  const { btn, type } = rig();
  // The whole reason this is not the `disabled` attribute: a screen-reader
  // user tabbing an untouched editor has to still FIND Save, and the tooltip
  // that says why it is dim has to be reachable — neither works on a
  // natively-disabled button (no focus, no pointer events in most browsers).
  assert.equal(btn.disabled, false, 'not natively disabled');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.match(btn.title, /nothing to save/i);
  btn.focus();
  assert.equal(document.activeElement, btn, 'still a tab stop');

  await type('edited');
  assert.equal(btn.hasAttribute('aria-disabled'), false, 'no aria-disabled="false" left behind');
  assert.equal(btn.title, '', 'and the explanation goes with it');
});

test('a gated button does nothing when clicked — the gate suppresses it', async () => {
  let ran = 0;
  const { btn, type } = rig();
  btn.addEventListener('click', () => { ran++; });
  btn.click();
  assert.equal(ran, 0, 'aria-disabled suppresses nothing on its own — the gate does');

  await type('edited');
  btn.click();
  assert.equal(ran, 1, 'and stops suppressing the moment there is something to save');
});

test('...including the implicit submit from Enter in a text field', async () => {
  let submits = 0;
  const { root, btn, input, type } = rig();
  btn.type = 'submit';
  root.addEventListener('submit', (e) => { e.preventDefault(); submits++; });

  // jsdom models implicit submission as a click on the default button, which
  // is exactly the path the gate's capture listener sits on.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  btn.click();
  assert.equal(submits, 0, 'a form with nothing to save does not submit');

  await type('edited');
  btn.click();
  assert.equal(submits, 1);
});

test('busy() owns `disabled`, the gate owns aria-disabled, and neither clobbers the other', async () => {
  let saved = null;
  const { input, btn, type } = rig();
  let release;
  const held = new Promise((r) => { release = r; });
  btn.addEventListener('click', busy(btn, async () => {
    await held;
    saved = input.value;          // the commit "lands"
  }));

  await type('a name');
  assert.equal(off(btn), false);
  btn.click();
  await tick();
  // Mid-flight: the click that started the save is itself one of the gate's
  // signals. The two answers live on two attributes, so the gate re-reading
  // here cannot reopen the double-submit busy() exists to close.
  assert.equal(btn.disabled, true, 'busy() says working');
  assert.equal(off(btn), false, 'and the gate still says there is something to save');

  release();
  await tick(); await tick();
  assert.equal(saved, 'a name');
  // busy() hands `disabled` back unconditionally — it can, because the gate's
  // answer was never stored there. A save that failed has to be retryable.
  assert.equal(btn.disabled, false);
  assert.equal(off(btn), false, 'still differs from what we opened with');
});

test('...and a commit that succeeded without closing leaves the button dead', async () => {
  const { input, btn, gate, type } = rig();
  btn.addEventListener('click', busy(btn, async () => {
    // What the account page's name form does: take the server's answer as the
    // new truth, then say so.
    input.value = input.value.trim();
    gate.rebase();
  }));
  await type('  renamed  ');
  btn.click();
  await tick(); await tick();
  assert.equal(btn.disabled, false, 'not working any more');
  assert.equal(off(btn), true, 'saved — and nothing differs from the save');
});
