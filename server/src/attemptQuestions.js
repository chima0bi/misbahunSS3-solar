// server/src/attemptQuestions.js
// Builds a fresh, independently-shuffled question set for a single attempt,
// drawn at random from the active question bank. Every Start / Retake calls
// this again, so: (a) every student's test is shuffled differently, (b) the
// same student's retakes are reshuffled, and (c) newly-added bank questions
// can rotate in / older ones rotate out automatically, always capped at the
// test's configured `questions_per_attempt`.

const crypto = require("node:crypto");
const { db } = require("./db");

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Selects up to `questionsPerAttempt` active questions from the bank for
 * `testId`, in random order, and (for multiple-choice / true-false) computes
 * a randomized display order for their options. Persists the selection into
 * attempt_questions for `attemptId`. Also returns the computed total marks
 * for this specific attempt (bank questions can carry different mark values).
 */
async function buildAttemptQuestions(attemptId, testId, questionsPerAttempt) {
  const bank = await db.prepare(`SELECT * FROM questions WHERE test_id = ? AND active = 1`).all(testId);
  const selected = shuffle(bank).slice(0, Math.max(0, Math.min(questionsPerAttempt, bank.length)));

  const insertSql = `
    INSERT INTO attempt_questions (attempt_id, question_id, order_index, options_order)
    VALUES (?, ?, ?, ?)
  `;
  const statements = [];

  let totalMarks = 0;
  selected.forEach((q, index) => {
    let optionsOrder = null;
    if (q.options) {
      const opts = JSON.parse(q.options);
      optionsOrder = JSON.stringify(shuffle(opts));
    }
    statements.push({ sql: insertSql, args: [attemptId, q.id, index + 1, optionsOrder] }); // 1-based, so it can be shown directly as "Question N"
    totalMarks += q.marks;
  });

  await db.batch(statements); // one round trip, all-or-nothing

  return { count: selected.length, totalMarks };
}

module.exports = { buildAttemptQuestions, shuffle };
