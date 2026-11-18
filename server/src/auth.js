// server/src/auth.js
// Password hashing (scrypt, built into node:crypto — passwords are never stored
// in plain text) and cookie-based session management. No external deps.

const crypto = require("node:crypto");
const { db } = require("./db");
const { parseCookies, setCookie } = require("./utils/http");

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// Used for accounts created via "Sign in with Google" that never set a
// password: stores an unguessable, unusable hash so password login always
// fails for that account rather than the column being left in an odd state.
function unusablePasswordHash() {
  return hashPassword(crypto.randomBytes(32).toString("hex"));
}

function verifyPassword(password, stored) {
  if (!stored) return false; // e.g. a Google-only account with no password set
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires };
}

// Short-lived in-memory cache so every API call doesn't re-query session + user.
const userCache = new Map();
const USER_CACHE_MS = 15000;

async function destroySession(token) {
  if (!token) return;
  userCache.delete(token);
  await db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies["session"];
  if (!token) return null;
  const hit = userCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const session = await db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await destroySession(token);
    return null;
  }
  const user = await db.prepare(`SELECT id, full_name, email, role FROM users WHERE id = ?`).get(session.user_id);
  if (user) {
    if (userCache.size > 500) userCache.clear();
    userCache.set(token, { user, until: Date.now() + USER_CACHE_MS });
  }
  return user || null;
}

function attachSessionCookie(res, token) {
  setCookie(res, "session", token, { maxAgeSeconds: SESSION_TTL_SECONDS });
}

function clearSessionCookie(res) {
  setCookie(res, "session", "", { expirePast: true });
}

module.exports = {
  hashPassword,
  verifyPassword,
  unusablePasswordHash,
  createSession,
  destroySession,
  getUserFromRequest,
  attachSessionCookie,
  clearSessionCookie
};
