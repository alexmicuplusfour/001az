// A database that goes away mid-leg must not take the process with it
// (queue-by-resource-plan.md Stage 0).
//
// Each pipeline leg catches its own errors, but the catch block itself calls
// failOrRequeue — a DB write. When that write is what fails, the throw escapes a
// promise nobody awaits until stop(), and Node kills the process. A Postgres
// restart (every `docker compose up` on the db) produces exactly that pairing:
// the leg's provider call fails AND the recovery write fails, together.
//
// Three paths, three tests. The first two share backup.test.js's stray-rejection
// shape: collect on a listener, drain with setImmediate, assert nothing landed,
// restore in a finally. The intercept is asserted to have FIRED, so neither can
// pass by quietly missing its trigger.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, until } from "./helpers.js";
import { createAiKey, createBoard, createEntity, insertItem, setPluginState, openDb } from "../server/db.js";
import { startWorker } from "../server/worker.js";

const FACETS = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

let srv, db, galleryDir, thumbsDir;
before(async () => {
  srv = await startServer();
  ({ db, galleryDir, thumbsDir } = srv);
  await setPluginState(db, "ai:openai", { installed: true });
});
after(() => srv.close());

// A board whose items will actually be claimed and tagged: real facets, auto-tag
// on, and a real key (without one the claim gate holds the row and no leg runs).
// openai routes through the compat wire, which uses global.fetch — so the stub
// below reaches it. votes.test.js's pattern.
async function taggableBoard(name) {
  const keyId = await createAiKey(db, `${name}-k`, "openai", "sk-test");
  const boardId = await createBoard(db, name, FACETS, "", true, keyId);
  const eid = await createEntity(db, boardId, { identity: `${name}.png` });
  await insertItem(db, boardId, { identity: `${name}.png`, files: [], fields: {} }, "pending", eid);
  return boardId;
}

// The db as the worker sees it, with a kill switch. A Proxy that forwards
// everything (the pool is an EventEmitter too — helpers attaches an 'error'
// listener to it) and refuses query/connect once `dead`, the way a server that
// restarted under an open pool does.
function killableDb(real) {
  const state = { dead: false, rejected: 0 };
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "query" || prop === "connect") {
        return (...args) => {
          if (!state.dead) return v.apply(target, args);
          state.rejected++;
          return Promise.reject(Object.assign(
            new Error("terminating connection due to administrator command"),
            { code: "57P01" }
          ));
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { proxy, state };
}

// The pairing that makes the crash reachable: the provider call fails, and by
// the time the leg's catch tries to record that, the database is gone.
function killOnCall(state) {
  const realFetch = global.fetch;
  global.fetch = async () => {
    state.dead = true;
    throw new Error("ECONNRESET");
  };
  return () => { global.fetch = realFetch; };
}

test("a DB that dies mid-leg fails the item, not the process", async () => {
  await taggableBoard("containment");

  const strays = [];
  const onStray = (err) => strays.push(err);
  process.on("unhandledRejection", onStray);

  const { proxy, state } = killableDb(db);
  const restoreFetch = killOnCall(state);
  let stop;
  try {
    stop = startWorker({ db: proxy, galleryDir, thumbsDir });
    await until(() => state.rejected > 0);
    await new Promise((r) => setImmediate(r)); // let any stray rejection land
    assert.ok(state.rejected > 0, "the leg's recovery write must actually have been refused");
    assert.deepEqual(strays.map((e) => String(e?.message ?? e)), [],
      "a leg's failed recovery write must never escape as an unhandled rejection");
  } finally {
    restoreFetch();
    state.dead = false; // let the drain's own writes through
    await stop?.();
    process.removeListener("unhandledRejection", onStray);
  }
});

test("stop() resolves when a leg's recovery write was refused", async () => {
  // Path 2, the same defect downstream: stop() awaits Promise.all(pipelines), and
  // shutdown() is called from a floating process.on("SIGTERM", ...) — so a
  // rejecting pipeline surfaces as an unhandled rejection during shutdown, when
  // there is nothing left to report it. Catch-BEFORE-finally is what closes this.
  await taggableBoard("containment-stop");

  const { proxy, state } = killableDb(db);
  const restoreFetch = killOnCall(state);
  let stop;
  try {
    stop = startWorker({ db: proxy, galleryDir, thumbsDir });
    await until(() => state.rejected > 0);
    assert.ok(state.rejected > 0, "the trigger must have fired");
    state.dead = false;
    await assert.doesNotReject(() => stop(), "the drain must resolve, not reject");
    stop = null;
  } finally {
    restoreFetch();
    state.dead = false;
    await stop?.();
  }
});

test("an idle pool client's error does not kill the process", async () => {
  // Path 3, a different mechanism entirely: pg emits 'error' on the POOL for a
  // client that dies while IDLE — a restart, a failover, an admin disconnect.
  // EventEmitter throws an unhandled 'error' event, so openDb must carry a
  // listener. test/helpers.js has swallowed this for years for exactly this
  // reason; production had nothing, so the harness was immune to a crash the
  // real deployment was not.
  const pool = openDb(process.env.TEST_ADMIN_URL || "postgres://gallery:gallery@127.0.0.1:5433/postgres");
  try {
    assert.ok(pool.listenerCount("error") > 0,
      "openDb must attach a pool 'error' listener — an unhandled one is an uncaughtException");
    // Emitting proves it: with no listener this line throws and takes the file down.
    assert.doesNotThrow(() => pool.emit("error", new Error("simulated idle client failure")));
  } finally {
    await pool.end();
  }
});
