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

// `api` collapses every non-200 into one thrown Error, which is right for a
// caller that only has to say what went wrong. It loses the distinction a
// caller has to act on when the answer decides where the reader ENDS UP: did
// the server answer, or did we never get one?
//
// A 404 is a fact about the resource — it is not there, or not yours; the
// server says which to nobody on purpose. A dropped request is a fact about
// the network, and it says nothing about the resource at all. Code that
// navigates away on the first must not navigate away on the second, and the
// idiom this replaces — `.then(r => r.ok ? r.json() : null).catch(() => null)`
// — could not tell them apart because both came out as null.
//
//   { data }    answered, and the body parsed
//   { status }  answered with a refusal (404, 403, 401 …)
//   { }         no answer: offline, dropped, or a body that wouldn't parse
//
// The empty object is the shape a caller falls into by writing no branch for
// it, which is the safe direction: do nothing, stay put.
export async function getJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return { status: r.status };
    // Inside the try: a 200 whose body won't parse is not an answer either, and
    // must not be reported as one.
    return { data: await r.json() };
  } catch {
    return {};
  }
}

export function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const t = btn.textContent;
    btn.textContent = "copied!";
    setTimeout(() => (btn.textContent = t), 1200);
  });
}
