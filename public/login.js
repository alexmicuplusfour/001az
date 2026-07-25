// Self-routing login page: /api/me decides which face it shows. Logged out →
// sign-in form; logged in without a password (fresh invite redemption) →
// set-password form; fully logged in → bounce to the app. index.html's app.js
// redirects here for the first two states, so the pair can't loop.
import { api } from "./api.js";

const params = new URLSearchParams(location.search);
const title = document.getElementById("login-title");
const sub = document.getElementById("login-sub");
const loginForm = document.getElementById("login-form");
const setForm = document.getElementById("set-form");
const errorEl = document.getElementById("login-error");

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

// ?next= comes from app.js preserving the interrupted URL. Same-origin only,
// enforced by resolving through the URL parser — a startsWith("/") check
// misses browser normalization ("/\evil.com" and "/\t/evil.com" both resolve
// protocol-relative to https://evil.com).
function nextTarget() {
  try {
    const u = new URL(params.get("next") || "", location.origin);
    if (u.origin === location.origin) return u.pathname + u.search + u.hash;
  } catch {}
  return "/";
}

async function submit(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  showError("");
  try {
    await fn();
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    btn.disabled = false;
  }
}

const me = await fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null);

if (me && !me.needs_password && !params.has("change")) {
  location.replace(nextTarget());
} else if (me) {
  // One form, two moods: first-time set (fresh invite, no current password to
  // ask for) and ?change=1 (linked from the admin page; needs the current one).
  const changeMode = !me.needs_password;
  title.textContent = changeMode ? "Change password" : "Choose a password";
  sub.textContent = changeMode
    ? "Every other signed-in session will be signed out."
    : "You'll use it to sign in from now on.";
  sub.hidden = false;
  if (changeMode) {
    document.getElementById("set-current-label").hidden = false;
    document.getElementById("set-current").required = true;
    document.getElementById("set-submit").textContent = "Change password";
  }
  setForm.hidden = false;
  document.getElementById(changeMode ? "set-current" : "set-password").focus(); // autofocus doesn't fire on unhide
  setForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = document.getElementById("set-password").value;
    const confirm = document.getElementById("set-confirm").value;
    if (password !== confirm) return showError("Passwords don't match.");
    submit(setForm, async () => {
      await api("POST", "/api/account/password", {
        current: document.getElementById("set-current").value,
        password,
      });
      location.replace(changeMode ? nextTarget() : "/");
    });
  });
} else {
  title.textContent = "Sign in";
  loginForm.hidden = false;
  document.getElementById("login-email").focus(); // autofocus doesn't fire on unhide
  if (params.get("error") === "invalid") {
    showError("That login link has expired or was already used — sign in with your password, or ask an admin for a new link.");
  }
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(loginForm, async () => {
      const email = document.getElementById("login-email").value;
      const password = document.getElementById("login-password").value;
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) return location.replace(nextTarget());
      if (r.status === 429) throw new Error("Too many attempts — try again in a few minutes.");
      throw new Error("Invalid email or password.");
    });
  });
}
