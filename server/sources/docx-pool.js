// A tiny worker_threads pool for docx extraction. mammoth is pure JS and
// CPU-bound, so running it on the main thread stalls the event loop for the
// whole process — every other in-flight upload and the tag worker included —
// while one large document parses. Offloading it keeps the main loop free,
// mirroring how the image path lets libvips run on the libuv threadpool.
//
// Workers spawn lazily (an image-only deployment never pays the memory), up to
// DOCX_WORKERS (default 1, matching the single-vCPU droplet), and stay warm
// between documents (mammoth is loaded once per worker, not per file). A worker
// is ref'd only while it's running a task — so the loop stays alive to receive
// the result even when nothing else holds it — and unref'd when idle, so a warm
// pool never keeps the process from exiting on its own.
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./docx-worker.js", import.meta.url);

export function createDocxPool({ size } = {}) {
  const poolSize = Math.max(1, size || Number(process.env.DOCX_WORKERS) || 1);
  const workers = new Set(); // every live worker
  const idle = []; // workers ready for a task
  const queue = []; // tasks waiting for a free worker
  const inflight = new Map(); // task id -> task, for the error path
  let nextId = 1;
  let closed = false;

  function spawn() {
    const w = new Worker(WORKER_URL);
    w.on("message", (msg) => {
      const task = inflight.get(msg.id);
      if (task) {
        inflight.delete(msg.id);
        // ok:false = mammoth couldn't read the bytes -> not a real docx. The
        // caller turns null into an "unsupported file" rejection.
        task.resolve(msg.ok ? { text: msg.text, html: msg.html } : null);
      }
      free(w);
    });
    w.on("error", (err) => scrap(w, err));
    w.on("exit", (code) => {
      if (!closed && code !== 0) scrap(w, new Error(`docx worker exited (code ${code})`));
    });
    // unref AFTER attaching the message listener — attaching one re-refs the
    // port, which would otherwise keep an idle worker holding the process open.
    w.unref();
    workers.add(w);
    return w;
  }

  function assign(w, task) {
    const id = nextId++;
    task.worker = w;
    inflight.set(id, task);
    w.ref(); // in-flight: keep the loop alive until the result comes back
    w.postMessage({ id, buffer: task.buffer });
  }

  // A worker just finished: hand it the next queued task, or park it as idle
  // (unref'd, so a warm-but-quiet pool doesn't hold the process open).
  function free(w) {
    if (closed) {
      w.terminate().catch(() => {});
      workers.delete(w);
      return;
    }
    const task = queue.shift();
    if (task) assign(w, task);
    else {
      w.unref();
      idle.push(w);
    }
  }

  // A worker died mid-flight: reject whatever it was running and, unless we're
  // closing, let pump() replace it so the pool keeps draining the queue.
  function scrap(w, err) {
    workers.delete(w);
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    for (const [id, task] of inflight) {
      if (task.worker === w) {
        inflight.delete(id);
        task.reject(err);
      }
    }
    w.terminate().catch(() => {});
    if (!closed) pump();
  }

  // Dispatch queued tasks to idle workers, spawning more up to the cap.
  function pump() {
    while (queue.length && (idle.length || workers.size < poolSize)) {
      const w = idle.pop() || spawn();
      assign(w, queue.shift());
    }
  }

  // Extract one docx buffer -> { text, html }, or null when it isn't a docx
  // mammoth can read.
  function extract(buffer) {
    if (closed) return Promise.reject(new Error("docx pool is closed"));
    return new Promise((resolve, reject) => {
      queue.push({ buffer, resolve, reject, worker: null });
      pump();
    });
  }

  // Terminate every worker and reject anything still outstanding. Idempotent.
  async function close() {
    closed = true;
    for (const task of inflight.values()) task.reject(new Error("docx pool closing"));
    inflight.clear();
    for (const task of queue.splice(0)) task.reject(new Error("docx pool closing"));
    idle.length = 0;
    const all = [...workers];
    workers.clear();
    await Promise.all(all.map((w) => w.terminate().catch(() => {})));
  }

  return { extract, close };
}
