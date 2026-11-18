// server/src/db.js
// Database access layer. Uses libSQL (@libsql/client), which speaks SQLite SQL
// and works in two modes with the exact same code:
//   - Turso (hosted, free tier): set TURSO_DATABASE_URL (libsql://...) and
//     TURSO_AUTH_TOKEN. Data lives in Turso, so it survives host restarts and
//     redeploys (this is what makes free hosting such as Render's free tier
//     safe to use).
//   - Local file (default for development / LAN use): no env needed; a file
//     is created at server/data/assessment.db (override with DB_PATH/DB_DIR).
// The database is the single source of truth for all accounts, tests,
// attempts, answers, and results (never the client / localStorage).

const path = require("node:path");
const fs = require("node:fs");
const { createClient } = require("@libsql/client");

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "assessment.db");

const REMOTE_URL = (process.env.TURSO_DATABASE_URL || "").trim();
const IS_REMOTE = !!REMOTE_URL;

let client;
if (IS_REMOTE) {
  client = createClient({ url: REMOTE_URL, authToken: (process.env.TURSO_AUTH_TOKEN || "").trim() || undefined });
} else {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  client = createClient({ url: `file:${DB_PATH}` });
}

// ---- Tiny async wrapper so the rest of the app can keep writing
//      db.prepare(sql).get/all/run(...args), just with `await`. ----
function clean(args) {
  return args.map((a) => (a === undefined ? null : a));
}

function rowsToObjects(rs) {
  return rs.rows.map((row) => {
    const o = {};
    rs.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

const db = {
  client,
  prepare(sql) {
    return {
      async get(...args) {
        const rs = await client.execute({ sql, args: clean(args) });
        const rows = rowsToObjects(rs);
        return rows.length ? rows[0] : undefined;
      },
      async all(...args) {
        const rs = await client.execute({ sql, args: clean(args) });
        return rowsToObjects(rs);
      },
      async run(...args) {
        const rs = await client.execute({ sql, args: clean(args) });
        return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
      }
    };
  },
  // Runs several statements atomically (all succeed or none are applied).
  // statements: [{ sql, args }]
  async batch(statements) {
    if (!statements.length) return;
    await client.batch(statements.map((s) => ({ sql: s.sql, args: clean(s.args || []) })), "write");
  },
  async exec(sql) {
    await client.executeMultiple(sql);
  }
};

async function migrate() {
  if (!IS_REMOTE) {
    try { await db.exec("PRAGMA journal_mode = WAL;"); } catch { /* not critical */ }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      google_id TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('STUDENT','TEACHER')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      duration_seconds INTEGER NOT NULL,
      questions_per_attempt INTEGER NOT NULL DEFAULT 20,
      subject TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      opens_at TEXT,
      closes_at TEXT
    );

    -- Each test has its own question bank. Each attempt draws a random sample
    -- of questions_per_attempt ACTIVE questions from it (see attempt_questions).
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL REFERENCES tests(id),
      order_index INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('multiple-choice','true-false','short-answer')),
      question TEXT NOT NULL,
      options TEXT,
      correct_answer TEXT NOT NULL,
      model_answer TEXT,
      explanation TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      marks INTEGER NOT NULL,
      review_recommended INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id),
      test_id TEXT NOT NULL REFERENCES tests(id),
      attempt_number INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      submitted_at TEXT,
      submission_type TEXT CHECK(submission_type IN ('MANUAL','AUTO')),
      status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS','SUBMITTED')),
      total_marks INTEGER,
      score INTEGER,
      percentage REAL,
      correct_count INTEGER,
      incorrect_count INTEGER,
      partial_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS attempt_questions (
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      question_id TEXT NOT NULL REFERENCES questions(id),
      order_index INTEGER NOT NULL,
      options_order TEXT,
      PRIMARY KEY (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      question_id TEXT NOT NULL REFERENCES questions(id),
      answer_text TEXT,
      is_correct INTEGER,
      marks_awarded INTEGER,
      grading_method TEXT,
      teacher_override INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(attempt_id, question_id)
    );

    CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_student_test ON attempts(student_id, test_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_attempt_questions_attempt ON attempt_questions(attempt_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_questions_test_active ON questions(test_id, active);

    -- Small key/value store for settings a teacher can change at runtime
    -- (e.g. the teacher sign-up code).
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Forward-migrations for databases created by earlier versions of this app.
  const colsOf = async (table) => (await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name);
  const addCol = async (table, cols, name, ddl) => {
    if (!cols.includes(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  let c = await colsOf("users");
  await addCol("users", c, "google_id", "google_id TEXT");

  c = await colsOf("attempts");
  await addCol("attempts", c, "attempt_number", "attempt_number INTEGER NOT NULL DEFAULT 1");
  await addCol("attempts", c, "total_marks", "total_marks INTEGER");
  await addCol("attempts", c, "partial_count", "partial_count INTEGER NOT NULL DEFAULT 0");

  c = await colsOf("questions");
  await addCol("questions", c, "active", "active INTEGER NOT NULL DEFAULT 1");
  await addCol("questions", c, "model_answer", "model_answer TEXT");

  c = await colsOf("answers");
  await addCol("answers", c, "grading_method", "grading_method TEXT");

  c = await colsOf("tests");
  await addCol("tests", c, "questions_per_attempt", "questions_per_attempt INTEGER NOT NULL DEFAULT 20");
  await addCol("tests", c, "subject", "subject TEXT NOT NULL DEFAULT ''");
  await addCol("tests", c, "class_name", "class_name TEXT NOT NULL DEFAULT ''");
  await addCol("tests", c, "active", "active INTEGER NOT NULL DEFAULT 1");
  await addCol("tests", c, "created_at", "created_at TEXT");
  await addCol("tests", c, "opens_at", "opens_at TEXT");
  await addCol("tests", c, "closes_at", "closes_at TEXT");
}

// Permanently removes a test with its questions (answers, explanations) and
// every attempt / served question / student answer on it - atomically.
async function deleteTestCascade(testId) {
  await db.batch([
    { sql: `DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE test_id = ?)`, args: [testId] },
    { sql: `DELETE FROM attempt_questions WHERE attempt_id IN (SELECT id FROM attempts WHERE test_id = ?)`, args: [testId] },
    { sql: `DELETE FROM attempts WHERE test_id = ?`, args: [testId] },
    { sql: `DELETE FROM questions WHERE test_id = ?`, args: [testId] },
    { sql: `DELETE FROM tests WHERE id = ?`, args: [testId] }
  ]);
}

// v4.1: tests are no longer built in. The old hard-coded "AI Bootcamp
// Assessment" (id "test-1") and everything attached to it is removed, once.
async function purgeLegacyBuiltInTest() {
  const legacy = await db.prepare(`SELECT id FROM tests WHERE id = 'test-1'`).get();
  if (legacy) {
    await deleteTestCascade("test-1");
    console.log("Removed the legacy built-in test and all of its questions, answers and explanations.");
  }
}

// ---- Simple settings key/value helpers ----
async function getSetting(key, fallback = null) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// One-time seed: if TEACHER_SIGNUP_CODE is set and no code exists in the
// database yet, use it as the starting value. After that the database is the
// source of truth (changeable from the dashboard).
async function seedSettings() {
  const existing = await db.prepare(`SELECT value FROM settings WHERE key = 'teacher_signup_code'`).get();
  if (!existing && process.env.TEACHER_SIGNUP_CODE) {
    await setSetting("teacher_signup_code", process.env.TEACHER_SIGNUP_CODE);
  }
}

// The server must `await ready` before it starts accepting requests.
const ready = (async () => {
  await migrate();
  await purgeLegacyBuiltInTest();
  await seedSettings();
})();

module.exports = { db, ready, getSetting, setSetting, deleteTestCascade, IS_REMOTE };
