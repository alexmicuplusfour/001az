// The S3 ingestion source (@aws-sdk/client-s3). Works against AWS S3 and any
// S3-compatible store (MinIO, Cloudflare R2, …) via the optional endpoint +
// path-style toggle. An object store has no real directories: "folders" are
// key prefixes, surfaced with Delimiter="/" as CommonPrefixes — the browse
// modal treats those as dirs, and the shared file/dir entry shape hides the
// difference from everything upstream. Keys ARE object keys (globally stable),
// so the ledger never re-ingests across a base-prefix change.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

export const manifest = {
  name: "s3",
  label: "S3 (AWS / compatible)",
  description: "Ingest files from an S3 bucket (AWS, MinIO, R2, …)",
  core: false,
  browsable: true,
  needsConnection: true,
  connectionSchema: [
    { key: "bucket", type: "text", label: "Bucket", required: true },
    { key: "region", type: "text", label: "Region", default: "us-east-1" },
    { key: "endpoint", type: "text", label: "Endpoint URL", help: "optional — MinIO / R2 / other S3-compatible" },
    { key: "accessKeyId", type: "text", label: "Access key ID", required: true },
    { key: "secretAccessKey", type: "secret", label: "Secret access key", required: true },
    { key: "forcePathStyle", type: "toggle", label: "Path-style URLs", default: false, help: "on for MinIO / most self-hosted" },
  ],
  sourceSchema: [
    { key: "path", type: "text", label: "Prefix", help: "key prefix; blank = whole bucket" },
    { key: "recursive", type: "boolean", label: "Include sub-prefixes", default: true },
  ],
};

function makeClient(conn) {
  return new S3Client({
    region: conn.region || "us-east-1",
    endpoint: conn.endpoint || undefined,
    forcePathStyle: !!conn.forcePathStyle,
    credentials: { accessKeyId: conn.accessKeyId || "", secretAccessKey: conn.secretAccessKey || "" },
  });
}

const withSlash = (p) => (p && !p.endsWith("/") ? p + "/" : p);
const baseName = (key) => key.replace(/\/+$/, "").split("/").pop();

export function backend({ conn = {} } = {}) {
  return {
    async list({ path = "", recursive = false, limit = Infinity, accept = null, maxBytes = Infinity, includeDirs = false } = {}) {
      const client = makeClient(conn);
      const Prefix = withSlash(path);
      const entries = [];
      let truncated = false;
      try {
        let ContinuationToken;
        do {
          const out = await client.send(new ListObjectsV2Command({
            Bucket: conn.bucket,
            Prefix: Prefix || undefined,
            Delimiter: recursive ? undefined : "/", // one level for browse, deep for enumerate
            ContinuationToken,
            MaxKeys: 1000,
          }));
          if (includeDirs && !recursive) {
            for (const cp of out.CommonPrefixes || []) {
              if (entries.length >= limit) { truncated = true; break; }
              entries.push({ key: cp.Prefix, name: baseName(cp.Prefix), path: cp.Prefix, type: "dir", size: 0, modified: null, created: null });
            }
          }
          for (const obj of out.Contents || []) {
            if (entries.length >= limit) { truncated = true; break; }
            if (obj.Key === Prefix) continue; // the zero-byte "folder marker" object, if any
            const name = baseName(obj.Key);
            if (!name) continue;
            if (accept && !accept(name)) continue;
            if (obj.Size > maxBytes) continue;
            entries.push({
              key: obj.Key, name, path: obj.Key, type: "file",
              size: obj.Size,
              modified: obj.LastModified ? obj.LastModified.getTime() : null,
              created: null,
            });
          }
          // Stop early if we filled the window (more may remain → truncated).
          if (entries.length >= limit) { if (out.IsTruncated) truncated = true; break; }
          ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (ContinuationToken);
      } finally {
        client.destroy();
      }
      return { entries, truncated };
    },

    async fetch(key, tmpPath) {
      const client = makeClient(conn);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: conn.bucket, Key: key }));
        await pipeline(out.Body, fs.createWriteStream(tmpPath));
      } finally {
        client.destroy();
      }
    },

    async test() {
      const client = makeClient(conn);
      try {
        await client.send(new ListObjectsV2Command({ Bucket: conn.bucket, MaxKeys: 1 }));
        return { ok: true };
      } finally {
        client.destroy();
      }
    },
  };
}
