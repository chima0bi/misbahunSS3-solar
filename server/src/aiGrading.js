// server/src/aiGrading.js
// OPTIONAL semantic grading for short-answer questions.
//
// The heuristic grader in grading.js already gives partial credit for
// paraphrased answers using stemming + synonyms + concept-overlap, and works
// fully offline on a local network. If a teacher also sets ANTHROPIC_API_KEY
// (and the server has internet access), this module asks a Claude model to
// judge how closely the student's answer matches the intended understanding
// — even when it shares few or no words with the model answer — and returns
// a 0-100 score used as partial credit. Any failure (no key, no network,
// timeout, bad response) simply falls back to the offline heuristic; the app
// never depends on this to function.

const https = require("node:https");

const TIMEOUT_MS = 8000;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Ask Claude to grade a single short-answer response.
 * Returns { score01, feedback } on success, or null if unavailable/failed —
 * callers must treat null as "fall back to the offline heuristic".
 */
async function aiGradeShortAnswer({ question, modelAnswer, acceptedFragments, studentAnswer, marks }) {
  if (!isConfigured()) return null;
  const trimmed = (studentAnswer || "").trim();
  if (!trimmed) return null;

  const prompt = [
    `You are grading one short-answer exam question. Grade the STUDENT ANSWER for how well it captures the correct understanding — give credit for correct meaning even if the wording, phrasing, or vocabulary is completely different from the reference answer. Do not require exact word matches.`,
    ``,
    `QUESTION: ${question}`,
    `REFERENCE ANSWER (one valid way to express the correct idea): ${modelAnswer || acceptedFragments.join("; ")}`,
    `KEY CONCEPTS THAT SHOULD BE PRESENT: ${acceptedFragments.join(", ")}`,
    `STUDENT ANSWER: ${trimmed}`,
    ``,
    `Score the student answer from 0 to 100, where 100 = fully demonstrates the correct understanding (in any wording), 0 = shows no relevant understanding, and any value between reflects partial/incomplete understanding.`,
    `Respond with ONLY a compact JSON object, no other text, in exactly this shape: {"score": <integer 0-100>, "feedback": "<one short sentence>"}`
  ].join("\n");

  try {
    const result = await callAnthropic(prompt);
    const parsed = extractJson(result);
    if (!parsed || typeof parsed.score !== "number") return null;
    const score01 = Math.max(0, Math.min(1, parsed.score / 100));
    return { score01, feedback: typeof parsed.feedback === "string" ? parsed.feedback : "" };
  } catch {
    return null; // network unavailable, timeout, or API error — caller falls back
  }
}

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        }
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Anthropic API status ${res.statusCode}`));
          }
          try {
            const json = JSON.parse(chunks);
            const text = (json.content || []).map((b) => b.text || "").join("");
            resolve(text);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("Anthropic API request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

module.exports = { aiGradeShortAnswer, isConfigured };
