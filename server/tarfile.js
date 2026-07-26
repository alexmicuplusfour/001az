// Minimal tar (ustar + PAX long names), dependency-free like the rest of the
// server. Backup archives are plain .tar: the originals inside are already
// compressed (webp/jpeg/pdf) and the DB members are gzipped individually, so
// compressing the container again would cost CPU for ~nothing.
//
// Writer: sequential — add entries one at a time, then end(). Sizes must be
// known up front (tar headers lead their payload), which is why backup.js
// spools DB dumps to temp files before archiving them.
// Reader: an async generator over a byte stream; each yielded entry's `body`
// must be fully consumed (or `skip()`ed) before advancing — the generator
// drains any leftovers itself so a lazy caller can't desync the stream.
import { Readable } from "node:stream";

const BLOCK = 512;

// --- numeric fields ---------------------------------------------------------
// Octal fits 8^11-1 (~8 GB); beyond that use GNU base-256 (0x80 + big-endian).
function writeNum(buf, off, len, value) {
  const max = Math.pow(8, len - 1) - 1;
  if (value <= max) {
    buf.write(value.toString(8).padStart(len - 1, "0") + "\0", off, "ascii");
  } else {
    buf[off] = 0x80;
    let v = BigInt(value);
    for (let i = len - 1; i > 0; i--) {
      buf[off + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
}

function readNum(buf, off, len) {
  if (buf[off] & 0x80) {
    let v = 0n;
    for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(buf[off + i]);
    return Number(v);
  }
  const s = buf.toString("ascii", off, off + len).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

// --- header -----------------------------------------------------------------

function makeHeader({ name, size, mtime, type, mode }) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, "utf8");
  writeNum(buf, 100, 8, mode ?? (type === "5" ? 0o755 : 0o644));
  writeNum(buf, 108, 8, 0); // uid
  writeNum(buf, 116, 8, 0); // gid
  writeNum(buf, 124, 12, size);
  writeNum(buf, 136, 12, Math.floor((mtime ?? 0) / 1000));
  buf.write(type, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  // checksum: computed with the field itself as spaces
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

// A name over 100 bytes that can't split into ustar's prefix(155)/name(100)
// fields rides in a preceding PAX 'x' entry as a `path=` record instead.
function fitsUstar(name) {
  return Buffer.byteLength(name, "utf8") <= 100;
}

function paxEntry(name) {
  // record = "<len> path=<name>\n" where len counts the whole record
  const body = `path=${name}\n`;
  let len = Buffer.byteLength(body, "utf8") + 3; // 2-digit guess + space
  let record = `${len} ${body}`;
  while (Buffer.byteLength(record, "utf8") !== len) {
    len = Buffer.byteLength(body, "utf8") + String(len).length + 1;
    record = `${len} ${body}`;
  }
  return Buffer.from(record, "utf8");
}

// --- writer -----------------------------------------------------------------

export class TarWriter {
  constructor(out) {
    this.out = out;
    // fs.WriteStream reports a failed write to the callback AND emits 'error';
    // without a listener that emit is an uncaughtException that kills the
    // process. Remember the first error so later writes surface it too (a
    // destroyed stream would otherwise report the blander ERR_STREAM_DESTROYED).
    this.errored = null;
    out.on("error", (err) => { this.errored ??= err; });
  }

  #write(chunk) {
    return new Promise((resolve, reject) => {
      if (this.errored) return reject(this.errored);
      this.out.write(chunk, (err) => (err ? reject(this.errored ?? err) : resolve()));
    });
  }

  async #header(name, size, type, mtime, mode) {
    if (!fitsUstar(name)) {
      const body = paxEntry(name);
      await this.#write(makeHeader({ name: "PaxHeaders/" + name.slice(-80), size: body.length, mtime, type: "x" }));
      await this.#write(body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad) await this.#write(Buffer.alloc(pad));
      name = name.slice(-100); // fallback name for PAX-unaware readers
    }
    await this.#write(makeHeader({ name, size, mtime, type, mode }));
  }

  async dir(name, { mtime = Date.now() } = {}) {
    await this.#header(name.endsWith("/") ? name : name + "/", 0, "5", mtime);
  }

  // source: a Buffer or a Readable producing exactly `size` bytes.
  async file(name, size, source, { mtime = Date.now(), mode } = {}) {
    await this.#header(name, size, "0", mtime, mode);
    let written = 0;
    if (Buffer.isBuffer(source)) {
      written = source.length;
      await this.#write(source);
    } else {
      for await (const chunk of source) {
        written += chunk.length;
        await this.#write(chunk);
      }
    }
    if (written !== size) throw new Error(`tar: "${name}" wrote ${written} bytes, expected ${size}`);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) await this.#write(Buffer.alloc(pad));
  }

  async end() {
    await this.#write(Buffer.alloc(BLOCK * 2));
    await new Promise((resolve, reject) => this.out.end((err) => (err ? reject(this.errored ?? err) : resolve())));
  }
}

// --- reader -----------------------------------------------------------------

class ByteReader {
  constructor(stream) {
    this.iter = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.avail = 0;
    this.ended = false;
  }

  async #pull() {
    const { value, done } = await this.iter.next();
    if (done) this.ended = true;
    else {
      this.chunks.push(value);
      this.avail += value.length;
    }
  }

  // Exactly n bytes; null on clean EOF at a boundary; throws mid-record.
  async read(n) {
    while (this.avail < n && !this.ended) await this.#pull();
    if (this.avail === 0 && this.ended) return null;
    if (this.avail < n) throw new Error("tar: truncated archive");
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - off);
      head.copy(out, off, 0, take);
      off += take;
      this.avail -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }
}

function parsePax(buf) {
  // "<len> key=value\n" records; we only care about `path`.
  const out = {};
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const len = parseInt(buf.toString("ascii", off, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = buf.toString("utf8", sp + 1, off + len - 1); // strip trailing \n
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    off += len;
  }
  return out;
}

const PAX_MAX = 1024 * 1024; // a path record has no business being bigger

// Yields { name, size, mtime, type, body, skip } where type is "file" or
// "dir"; other entry kinds (symlinks, hardlinks, devices) yield as
// { type: "skip" } so the caller can warn — their bodies are auto-drained.
export async function* readTar(stream) {
  const r = new ByteReader(stream);
  let override = null; // PAX/GNU long name for the next real entry

  for (;;) {
    const header = await r.read(BLOCK);
    if (header === null) return;
    if (header.every((b) => b === 0)) return; // end-of-archive marker

    let name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    const size = readNum(header, 124, 12);
    const mtime = readNum(header, 136, 12) * 1000;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // Metadata entries: consume, remember, continue.
    if (typeflag === "x" || typeflag === "L") {
      if (size > PAX_MAX) throw new Error("tar: oversized metadata entry");
      const body = (await r.read(padded))?.subarray(0, size);
      if (!body) throw new Error("tar: truncated archive");
      override = typeflag === "x" ? parsePax(body).path ?? override : body.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag === "g") { // global PAX header — irrelevant, skip
      if (size > PAX_MAX) throw new Error("tar: oversized metadata entry");
      await r.read(padded);
      continue;
    }

    if (override) {
      name = override;
      override = null;
    }

    const isFile = typeflag === "0" || typeflag === "\0";
    const isDir = typeflag === "5" || (!isFile && name.endsWith("/"));

    let remaining = padded;
    let bodySize = size;
    let pumping = false;
    // Single-flight pump: _read can fire again while an await is pending, and
    // two overlapping ByteReader reads would interleave the stream.
    async function pump(rs) {
      if (pumping) return;
      pumping = true;
      try {
        while (bodySize > 0) {
          const take = Math.min(bodySize, 64 * 1024);
          const chunk = await r.read(take);
          if (!chunk) throw new Error("tar: truncated archive");
          bodySize -= take;
          remaining -= take;
          if (!rs.push(chunk)) break; // backpressure — resume on next _read
        }
        if (bodySize === 0) {
          if (remaining) { await r.read(remaining); remaining = 0; }
          rs.push(null);
        }
      } catch (err) {
        rs.destroy(err);
      } finally {
        pumping = false;
      }
    }
    const body = new Readable({ read() { pump(this); } });
    const skip = async () => {
      if (remaining) await r.read(remaining);
      bodySize = 0;
      remaining = 0;
    };

    yield {
      name,
      size,
      mtime,
      type: isFile ? "file" : isDir ? "dir" : "skip",
      body,
      skip,
    };
    // Whatever the consumer left behind, drain before the next header.
    await skip();
  }
}
