// The board event channel (planning/board-events-stage-1.md) — how a page that
// is already open finds out about a change it did not make.
//
// 001az is multi-user: members, board roles, shared boards, hearts, and an MCP
// endpoint that writes. The server has always done its half of keeping people in
// sync — it stamps entities precisely so other viewers notice, and says so in as
// many words (db.js:1337, "stamp it so other viewers' delta polls pick the change
// up"). What was missing is anyone listening: the client's delta poll exists to
// follow work in flight and correctly stops when a board settles, so every one of
// those stamps landed in a database nobody was reading.
//
// This is the nudge, and nothing more. An event NAMES A SLICE and never carries
// it — `{type: "items"}`, not the items. The client refetches through the same
// code path its own clicks use, so there is one way for state to arrive and it
// cannot drift from a second one. Payloads would buy ordering guarantees and
// partial-state merges in exchange for nothing.
//
// SSE and not WebSockets: everything here is one-way, it rides ordinary HTTP
// through the droplet's Caddy with no upgrade handling, EventSource reconnects on
// its own, and the session cookie authenticates it like every other route.
import { requireAuth } from "./auth.js";
import { boardExists, canAccessBoard } from "./db.js";

// Express 4 does not forward a rejected promise to the error handler, so every
// async route needs this. Stated here like its four siblings (server.js,
// ingest.js, backup-routes.js, mcp.js) rather than hand-rolling a try/catch —
// the fifth spelling of one idea is the one that reads as a special case.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Every open stream: { res, userId, boardId }. A Set, and membership is the whole
// data structure — the same shape /api/logs/stream has used since it shipped.
const clients = new Set();

// Exported for tests, which otherwise have to infer connection bookkeeping from
// the outside and would pass while leaking every stream they opened.
export const openStreamCount = () => clients.size;

// A frame carries a slice NAME and nothing else, which is this module's whole
// design (see the header). There is deliberately no payload parameter: `data: {}`
// is what every client parses, and an argument nobody passes is an invitation to
// start sending state down a channel whose correctness rests on not doing that.
function send(client, type) {
  try {
    client.res.write(`event: ${type}\ndata: {}\n\n`);
  } catch {
    // Client gone mid-write; req.on("close") does the removal. Swallowing here
    // matters because this runs inside a request's finish handler — a throw
    // would surface as an unhandled rejection on an unrelated route.
  }
}

// To everyone looking at this board. The connection was access-checked when it
// opened, so a board id here reaches only people entitled to it — nothing is
// broadcast and filtered client-side, which would leak the existence of boards.
function emitBoard(boardId, type) {
  if (!boardId) return;
  for (const c of clients) if (c.boardId === boardId) send(c, type);
}

// To all of one person's tabs, whatever board each is on. This is what a change
// to the BOARDS LIST needs — "a board was created" belongs to no board — and the
// reason the stream is per-user with a board attached rather than per-board.
function emitUser(userId, type) {
  if (!userId) return;
  for (const c of clients) if (c.userId === userId) send(c, type);
}

// --- queueing, which is the only way a route announces anything --------------

// Routes do NOT emit. They queue onto the request, and the middleware in
// server.js flushes on `finish`.
//
// That is not ceremony — it is the only way every event gets the SAME guarantee.
// The finish hook advertises "after it is committed and answered, and only under
// 400", and six routes were emitting mid-handler, before `res.json()`, so a
// response that failed on its way out still announced itself. The crate toggle
// was worse: it sent its two halves at different moments, one mid-handler and
// one at finish, for a single indivisible change.
//
// A Set, so a route that queues the same thing twice — or a guard and a route
// that both name `items` — costs one frame.
export const onBoard = (req, boardId, type) => queue(req, "board", boardId, type);
export const onUser = (req, userId, type) => queue(req, "user", userId, type);

// A character that cannot occur in any of the three parts — board ids are
// uuids, user ids are digits, slice names are lowercase words — so the key
// always splits back into exactly what went in.
const SEP = "|";

function queue(req, kind, target, type) {
  if (!target) return;
  (req.queuedEvents ||= new Set()).add(`${kind}${SEP}${target}${SEP}${type}`);
}

export function flushEvents(req) {
  for (const key of req.queuedEvents || []) {
    const [kind, target, type] = key.split(SEP);
    if (kind === "board") emitBoard(target, type);
    else emitUser(Number(target), type);
  }
}

// Every stream ended before the process goes. `server.close()` refuses new
// connections but waits on open ones, and these never end by themselves — the
// same reason the log stream is ended by hand at the same point in shutdown.
// Without this the only thing closing them is closeAllConnections(), which is a
// socket being cut rather than a response finishing.
export function closeAllStreams() {
  for (const c of clients) {
    try { c.res.end(); } catch { /* already gone */ }
  }
  clients.clear();
}

export function mountEvents(app, { db }) {
  app.get("/api/events", requireAuth, wrap(async (req, res) => {
    const boardId = String(req.query.board || "").trim();
    // Checked ONCE, here, and PAIRED — `boardExists` before `canAccessBoard`,
    // the way /api/crates and /api/filter-configs do it. canAccessBoard
    // short-circuits true for a global admin without looking the board up, so
    // access alone would let an admin open a stream against any string at all
    // and sit there holding a connection nothing can ever emit to.
    //
    // 404, not 403, for both: the answer must not confirm that a board the
    // reader cannot see exists.
    if (boardId && !((await boardExists(db, boardId)) && (await canAccessBoard(db, boardId, req.user)))) {
      return res.status(404).json({ error: "not found" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // `no-transform` IS THE FEATURE, not boilerplate. compressible()
      // reports text/event-stream as compressible, so compression()
      // (server.js:297) opts streams in by default — and gzip holds bytes back
      // until it has enough to compress well, which is the opposite of what a
      // stream is for. Measured: 773/520/266/4ms late without it, 1ms with.
      // test/sse.test.js is the guard.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Same statement to a buffering reverse proxy.
      "X-Accel-Buffering": "no",
    });
    // Flush the headers so the client's `onopen` fires now rather than on the
    // first real event — which may be hours away, and until then a page cannot
    // tell "connected and quiet" from "never connected".
    res.write(": open\n\n");

    const client = { res, userId: req.user.id, boardId: boardId || null };
    clients.add(client);

    // Idle connections are what proxies kill; 20s matches the log stream and
    // sits well inside the common 60s. unref so a forgotten stream in a test
    // cannot hold the process open — the server's own socket keeps the loop
    // alive for as long as it should be.
    // A COMMENT, not an event. EventSource ignores comment lines entirely, so
    // nothing downstream has to know about a keepalive — whereas `event: ping`
    // is a real frame every consumer, and every test that counts frames, then
    // has to filter out. /api/logs/stream does the same.
    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* gone; close cleans up */ }
    }, 20000);
    heartbeat.unref?.();

    req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
    });
  }));
}
