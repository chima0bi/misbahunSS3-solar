// server/src/routes/student.js
const crypto = require("node:crypto");
const { db } = require("../db");
const { sendJson, readJsonBody } = require("../utils/http");
const { gradeAttempt } = require("../grading");
const { buildAttemptQuestions } = require("../attemptQuestions");

/**
 * The single source of truth for "is this attempt still valid" is the server
 * clock compared against the stored expiresAt — never the browser timer.
 * If an IN_PROGRESS attempt has passed its expiry, we auto-submit it right here,
 * lazily, whenever the server next touches it (on a GET, an answer save, or a
 * submit call). This guarantees a student can never keep an expired attempt
 * "open" just by not calling submit.
 */
// Optional availability window: a test may have opens_at / closes_at. Both are
// optional; with neither set the test is available any time. An attempt ends
// at the EARLIER of its own time limit and the moment the window closes, and
// the window is re-read from the test each time, so closing it (or editing
// closes_at) auto-submits any attempt still in progress.
function windowState(test, now = Date.now()) {
  const opens = test.opens_at ? new Date(test.opens_at).getTime() : null;
  const closes = test.closes_at ? new Date(test.closes_at).getTime() : null;
  let state = "open";
  if (opens !== null && now < opens) state = "not_open";
  else if (closes !== null && now >= closes) state = "closed";
  return { state, opensAt: test.opens_at || null, closesAt: test.closes_at || null };
}

async function effectiveExpiry(attempt) {
  const test = await db.prepare(`SELECT closes_at FROM tests WHERE id = ?`).get(attempt.test_id);
  let t = new Date(attempt.expires_at).getTime();
  if (test && test.closes_at) t = Math.min(t, new Date(test.closes_at).getTime());
  return new Date(t).toISOString();
}

function windowMessage(w) {
  const fmt = (iso) => new Date(iso).toUTCString();
  if (w.state === "not_open") return `This test opens on ${fmt(w.opensAt)}.`;
  if (w.state === "closed") return `This test closed on ${fmt(w.closesAt)}.`;
  return "";
}

async function ensureNotExpired(attempt) {
  if (attempt.status !== "IN_PROGRESS") return attempt;
  const isExpired = new Date(await effectiveExpiry(attempt)).getTime() <= Date.now();
  if (!isExpired) return attempt;
  return finalizeAttempt(attempt, "AUTO");
}

async function finalizeAttempt(attempt, submissionType) {
  const result = await gradeAttempt(attempt.id);
  await db.prepare(`
    UPDATE attempts SET status = 'SUBMITTED', submitted_at = ?, submission_type = ?,
      total_marks = ?, score = ?, percentage = ?, correct_count = ?, incorrect_count = ?, partial_count = ?
    WHERE id = ? AND status = 'IN_PROGRESS'
  `).run(
    new Date().toISOString(), submissionType,
    result.totalMarks, result.score, result.percentage, result.correctCount, result.incorrectCount, result.partialCount,
    attempt.id
  );
  return await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attempt.id);
}

async function getLatestAttempt(studentId, testId) {
  return await db.prepare(`
    SELECT * FROM attempts WHERE student_id = ? AND test_id = ?
    ORDER BY started_at DESC LIMIT 1
  `).get(studentId, testId);
}

// Returns the question rows selected for this attempt, in shuffled order,
// with each question's `options` overridden to that attempt's shuffled order.
async function getAttemptQuestions(attemptId) {
  const rows = await db.prepare(`
    SELECT q.*, aq.order_index AS attempt_order, aq.options_order AS attempt_options_order
    FROM attempt_questions aq
    JOIN questions q ON q.id = aq.question_id
    WHERE aq.attempt_id = ?
    ORDER BY aq.order_index
  `).all(attemptId);
  return rows.map((q) => ({
    ...q,
    options: q.attempt_options_order || q.options
  }));
}

function publicQuestion(q) {
  return {
    id: q.id,
    order: q.attempt_order,
    type: q.type,
    question: q.question,
    options: q.options ? JSON.parse(q.options) : null,
    marks: q.marks
  };
}

async function activeBankCount(testId) {
  return (await db.prepare(`SELECT COUNT(*) as c FROM questions WHERE test_id = ? AND active = 1`).get(testId)).c;
}

async function publicTest(test) {
  return {
    id: test.id,
    title: test.title,
    description: test.description,
    subject: test.subject,
    className: test.class_name,
    durationSeconds: test.duration_seconds,
    questionCount: Math.min(test.questions_per_attempt, await activeBankCount(test.id)),
    window: windowState(test)
  };
}

async function statusFor(userId, test) {
  const existing = await getLatestAttempt(userId, test.id);
  return {
    attemptStatus: existing ? existing.status : "NOT_STARTED",
    canRetake: !!existing && existing.status === "SUBMITTED",
    attemptNumber: existing ? existing.attempt_number : 0,
    lastScore: existing && existing.status === "SUBMITTED"
      ? {
          score: existing.score, totalMarks: existing.total_marks, percentage: existing.percentage,
          correctCount: existing.correct_count, totalQuestions: (existing.correct_count || 0) + (existing.incorrect_count || 0) + (existing.partial_count || 0),
          attemptId: existing.id
        }
      : null
  };
}

async function getActiveTest(testId) {
  if (!testId) return null;
  return await db.prepare(`SELECT * FROM tests WHERE id = ? AND active = 1`).get(testId);
}

function queryParam(req, name) {
  try { return new URL(req.url, "http://localhost").searchParams.get(name); } catch { return null; }
}

// Lists every published test (with this student's status on each) so the
// dashboard can offer subject -> class -> test selection.
async function handleListTests(req, res, user) {
  const tests = await db.prepare(`SELECT * FROM tests WHERE active = 1 ORDER BY subject COLLATE NOCASE, class_name COLLATE NOCASE, title COLLATE NOCASE`).all();
  const result = [];
  for (const t of tests) {
    if ((await activeBankCount(t.id)) === 0) continue;
    result.push({ ...(await publicTest(t)), ...(await statusFor(user.id, t)) });
  }
  sendJson(res, 200, { tests: result });
}

async function handleGetTest(req, res, user) {
  const test = await getActiveTest(queryParam(req, "testId"));
  if (!test) return sendJson(res, 404, { error: "Test not found." });
  sendJson(res, 200, { test: await publicTest(test), ...(await statusFor(user.id, test)) });
}

async function createFreshAttempt(user, test, attemptNumber) {
  const now = new Date();
  let expiresMs = now.getTime() + test.duration_seconds * 1000;
  if (test.closes_at) expiresMs = Math.min(expiresMs, new Date(test.closes_at).getTime());
  const expires = new Date(expiresMs);
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO attempts (id, student_id, test_id, attempt_number, started_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS')
  `).run(id, user.id, test.id, attemptNumber, now.toISOString(), expires.toISOString());

  const { totalMarks } = await buildAttemptQuestions(id, test.id, test.questions_per_attempt);
  await db.prepare(`UPDATE attempts SET total_marks = ? WHERE id = ?`).run(totalMarks, id);

  return await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id);
}

async function readTestFromBody(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: "Invalid request body" }); return null; }
  const test = await getActiveTest(body && body.testId);
  if (!test) { sendJson(res, 404, { error: "Test not found." }); return null; }
  const w = windowState(test);
  if (w.state !== "open") { sendJson(res, 403, { error: windowMessage(w), window: w }); return null; }
  if (await activeBankCount(test.id) === 0) { sendJson(res, 400, { error: "This test has no questions yet." }); return null; }
  return test;
}

async function handleStartAttempt(req, res, user) {
  const test = await readTestFromBody(req, res);
  if (!test) return;
  const existing = await getLatestAttempt(user.id, test.id);

  if (existing) {
    // Idempotent for an in-progress attempt: clicking Start again never
    // resets the timer or reshuffles questions mid-attempt.
    const checked = await ensureNotExpired(existing);
    if (checked.status === "IN_PROGRESS") {
      return sendJson(res, 200, { attempt: await serializeAttempt(checked) });
    }
    // A previous attempt exists but is SUBMITTED — Start shouldn't normally
    // be reachable here (the client should show Retake instead), but if it
    // is, just surface the submitted attempt rather than silently retaking.
    return sendJson(res, 200, { attempt: await serializeAttempt(checked) });
  }

  const attempt = await createFreshAttempt(user, test, 1);
  sendJson(res, 201, { attempt: await serializeAttempt(attempt) });
}

// Student-initiated reset: "unlimited tries after resetting their score
// themselves". Only allowed once the current attempt is SUBMITTED. Creates a
// brand-new attempt with a freshly sampled, freshly shuffled question set
// (rotating in any newly-added bank questions and dropping others, capped at
// the teacher's configured questions-per-attempt) — the prior attempt's
// history and score are kept intact for the teacher's records.
async function handleRetakeAttempt(req, res, user) {
  const test = await readTestFromBody(req, res);
  if (!test) return;
  const existing = await getLatestAttempt(user.id, test.id);
  const checked = existing ? await ensureNotExpired(existing) : null;

  if (checked && checked.status === "IN_PROGRESS") {
    return sendJson(res, 409, { error: "You already have a test in progress.", attempt: await serializeAttempt(checked) });
  }

  const nextAttemptNumber = checked ? checked.attempt_number + 1 : 1;
  const attempt = await createFreshAttempt(user, test, nextAttemptNumber);
  sendJson(res, 201, { attempt: await serializeAttempt(attempt) });
}

async function serializeAttempt(attempt) {
  return {
    id: attempt.id,
    testId: attempt.test_id,
    attemptNumber: attempt.attempt_number,
    status: attempt.status,
    startedAt: attempt.started_at,
    expiresAt: await effectiveExpiry(attempt),
    submittedAt: attempt.submitted_at,
    submissionType: attempt.submission_type,
    serverNow: new Date().toISOString(),
    totalMarks: attempt.total_marks,
    score: attempt.score,
    percentage: attempt.percentage
  };
}

async function handleGetCurrentAttempt(req, res, user) {
  const testId = queryParam(req, "testId");
  let attempt = testId
    ? await getLatestAttempt(user.id, testId)
    : await db.prepare(`SELECT * FROM attempts WHERE student_id = ? ORDER BY started_at DESC LIMIT 1`).get(user.id);
  if (!attempt) return sendJson(res, 404, { error: "No attempt started yet." });

  attempt = await ensureNotExpired(attempt);

  const questions = await getAttemptQuestions(attempt.id);
  const answers = await db.prepare(`SELECT question_id, answer_text FROM answers WHERE attempt_id = ?`).all(attempt.id);
  const answerMap = Object.fromEntries(answers.map((a) => [a.question_id, a.answer_text]));

  sendJson(res, 200, {
    attempt: await serializeAttempt(attempt),
    questions: questions.map(publicQuestion),
    answers: answerMap
  });
}

async function handleSaveAnswer(req, res, user, attemptId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  let attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt || attempt.student_id !== user.id) return sendJson(res, 404, { error: "Attempt not found" });

  attempt = await ensureNotExpired(attempt);
  if (attempt.status !== "IN_PROGRESS") {
    return sendJson(res, 409, { error: "This attempt is no longer active.", attempt: await serializeAttempt(attempt) });
  }

  const { questionId, answerText } = body;
  if (!questionId) return sendJson(res, 400, { error: "questionId is required" });

  // Only questions actually served in THIS attempt (per attempt_questions)
  // may be answered — prevents answering bank questions outside the sample.
  const question = await db.prepare(`
    SELECT q.* FROM attempt_questions aq
    JOIN questions q ON q.id = aq.question_id
    WHERE aq.attempt_id = ? AND q.id = ?
  `).get(attempt.id, questionId);
  if (!question) return sendJson(res, 404, { error: "Question not found in this attempt" });

  const id = `${attempt.id}-${questionId}`;
  await db.prepare(`
    INSERT INTO answers (id, attempt_id, question_id, answer_text, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET answer_text = excluded.answer_text, updated_at = excluded.updated_at
    WHERE answers.teacher_override = 0
  `).run(id, attempt.id, questionId, answerText || "", new Date().toISOString());

  sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
}

async function handleSubmitAttempt(req, res, user, attemptId) {
  let attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt || attempt.student_id !== user.id) return sendJson(res, 404, { error: "Attempt not found" });

  // Idempotency guard: if it's already submitted (by an earlier request, a
  // double-click, or the auto-submit path), just return the existing result —
  // never create a duplicate submission or re-grade over a teacher override.
  attempt = await ensureNotExpired(attempt);
  if (attempt.status === "SUBMITTED") {
    return sendJson(res, 200, { attempt: await serializeAttempt(attempt) });
  }

  const updated = await finalizeAttempt(attempt, "MANUAL");
  sendJson(res, 200, { attempt: await serializeAttempt(updated) });
}

async function buildResultPayload(attempt) {
  const test = await db.prepare(`SELECT * FROM tests WHERE id = ?`).get(attempt.test_id);
  const questions = await getAttemptQuestions(attempt.id);
  const answers = await db.prepare(`SELECT * FROM answers WHERE attempt_id = ?`).all(attempt.id);
  const answerByQuestion = Object.fromEntries(answers.map((a) => [a.question_id, a]));

  const student = await db.prepare(`SELECT full_name, email FROM users WHERE id = ?`).get(attempt.student_id);

  const timeUsedSeconds = attempt.submitted_at
    ? Math.max(0, Math.round((new Date(attempt.submitted_at) - new Date(attempt.started_at)) / 1000))
    : null;

  const review = questions.map((q) => {
    const a = answerByQuestion[q.id];
    const marksAwarded = a ? a.marks_awarded : 0;
    const status = !a || marksAwarded === 0 ? "incorrect" : marksAwarded >= q.marks ? "correct" : "partial";
    return {
      id: q.id,
      order: q.attempt_order,
      type: q.type,
      question: q.question,
      options: q.options ? JSON.parse(q.options) : null,
      yourAnswer: a ? a.answer_text : "",
      correctAnswer: q.type === "short-answer" ? null : JSON.parse(q.correct_answer),
      modelAnswer: q.type === "short-answer" ? q.model_answer : null,
      status,
      isCorrect: status === "correct",
      marksAwarded,
      marks: q.marks,
      explanation: q.explanation,
      reasoning: q.reasoning,
      teacherOverride: a ? !!a.teacher_override : false,
      reviewRecommended: !!q.review_recommended
    };
  });

  return {
    student: { fullName: student.full_name, email: student.email },
    test: { id: test.id, title: test.title, subject: test.subject, className: test.class_name },
    attempt: {
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at,
      submissionType: attempt.submission_type,
      totalMarks: attempt.total_marks,
      score: attempt.score,
      percentage: attempt.percentage,
      correctCount: attempt.correct_count,
      incorrectCount: attempt.incorrect_count,
      partialCount: attempt.partial_count,
      totalQuestions: review.length,
      timeUsedSeconds
    },
    review
  };
}

async function handleGetResult(req, res, user, attemptId) {
  let attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt || attempt.student_id !== user.id) return sendJson(res, 404, { error: "Attempt not found" });

  attempt = await ensureNotExpired(attempt);
  if (attempt.status !== "SUBMITTED") {
    return sendJson(res, 409, { error: "This attempt has not been submitted yet." });
  }

  sendJson(res, 200, await buildResultPayload(attempt));
}

module.exports = {
  handleListTests,
  handleGetTest,
  handleStartAttempt,
  handleRetakeAttempt,
  handleGetCurrentAttempt,
  handleSaveAnswer,
  handleSubmitAttempt,
  handleGetResult,
  buildResultPayload,
  ensureNotExpired
};
