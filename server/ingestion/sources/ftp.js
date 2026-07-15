// The FTP / FTPS ingestion source (basic-ftp). A saved source_connections row
// holds the host + login; a board points at one plus a subpath. Hierarchical,
// so the browse modal navigates it like a filesystem. Keys are full posix paths
// from the login root, so a board changing its base subpath never re-ingests
// what it already has. One client per operation (connect → act → close):
// simplest and correct; a hot run pays a handshake per file (bounded by
// INGEST_RUN_CAP), the obvious later optimisation.
import ftp from "basic-ftp";

export const manifest = {
  name: "ftp",
  label: "FTP / FTPS",
  description: "Ingest files from an FTP or FTPS server",
  core: false,
  browsable: true,
  needsConnection: true,
  // Fields to CREATE a connection (admin form on the Plugins page).
  connectionSchema: [
    { key: "host", type: "text", label: "Host", required: true, help: "hostname or IP" },
    { key: "port", type: "number", label: "Port", default: 21, min: 1 },
    { key: "secure", type: "toggle", label: "Use FTPS (TLS)", default: false },
    // FTPS only: self-hosted servers usually carry a self-signed cert, which a
    // verifying client rejects. This opts out of verification for THIS
    // connection (ignored when secure is off). Default: verify.
    { key: "allowSelfSigned", type: "toggle", label: "Allow self-signed TLS cert", default: false, help: "FTPS only — skip certificate verification" },
    { key: "user", type: "text", label: "Username", default: "anonymous" },
    { key: "password", type: "secret", label: "Password" },
  ],
  // Per-board fields (the modal's Source section).
  sourceSchema: [
    { key: "path", type: "text", label: "Base folder", help: "path on the server; blank = login root" },
    { key: "recursive", type: "boolean", label: "Include subfolders", default: true },
  ],
};

const joinPosix = (a, b) => (a ? `${a.replace(/\/+$/, "")}/${b}` : b);

// Control-connection timeout; a slow server just fails the tick and retries.
const CONNECT_TIMEOUT_MS = 30000;

async function withClient(conn, fn) {
  const client = new ftp.Client(CONNECT_TIMEOUT_MS);
  try {
    await client.access({
      host: conn.host,
      port: Number(conn.port) || 21,
      user: conn.user || "anonymous",
      password: conn.password || "",
      secure: !!conn.secure,
      // Self-hosted/test FTPS servers usually carry a self-signed cert, which a
      // verifying client rejects — the connection's `allowSelfSigned` toggle
      // opts out of verification (default: verify). Ignored when secure is off.
      secureOptions: conn.secure ? { rejectUnauthorized: !conn.allowSelfSigned } : undefined,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

export function backend({ conn = {} } = {}) {
  return {
    async list({ path = "", recursive = false, limit = Infinity, accept = null, maxBytes = Infinity, includeDirs = false } = {}) {
      return withClient(conn, async (client) => {
        const entries = [];
        let truncated = false;

        async function walk(dir) {
          let infos;
          try {
            infos = await client.list(dir || "/");
          } catch (err) {
            if (dir === path) throw new Error(`FTP list failed: ${err.message}`);
            return; // a vanished/forbidden subdir shouldn't fail the whole scan
          }
          for (const info of infos) {
            if (entries.length >= limit) { truncated = true; return; }
            if (info.name === "." || info.name === "..") continue;
            if (info.isSymbolicLink) continue;
            const full = joinPosix(dir, info.name);
            if (info.isDirectory) {
              if (includeDirs) entries.push({ key: full, name: info.name, path: full, type: "dir", size: 0, modified: null, created: null });
              if (recursive) await walk(full);
              continue;
            }
            if (!info.isFile) continue;
            if (accept && !accept(info.name)) continue;
            if (info.size > maxBytes) continue;
            entries.push({
              key: full, name: info.name, path: full, type: "file",
              size: info.size,
              // FTP has no reliable creation time; modifiedAt comes from MLSD.
              modified: info.modifiedAt ? info.modifiedAt.getTime() : null,
              created: null,
            });
          }
        }

        await walk(path);
        return { entries, truncated };
      });
    },

    async fetch(key, tmpPath) {
      await withClient(conn, (client) => client.downloadTo(tmpPath, key));
    },

    async test() {
      await withClient(conn, (client) => client.pwd());
      return { ok: true };
    },
  };
}
