// Mint a one-time login link for an email (creates the user if needed).
// Usage: node server/mintlink.js <email>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, getUserByEmail, createUser, mintPermanentInvite } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";

const email = process.argv[2];
if (!email) {
  console.error("usage: node server/mintlink.js <email>");
  process.exit(1);
}

const db = openDb(DB_PATH);
const user = getUserByEmail(db, email) || createUser(db, email, email.split("@")[0]);
const token = mintPermanentInvite(db, user.id);
console.log(`${BASE_URL}/auth/${token}`);
