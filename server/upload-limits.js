// The absolute per-file upload ceiling — the ONE global cap, shared by the two
// places that must agree on it (extracting it here avoids an ingest↔plugins
// circular import). multer enforces it at the parse boundary (a hard 413 above
// it), and every per-media-type limit is clamped to it in plugins.mediaLimits —
// so the client is never offered a size multer would reject, and an over-large
// admin override caps here instead of surprising the user with a 413.
//
// Per-type limits (manifest defaults + admin overrides) live BELOW this. Raising
// a single type past the ceiling means raising the ceiling too (this env var),
// which also widens multer — a deliberate two-step, because the ceiling likewise
// bounds the worst-case tmp spool of one request (ceiling × MAX_FILES).
export const UPLOAD_HARD_CEILING = Number(process.env.UPLOAD_HARD_CEILING) || 100 * 1024 * 1024;
