// Admin backup/restore routes + the restore gate. Mounted by server.js the
// same way ingest.js is; the gate is installed separately, early in the
// middleware chain, because during a restore the session tables are mid-drop
// and NOTHING downstream (attachUser included) may touch the database.
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { requireAdmin, parseCookies } from "./auth.js";
import { getSetting, setSetting } from "./db.js";
import {
  createBackup,
  restoreBackup,
  autoBackupSweep,
  isDebrisName,
  startJob,
  publicJob,
  job,
  APP_NAME,
  APP_VERSION,
} from "./backup.js";

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Archive filenames we mint are safe by construction; anything client-supplied
// must match before it goes near a path join.
const ARCHIVE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/;
const validName = (n) => typeof n === "string" && ARCHIVE_NAME_RE.test(n) && !n.includes("..");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// While a restore is running EVERYTHING answers 503 except the initiating
// admin's status poll: the schema is mid-rebuild, and attachUser runs on every
// request (static files included), so any route allowed past this point would
// hit the pool and fail confusingly — or worse, block the DROP with an open
// transaction. The initiator's session id was captured at kickoff, so the
// status poll authenticates by string compare, no DB required.
export function restoreGate(runtime) {
  return (req, res, next) => {
    if (!runtime.restore.active) return next();
    if (req.path === "/api/admin/backups/status" && parseCookies(req).sid === runtime.restore.sid) {
      return res.json({ job: publicJob(), restoring: true });
    }
    res.set("Retry-After", "5");
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
      return res.status(503).json({ error: "restore in progress" });
    }
    res.status(503).type("text/plain").send("Restore in progress — back in a moment.");
  };
}

export function mountBackups(app, { db, backupsDir, dirs, runtime, adminEmail }) {
  fs.mkdirSync(backupsDir, { recursive: true });

  // Sweep debris from interrupted runs (spools, staging, partials, multer
  // temps — see isDebrisName). Boot time, so none of it can belong to work in
  // flight; autoBackupSweep re-runs this daily with an age floor for what
  // accumulates between reboots.
  for (const n of fs.readdirSync(backupsDir)) {
    if (isDebrisName(n)) {
      fs.rmSync(path.join(backupsDir, n), { recursive: true, force: true });
      console.log(`backups: cleaned up leftover ${n}`);
    }
  }

  async function listArchives() {
    const names = (await fs.promises.readdir(backupsDir)).filter((n) => validName(n));
    const out = [];
    for (const name of names) {
      const st = await fs.promises.stat(path.join(backupsDir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      const kind = /-full\.tar$/.test(name) ? "full" : /-db\.tar$/.test(name) ? "db" : null;
      out.push({ name, size: st.size, mtime: st.mtimeMs, kind, auto: name.startsWith("auto-") });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async function autoSettings() {
    return {
      auto: ((await getSetting(db, "backup_auto")) ?? "1") === "1",
      at: (await getSetting(db, "backup_auto_at")) || "03:30",
      keep: Math.max(1, Number(await getSetting(db, "backup_auto_keep")) || 7),
    };
  }

  app.get("/api/admin/backups", requireAdmin, wrap(async (_req, res) => {
    res.json({ backups: await listArchives(), job: publicJob(), settings: await autoSettings(), version: APP_VERSION });
  }));

  // Same payload as the list route; exists so the UI has one URL that works
  // mid-restore too (the gate short-circuits it then).
  app.get("/api/admin/backups/status", requireAdmin, (_req, res) => {
    res.json({ job: publicJob(), restoring: runtime.restore.active });
  });

  app.post("/api/admin/backups", requireAdmin, wrap(async (req, res) => {
    const kind = req.body?.kind === "db" ? "db" : "full";
    const j = startJob("backup"); // 409s if one is running
    res.status(202).json({ job: publicJob() });
    try {
      j.result = await createBackup({ db, kind, backupsDir, dirs, j });
      j.done = true;
      console.log(`backup: wrote ${j.result.name} (${(j.result.size / 1048576).toFixed(1)} MB)`);
    } catch (err) {
      j.error = err.message;
      j.done = true;
      console.error(`backup failed: ${err.message}`);
    }
  }));

  app.post("/api/admin/backups/settings", requireAdmin, wrap(async (req, res) => {
    const { auto, at, keep } = req.body || {};
    if (at !== undefined && !TIME_RE.test(String(at))) return res.status(400).json({ error: "time must be HH:MM" });
    const keepN = keep === undefined ? undefined : Number(keep);
    if (keepN !== undefined && (!Number.isInteger(keepN) || keepN < 1 || keepN > 100)) {
      return res.status(400).json({ error: "keep must be 1-100" });
    }
    if (auto !== undefined) await setSetting(db, "backup_auto", auto ? "1" : "0");
    if (at !== undefined) await setSetting(db, "backup_auto_at", String(at));
    if (keepN !== undefined) await setSetting(db, "backup_auto_keep", String(keepN));
    res.json(await autoSettings());
  }));

  app.get("/api/admin/backups/:name/download", requireAdmin, wrap(async (req, res) => {
    if (!validName(req.params.name)) return res.status(400).json({ error: "bad archive name" });
    const p = path.join(backupsDir, req.params.name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "no such archive" });
    res.download(p);
  }));

  app.delete("/api/admin/backups/:name", requireAdmin, wrap(async (req, res) => {
    if (!validName(req.params.name)) return res.status(400).json({ error: "bad archive name" });
    await fs.promises.unlink(path.join(backupsDir, req.params.name)).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
    res.json({ ok: true });
  }));

  // Uploads spool straight into the backups dir (same volume, no tmp-fs
  // double-write) under multer's random name, then take a minted name. No
  // fileSize limit: a full archive is legitimately huge, and this endpoint is
  // admin-only.
  const upload = multer({ dest: backupsDir });
  app.post("/api/admin/backups/upload", requireAdmin, upload.single("file"), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    if (!/\.tar$/i.test(req.file.originalname || "")) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: "expected a .tar backup archive" });
    }
    // Mint a name that satisfies validName BY CONSTRUCTION — list, download,
    // delete, and restore all filter on it, so a minted name that fails (an
    // uppercase .TAR passed through, a stem that sanitized away taking the
    // suffix with it) would be an invisible orphan on disk no route can reach
    // again. Strip the extension case-insensitively and re-append it
    // lowercase; collapse dot runs and drop trailing dots (validName refuses
    // ".."); a stem that sanitizes to nothing falls back rather than
    // surviving suffix-less.
    const stem = req.file.originalname
      .replace(/\.tar$/i, "")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.\.+/g, ".")
      .replace(/^[._]+/, "")
      .replace(/\.+$/, "")
      .slice(-80) || "backup";
    let name = `uploaded-${stem}.tar`;
    if (!validName(name)) {
      // Unreachable by construction; kept so a future sanitizer change fails
      // loudly here instead of minting an orphan.
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: "could not derive a safe archive name" });
    }
    // Claim the name exclusively: link() refuses EEXIST atomically, where an
    // exists-then-rename check would let two same-named uploads race and the
    // loser silently clobber the winner. Same dir as the multer temp, so
    // always the same filesystem.
    try {
      await fs.promises.link(req.file.path, path.join(backupsDir, name));
    } catch (err) {
      if (err.code === "EEXIST") {
        name = `uploaded-${Date.now()}-${stem}.tar`;
        await fs.promises.link(req.file.path, path.join(backupsDir, name));
      } else if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "ENOSYS") {
        // Filesystem without hardlinks (exotic NAS mounts) — fall back to the
        // rename with its tiny same-name race rather than refuse uploads.
        await fs.promises.rename(req.file.path, path.join(backupsDir, name));
        return res.json({ name });
      } else {
        throw err;
      }
    }
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.json({ name });
  }));

  app.post("/api/admin/backups/:name/restore", requireAdmin, wrap(async (req, res) => {
    if (!validName(req.params.name)) return res.status(400).json({ error: "bad archive name" });
    const archivePath = path.join(backupsDir, req.params.name);
    if (!fs.existsSync(archivePath)) return res.status(404).json({ error: "no such archive" });
    if (req.body?.confirm !== "RESTORE") {
      return res.status(400).json({ error: 'restore replaces ALL data — send { "confirm": "RESTORE" }' });
    }

    const j = startJob("restore"); // 409s if a backup/restore is running
    runtime.restore.active = true;
    runtime.restore.sid = req.sid;
    res.status(202).json({ job: publicJob() });

    try {
      // Quiesce: stop the worker's claims and let in-flight legs settle so no
      // connection holds a lock (or a horror-show mid-drop write) during the
      // schema rebuild. Bounded like shutdown is.
      const drained = runtime.stopWorker?.();
      if (drained) {
        await Promise.race([drained, new Promise((r) => setTimeout(r, 30000).unref())]);
      }
      j.result = await restoreBackup({ db, archivePath, dirs, adminEmail, j });
      j.done = true;
      console.log(`restore: ${req.params.name} restored (${j.result.warnings.length} warning(s))`);
      for (const w of j.result.warnings) console.warn(`restore: ${w}`);
      if (runtime.exitAfter) {
        // Restart for a clean slate: module caches (external plugin code just
        // changed on disk), worker state, board prompt caches. Docker's
        // restart policy brings us back; the UI polls /api/health until then.
        console.log("restore complete — exiting so the supervisor reboots the app on the restored state");
        setTimeout(() => process.exit(0), 1500);
      } else {
        runtime.restore.active = false;
      }
    } catch (err) {
      j.error = err.message;
      j.done = true;
      runtime.restore.active = false;
      // The worker was quiesced above but this process lives on (refused
      // archive, failed validation) — bring the worker back or tagging,
      // ingestion, and alerts would stay silently dead until a reboot.
      // (If the 30 s drain race was lost, the old loop may still be finishing
      // a leg; it exits at its next `running` check while this one takes over.)
      runtime.restartWorker?.();
      console.error(`restore failed: ${err.message}`);
    }
  }));

  return { autoBackupSweep: () => autoBackupSweep({ db, backupsDir }), job };
}
