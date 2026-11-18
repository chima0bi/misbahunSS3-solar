# aiB Assessment Platform (v5.0)

> **v5.0**: the platform is now **multiple-choice only** (true/false allowed). The AI grader, `ANTHROPIC_API_KEY` and all theory/short-answer features were removed; grading is exact-match and offline. Any old short-answer questions are deactivated automatically. The UI was redesigned. Older sections below that mention short-answer or AI grading no longer apply.

> **v4.2.0**: the database layer now uses **libSQL** (`@libsql/client`). With no configuration it still uses a local SQLite file exactly as before; set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` and all data lives in **Turso** (free hosted SQLite), so the app can run on a host with a wiped filesystem such as Render's free plan without losing data. This version also adds a `/healthz` endpoint (for UptimeRobot), makes JSON paste / drag-and-drop the way to add questions, and removes the "Leave site?" prompt after submitting. See "Free hosting: Turso + Render + UptimeRobot" below.

> **v4.1.1**: each test can now have an optional **availability window** (opens / closes). Outside the window students cannot start or retake it (the dashboard shows when it opens or closed). A student still writing when the window closes is **submitted automatically**, even if their own time limit has not run out; an attempt always ends at the earlier of the time limit and the closing time. With no window set, students can write any time. Set or clear it from Tests & Question Bank > Availability Window. Times are entered in the admin's local time. Students can still view their past results after a window closes.

> **v4.1 changes** (from v4.0): tests are no longer a single built-in test. Admins (teachers) create any number of tests, each with its own **subject, class, question set (multiple-choice, true/false and theory/short-answer), time limit and number of questions per test** — all editable. Students log in, pick a subject and class, then take a test. Scores are shown as a **percentage**, with correct-vs-total (e.g. "14 of 20 correct") alongside. Students can still erase their score and retake. The old built-in test, with all its questions, answers and explanations, has been removed (an existing v4.0 database is cleaned automatically on first start).

## Quick start for admins
1. Sign up at `/teacher-signup.html` with the teacher code, then open **Tests & Question Bank**.
2. Click **+ New Test**, fill in title, subject, class, time limit and number of questions per test, and **Create Test**.
3. Add questions with **Import Questions (JSON)**: paste JSON or drag and drop a `.json` file. Explanation/reasoning are optional; marks default to 1. Existing questions can still be edited one at a time.
4. Edit any property later, hide a test from students (untick *Visible to students*), or **Delete Test** to remove it permanently with all its questions and attempts.

A test appears to students once it has at least one active question. If a test has more questions than its "questions per test" number, each attempt draws a random subset of that size.


A simple, self-hosted web app for administering an AI Bootcamp assessment:
students take a timed, randomly-shuffled test with unlimited self-service
retakes and get an instant, educational question-by-question review (with
partial credit on short answers); teachers get a dashboard of every
submission, class statistics (including time spent), a live-editable
question bank, and CSV export.

**One small dependency.** The server uses Node built-ins plus the `@libsql/client`
package for the database (a local SQLite file by default, or Turso). Run
`npm install` once. The core app (taking the test, grading, dashboards) works
offline on a local network when using the local file database. Google Sign-In
and AI-assisted short-answer grading are optional, additive features that only
activate when configured and online.

---

## 1. Features

**Student**
- Public sign-up creates a **student** account only (see §6 for teachers)
- Log in with email + password, or optionally with Google (see §5)
- Start the assessment — a server-side timer (configurable by the teacher)
  begins the instant "Start Test" is clicked
- Every attempt draws a **freshly randomized sample of questions from the
  question bank**, in shuffled order, with **shuffled multiple-choice/true-
  false answer options** — no two students (or attempts) see the same layout
- Autosaved answers; timer survives refresh, closing the tab, or reopening
  later — it's driven entirely by a server-side `expiresAt` timestamp, never
  the browser
- Submit manually any time, or get auto-submitted the instant time runs out
- Immediate results: score, percentage, correct / **partial credit** /
  incorrect breakdown, time used, and for every question — your answer, the
  correct answer, a model answer (for short-answer questions), an
  explanation, and the reasoning behind it
- **Unlimited retakes**: once submitted, a student can reset and retake the
  test as many times as they like. Each retake reshuffles everything again
  and re-samples from the question bank (rotating in newly-added questions,
  dropping others, always capped at the teacher's configured count). Past
  attempts stay on record for the teacher.

**Short-answer partial credit**
- Short-answer questions are graded on a 0–100% understanding scale, not a
  strict "contains this exact string" check — a student can express the
  right idea in different words and still earn a proportional share of the
  marks. See §8 for exactly how this works, including the optional
  AI-assisted grading mode for genuinely wording-independent scoring.

**Teacher**
- Sign up (gated by an access code — see §6) / log in
- Dashboard of every submission: name, email, attempt #, score, percentage,
  **time spent**, submission time, manual vs. auto
- Search/filter by name or email
- Class performance: average / highest / lowest score, score-band
  distribution, most-missed questions, **average/fastest/slowest time spent**,
  and a full per-student time table
- Open any student's submission and see every question, their answer, the
  correct/model answer, and the explanation
- Manually override any question's grade/score (useful for reviewing
  short-answer partial credit)
- Export all results to CSV (includes time spent, attempt #, partial count)
- **Test Settings**: change the time limit and how many questions are served
  per attempt, at any time, from the dashboard
- **Question Bank**: add, edit, and deactivate questions (multiple-choice,
  true/false, or short-answer with a model answer + accepted key ideas) —
  changes apply to attempts started from that point on

---

## 2. Tech Stack

| Layer      | Choice                                                                 |
|------------|-------------------------------------------------------------------------|
| Backend    | Node.js `http` module (no Express) — plain JSON API                    |
| Database   | libSQL via `@libsql/client` - local SQLite file by default, or hosted Turso |
| Auth       | Cookie-based sessions, `node:crypto` scrypt password hashing; optional Google Sign-In verified via `node:https`/`node:crypto` (no JWT library) |
| Frontend   | Static HTML/CSS/vanilla JS (no build step, no framework)                |
| Optional AI grading | Plain HTTPS call to the Anthropic API via `node:https` — only used if `ANTHROPIC_API_KEY` is set |

Node.js 20 or newer is required. There is no experimental-flag handling any
more because `node:sqlite` is no longer used.

---

## 3. Project Structure

```
server/
  data/                  # SQLite database file lives here (auto-created)
  src/
    server.js            # HTTP server + routing + static file serving + LAN startup banner
    db.js                # libSQL/Turso client, schema + forward-migrations (async)
    auth.js              # Password hashing, sessions
    googleAuth.js         # Verifies Google ID tokens (zero-dependency)
    aiGrading.js           # Optional AI-assisted short-answer grading (Anthropic API)
    grading.js            # Server-authoritative grading (incl. partial credit)
    attemptQuestions.js    # Per-attempt question sampling + shuffling
    routes/
      auth.js            # /api/auth/*, /api/config
      student.js         # /api/test, /api/attempt/*
      teacher.js         # /api/teacher/*  (submissions, stats, settings, question bank)
    utils/http.js         # JSON body parsing, cookies (no framework needed)

client/
  index.html              # Login / Student sign-up (+ optional Google button)
  teacher-signup.html      # Code-gated teacher sign-up
  student-dashboard.html   # Start / continue / retake
  test.html                # The timed test-taking UI
  results.html
  teacher-dashboard.html   # Submissions, class stats, settings, question bank
  teacher-submission.html
  css/style.css
  js/api.js                # Shared fetch wrapper + helpers

package.json
.env.example
README.md
```

---

## 4. Environment Variables

See `.env.example`. All are optional except none are strictly required to
run locally:

```
PORT=3000                    # HTTP port
HOST=0.0.0.0                 # Bind address — 0.0.0.0 = reachable on your LAN (default)

# Optional: seeds the initial teacher self-signup code (both password and
# Google) the FIRST time the server ever starts. Anyone who knows this code
# can create a teacher account, so keep it private. After first launch, the
# live code lives in the database, not this file — a teacher can rotate it
# any time from the Teacher Dashboard's Settings tab, and that change takes
# effect immediately (no restart, no editing this file).
TEACHER_SIGNUP_CODE=

# Optional: enables "Sign in / up with Google" (requires internet access).
GOOGLE_CLIENT_ID=

# Optional: enables true wording-independent AI grading of short answers
# (requires internet access). Falls back to the offline heuristic if unset.
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

No API keys or secrets are required to run the core app.

**Setting these**: copy `.env.example` to `.env` and fill in what you need
(`cp .env.example .env`; it also lists TURSO_DATABASE_URL / TURSO_AUTH_TOKEN). The server automatically reads `.env` from the
project root on startup — no extra flags or packages needed (this app has
zero dependencies, so there's no `dotenv` package involved; a small
built-in loader in `server/src/server.js` handles it). A real shell/OS
environment variable always takes precedence over the same key in `.env`.
If you set a value in `.env` and the server still behaves as if it's unset,
double check the file is named exactly `.env` and sits in the project root
(next to `package.json`, not inside `server/`) — and restart the server
after editing it, since `.env` is only read once at startup.

---

## 5. Installation & Running Locally (incl. on a local network, no internet)

```bash
npm install   # once (installs @libsql/client)
npm start
# or directly:
node server/src/server.js
```

The server prints something like:

```
AI Bootcamp Assessment server running on http://localhost:3000
Reachable on your local network (no internet required) at:
  http://192.168.1.42:3000
```

- On the machine running the server, open **http://localhost:3000**.
- On **any other device on the same Wi-Fi/LAN** (a student's laptop, phone,
  etc.), open the `http://192.168.x.x:3000` address printed above — no
  internet connection is needed for any of this. If a device can't connect,
  check that your OS firewall allows inbound connections on that port.
- To restrict the server to only the local machine, set `HOST=127.0.0.1`.

The SQLite database is created automatically at `server/data/assessment.db`
on first run, and no tests exist until an admin creates them. You do not need to run a separate seed
command; just start the server.

If you ever want to reset all data (wipe every account, test and attempt):

```bash
rm -f server/data/assessment.db*
node server/src/server.js
```

### Enabling "Sign in with Google" (optional, requires internet)

1. Create an OAuth 2.0 Client ID (type "Web application") in the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   and add the URL(s) you'll serve the app from (e.g.
   `http://localhost:3000`) as an authorized JavaScript origin.
2. Set `GOOGLE_CLIENT_ID` to that client ID and restart the server.
3. A "Continue with Google" button will now appear on the login/sign-up
   pages automatically. If the server (or the student's device) has no
   internet access, the button simply doesn't appear / doesn't work — the
   rest of the app is unaffected.

New accounts created via Google follow the same student/teacher rules as
password sign-up (see §6).

### Enabling AI-assisted short-answer grading (optional, requires internet)

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) to have short
answers graded by asking a Claude model how well the student's answer
matches the intended understanding — even when the wording shares no words
in common with the reference answer. If unset, offline, or the request
fails for any reason, grading transparently falls back to the built-in
offline heuristic (see §8) — a test can always be graded on a LAN with no
internet at all.

---

## 6. Accounts: Students vs. Teachers

- **Students**: anyone can self-register from the homepage (`/index.html`)
  or via Google — this always creates a **student** account. There's no
  teacher option on that form.
- **Teachers**: teacher accounts can only be created from
  `/teacher-signup.html`, which requires the current teacher sign-up code.
  That code starts out as whatever `TEACHER_SIGNUP_CODE` was set to on first
  launch, but any teacher can rotate it afterwards from the Teacher
  Dashboard → Settings tab → "Teacher Sign-Up Code" panel — no restart or
  `.env` edit needed, and the new code applies immediately. If no code has
  ever been set, teacher sign-up is disabled entirely (the page says so).
  Share the code only with the people who should be able to administer the
  test.
- **Login** (`/index.html`, the "Log In" tab) works identically for both
  roles — the account decides where you land after logging in, not the form.

---

## 7. How the Timer & Attempt Rules Work

- The countdown starts **only** when `/api/attempt/start` (or
  `/api/attempt/retake`) is called — never at registration, login, or page
  load.
- The server stores `startedAt` and `expiresAt` in the database. The
  **only** source of truth for whether time remains is `expiresAt` vs. the
  server clock — the browser's countdown is cosmetic.
- Refreshing, closing the tab, switching devices, or tampering with
  client-side JS cannot reset or extend the timer, because the client never
  sends a duration — it only ever asks the server "what's my current attempt
  and how much time is left," and the server answers from its own clock.
- If a student returns after time has run out — even days later — the very
  next request touching that attempt causes the server to grade and mark it
  `SUBMITTED` / `AUTO` before responding. Expiry is enforced lazily and
  authoritatively wherever the attempt is touched (`ensureNotExpired()` in
  `server/src/routes/student.js`).
- Submission is idempotent: resubmitting (double-click, network retry, or a
  race between manual submit and the timer hitting zero) always returns the
  same stored result rather than creating a duplicate or re-grading over a
  teacher's manual override.
- **Retakes**: once an attempt is `SUBMITTED`, the student can call
  `/api/attempt/retake` (via the "Retake Test" button) to start a brand-new
  attempt with a freshly sampled/shuffled question set. There is no limit on
  the number of retakes. Every past attempt is preserved for the teacher's
  records (visible in the submissions list and included in CSV export) —
  nothing is deleted.

---

## 8. How Grading Works

Grading is entirely server-side and data-driven off the `questions` table —
never hardcoded per question in the UI.

- **Multiple-choice / True-False**: exact match against the stored correct
  answer — all-or-nothing, as you'd expect.
- **Short-answer (partial credit)**: instead of a strict "contains this
  exact fragment" check, each answer is scored on a 0–100% understanding
  scale and awarded a **proportional** share of the question's marks. Two
  graders feed into that score:
  1. **Offline heuristic (always available, no internet needed)** — blends
     two signals: how many of the question's key concepts/fragments are
     present (checked with light stemming and a small synonym table so
     common paraphrases are recognized even without literal word matches),
     and the stemmed token overlap against a teacher-supplied model answer.
     This reliably gives partial credit for realistic paraphrases (e.g. a
     student who reworks "training data... bias... reflects" into "if the
     dataset the model is trained on has biases, the outputs will reflect
     that" scores highly) — but, being offline and dependency-free, it
     can't fully replicate a human/LLM's semantic judgment for an answer
     that shares **no words or synonyms at all** with the reference
     material.
  2. **Optional AI-assisted grading** (`ANTHROPIC_API_KEY`, requires
     internet) — asks a Claude model to judge how well the student's answer
     matches the intended understanding regardless of wording, which is the
     way to get genuinely wording-independent partial credit as described
     in the spec. It's used automatically when configured, and falls back
     to the offline heuristic on any failure (no key, no network, timeout,
     bad response) — grading never blocks or fails because of this.
  Every result shows the student a **Correct / Partial Credit / Incorrect**
  badge with the marks awarded, plus a model answer and explanation.
- Multiple-choice/true-false and short-answer questions can be freely mixed;
  each question carries its own `marks` value set by the teacher.

---

## 9. Question Bank & Test Settings (Teacher)

From the **Test Settings & Question Bank** tab on the teacher dashboard:

- **Test Settings**: change the title, description, time limit (minutes),
  and how many questions are served per attempt. Changes apply to attempts
  started after the change — attempts already in progress keep their
  original settings.
- **Question Bank**: add new questions (multiple-choice, true/false, or
  short-answer with a model answer + comma-separated accepted key ideas),
  edit existing ones, or deactivate them. Deactivated questions are hidden
  from future random selection but remain attached to any past attempt that
  already used them, so historical results and reviews stay intact.
- **Adding many questions at once** — two ways:
  1. **"+ Add Question(s)"** opens the usual modal, but with a
     **"+ Add Another Question"** button at the bottom: keep clicking it to
     stack as many question forms as you like, fill them all in, then hit
     **"Save All"** once. If a couple of them have a typo/validation issue,
     the rest still save — only the failing ones stay in the modal with
     their specific error, so you're not stuck re-typing everything.
  2. **"Bulk Import (paste)"** opens a text box where you paste a **JSON
     array** of question objects — the same field names used in
     the Add Question form (`type`, `question`, `options`,
     `correctAnswer`, `explanation`, `reasoning`, `marks`, and for
     short-answer, `correctAnswer` as an array of accepted phrases). This is
     the fastest way to move a whole prepared set of questions in from a
     document: draft them in that JSON shape (or ask an AI assistant to
     convert your questions into it) and paste the array in one go. Note:
     it must be valid **JSON** (double-quoted keys/strings) — a JavaScript array literal won't
     parse as-is, since JS object literals allow things JSON doesn't
     (unquoted keys, trailing commas); the import box shows a template and a
     clear parse error if the paste isn't valid JSON yet.
- Every attempt (first attempt or retake) independently samples
  `questionsPerAttempt` **active** questions at random from the bank and
  shuffles their order — plus shuffles multiple-choice/true-false option
  order — so the bank can hold more questions than any one attempt uses,
  and can grow over time without disrupting students mid-course.

---

## 10. Security Notes

- Passwords are hashed with `scrypt` (via `node:crypto`) with a random salt
  per user; plain-text passwords are never stored or logged. Google-only
  accounts get an unguessable, unusable password hash so password login
  can't be used to impersonate them.
- Google ID tokens are verified server-side (signature via Google's public
  JWKS, issuer, audience, and expiry) before any session is created — the
  client-provided token is never trusted blindly.
- Sessions are random 256-bit tokens stored server-side, set as an
  `HttpOnly`, `SameSite=Lax` cookie — not accessible to client-side JS, and
  not stored in `localStorage`.
- Every API route re-derives the current user from the session cookie and
  checks role (`STUDENT` / `TEACHER`) and, for student data, ownership
  (`attempt.student_id === user.id`) before returning or mutating anything.
  A student can never fetch or modify another student's attempt/answers, or
  answer a question that wasn't actually served in their attempt.
- Teacher account creation requires `TEACHER_SIGNUP_CODE`; it's never
  exposed to the client (only a boolean "is teacher sign-up enabled" is).
- Correct answers are never sent to the client until after submission.
- The score is always computed and verified server-side — the client never
  submits a score, only answers.
- Static file serving strips query strings and rejects any path that
  resolves outside the `client/` directory, so it can't be used to read
  arbitrary files off disk.

---

## 10.5 Inspecting the Database Directly (like MongoDB Compass, for this SQLite file)

The data lives in one file, `server/data/assessment.db` (plus `-wal`/`-shm`
helper files while the server is running). It's a binary SQLite file — that's
why it looked like garbage when you opened it in a text editor. To browse/edit
it visually the way you'd use Compass for MongoDB, use a SQLite-specific tool
instead of a text editor:

- **[DB Browser for SQLite](https://sqlitebrowser.org/)** (free, Windows/Mac/
  Linux) — the closest equivalent to Compass: open `assessment.db`, browse
  every table (`users`, `tests`, `questions`, `attempts`, `attempt_questions`,
  `answers`, `settings`, `sessions`) in a spreadsheet-like grid, edit cells,
  and run raw SQL queries. This is the one to install first.
- **VS Code extensions** like "SQLite Viewer" or "SQLite3 Editor" — handy if
  you're already editing this project in VS Code; right-click the `.db` file
  and open it.
- **`sqlite3` CLI** (often preinstalled on Mac/Linux; downloadable for
  Windows) — for quick one-off queries: `sqlite3 server/data/assessment.db`
  then e.g. `.tables`, `SELECT * FROM users;`.
- **TablePlus / DBeaver** — heavier general-purpose DB GUIs that also support
  SQLite, if you want one tool for multiple database types.

A few things worth knowing before you poke around:

- **You can browse safely while the server is running** — the database uses
  WAL mode, which the tools above handle fine for read-only browsing.
  However, **editing data directly while the server is running is risky**
  (the server's in-memory statements and the app's own validation don't know
  about your edit) — for anything beyond looking, stop the server first
  (`Ctrl+C` in its terminal), make your changes, then restart it.
- **Always back up first**: copy the whole `server/data/` folder somewhere
  safe before editing anything by hand. If you break something, you can copy
  it back.
- Passwords are stored as salted `scrypt` hashes (`users.password_hash`) —
  you cannot read anyone's actual password from the database, by design.
- If you just want to *change the teacher sign-up code*, you don't need any
  of this — do it from the Teacher Dashboard's Settings tab instead (see §6).

---

## 11. Free hosting: Turso + Render + UptimeRobot

Render's free web service has a filesystem that is wiped on every restart,
redeploy and idle spin-down, so a local SQLite file would lose all data there.
Storing the data in Turso avoids that.

**A. Create the Turso database (free)**
1. Sign up at turso.tech and create a database (pick a region near your students).
2. Copy the database URL (`libsql://your-db-name-your-org.turso.io`).
3. Create a database auth token and copy it. Keep both values private.

**B. Put the code on GitHub** (private repo). `.env`, `node_modules/` and
`server/data/*.db*` are git-ignored. Do not commit secrets.

**C. Create the Render web service**
1. render.com > New > Web Service > pick the repo (or New > Blueprint to use `render.yaml`).
2. Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
3. Environment variables: `NODE_VERSION=22`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `TEACHER_SIGNUP_CODE` (6+ characters). Do not set `PORT`. Do not set `DB_DIR`.
4. Health Check Path: `/healthz`. Deploy.
5. Open the service URL, go to `/teacher-signup.html` and create the admin account.

**D. UptimeRobot (keeps the free service awake)**
Render free services spin down after a period without traffic and take a while
to wake. Add an HTTP(S) monitor for `https://YOUR-SERVICE.onrender.com/healthz`
with the shortest interval the free plan allows. Data is safe either way
because it is in Turso; this only avoids slow first loads.

Notes: free-tier limits change, so check Turso's and Render's pricing pages.
Run one instance only. Avoid redeploying while students are mid-test; timers
are enforced from the database, so a short restart does not reset anyone's clock.
If `libsql://` has trouble connecting from your host, try the same URL with
`https://` instead of `libsql://`.

---

## 12. Known Limitations & Decisions

- **Database latency**: with Turso the database is remote, so each request does a few network round trips. This is fine for a class; the grading and import paths are batched to keep it quick.
- **Offline short-answer grading has a ceiling**: the heuristic grader
  (fragment coverage + synonyms + stemmed overlap) handles realistic
  paraphrasing well, but genuinely can't award credit for an answer that
  shares zero words or recognized synonyms with the reference material,
  since that requires real semantic understanding. Set `ANTHROPIC_API_KEY`
  (requires internet) if you need grading that's fully wording-independent.
- **Multiple tests** are supported from v4.1 (see top of this file). Deleting a test also deletes student attempts on it.
- No email verification or password-reset flow.
- No automated test *suite* (Jest, etc.) is included, to avoid introducing a
  dependency; the full flow (registration → attempt → shuffling → timer/
  expiry → partial-credit grading → retakes → teacher settings/question
  bank → idempotent submit → teacher dashboard → CSV export → security
  boundaries) was manually verified end-to-end against the running server.
