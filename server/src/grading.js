// server/src/grading.js
// Grading is entirely server-side and data-driven off the `questions` table.
// The platform is multiple-choice only (true/false is a two-option multiple
// choice): every answer is an exact, all-or-nothing match. No AI, no network.

const { db } = require("./db");

function gradeAnswer(question, answerText) {
  const marks = question.marks;
  const trimmed = (answerText || "").trim();
  if (trimmed === "") return { isCorrect: 0, marksAwarded: 0, gradingMethod: "empty" };
  if (question.type === "multiple-choice" || question.type === "true-false") {
    const correct = JSON.parse(question.correct_answer);
    const isCorrect = trimmed === correct;
    return { isCorrect: isCorrect ? 1 : 0, marksAwarded: isCorrect ? marks : 0, gradingMethod: "exact" };
  }
  return { isCorrect: 0, marksAwarded: 0, gradingMethod: "unsupported" };
}

// Grades every question served in one attempt, persists per-question results
// and returns the attempt summary. Idempotent; never overwrites teacher overrides.
async function gradeAttempt(attemptId) {
  const attempt = await db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId);
  if (!attempt) throw new Error("Attempt not found");

  const questions = await db.prepare(`
    SELECT q.* FROM attempt_questions aq
    JOIN questions q ON q.id = aq.question_id
    WHERE aq.attempt_id = ?
    ORDER BY aq.order_index
  `).all(attemptId);

  const existingAnswers = await db.prepare(`SELECT * FROM answers WHERE attempt_id = ?`).all(attemptId);
  const answerByQuestion = Object.fromEntries(existingAnswers.map((a) => [a.question_id, a]));

  const upsertSql = `
    INSERT INTO answers (id, attempt_id, question_id, answer_text, is_correct, marks_awarded, grading_method, teacher_override, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET
      is_correct = excluded.is_correct,
      marks_awarded = excluded.marks_awarded,
      grading_method = excluded.grading_method,
      updated_at = excluded.updated_at
    WHERE answers.teacher_override = 0
  `;
  const upserts = [];
  let score = 0, totalMarks = 0, correctCount = 0, incorrectCount = 0, partialCount = 0;

  for (const q of questions) {
    totalMarks += q.marks;
    const existing = answerByQuestion[q.id];
    if (existing && existing.teacher_override) {
      score += existing.marks_awarded || 0;
      if (existing.is_correct) correctCount++;
      else if ((existing.marks_awarded || 0) > 0) partialCount++;
      else incorrectCount++;
      continue;
    }
    const answerText = existing ? existing.answer_text : "";
    const graded = gradeAnswer(q, answerText);
    const id = existing ? existing.id : `${attemptId}-${q.id}`;
    upserts.push({ sql: upsertSql, args: [id, attemptId, q.id, answerText, graded.isCorrect, graded.marksAwarded, graded.gradingMethod, new Date().toISOString()] });
    score += graded.marksAwarded;
    if (graded.isCorrect) correctCount++; else incorrectCount++;
  }

  await db.batch(upserts);
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 1000) / 10 : 0;
  return { score, totalMarks, percentage, correctCount, incorrectCount, partialCount };
}

module.exports = { gradeAnswer, gradeAttempt };
