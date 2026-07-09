// Shared client helpers. `api` is a thin fetch wrapper that unwraps the
// server's JSON `{ error }` into a throwable message; `copy` writes to the
// clipboard and flashes the triggering button. Dependency-free so the admin
// tabs and board-modal.js (also loaded by the gallery toolbar) can share it.

export async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

export function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const t = btn.textContent;
    btn.textContent = "copied!";
    setTimeout(() => (btn.textContent = t), 1200);
  });
}
