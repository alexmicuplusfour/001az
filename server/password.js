// Password hashing on Node's built-in scrypt — no native deps. Stored values
// are self-describing (`scrypt$N$r$p$saltB64$hashB64`) so the parameters can
// be raised later without invalidating existing rows: verification always
// runs with the params baked into the stored string.
import crypto from "node:crypto";

export const MIN_PASSWORD_LEN = 8;

const N = 16384, R = 8, P = 1, KEYLEN = 32, SALTLEN = 16;
// Verification honours stored params, so cap them: a corrupted or hostile row
// must not turn one login attempt into a multi-GB scrypt.
const MAXMEM = 64 * 1024 * 1024;

const scrypt = (password, salt, keylen, opts) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  );

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALTLEN);
  const hash = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const n = Number(nStr), r = Number(rStr), p = Number(pStr);
    if (!Number.isInteger(n) || n < 1024 || n > 2 ** 20 || (n & (n - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32) return false;
    if (!Number.isInteger(p) || p < 1 || p > 16) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    if (!salt.length || !expected.length) return false;
    const actual = await scrypt(String(password), salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Burned on login attempts that can't match (unknown email, no password set)
// so their response time is indistinguishable from a wrong password.
let dummyHash = null;
export async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(String(password || ""), dummyHash);
  return false;
}
