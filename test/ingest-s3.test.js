// The S3 ingestion backend, unit-tested against a mocked S3 client (no live
// bucket). Covers the object-store specifics the FTP e2e can't: CommonPrefixes
// → dir entries, the folder-marker skip, prefix (withSlash) handling,
// ContinuationToken paging + the truncated flag, and streaming a GetObject body
// to disk. (The whole path was also live-verified once against a real MinIO.)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { backend as s3Backend } from "../server/ingestion/sources/s3.js";

const s3mock = mockClient(S3Client);
const conn = { bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true };
const be = () => s3Backend({ conn });

beforeEach(() => s3mock.reset());

test("s3 list (recursive): files only, honors accept, maps size/modified", async () => {
  s3mock.on(ListObjectsV2Command).resolves({
    Contents: [
      { Key: "a.txt", Size: 5, LastModified: new Date(1000) },
      { Key: "sub/b.md", Size: 3, LastModified: new Date(2000) },
      { Key: "sub/skip.exe", Size: 9, LastModified: new Date(3000) },
    ],
    IsTruncated: false,
  });
  const { entries } = await be().list({ recursive: true, accept: (n) => /\.(txt|md)$/i.test(n) });
  assert.deepEqual(entries.map((e) => e.key).sort(), ["a.txt", "sub/b.md"], "recurses prefixes, .exe filtered");
  const a = entries.find((e) => e.key === "a.txt");
  assert.equal(a.type, "file");
  assert.equal(a.size, 5);
  assert.equal(a.modified, 1000);
});

test("s3 list (browse): CommonPrefixes become dirs, files listed, blank key ignored", async () => {
  s3mock.on(ListObjectsV2Command).resolves({
    CommonPrefixes: [{ Prefix: "sub/" }, { Prefix: "img/" }],
    Contents: [
      { Key: "top.txt", Size: 4, LastModified: new Date(5000) },
      { Key: "", Size: 0 },
    ],
    IsTruncated: false,
  });
  const { entries } = await be().list({ recursive: false, includeDirs: true });
  assert.deepEqual(entries.filter((e) => e.type === "dir").map((e) => e.name).sort(), ["img", "sub"]);
  assert.deepEqual(entries.filter((e) => e.type === "file").map((e) => e.name), ["top.txt"]);
});

test("s3 browse into a prefix skips the prefix's own marker object", async () => {
  s3mock.on(ListObjectsV2Command).resolves({
    Contents: [
      { Key: "sub/", Size: 0 }, // the zero-byte folder marker for the prefix itself
      { Key: "sub/file.txt", Size: 2, LastModified: new Date(1) },
    ],
    IsTruncated: false,
  });
  const { entries } = await be().list({ path: "sub", recursive: false, includeDirs: true });
  assert.deepEqual(entries.filter((e) => e.type === "file").map((e) => e.name), ["file.txt"]);
});

test("s3 list: paginates via ContinuationToken; complete pages are not truncated", async () => {
  s3mock.on(ListObjectsV2Command)
    .resolvesOnce({ Contents: [{ Key: "a.txt", Size: 1, LastModified: new Date(1) }], IsTruncated: true, NextContinuationToken: "t1" })
    .resolvesOnce({ Contents: [{ Key: "b.txt", Size: 1, LastModified: new Date(2) }], IsTruncated: false });
  const { entries, truncated } = await be().list({ recursive: true });
  assert.deepEqual(entries.map((e) => e.key).sort(), ["a.txt", "b.txt"]);
  assert.equal(truncated, false);
});

test("s3 list: hitting the limit flags truncated", async () => {
  s3mock.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: "a.txt", Size: 1, LastModified: new Date(1) }, { Key: "b.txt", Size: 1, LastModified: new Date(2) }],
    IsTruncated: true, NextContinuationToken: "t",
  });
  const { entries, truncated } = await be().list({ recursive: true, limit: 1 });
  assert.equal(entries.length, 1);
  assert.equal(truncated, true);
});

test("s3 fetch: streams the object body to tmp", async () => {
  s3mock.on(GetObjectCommand).resolves({ Body: Readable.from("hello s3") });
  const tmp = path.join(os.tmpdir(), "s3t-" + Math.random().toString(16).slice(2));
  await be().fetch("a.txt", tmp);
  assert.equal(fs.readFileSync(tmp, "utf8"), "hello s3");
  fs.rmSync(tmp, { force: true });
});

test("s3 test: a successful list resolves { ok: true }", async () => {
  s3mock.on(ListObjectsV2Command).resolves({ Contents: [] });
  assert.deepEqual(await be().test(), { ok: true });
});
