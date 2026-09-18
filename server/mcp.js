// The MCP endpoint (planning/mcp-stage-1.md) — how an AI client reaches this
// instance's boards. Two halves in one module because they are one feature:
// the JSON-RPC transport at /mcp, and the admin routes the MCP tab reads
// and writes. Neither knows anything about boards; mcp-tools.js owns that.
//
// Hand-rolled rather than @modelcontextprotocol/sdk. The spec's minimum for a
// search server is genuinely small — one path, plain JSON responses (SSE is
// optional), 405 on GET, no sessions — and the SDK exists mostly for the
// stateful streaming this does not do. The repo already calls every AI
// provider with plain fetch; 150 lines of dispatch is not worth a dependency.
//
// CONFIG LIVES IN `settings`, NOT THE ENVIRONMENT. That is where this app
// already keeps API keys (crypto_key_coingecko, stocks_key_financialmodelingprep),
// and an env-only feature is one nobody discovers and one that cannot hand the
// operator a working command to paste. The single surviving env var is
// MCP_DISABLE, a hard kill for an operator who wants the code path gone
// whatever a database row says.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin, requireAuth } from "./auth.js";
import {
  getSetting, getSettings, setSetting,
  resolveMcpToken, mcpTokenFor, setMcpToken, touchMcpToken,
  listMcpTokens, deleteMcpToken,
} from "./db.js";
import { rateLimit } from "./ratelimit.js";
import { toolSpecs, findTool, liveScope, visibleBoards } from "./mcp-tools.js";

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SERVER_NAME = "001az-boards";
// Newest first: an `initialize` naming one of these gets it echoed back,
// anything else gets PROTOCOLS[0]. The spec's version negotiation, whole.
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// What a request with no MCP-Protocol-Version header is, per the transport
// spec — the header postdates that release, so its absence identifies it.
const ASSUMED_PROTOCOL = "2025-03-26";

// The one lever for steering a caller before it writes its first query. Each
// board's vocabulary is its own, so the whole point is: ask what the words are
// before searching with them.
const INSTRUCTIONS = `These tools search private, self-hosted galleries ("boards") of tagged images.

Each board carries its OWN hand-authored facet vocabulary, so call describe_board before your first search_board on a board and phrase facet filters in the exact keys and values it returns. search_board composes facet filters, meaning search and similar-to in ONE call — prefer one composed call over several narrow ones.

Images returned inline are low-resolution previews for you to read.`;

// --- settings ---------------------------------------------------------------

// ONE round trip. This used to be six `getSetting` calls in a Promise.all,
// which makes them concurrent but not free — six connection checkouts from a
// pool of five, on a path the gate runs for every single request.
//
// FOUR keys, not six: the token and its last-used stamp belong to a person now
// and live in `mcp_tokens` (planning/mcp-members-plan.md §3). What is left here
// is what is true of the INSTANCE — whether the feature is on, which origins
// may call it, which boards it may reach at all, and whether agents may save.
const CONFIG_KEYS = ["mcp_enabled", "mcp_origins", "mcp_boards", "mcp_write"];

const readConfig = async (db) => {
  const s = await getSettings(db, CONFIG_KEYS);
  return {
    enabled: s.mcp_enabled === "1",
    // The NEGATIVE is what gets stored, so absence reads as ON — the same
    // stance liveScope takes about an empty board list on this very pane.
    // Absence is not a choice, and a write switch that defaults to off makes
    // every operator opt in a second time to the feature they just enabled.
    write: s.mcp_write !== "0",
    origins: s.mcp_origins || "",
    // The raw stored list. What it MEANS is liveScope's rule (mcp-tools.js):
    // intersected with the boards that still exist, and empty reads as ALL —
    // "no selection" is absence, not a claim, and a scope control whose empty
    // state silently switches the feature off would be a trap. Stated in one
    // place so the tools and the checklist cannot come to differ about it.
    boards: s.mcp_boards ? s.mcp_boards.split(",").filter(Boolean) : [],
  };
};

const mintToken = () => crypto.randomBytes(24).toString("base64url");

// --- asset links (mcp-stage-2.md §4) ------------------------------------------

// How long a download link lives. Long enough for the turn that asked for it,
// short enough that one pasted into a shared transcript is already dead.
const ASSET_TTL_MS = 60 * 60 * 1000;

// What this gallery actually stores, by count: png 2751, jpg 1258, webp 979,
// gif 146, avif 46, pdf 18, mp3 7. Only the ones `mime@1.6` (express's, via
// `send`) gets wrong or that matter for a download need naming — but spelling
// out the whole set is cheaper to read than a list of exceptions, and it means
// a future express bump cannot silently change what a link serves.
const ASSET_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".pdf": "application/pdf", ".mp3": "audio/mpeg",
};

// A SEPARATE secret from mcp_token, deliberately. Rotating the token is about
// disconnecting clients; it must not also kill a download an agent is halfway
// through. Clearing this row is the distinct act that invalidates every
// outstanding link at once. Minted on first use so nothing exists until the
// first `get_items`.
async function assetSecret(db) {
  let s = await getSetting(db, "mcp_asset_secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("base64url");
    await setSetting(db, "mcp_asset_secret", s);
  }
  return s;
}

// The signature IS the grant — no table, nothing to clean up, and a link that
// names one file and confers nothing else. `crypto.createHmac` is already the
// repo's idiom (alerts.js signs webhook bodies the same way).
//
// The KIND is signed, not just the name. Stage 4 added a second tier (the
// thumbnail an MCP App's grid renders), and a signature over the name alone
// would make the two links interchangeable: anyone holding a thumb link could
// walk it to the original by editing one path segment. Signing `kind:name`
// means a link grants one file at one size and nothing else.
const signAsset = (secret, kind, name, exp) =>
  crypto.createHmac("sha256", secret).update(`${kind}:${name}.${exp}`).digest("base64url").slice(0, 22);

// Constant-time, and length-checked first because timingSafeEqual throws on a
// mismatch. This is the last constant-time compare in the file: the bearer is
// an indexed lookup now, because it has to name a person rather than match a
// stored string.
function sigOk(secret, kind, name, exp, sig) {
  const want = Buffer.from(signAsset(secret, kind, name, exp));
  const got = Buffer.from(String(sig || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// The two tiers a link can name. `asset` is the original in the gallery tree —
// what get_items hands over for export. `thumb` is the .webp the grid renders,
// which is the same file the inline previews already read, and the reason it
// exists is measured: thirty thumbs are ~409 KB on disk, so a UI that embedded
// them as data: URIs would ship ~545 KB of base64 through the protocol where
// thirty <img> URLs cost ~4.5 KB of JSON (mcp-stage-4.md §2.3).
const ASSET_TIERS = {
  asset: { dir: "galleryDir", suffix: "" },
  thumb: { dir: "thumbsDir", suffix: ".webp" },
};

// --- the MCP App (mcp-stage-4.md) --------------------------------------------

// SEP-1865, Final 2026-01-26. An extension, so it is negotiated and optional,
// and every tool still returns a meaningful text result — which the spec
// REQUIRES and which is also the only thing most clients will ever show: Claude
// Code does not advertise this extension at all (anthropics/claude-code#95149),
// and it is the client the MCP tab's own copy-command sets up.
const UI_EXT = "io.modelcontextprotocol/ui";
const UI_MIME = "text/html;profile=mcp-app";
const UI_URI = `ui://${SERVER_NAME}/board-grid`;

// Read once, not per request: it is a file that ships with the server and
// cannot change while the process runs. Synchronous at module load, like every
// other constant here.
const UI_HTML = fs.readFileSync(new URL("./mcp-app.html", import.meta.url), "utf8");

// What the host is allowed to let the view reach. Built from BASE_URL at read
// time rather than written down, because the one origin the grid needs is THIS
// instance's — the signed thumbnail route (§2.3), which takes no bearer and so
// is the only image path an iframe with no cookie can use.
//
// connectDomains stays empty on purpose. The view never fetches; everything it
// knows arrives over postMessage, and an allowance nobody uses is an allowance
// a later change can quietly start using.
const uiMeta = (baseUrl) => ({
  _meta: {
    ui: {
      csp: { resourceDomains: [baseUrl], connectDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    },
  },
});

// --- the gates --------------------------------------------------------------

// THE TOKENLESS LOOPBACK PATH IS GONE (planning/mcp-members-plan.md §4). It let
// a client on the server's own machine connect with no token at all, acting as
// whoever ADMIN_EMAIL named. Two things killed it. It was the path that trusted
// `req.ip` — a header the caller writes — and answered 200 to anyone who sent
// `X-Forwarded-For: 127.0.0.1` at a published port. And once a token names a
// PERSON, "no token" names nobody: the honest answer to "who is this?" would
// have had to be "the admin, by convention", which is the thing this arc is
// removing. The admin holds a token like everyone else; pasting it is the same
// gesture the shortcut saved.

// DNS-rebinding defence, and the spec MANDATES it. A page in the operator's
// browser can POST to http://localhost:8001/mcp, the app's CSP constrains its
// own pages rather than other origins, and cookie auth is irrelevant because
// MCP does not use cookies. A real MCP client sends no Origin at all, so this
// costs legitimate callers nothing.
function originAllowed(req, origins, baseUrl) {
  const origin = req.get("origin");
  if (!origin) return true; // not a browser — the normal case
  // Compared against the CONFIGURED base, never `req.get("host")`: Host is
  // whatever the caller wrote, so a page on evil.example could send a matching
  // Host and Origin and call itself same-origin. baseUrl is the one address
  // this instance actually claims — the same value invite links mint from.
  const trim = (u) => u.trim().replace(/\/+$/, "");
  return [baseUrl, ...origins.split(",")].map(trim).filter(Boolean).includes(trim(origin));
}

// --- JSON-RPC ---------------------------------------------------------------

const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function mountMcp(app, { db, dirs, baseUrl }) {
  if (process.env.MCP_DISABLE === "1") {
    console.log("mcp: disabled by MCP_DISABLE");
    return;
  }

  // Abuse throttling, not a security boundary — the same stance
  // ratelimit.js's header states, and the same window /api/search uses.
  //
  // THREE counters, and what separates them is whose budget they are, NOT how
  // big they are. Each rateLimit() owns a private map, so these never share a
  // bucket; sharing one was the bug (an MCP App's grid is one <img> per card,
  // so a 30-card result fired 30 GETs at the asset route and took the agent's
  // next tools/call down with it — the model refused because the person's
  // browser loaded pictures).
  //
  // The PER-USER window is the one that binds, and the other two have to stay
  // well above it. Every authenticated request is counted by IP too, and under
  // Docker every member NATs to the same bridge address — so an IP ceiling at
  // the per-user figure would cap the whole instance there however many people
  // hold tokens, which is the exact problem the fair-share window exists to
  // solve. Stated as a ratio in code rather than as two numbers a later tuner
  // could move apart without noticing.
  const PER_USER = 60; // one member's minute
  const HEADROOM = 10; // …and how many of them a shared address may carry
  const limiter = rateLimit({ windowMs: 60_000, max: PER_USER * HEADROOM });
  const assetLimiter = rateLimit({ windowMs: 60_000, max: PER_USER * HEADROOM }); // ~20 full grids
  // Keyed on the PERSON the token named. Stage 1 of the arc predicted this:
  // per-IP "becomes wrong the day callers are distinguishable". Mounted after
  // `identify`, which is the only reason it can key on anyone. The id is
  // stringified because a falsy key reads as "unknown" in ratelimit.js — not
  // because it could collide with an IP, which a private map already prevents.
  const userLimiter = rateLimit({ windowMs: 60_000, max: PER_USER, key: (req) => String(req.mcpUser.id) });

  // Fixed for the life of the mount, so it is built once rather than per
  // request. Both `resources/list` and `resources/read` carry it, because a
  // host may prefetch from either and the CSP has to arrive with whichever
  // it used.
  const UI_META = uiMeta(baseUrl);

  // A link to one stored file, at one tier. Handed to the tools as a function
  // so they never see the secret — mcp-tools.js knows there is a link, not how
  // it is made.
  // MANY links, one secret read. Minting per name was a settings query per
  // card — 30 identical ones for a full search page, and it paid them even
  // with `include_images: false`, the mode advertised as the cheap one.
  //
  // Batched rather than memoised on purpose. Caching the secret in this
  // closure would break the one thing the separate row exists for: clearing it
  // is how an operator revokes every outstanding link, and a cached copy would
  // go on SIGNING with the dead secret that the route (which reads fresh) then
  // refuses — so revocation would silently take new links down too, until a
  // restart.
  const linksTo = async (kind, names) => {
    const secret = await assetSecret(db);
    const exp = Date.now() + ASSET_TTL_MS;
    return names.map((name) =>
      name == null
        ? null
        : `${baseUrl}/mcp/${kind}/${encodeURIComponent(name)}/${exp}/${signAsset(secret, kind, name, exp)}`
    );
  };
  const assetLink = async (name) => (await linksTo("asset", [name]))[0];
  const thumbLinks = (names) => linksTo("thumb", names);

  // "When did this client last run?" is the question an operator has after
  // setting this up, and it is now answerable per CONNECTION rather than per
  // instance — which is what makes it worth asking with several members.
  //
  // Throttled against the stamp the token lookup ALREADY returned, so it costs
  // nothing to check, it survives a restart, and it cannot go stale the way an
  // in-process clock does. An UPDATE on every request would be a write per read
  // for a number nobody consults to the second.
  function touchLastUsed(token) {
    const now = Date.now();
    if (token.lastUsedAt && now - token.lastUsedAt < 60_000) return;
    touchMcpToken(db, token.id).catch(() => {});
  }

  // Everything /mcp answers passes here first, as MIDDLEWARE rather than a call
  // inside the handler: the per-user rate window below cannot key on a person
  // until the token has named one, so identity has to finish before it starts.
  //
  // The checks are per-REQUEST rather than per-mount because the config is
  // runtime-mutable from the tab — flipping the switch must take effect without
  // a restart.
  async function identify(req, res, next) {
    // Both reads at once. They do not depend on each other, and the ORDER OF
    // THE ANSWERS below is what matters, not the order of the queries —
    // measured 1.56ms sequential against 0.82ms together, on every request
    // including the cheap ones. What the concurrency spends that waiting did
    // not is one indexed probe (0.08ms) on the disabled and bad-origin paths,
    // which are not the paths anybody is on.
    //
    // The lookup answers "is this token real" and "whose is it" together, where
    // the old compare only ever answered the first. It is a b-tree probe rather
    // than a timingSafeEqual, which is how every cookie-bearing request in this
    // app already resolves its person (getSessionUser) — and against 192 bits
    // of randomness a timing signal on an index is not a way in.
    const bearer = /^Bearer (.+)$/.exec(req.get("authorization") || "")?.[1] || "";
    const [cfg, caller] = await Promise.all([readConfig(db), resolveMcpToken(db, bearer)]);

    // Off is 404, not 503: a feature nobody switched on is absent, not broken,
    // and 503 would tell a client to retry something that will never answer.
    // FIRST, so a caller who is not allowed to know this endpoint exists learns
    // nothing from the answers below.
    if (!cfg.enabled) return res.status(404).json({ error: "not found" });
    if (!originAllowed(req, cfg.origins, baseUrl)) {
      return res.status(403).json({ error: "origin not allowed" });
    }
    if (!caller) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
      return res.status(401).json({
        error: "a token is required — create one under MCP on your account page",
      });
    }
    touchLastUsed(caller.token);
    req.mcpCfg = cfg;
    req.mcpUser = caller.user;
    next();
  }

  // The MCP endpoint MUST support POST and GET on one path. We offer no
  // server-initiated stream, so GET is 405 — explicitly allowed by the spec
  // and the right answer for a server that only ever replies to requests.
  app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "method not allowed" }));
  app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "method not allowed" }));

  // The original file behind a `get_items` link. The SIGNATURE is the
  // authorisation — no bearer, because the alternative was echoing the
  // instance's token into tool output, which spreads it into every transcript
  // and log that quotes the answer.
  //
  // No Origin check: that gate exists for JSON-RPC DNS rebinding and means
  // nothing on a GET of an image. The `mcp_enabled` check stays, so switching
  // the feature off kills outstanding links.
  //
  // NOTE for whoever edits restoreGate: that gate matches `/mcp` EXACTLY, and
  // must keep doing so. This path is not JSON-RPC, and a browser fetching an
  // image during a restore should get the plain-text notice like any other
  // page — widening it to startsWith("/mcp") would hand a JSON body to an
  // <img>. mcp-asset.test.js pins both halves.
  // The link names the stored FILE, not the entity. get_items already knows
  // exactly which file it rendered; having this route re-resolve an entity's
  // face would be a second implementation of that choice, free to disagree
  // with the first on any item with several instances.
  app.get("/mcp/:kind(asset|thumb)/:name/:exp/:sig", assetLimiter, wrap(async (req, res) => {
    // The two rows this route needs, in one query. It used to call readConfig
    // — six selects — to read one boolean, and then a seventh for the secret.
    // This is the arc's hottest path by a wide margin: the MCP App's grid
    // renders one <img> per card, so a 30-card result was 210 settings queries
    // against a five-connection pool.
    const s = await getSettings(db, ["mcp_enabled", "mcp_asset_secret"]);
    if (s.mcp_enabled !== "1") return res.status(404).json({ error: "not found" });

    const kind = req.params.kind;
    const tier = ASSET_TIERS[kind];
    const { name, sig } = req.params;
    const exp = Number(req.params.exp);
    const gone = { error: "this download link has expired or is invalid — run get_items again for a fresh one" };
    if (!Number.isInteger(exp) || exp < Date.now()) return res.status(403).json(gone);
    // Belt and braces: the signature already makes a forged name impossible,
    // but a path that never reaches the join is one that cannot escape it.
    if (name !== path.basename(name)) return res.status(403).json(gone);
    // The stored secret, read above rather than through assetSecret(): a
    // request arriving before any link was ever minted must be refused, not
    // answered by a secret it mints on the spot.
    const secret = s.mcp_asset_secret;
    if (!secret || !sigOk(secret, kind, name, exp, sig)) return res.status(403).json(gone);

    res.setHeader("Cache-Control", "private, max-age=3600");
    // express's sendFile guesses the type through `send` → `mime@1.6`, which
    // predates AVIF: 46 files in this gallery would go out as
    // application/octet-stream, and a download nobody can preview is half a
    // download. Setting it first wins, because `send` only guesses when the
    // header is absent. Anything not listed keeps sendFile's guess — an
    // extensionless file honestly IS a stream of bytes.
    const file = name + tier.suffix;
    const type = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (type) res.type(type);
    // sendFile still handles ranges and conditional requests — everything
    // express.static does for /gallery, which is the same tree.
    res.sendFile(path.join(dirs[tier.dir], file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "that file is no longer on disk" });
    });
  }));

  // IP first, identity second, the person's own window third. The order is the
  // point: the IP window is what keeps an unauthenticated flood from costing a
  // database lookup each, and the per-user window is what stops one member's
  // agent spending everybody's budget — which under Docker it otherwise would,
  // since every member NATs to the same bridge address.
  app.post("/mcp", limiter, wrap(identify), userLimiter, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); // the /api no-store rule is path-scoped and misses us
    const version = req.get("mcp-protocol-version") || ASSUMED_PROTOCOL;
    if (!PROTOCOLS.includes(version)) {
      return res.status(400).json({ error: `unsupported MCP-Protocol-Version: ${version}` });
    }

    const msg = req.body;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return res.status(400).json(rpcError(null, PARSE_ERROR, "Parse error"));
    }
    // A notification or a response carries no id to answer, and the spec says
    // acknowledge with 202 and an empty body. `notifications/initialized` is
    // the one every client sends right after handshaking.
    if (msg.id === undefined) {
      if (typeof msg.method !== "string") {
        return res.status(400).json(rpcError(null, INVALID_REQUEST, "Invalid Request"));
      }
      return res.status(202).end();
    }
    if (typeof msg.method !== "string") {
      return res.json(rpcError(msg.id, INVALID_REQUEST, "Invalid Request"));
    }

    try {
      return res.json(await dispatch(msg, req));
    } catch (err) {
      console.log(`mcp: ${msg.method} failed — ${err.message}`);
      return res.json(rpcError(msg.id, INTERNAL_ERROR, "Internal error"));
    }
  }));

  // `req` carries both halves identify resolved — the instance config and the
  // person — so it is the only thing this needs beyond the message.
  async function dispatch(msg, req) {
    const { id, method, params } = msg;
    const cfg = req.mcpCfg;
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          // Echo what they asked for when we speak it; otherwise answer with
          // ours and let the client decide whether it can live with that.
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          // No listChanged. The list is NOT a constant — the MCP tab's
          // saving switch adds and removes a tool at runtime — but the
          // capability declares whether we will EMIT notifications, and we
          // have no channel to emit on: GET is 405 by design and there is no
          // stream to push down. A client sees the current list when it
          // connects and re-lists when it reconnects.
          //
          // `resources` exists solely to carry the one ui:// template; there
          // is no general resource surface here and no subscribe.
          capabilities: {
            tools: {},
            resources: {},
            extensions: { [UI_EXT]: { mimeTypes: [UI_MIME] } },
          },
          serverInfo: { name: SERVER_NAME, version: process.env.APP_VERSION || "1" },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        // Pagination exists in the spec and is pointless at five tools, so no
        // nextCursor — its absence IS "that is all of them".
        return rpcResult(id, { tools: toolSpecs(cfg.write, UI_URI) });
      case "resources/list":
        return rpcResult(id, {
          resources: [{
            uri: UI_URI,
            name: "board_grid",
            description: "The grid an MCP App host renders for a search_board result.",
            mimeType: UI_MIME,
            ...UI_META,
          }],
        });
      case "resources/read": {
        // One resource, so the check is equality rather than a lookup — and a
        // wrong uri is a PROTOCOL error, not a tool error: nothing about it is
        // recoverable by a model, it is a client asking for something that was
        // never advertised.
        if (params?.uri !== UI_URI) {
          return rpcError(id, INVALID_PARAMS, `Unknown resource: ${params?.uri}`);
        }
        return rpcResult(id, {
          contents: [{ uri: UI_URI, mimeType: UI_MIME, text: UI_HTML, ...UI_META }],
        });
      }
      case "tools/call": {
        const tool = findTool(params?.name);
        // An unknown tool is a PROTOCOL error. Everything that goes wrong
        // INSIDE a tool comes back as isError in the result instead — the
        // spec's split, and the useful one: a model can read and recover from
        // the second, where the first is a transport failure.
        if (!tool) return rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${params?.name}`);
        // A switched-off write is NOT an unknown tool. It is hidden from
        // tools/list, because offering what the server will refuse is a lie —
        // but a client that listed before the switch flipped still calls it,
        // and METHOD_NOT_FOUND gives that client nothing it can act on. This
        // one it can read out to the person who can fix it.
        if (tool.write && !cfg.write) {
          return rpcResult(id, {
            content: [{ type: "text", text: "Saving is switched off for agents on this instance. The person running it can turn it back on under MCP in the admin settings." }],
            isError: true,
          });
        }
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) {
          return rpcError(id, INVALID_PARAMS, "arguments must be an object");
        }
        // The person the token named, resolved by `identify`. There is no
        // "configured admin" to be missing any more — a call that got this far
        // carries a token, and a token carries its owner.
        const user = req.mcpUser;
        const started = Date.now();
        const result = await tool.handler({ db, dirs, user, assetLink, thumbLinks, write: cfg.write }, args);
        // task_intent lands HERE and nowhere else. A parameter the model
        // spends tokens writing and the server discards is a lie in the
        // schema; in the log it makes the Logs tab answer WHY calls are
        // happening, for no new storage.
        const why = typeof args.task_intent === "string" ? ` · "${args.task_intent.slice(0, 120)}"` : "";
        const where = typeof args.board === "string" ? ` · ${args.board}` : "";
        // The crate names WHAT a write touched. For a read it is a filter and
        // just as worth having: both answer "why is this call happening" from
        // the Logs tab, which is the whole reason task_intent lands here.
        const what = typeof args.crate === "string" ? ` · crate "${args.crate.slice(0, 64)}"` : "";
        // WHO, now that there is more than one answer. This line was complete
        // while every call was the same caller; with tokens naming people the
        // connections list says "Bob's agent ran 3m ago" and this line could
        // not say which of them was Bob (planning/mcp-members-plan.md §10.21).
        console.log(`mcp ${tool.name} ${Date.now() - started}ms · ${user.email}${where}${what}${why}${result.isError ? " (tool error)" : ""}`);
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // --- the MCP tab's routes ---------------------------------------------

  // Everything the pane draws, including the TOOL LIST — so it renders the
  // vocabulary it is handed and invents none, and a fourth tool appears there
  // with no client edit. Same stance admin-capabilities.js takes about
  // capabilities.
  // ONE payload for all three pane routes. It used to be this on GET and the
  // bare config triple on PATCH/rotate — which the pane re-renders from, so
  // the first click on the switch painted `undefined` for the endpoint and
  // threw on a missing tool list. A reader that re-renders from a WRITE's
  // answer has to be handed the same shape the READ gave it.
  // The tool table both panes render. Filtered by the saving switch exactly as
  // tools/list is — so the list IS the switch's readout: turn it off and the
  // row goes.
  //
  // `write` and `ui` are DERIVED from the spec a client is handed, never
  // restated: `readOnlyHint` is already how a caller learns a tool writes, and
  // the ui `_meta` is already what makes one ship a grid. A pane that kept its
  // own copy of either could disagree with tools/list, and the whole point of
  // serving this list is that it cannot.
  const toolRows = (write) =>
    toolSpecs(write, UI_URI).map(({ name, title, description, annotations, _meta }) => ({
      name,
      title,
      // The pane wants a line, not the query-writing essay the model needs.
      summary: description.split("\n")[0],
      write: !annotations.readOnlyHint,
      ui: !!_meta?.ui,
    }));

  // THE INSTANCE, and nothing personal. Tokens moved to the account page in
  // stage 2, so this no longer answers "what is mine" for anybody — an admin
  // reads their own connection where every other member reads theirs.
  async function adminState() {
    const [cfg, { rows: boardRows }, connections] = await Promise.all([
      readConfig(db),
      db.query("SELECT id, name FROM boards ORDER BY created_at ASC"),
      // Folded into this payload rather than served from a route of its own,
      // because the pane re-renders from whatever a WRITE answers (see above) —
      // so a separate route would mean every switch flip either dropped the
      // table or paid a second fetch, and revoke would need a refresh path
      // nothing else on this pane has (planning/mcp-members-plan.md §10.18).
      listMcpTokens(db),
    ]);
    // The same rule the tools apply, from the same function: a scope naming
    // only deleted boards is no scope, and the checklist must say so.
    const scoped = liveScope(boardRows, cfg.boards);
    return {
      ...cfg,
      endpoint: `${baseUrl}/mcp`,
      // Every board with whether it is in scope — the checklist renders what
      // it is handed rather than intersecting two lists itself. An empty
      // scope reads as every box ticked, which is what empty MEANS.
      allBoards: boardRows.map((b) => ({ ...b, on: !scoped.size || scoped.has(b.id) })),
      // Who has an agent pointed at this instance, and when did it last run.
      // The one question the old instance-wide `mcp_last_used` could never
      // answer once callers became distinguishable. Nothing here is the token:
      // listMcpTokens does not select it, so there is no masking decision to
      // get wrong on the way out.
      connections: connections.map((t) => ({
        id: t.id,
        email: t.email,
        name: t.name,
        isAdmin: t.is_admin,
        created: t.created_at,
        lastUsed: t.last_used_at,
      })),
      tools: toolRows(cfg.write),
    };
  }

  // ONE PERSON'S CONNECTION, for the account page. The three facts the admin
  // pane used to carry about its reader, now where they belong — plus the
  // boards their agent can actually reach, which is `visibleBoards` and not a
  // second query, so this page cannot promise access the tool then refuses.
  async function accountState(user) {
    const [cfg, token, boards] = await Promise.all([
      readConfig(db),
      mcpTokenFor(db, user.id),
      visibleBoards(db, user),
    ]);
    return {
      enabled: cfg.enabled,
      // Read-only here. Whether agents may save is the instance's answer, and
      // this page states it rather than offering to change it.
      write: cfg.write,
      endpoint: `${baseUrl}/mcp`,
      token: token?.token || null,
      lastUsed: token?.last_used_at ? Number(token.last_used_at) : null,
      actingAs: user.email,
      boards: boards.map((b) => ({ id: b.id, name: b.name })),
      tools: toolRows(cfg.write),
    };
  }

  app.get("/api/admin/mcp", requireAdmin, wrap(async (_req, res) => {
    res.json(await adminState());
  }));

  app.patch("/api/admin/mcp", requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    // Enabling MINTS NOTHING. Stage 1 had it mint for whoever threw the switch,
    // because the admin tab was then the only place a token could exist and one
    // click between switching on and a working command was the whole reason
    // this is a tab. The account page is that place now, so the same mint would
    // hand an admin a token they did not ask for, on a page that no longer
    // shows it (planning/mcp-members-plan.md §10.14).
    if (b.enabled !== undefined) await setSetting(db, "mcp_enabled", b.enabled ? "1" : null);
    // The NEGATIVE is stored, so clearing the row means ON. Absence is not a
    // choice, and a default-off write switch would make the operator opt in a
    // second time to the feature they just switched on — see readConfig.
    if (b.write !== undefined) await setSetting(db, "mcp_write", b.write ? null : "0");
    if (b.origins !== undefined) await setSetting(db, "mcp_origins", String(b.origins || "").slice(0, 1000) || null);
    if (b.boards !== undefined) {
      const ids = Array.isArray(b.boards) ? b.boards.filter((x) => typeof x === "string").slice(0, 500) : [];
      const { rows } = await db.query("SELECT id FROM boards");
      const real = new Set(rows.map((r) => r.id));
      const keep = ids.filter((id) => real.has(id));
      // All of them selected is the same statement as none of them: store
      // nothing, so a board added later is in scope by default rather than
      // silently excluded by a list written before it existed.
      await setSetting(db, "mcp_boards", keep.length && keep.length < real.size ? keep.join(",") : null);
    }
    res.json(await adminState());
  }));

  // Revoking a connection: the admin's half of a token's life, and the only
  // thing they can do to one. It names a ROW rather than a person — see
  // deleteMcpToken — and answers the whole pane state, so the table redraws by
  // the same path every switch on this tab already uses.
  //
  // AN ID ALREADY GONE IS NOT AN ERROR. Two admins with this tab open is the
  // normal case, and the second one got exactly what they asked for; a 404
  // would be the pane arguing with a reader who is right. What is guarded is
  // the id being a NUMBER at all: `Number("x")` is NaN, which Postgres rejects
  // for a bigint with "invalid input syntax", and a 500 in the log is a worse
  // answer to a junk URL than a 404.
  app.delete("/api/admin/mcp/connections/:id", requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).json({ error: "not found" });
    await deleteMcpToken(db, id);
    res.json(await adminState());
  }));

  // --- the account page's routes ----------------------------------------
  //
  // requireAuth, not requireAdmin: a token is a personal thing and every member
  // holds their own. `req.user.id` is the only id these touch, so minting for
  // somebody else is not a shape this allows rather than a check it performs.

  app.get("/api/account/mcp", requireAuth, wrap(async (req, res) => {
    res.json(await accountState(req.user));
  }));

  // Mint and rotate are one act — setMcpToken replaces this person's row, so
  // there is no second code path that has to remember there is one each.
  app.post("/api/account/mcp/token", requireAuth, wrap(async (req, res) => {
    await setMcpToken(db, req.user.id, mintToken());
    res.json(await accountState(req.user));
  }));

  app.delete("/api/account/mcp/token", requireAuth, wrap(async (req, res) => {
    await setMcpToken(db, req.user.id, null);
    res.json(await accountState(req.user));
  }));
}
