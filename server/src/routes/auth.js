// server/src/routes/auth.js
const crypto = require("node:crypto");
const { db, getSetting } = require("../db");
const { sendJson, readJsonBody, parseCookies } = require("../utils/http");
const {
  hashPassword,
  verifyPassword,
  unusablePasswordHash,
  createSession,
  destroySession,
  getUserFromRequest,
  attachSessionCookie,
  clearSessionCookie
} = require("../auth");
const { verifyGoogleIdToken } = require("../googleAuth");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public student sign-up needs no code. Teacher accounts can only be created
// by supplying the shared teacher sign-up code — this is what "teacher
// sign-up is passworded" means in practice. Sign-IN (both roles) never
// requires this code; only account *creation* does.
//
// The code itself lives in the `settings` table (see db.js), seeded once
// from TEACHER_SIGNUP_CODE if present, and changeable afterwards from the
// Teacher Dashboard (Settings tab) without editing .env or restarting.
async function teacherCodeValid(suppliedCode) {
  const required = await getSetting("teacher_signup_code", "");
  if (!required) return false; // no code configured => teacher signup disabled
  return typeof suppliedCode === "string" && suppliedCode === required;
}

async function handleRegister(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const fullName = (body.fullName || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const requestedRole = body.role === "TEACHER" ? "TEACHER" : "STUDENT";

  if (!fullName || fullName.length < 2) {
    return sendJson(res, 400, { error: "Please provide your full name." });
  }
  if (!EMAIL_RE.test(email)) {
    return sendJson(res, 400, { error: "Please provide a valid email address." });
  }
  if (!password || password.length < 8) {
    return sendJson(res, 400, { error: "Password must be at least 8 characters." });
  }

  let role = "STUDENT";
  if (requestedRole === "TEACHER") {
    if (!(await teacherCodeValid(body.teacherCode))) {
      return sendJson(res, 403, { error: "Invalid or missing teacher access code." });
    }
    role = "TEACHER";
  }

  const existing = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) {
    return sendJson(res, 409, { error: "An account with this email already exists." });
  }

  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, fullName, email, passwordHash, role, new Date().toISOString());

  const session = await createSession(id);
  attachSessionCookie(res, session.token);
  sendJson(res, 201, { user: { id, fullName, email, role } });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  // Sign-in works identically for both roles — the account's stored role
  // decides where the user lands after login, not anything on this form.
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  const user = await db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return sendJson(res, 401, { error: "Invalid email or password." });
  }

  const session = await createSession(user.id);
  attachSessionCookie(res, session.token);
  sendJson(res, 200, {
    user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
  });
}

// "Sign in / up with Google" — only reachable, and only useful, when the
// server has internet access (to fetch Google's public keys) and
// GOOGLE_CLIENT_ID is configured. If either is missing, this simply fails
// with a clear error and the client falls back to email/password.
async function handleGoogleAuth(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return sendJson(res, 501, { error: "Google sign-in is not configured on this server." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const { credential } = body;
  if (!credential) return sendJson(res, 400, { error: "Missing Google credential." });

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential, clientId);
  } catch (err) {
    return sendJson(res, 401, { error: "Could not verify Google sign-in (are you online?)." });
  }

  if (!payload.email || payload.email_verified === false) {
    return sendJson(res, 401, { error: "Google account has no verified email." });
  }

  const email = String(payload.email).toLowerCase();
  const googleId = payload.sub;
  const fullName = payload.name || email.split("@")[0];

  let user = await db.prepare(`SELECT * FROM users WHERE google_id = ?`).get(googleId);

  if (!user) {
    user = await db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (user) {
      // An account with this email already exists (created via password
      // sign-up) — link it so Google sign-in works going forward.
      await db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(googleId, user.id);
      user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
    } else {
      // Brand-new account via Google. Same rule as normal registration:
      // teacher accounts require a valid teacher access code.
      const requestedRole = body.role === "TEACHER" ? "TEACHER" : "STUDENT";
      let role = "STUDENT";
      if (requestedRole === "TEACHER") {
        if (!(await teacherCodeValid(body.teacherCode))) {
          return sendJson(res, 403, { error: "Invalid or missing teacher access code." });
        }
        role = "TEACHER";
      }
      const id = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO users (id, full_name, email, password_hash, google_id, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, fullName, email, unusablePasswordHash(), googleId, role, new Date().toISOString());
      user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    }
  }

  const session = await createSession(user.id);
  attachSessionCookie(res, session.token);
  sendJson(res, 200, {
    user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
  });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  await destroySession(cookies["session"]);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: "Not authenticated" });
  sendJson(res, 200, {
    user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
  });
}

// Public, non-sensitive client configuration: whether Google sign-in is
// available (needs internet + GOOGLE_CLIENT_ID) and its client ID, plus
// whether teacher self-registration is enabled at all. Never reveals the
// teacher signup code itself.
async function handleConfig(req, res) {
  sendJson(res, 200, {
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    teacherSignupEnabled: !!(await getSetting("teacher_signup_code", ""))
  });
}

module.exports = { handleRegister, handleLogin, handleGoogleAuth, handleLogout, handleMe, handleConfig };
