// server/src/routes/teacher.js
const crypto = require("node:crypto");
const { db, getSetting, setSetting, deleteTestCascade } = require("../db");
const { sendJson, readJsonBody } = require("../utils/http");
const { buildResultPayload } = require("./student");

function timeUsedSeconds(row) {
  if (!row.submitted_at) return null;
  return Math.max(0, Math.round((new Date(row.submitted_at) - new Date(row.started_at)) / 1000));
}

async function listSubmissions(req, res, user, query) {
  const search = (query.get("search") || "").trim().toLowerCase();
  const testId = query.get("testId") || "";

  let rows = await db.prepare(`
    SELECT a.*, u.full_name, u.email, t.title AS test_title, t.subject AS test_subject, t.class_name AS test_class
    FROM attempts a
    JOIN users u ON u.id = a.student_id
    JOIN tests t ON t.id = a.test_id
    WHERE a.status = 'SUBMITTED' ${testId ? "AND a.test_id = ?" : ""}
    ORDER BY a.submitted_at DESC
  `).all(...(testId ? [testId] : []));

  if (search) {
    rows = rows.filter(
      (r) => r.full_name.toLowerCase().includes(search) || r.email.toLowerCase().includes(search)
    );
  }

  sendJson(res, 200, {
    submissions: rows.map((r) => ({
      attemptId: r.id,
      attemptNumber: r.attempt_number,
      fullName: r.full_name,
      email: r.email,
      testTitle: r.test_title,
      subject: r.test_subject,
      className: r.test_class,
      totalQuestions: (r.correct_count || 0) + (r.incorrect_count || 0) + (r.partial_count || 0),
      score: r.score,
      totalMarks: r.total_marks,
      percentage: r.percentage,
      correctCount: r.correct_count,
      incorrectCount: r.incorrect_count,
      partialCount: r.partial_count,
      submittedAt: r.submitted_at,
      submissionType: r.submission_type,
      timeUsedSeconds: timeUsedSeconds(r)
    }))
  });
}

async function getSubmissionDetail(req, res, user, attemptId) {
  const attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt || attempt.status !== "SUBMITTED") return sendJson(res, 404, { error: "Submission not found" });
  sendJson(res, 200, await buildResultPayload(attempt));
}

async function getStats(req, res, user, query) {
  const testId = (query && query.get("testId")) || "";
  const submissions = await db.prepare(`SELECT * FROM attempts WHERE status = 'SUBMITTED' ${testId ? "AND test_id = ?" : ""}`).all(...(testId ? [testId] : []));

  if (submissions.length === 0) {
    return sendJson(res, 200, {
      totalSubmissions: 0, average: 0, highest: 0, lowest: 0,
      averageTimeSeconds: 0, fastestTimeSeconds: 0, slowestTimeSeconds: 0,
      distribution: { "90-100": 0, "80-89": 0, "70-79": 0, "60-69": 0, "below-60": 0 },
      mostMissed: [],
      studentTimes: []
    });
  }

  const percentages = submissions.map((s) => s.percentage);
  const average = Math.round((percentages.reduce((a, b) => a + b, 0) / percentages.length) * 10) / 10;
  const highest = Math.max(...percentages);
  const lowest = Math.min(...percentages);

  const times = submissions.map(timeUsedSeconds).filter((t) => t !== null);
  const averageTimeSeconds = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const fastestTimeSeconds = times.length ? Math.min(...times) : 0;
  const slowestTimeSeconds = times.length ? Math.max(...times) : 0;

  const distribution = { "90-100": 0, "80-89": 0, "70-79": 0, "60-69": 0, "below-60": 0 };
  for (const p of percentages) {
    if (p >= 90) distribution["90-100"]++;
    else if (p >= 80) distribution["80-89"]++;
    else if (p >= 70) distribution["70-79"]++;
    else if (p >= 60) distribution["60-69"]++;
    else distribution["below-60"]++;
  }

  const missedRows = await db.prepare(`
    SELECT q.id AS question_id, q.order_index, q.question,
           COUNT(an.id) AS total,
           SUM(CASE WHEN an.is_correct = 1 THEN 0 ELSE 1 END) AS incorrect
    FROM answers an
    JOIN questions q ON q.id = an.question_id
    JOIN attempts at ON at.id = an.attempt_id
    WHERE at.status = 'SUBMITTED' ${testId ? "AND q.test_id = ?" : ""}
    GROUP BY q.id, q.order_index, q.question
  `).all(...(testId ? [testId] : []));
  const mostMissed = missedRows.map((r) => {
    const total = r.total || 0;
    const incorrectPct = total > 0 ? Math.round(((r.incorrect || 0) / total) * 1000) / 10 : 0;
    return { questionId: r.question_id, order: r.order_index, question: r.question, incorrectPercentage: incorrectPct, totalAnswered: total };
  }).filter((q) => q.totalAnswered > 0).sort((a, b) => b.incorrectPercentage - a.incorrectPercentage).slice(0, 5);

  // Per-student time spent, so a teacher can see everyone's timing at a glance
  // alongside the class average computed above.
  const rows = await db.prepare(`
    SELECT a.*, u.full_name, u.email
    FROM attempts a JOIN users u ON u.id = a.student_id
    WHERE a.status = 'SUBMITTED' ${testId ? "AND a.test_id = ?" : ""}
    ORDER BY a.submitted_at DESC
  `).all(...(testId ? [testId] : []));
  const studentTimes = rows.map((r) => ({
    fullName: r.full_name,
    email: r.email,
    attemptNumber: r.attempt_number,
    timeUsedSeconds: timeUsedSeconds(r),
    percentage: r.percentage,
    submittedAt: r.submitted_at
  }));

  sendJson(res, 200, {
    totalSubmissions: submissions.length,
    average, highest, lowest,
    averageTimeSeconds, fastestTimeSeconds, slowestTimeSeconds,
    distribution, mostMissed, studentTimes
  });
}

async function exportCsv(req, res, user, query) {
  const testId = (query && query.get("testId")) || "";
  const rows = await db.prepare(`
    SELECT a.*, u.full_name, u.email, t.title AS test_title, t.subject AS test_subject, t.class_name AS test_class
    FROM attempts a
    JOIN users u ON u.id = a.student_id
    JOIN tests t ON t.id = a.test_id
    WHERE a.status = 'SUBMITTED' ${testId ? "AND a.test_id = ?" : ""}
    ORDER BY a.submitted_at DESC
  `).all(...(testId ? [testId] : []));

  const header = ["Full Name", "Email", "Subject", "Class", "Test", "Attempt #", "Score", "Total Marks", "Percentage", "Correct", "Partial", "Incorrect", "Time Used (s)", "Submitted At", "Submission Type"];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(",")];
  for (const r of rows) {
    lines.push([
      r.full_name, r.email, r.test_subject, r.test_class, r.test_title, r.attempt_number, r.score, r.total_marks, `${r.percentage}%`,
      r.correct_count, r.partial_count, r.incorrect_count, timeUsedSeconds(r), r.submitted_at, r.submission_type
    ].map(escape).join(","));
  }
  const csv = lines.join("\r\n");

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="assessment-results.csv"`,
    "Content-Length": Buffer.byteLength(csv)
  });
  res.end(csv);
}

async function overrideScore(req, res, user, attemptId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const { questionId, isCorrect, marksAwarded } = body;
  const attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt || attempt.status !== "SUBMITTED") return sendJson(res, 404, { error: "Submission not found" });

  const question = await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId);
  if (!question) return sendJson(res, 404, { error: "Question not found" });

  const clampedMarks = Math.max(0, Math.min(question.marks, Number(marksAwarded)));

  await db.prepare(`
    INSERT INTO answers (id, attempt_id, question_id, answer_text, is_correct, marks_awarded, teacher_override, updated_at)
    VALUES (?, ?, ?, COALESCE((SELECT answer_text FROM answers WHERE attempt_id = ? AND question_id = ?), ''), ?, ?, 1, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET
      is_correct = excluded.is_correct, marks_awarded = excluded.marks_awarded,
      teacher_override = 1, updated_at = excluded.updated_at
  `).run(`${attemptId}-${questionId}`, attemptId, questionId, attemptId, questionId, isCorrect ? 1 : 0, clampedMarks, new Date().toISOString());

  // Recompute attempt totals from the (now-overridden) answers, joined
  // against each question's max marks to classify correct/partial/incorrect.
  const answers = await db.prepare(`
    SELECT an.*, q.marks AS question_marks FROM answers an
    JOIN questions q ON q.id = an.question_id
    WHERE an.attempt_id = ?
  `).all(attemptId);
  const score = answers.reduce((sum, a) => sum + (a.marks_awarded || 0), 0);
  const correctCount = answers.filter((a) => (a.marks_awarded || 0) >= a.question_marks).length;
  const incorrectCount = answers.filter((a) => !(a.marks_awarded || 0)).length;
  const partialCount = answers.length - correctCount - incorrectCount;
  const totalMarks = attempt.total_marks;
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 1000) / 10 : 0;

  await db.prepare(`UPDATE attempts SET score = ?, percentage = ?, correct_count = ?, incorrect_count = ?, partial_count = ? WHERE id = ?`)
    .run(score, percentage, correctCount, incorrectCount, partialCount, attemptId);

  sendJson(res, 200, { ok: true, score, percentage, correctCount, incorrectCount, partialCount });
}

// ---- Tests (admin can create any number; each has its own subject, class,
// duration, questions-per-attempt and question bank) ----

async function serializeTest(t) {
  const counts = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM questions WHERE test_id = ?`).get(t.id);
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    subject: t.subject || "",
    className: t.class_name || "",
    durationSeconds: t.duration_seconds,
    questionsPerAttempt: t.questions_per_attempt,
    active: !!t.active,
    opensAt: t.opens_at || null,
    closesAt: t.closes_at || null,
    totalQuestions: counts.total,
    activeBankCount: counts.active
  };
}

async function listTests(req, res, user) {
  const tests = await db.prepare(`SELECT * FROM tests ORDER BY subject COLLATE NOCASE, class_name COLLATE NOCASE, title COLLATE NOCASE`).all();
  sendJson(res, 200, { tests: await Promise.all(tests.map(serializeTest)) });
}

// Validates the editable properties of a test. `existing` is null on create.
function parseTestInput(body, existing) {
  const out = {};
  const title = body.title !== undefined ? String(body.title).trim() : existing ? existing.title : "";
  if (!title) return { error: "Test title is required." };
  out.title = title;

  const subject = body.subject !== undefined ? String(body.subject).trim() : existing ? existing.subject : "";
  if (!subject) return { error: "Subject is required." };
  out.subject = subject;

  const className = body.className !== undefined ? String(body.className).trim() : existing ? existing.class_name : "";
  if (!className) return { error: "Class is required." };
  out.className = className;

  out.description = body.description !== undefined ? String(body.description) : existing ? existing.description || "" : "";

  let durationSeconds = existing ? existing.duration_seconds : 30 * 60;
  if (body.durationSeconds !== undefined) {
    const n = Number(body.durationSeconds);
    if (!Number.isFinite(n) || n < 60) return { error: "durationSeconds must be at least 60." };
    durationSeconds = Math.round(n);
  } else if (body.durationMinutes !== undefined) {
    const n = Number(body.durationMinutes);
    if (!Number.isFinite(n) || n < 1) return { error: "Time limit must be at least 1 minute." };
    durationSeconds = Math.round(n * 60);
  }
  out.durationSeconds = durationSeconds;

  let questionsPerAttempt = existing ? existing.questions_per_attempt : 20;
  if (body.questionsPerAttempt !== undefined) {
    const n = Number(body.questionsPerAttempt);
    if (!Number.isInteger(n) || n < 1) return { error: "Number of questions must be a positive whole number." };
    questionsPerAttempt = n;
  }
  out.questionsPerAttempt = questionsPerAttempt;

  // Optional availability window (ISO timestamps; null / "" clears it).
  const readDate = (key, current) => {
    if (body[key] === undefined) return { value: current || null };
    if (body[key] === null || body[key] === "") return { value: null };
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) return { error: `${key} is not a valid date/time.` };
    return { value: d.toISOString() };
  };
  const o = readDate("opensAt", existing && existing.opens_at);
  if (o.error) return { error: o.error };
  const c = readDate("closesAt", existing && existing.closes_at);
  if (c.error) return { error: c.error };
  if (o.value && c.value && new Date(c.value) <= new Date(o.value)) return { error: "The closing time must be after the opening time." };
  out.opensAt = o.value;
  out.closesAt = c.value;

  out.active = body.active !== undefined ? (body.active ? 1 : 0) : existing ? existing.active : 1;
  return out;
}

async function createTest(req, res, user) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid request body" }); }
  const p = parseTestInput(body || {}, null);
  if (p.error) return sendJson(res, 400, { error: p.error });
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO tests (id, title, description, duration_seconds, questions_per_attempt, subject, class_name, active, created_at, opens_at, closes_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, p.title, p.description, p.durationSeconds, p.questionsPerAttempt, p.subject, p.className, p.active, new Date().toISOString(), p.opensAt, p.closesAt);
  sendJson(res, 201, { test: await serializeTest(await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(id)) });
}

async function updateTest(req, res, user, testId) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid request body" }); }
  const existing = await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(testId);
  if (!existing) return sendJson(res, 404, { error: "Test not found." });
  const p = parseTestInput(body || {}, existing);
  if (p.error) return sendJson(res, 400, { error: p.error });
  await db.prepare(`
    UPDATE tests SET title = ?, description = ?, duration_seconds = ?, questions_per_attempt = ?, subject = ?, class_name = ?, active = ?, opens_at = ?, closes_at = ?
    WHERE id = ?
  `).run(p.title, p.description, p.durationSeconds, p.questionsPerAttempt, p.subject, p.className, p.active, p.opensAt, p.closesAt, testId);
  sendJson(res, 200, { test: await serializeTest(await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(testId)) });
}

// Permanently removes a test together with its questions (answers,
// explanations), and every attempt/answer students made on it.
async function deleteTest(req, res, user, testId) {
  const existing = await db.prepare(`SELECT id FROM tests WHERE id = ?`).get(testId);
  if (!existing) return sendJson(res, 404, { error: "Test not found." });
  await deleteTestCascade(testId);
  sendJson(res, 200, { ok: true });
}

// ---- Teacher sign-up code ----
// Lets a teacher rotate the shared code required to create new TEACHER
// accounts, without editing .env or restarting the server. Showing the
// current code back is safe here because only authenticated teachers can
// reach this endpoint in the first place.
async function getSignupCode(req, res, user) {
  const code = await getSetting("teacher_signup_code", "");
  sendJson(res, 200, { code, enabled: !!code });
}

async function updateSignupCode(req, res, user) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }
  const code = String(body.code || "").trim();
  if (code.length < 6) return sendJson(res, 400, { error: "Sign-up code must be at least 6 characters." });
  await setSetting("teacher_signup_code", code);
  sendJson(res, 200, { ok: true, code });
}

// ---- Question bank management ----

function serializeQuestion(q) {
  const parsedCorrect = JSON.parse(q.correct_answer);
  return {
    id: q.id,
    order: q.order_index,
    type: q.type,
    question: q.question,
    options: q.options ? JSON.parse(q.options) : null,
    correctAnswer: parsedCorrect,
    explanation: q.explanation,
    reasoning: q.reasoning,
    marks: q.marks,
    reviewRecommended: !!q.review_recommended,
    active: !!q.active
  };
}

async function listQuestions(req, res, user, testId) {
  const test = await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(testId);
  if (!test) return sendJson(res, 404, { error: "Test not found." });
  const questions = await db.prepare(`SELECT * FROM questions WHERE test_id = ? ORDER BY order_index`).all(test.id);
  sendJson(res, 200, { questions: questions.map(serializeQuestion) });
}

function validateQuestionInput(body) {
  const type = body.type;
  if (!["multiple-choice", "true-false"].includes(type)) {
    return { error: "type must be multiple-choice or true-false (theory/short-answer questions are no longer supported)." };
  }
  const question = (body.question || "").trim();
  if (!question) return { error: "question text is required." };
  const explanation = (body.explanation || "").trim();
  const reasoning = (body.reasoning || "").trim();
  const marks = body.marks === undefined || body.marks === null || body.marks === "" ? 1 : Number(body.marks);
  if (!Number.isInteger(marks) || marks < 1) return { error: "marks must be a positive integer." };

  let options = null;
  let correctAnswerStored;
  let modelAnswer = null;

  if (type === "multiple-choice" || type === "true-false") {
    options = type === "true-false" ? ["True", "False"] : Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (type === "multiple-choice" && options.length < 2) return { error: "multiple-choice questions need at least 2 options." };
    const correctAnswer = String(body.correctAnswer || "").trim();
    if (!options.includes(correctAnswer)) return { error: "correctAnswer must match one of the provided options exactly." };
    correctAnswerStored = correctAnswer;
  }

  return {
    type, question, explanation, reasoning, marks, options, correctAnswerStored, modelAnswer,
    reviewRecommended: !!body.reviewRecommended
  };
}

async function addQuestion(req, res, user, testId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const parsed = validateQuestionInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  const test = await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(testId);
  if (!test) return sendJson(res, 404, { error: "Test not found." });
  const maxOrder = (await db.prepare(`SELECT COALESCE(MAX(order_index), 0) as m FROM questions WHERE test_id = ?`).get(test.id)).m;
  const id = crypto.randomUUID();

  await db.prepare(`
    INSERT INTO questions (id, test_id, order_index, type, question, options, correct_answer, model_answer, explanation, reasoning, marks, review_recommended, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, test.id, maxOrder + 1, parsed.type, parsed.question,
    parsed.options ? JSON.stringify(parsed.options) : null,
    JSON.stringify(parsed.correctAnswerStored), parsed.modelAnswer,
    parsed.explanation, parsed.reasoning, parsed.marks, parsed.reviewRecommended ? 1 : 0
  );

  const q = await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(id);
  sendJson(res, 201, { question: serializeQuestion(q) });
}

// Adds many questions in one call — used by both the "keep adding rows in
// the modal" flow and the "paste JSON" bulk-import flow on the client. Each
// item is validated independently with the exact same rules as a single
// addQuestion call, so one bad item never blocks the good ones: valid
// questions are inserted and invalid ones come back in `errors` (with their
// original index) so the teacher can fix just those.
//
// Accepts items shaped either the way the Add-Question form sends them
// (acceptedFragments as an array for short-answer) OR the way
// questions.seed.js itself writes them (correctAnswer as an array for
// short-answer) — the latter is what makes "paste the bank in seed format"
// work without asking the teacher to rename fields.
async function bulkAddQuestions(req, res, user, testId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const items = Array.isArray(body.questions) ? body.questions : null;
  if (!items || items.length === 0) {
    return sendJson(res, 400, { error: "questions must be a non-empty array." });
  }
  if (items.length > 300) {
    return sendJson(res, 400, { error: "Please import at most 300 questions at a time." });
  }

  const test = await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(testId);
  if (!test) return sendJson(res, 404, { error: "Test not found." });
  let maxOrder = (await db.prepare(`SELECT COALESCE(MAX(order_index), 0) as m FROM questions WHERE test_id = ?`).get(test.id)).m;

  const insertSql = `
    INSERT INTO questions (id, test_id, order_index, type, question, options, correct_answer, model_answer, explanation, reasoning, marks, review_recommended, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `;
  const statements = [];

  const addedIds = [];
  const errors = [];

  items.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      errors.push({ index, question: "(not an object)", error: "Each item must be an object." });
      return;
    }
    const normalized = { ...raw };

    const parsed = validateQuestionInput(normalized);
    if (parsed.error) {
      errors.push({ index, question: (raw.question || "(untitled)").toString().slice(0, 60), error: parsed.error });
      return;
    }

    maxOrder += 1;
    const id = crypto.randomUUID();
    statements.push({
      sql: insertSql,
      args: [
        id, test.id, maxOrder, parsed.type, parsed.question,
        parsed.options ? JSON.stringify(parsed.options) : null,
        JSON.stringify(parsed.correctAnswerStored), parsed.modelAnswer,
        parsed.explanation, parsed.reasoning, parsed.marks, parsed.reviewRecommended ? 1 : 0
      ]
    });
    addedIds.push(id);
  });

  await db.batch(statements); // one round trip for the whole import

  sendJson(res, 200, { addedCount: addedIds.length, errorCount: errors.length, errors });
}

async function updateQuestion(req, res, user, questionId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const existing = await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId);
  if (!existing) return sendJson(res, 404, { error: "Question not found." });

  // Allow a lightweight "just toggle active" update without re-validating
  // the full question body.
  if (Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, "active")) {
    await db.prepare(`UPDATE questions SET active = ? WHERE id = ?`).run(body.active ? 1 : 0, questionId);
    return sendJson(res, 200, { question: serializeQuestion(await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId)) });
  }

  const parsed = validateQuestionInput({ ...existing, ...body, type: body.type || existing.type });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  await db.prepare(`
    UPDATE questions SET type = ?, question = ?, options = ?, correct_answer = ?, model_answer = ?,
      explanation = ?, reasoning = ?, marks = ?, review_recommended = ?, active = ?
    WHERE id = ?
  `).run(
    parsed.type, parsed.question, parsed.options ? JSON.stringify(parsed.options) : null,
    JSON.stringify(parsed.correctAnswerStored), parsed.modelAnswer,
    parsed.explanation, parsed.reasoning, parsed.marks, parsed.reviewRecommended ? 1 : 0,
    body.active !== undefined ? (body.active ? 1 : 0) : existing.active,
    questionId
  );

  sendJson(res, 200, { question: serializeQuestion(await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId)) });
}

// Deleting is a soft-delete (active = 0): past attempts that already served
// this question keep referencing it (for review/history), it's just excluded
// from future random selection.
async function deleteQuestion(req, res, user, questionId) {
  const existing = await db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId);
  if (!existing) return sendJson(res, 404, { error: "Question not found." });
  await db.prepare(`UPDATE questions SET active = 0 WHERE id = ?`).run(questionId);
  sendJson(res, 200, { ok: true });
}

module.exports = {
  listSubmissions, getSubmissionDetail, getStats, exportCsv, overrideScore,
  listTests, createTest, updateTest, deleteTest,
  getSignupCode, updateSignupCode,
  listQuestions, addQuestion, bulkAddQuestions, updateQuestion, deleteQuestion
};
