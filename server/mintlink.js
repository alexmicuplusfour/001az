// Mint a login link for an email (creates the user if needed).
// Usage: node server/mintlink.js <email>
import { openDb, getUserByEmail, createUser, mintPermanentInvite } from "./db.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://gallery:gallery@127.0.0.1:5433/gallery";
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";

const email = process.argv[2];
if (!email) {
  console.error("usage: node server/mintlink.js <email>");
  process.exit(1);
}

const db = openDb(DATABASE_URL);
const user = (await getUserByEmail(db, email)) || (await createUser(db, email, email.split("@")[0]));
const token = await mintPermanentInvite(db, user.id);
console.log(`${BASE_URL}/auth/${token}`);
await db.end();
