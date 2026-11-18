// server/src/grading.js
// Grading is entirely server-side and data-driven off the `questions` table —
// no grading logic is hardcoded per-question in the UI or route handlers.
//
// Short-answer partial credit
// ----------------------------
// Rather than a strict "did the string contain this exact fragment" check,
// short-answer questions are scored on a 0..1 understanding scale and then
// awarded a *proportional* share of the question's marks. Two graders feed
// into that scale:
//   1. A local, offline heuristic (always available): concept-fragment
//      coverage blended with stemmed token-overlap against a model answer,
//      with a small synonym table so common paraphrases are recognised even
//      when they don't share literal words.
//   2. An optional AI grader (server/src/aiGrading.js): if the operator sets
//      ANTHROPIC_API_KEY and the server has internet access, Claude judges
//      how well the student's answer matches the intended understanding,
//      even when wording is completely different. If it's not configured,
//      times out, or the network is unreachable (e.g. a LAN-only deployment
//      with no internet), grading silently falls back to the heuristic — the
//      app never depends on connectivity to grade a test.
// Multiple-choice / true-false stay exact-match / all-or-nothing, as before.

const { db } = require("./db");
const { aiGradeShortAnswer } = require("./aiGrading");

const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","of","to","in","on","for",
  "and","or","but","it","its","that","this","these","those","as","by","with","from",
  "at","so","if","than","then","because","not","no","can","could","should","would",
  "will","shall","may","might","do","does","did","has","have","had","you","your",
  "they","their","he","she","we","our","i","also","which","who","what","when","how",
  "why","into","about","such","more","most","very","just","only","also","there"
]);

// Small synonym clusters so common paraphrases score credit even when they
// share no literal words with the fragments/model answer. Each array maps to
// the same canonical token.
const SYNONYM_GROUPS = [
  ["training data", "trained on", "training set", "data trained", "learns from data"],
  ["bias", "biased", "unfair", "skewed", "prejudice"],
  ["quality", "accuracy", "reliability", "correctness"],
  ["reflect", "reflects", "mirrors", "inherits", "carries over"],
  ["open-ended", "open ended", "broad enough", "flexible", "not restrictive"],
  ["narrow", "too specific", "overly specific", "limiting"],
  ["actionable", "practical", "usable", "workable"],
  ["user need", "user needs", "user's need", "based on research", "grounded in insight"],
  ["garbage in", "garbage in garbage out", "bad input bad output"]
];

function stem(word) {
  // Extremely small heuristic stemmer — good enough for matching, not linguistics.
  return word
    .replace(/(ing|edly|ed|ies|es|s)$/i, (m, suffix) => {
      if (suffix === "ies") return "y";
      return "";
    })
    .toLowerCase();
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(stem)
  );
}

function applySynonyms(normalizedText) {
  let out = normalizedText;
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const variant of group) {
      if (variant === canonical) continue;
      if (out.includes(variant)) out = out.split(variant).join(canonical);
    }
  }
  return out;
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Offline heuristic partial-credit score for a short-answer question.
 * Returns a value in [0, 1].
 */
function heuristicShortAnswerScore(acceptedFragments, modelAnswer, studentAnswer) {
  const rawNormalized = normalize(studentAnswer);
  if (!rawNormalized) return 0;
  const synonymized = applySynonyms(rawNormalized);

  // 1. Concept-fragment coverage: how many distinct accepted fragments/ideas
  //    are present (checked both literally and after synonym substitution).
  const fragments = acceptedFragments.length ? acceptedFragments : [];
  let hits = 0;
  for (const fragment of fragments) {
    const normFragment = applySynonyms(normalize(fragment));
    if (synonymized.includes(normFragment) || rawNormalized.includes(normalize(fragment))) hits++;
  }
  // Matching ~2 distinct key concepts is treated as full concept coverage;
  // matching all of them isn't required (fragments are illustrative, not exhaustive).
  const conceptTarget = Math.max(1, Math.min(2, fragments.length));
  const fragmentScore = fragments.length ? Math.min(1, hits / conceptTarget) : 0;

  // 2. Stemmed token overlap against a model answer (or the fragments joined,
  //    if no model answer was supplied), which rewards paraphrases that don't
  //    contain a literal accepted fragment but cover the same ground.
  const referenceText = modelAnswer || fragments.join(". ");
  const overlapScore = jaccard(tokenSet(studentAnswer), tokenSet(referenceText));

  // Blend the two signals; either a strong concept hit or strong lexical
  // overlap alone should already earn solid partial credit.
  let score = 0.6 * fragmentScore + 0.4 * overlapScore;
  if (overlapScore >= 0.55) score = Math.max(score, 0.85);
  if (fragmentScore >= 1) score = Math.max(score, 0.8);

  return Math.max(0, Math.min(1, score));
}

/**
 * Grade a single answer against its question definition.
 * Returns { isCorrect, marksAwarded, gradingMethod }.
 * isCorrect is 1 only for full marks; partial credit still leaves isCorrect
 * 0 but marksAwarded > 0 (surfaced to the UI as a distinct "Partial" state).
 */
async function gradeAnswer(question, answerText) {
  const marks = question.marks;
  const trimmed = (answerText || "").trim();

  if (trimmed === "") {
    return { isCorrect: 0, marksAwarded: 0, gradingMethod: "empty" };
  }

  if (question.type === "multiple-choice" || question.type === "true-false") {
    const correct = JSON.parse(question.correct_answer);
    const isCorrect = trimmed === correct;
    return { isCorrect: isCorrect ? 1 : 0, marksAwarded: isCorrect ? marks : 0, gradingMethod: "exact" };
  }

  if (question.type === "short-answer") {
    const parsed = JSON.parse(question.correct_answer);
    const acceptedFragments = Array.isArray(parsed) ? parsed : parsed.fragments || [];
    const modelAnswer = question.model_answer || (parsed && parsed.modelAnswer) || null;

    // Prefer AI-assisted semantic grading when configured & reachable; fall
    // back to the offline heuristic on any failure (no key, no internet,
    // timeout, bad response) so grading always completes on a LAN-only box.
    let score01;
    let gradingMethod;
    const aiResult = await aiGradeShortAnswer({
      question: question.question,
      modelAnswer,
      acceptedFragments,
      studentAnswer: trimmed,
      marks
    });
    if (aiResult) {
      score01 = aiResult.score01;
      gradingMethod = "ai";
    } else {
      score01 = heuristicShortAnswerScore(acceptedFragments, modelAnswer, trimmed);
      gradingMethod = "heuristic";
    }

    const marksAwarded = Math.round(marks * score01);
    const isCorrect = marksAwarded >= marks; // full marks only
    return { isCorrect: isCorrect ? 1 : 0, marksAwarded, gradingMethod };
  }

  return { isCorrect: 0, marksAwarded: 0, gradingMethod: "unknown" };
}

/**
 * Grade every question served in a specific attempt (per attempt_questions,
 * NOT the whole bank), persist per-question results, compute and persist the
 * attempt-level score/percentage, and return the summary. Idempotent: safe to
 * call multiple times (used by both manual submit and auto-submit code
 * paths); does not stomp on teacher overrides.
 */
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

  let score = 0;
  let totalMarks = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let partialCount = 0;

  for (const q of questions) {
    totalMarks += q.marks;
    const existing = answerByQuestion[q.id];

    if (existing && existing.teacher_override) {
      // Respect a teacher's manual override; just fold it into the totals.
      score += existing.marks_awarded || 0;
      if (existing.is_correct) correctCount++;
      else if ((existing.marks_awarded || 0) > 0) partialCount++;
      else incorrectCount++;
      continue;
    }

    const answerText = existing ? existing.answer_text : "";
    const graded = await gradeAnswer(q, answerText);
    const id = existing ? existing.id : `${attemptId}-${q.id}`;
    upserts.push({ sql: upsertSql, args: [id, attemptId, q.id, answerText, graded.isCorrect, graded.marksAwarded, graded.gradingMethod, new Date().toISOString()] });

    score += graded.marksAwarded;
    if (graded.isCorrect) correctCount++;
    else if (graded.marksAwarded > 0) partialCount++;
    else incorrectCount++;
  }

  await db.batch(upserts);

  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 1000) / 10 : 0;

  return { score, totalMarks, percentage, correctCount, incorrectCount, partialCount };
}

module.exports = { gradeAnswer, gradeAttempt, heuristicShortAnswerScore };
