const DURATIONS = { short: 2000, medium: 4500, long: 8000 };
const MAX_VISIBLE = 3;

const wrap = (() => {
  const el = document.createElement("div");
  el.id = "toast-wrap";
  document.body.appendChild(el);
  return el;
})();

let queue = [];
let visible = [];

function resolveDuration(d) {
  if (d === null || d === 'sticky') return null;
  if (typeof d === 'number') return d;
  return DURATIONS[d] ?? DURATIONS.medium;
}

// `duration: null` means sticky, so only an *absent* duration falls back to
// the default (`??` would swallow the null and give sticky toasts a timer).
function effectiveDuration(opts) {
  if (opts.duration !== undefined) return opts.duration;
  return opts.loading ? null : 'medium';
}

function timedCount() {
  return visible.filter(h => !h.sticky).length;
}

function dequeue() {
  if (!queue.length || timedCount() >= MAX_VISIBLE) return;
  const { msg, opts } = queue.shift();
  _show(msg, opts);
}

function _show(msg, opts = {}) {
  const { type = '', loading = false, actions = [], progress = null } = opts;
  const ms = resolveDuration(effectiveDuration(opts));
  const sticky = ms === null;

  // Dedup: skip if same message+type is already on screen
  if (visible.some(h => h.msg === msg && h.type === type)) return null;

  const el = document.createElement("div");
  el.className = "toast" + (type ? ` toast--${type}` : "");

  if (loading) {
    const spinner = document.createElement("div");
    spinner.className = "toast-spinner";
    el.appendChild(spinner);
  }

  const msgEl = document.createElement("span");
  msgEl.className = "toast-msg";
  msgEl.textContent = msg;
  el.appendChild(msgEl);

  let barFill = null;
  if (progress !== null) {
    const bar = document.createElement("div");
    bar.className = "toast-bar";
    barFill = document.createElement("div");
    bar.appendChild(barFill);
    el.appendChild(bar);
    barFill.style.width = `${progress}%`;
  }

  let actionsEl = null;
  if (actions.length) {
    actionsEl = document.createElement("div");
    actionsEl.className = "toast-actions";
    for (const { label, onClick } of actions) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      actionsEl.appendChild(btn);
    }
    el.appendChild(actionsEl);
  }

  wrap.appendChild(el);

  let timer = null;
  let remaining = ms;
  let startedAt = null;

  function startTimer() {
    if (sticky || remaining <= 0) return;
    startedAt = Date.now();
    timer = setTimeout(remove, remaining);
  }

  function pauseTimer() {
    if (!timer) return;
    clearTimeout(timer);
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
    timer = null;
  }

  function remove() {
    clearTimeout(timer);
    el.remove();
    visible = visible.filter(h => h !== handle);
    dequeue();
  }

  if (!sticky && !actions.length) {
    el.style.cursor = 'pointer';
    el.addEventListener("click", remove);
  }

  if (!sticky) {
    el.addEventListener("mouseenter", pauseTimer);
    el.addEventListener("mouseleave", startTimer);
  }

  startTimer();

  const handle = {
    msg, type, sticky,
    update(newMsg, { progress: p, showActions } = {}) {
      if (newMsg != null) { handle.msg = newMsg; msgEl.textContent = newMsg; }
      if (p != null && barFill) barFill.style.width = `${p}%`;
      if (showActions != null && actionsEl) actionsEl.hidden = !showActions;
    },
    remove,
  };

  visible.push(handle);
  return handle;
}

export function toast(msg, opts = {}) {
  const ms = resolveDuration(effectiveDuration(opts));
  if (ms === null || timedCount() < MAX_VISIBLE) return _show(msg, opts);
  queue.push({ msg, opts });
  return null;
}

toast.error   = (msg, opts = {}) => toast(msg, { duration: 'long',   ...opts, type: 'error' });
toast.success = (msg, opts = {}) => toast(msg, { duration: 'short',  ...opts, type: 'success' });
toast.info    = (msg, opts = {}) => toast(msg, { duration: 'medium', ...opts, type: 'info' });
toast.warn    = (msg, opts = {}) => toast(msg, { duration: 'long',   ...opts, type: 'warn' });
