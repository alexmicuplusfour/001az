import { getSessionUser, touchSession } from "./db.js";

const COOKIE = "sid";
const MAX_AGE = 90 * 24 * 3600; // seconds

function secure() {
  return process.env.COOKIE_SECURE !== "0";
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, sid) {
  const parts = [`${COOKIE}=${sid}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${MAX_AGE}`];
  if (secure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

// Middleware: attach req.sid and req.user (or null) to every request.
export function attachUser(db) {
  return (req, res, next) => {
    req.sid = parseCookies(req)[COOKIE] || null;
    req.user = req.sid ? getSessionUser(db, req.sid) : null;
    // Slide the session forward on activity; refresh the cookie when it renews.
    if (req.user && touchSession(db, req.sid)) setSessionCookie(res, req.sid);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login required" });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: "admin only" });
  next();
}
