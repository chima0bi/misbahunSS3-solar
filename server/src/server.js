// server/src/server.js
// HTTP server (Node built-ins; only dependency is the libSQL client) serving both the JSON API
// and the static frontend. Binds to all network interfaces by default so it
// is reachable from other devices on the same local network — see the "LAN
// access" note printed on startup, or README.md for details.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { URL } = require("node:url");

// ---- Minimal, zero-dependency .env loader ----
// This app has no dependencies (no `dotenv` package), so plain `node
// server/src/server.js` does NOT read a .env file on its own — Node only
// reads environment variables that are actually set in the shell/process.
// This loader fills that gap: if a .env file exists at the project root, its
// KEY=VALUE lines are loaded into process.env *before* any other local
// module (db.js, routes/*) is required — which matters, because several of
// them read process.env at require-time. A real shell/OS environment
// variable always takes precedence over the .env file, matching standard
// dotenv behavior.
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value; // real env vars win
  }
}
loadDotEnv();

const { sendJson } = require("./utils/http");
const { getUserFromRequest } = require("./auth");
const { getSetting, ready: dbReady, IS_REMOTE } = require("./db");
const authRoutes = require("./routes/auth");
const studentRoutes = require("./routes/student");
const teacherRoutes = require("./routes/teacher");

const PORT = process.env.PORT || 3000;
// "0.0.0.0" (the default) listens on every network interface, so devices on
// the same Wi-Fi/LAN can reach the server at http://<this-machine's-IP>:PORT
// with no internet connection required at all. Set HOST=127.0.0.1 to restrict
// access to this machine only.
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_DIR = path.join(__dirname, "..", "..", "client");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  // no query strings, no traversal
  filePath = filePath.split("?")[0];
  const resolved = path.normalize(path.join(CLIENT_DIR, filePath));
  if (!resolved.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA-ish fallback for clean routes without a file extension
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(CLIENT_DIR, "index.html"), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            return res.end("Not found");
          }
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(data2);
        });
      }
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function requireAuth(req, res, role) {
  const user = await getUserFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: "Not authenticated" });
    return null;
  }
  if (role && user.role !== role) {
    sendJson(res, 403, { error: "You do not have access to this resource." });
    return null;
  }
  return user;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Lightweight liveness check (no database access) - point UptimeRobot or
    // the host's health check here.
    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    if (!pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }

    // ---- Auth (public) ----
    if (pathname === "/api/config" && req.method === "GET") {
      return await authRoutes.handleConfig(req, res);
    }
    if (pathname === "/api/auth/register" && req.method === "POST") {
      return await authRoutes.handleRegister(req, res);
    }
    if (pathname === "/api/auth/login" && req.method === "POST") {
      return await authRoutes.handleLogin(req, res);
    }
    if (pathname === "/api/auth/google" && req.method === "POST") {
      return await authRoutes.handleGoogleAuth(req, res);
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      return await authRoutes.handleLogout(req, res);
    }
    if (pathname === "/api/auth/me" && req.method === "GET") {
      return await authRoutes.handleMe(req, res);
    }

    // ---- Student (requires STUDENT role) ----
    if (pathname === "/api/tests" && req.method === "GET") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleListTests(req, res, user);
    }
    if (pathname === "/api/test" && req.method === "GET") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleGetTest(req, res, user);
    }
    if (pathname === "/api/attempt/start" && req.method === "POST") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleStartAttempt(req, res, user);
    }
    if (pathname === "/api/attempt/retake" && req.method === "POST") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleRetakeAttempt(req, res, user);
    }
    if (pathname === "/api/attempt/current" && req.method === "GET") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleGetCurrentAttempt(req, res, user);
    }
    let m;
    if ((m = pathname.match(/^\/api\/attempt\/([^/]+)\/answer$/)) && req.method === "POST") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleSaveAnswer(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/attempt\/([^/]+)\/submit$/)) && req.method === "POST") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleSubmitAttempt(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/attempt\/([^/]+)\/result$/)) && req.method === "GET") {
      const user = await requireAuth(req, res, "STUDENT");
      if (!user) return;
      return await studentRoutes.handleGetResult(req, res, user, m[1]);
    }

    // ---- Teacher (requires TEACHER role) ----
    if (pathname === "/api/teacher/submissions" && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.listSubmissions(req, res, user, url.searchParams);
    }
    if ((m = pathname.match(/^\/api\/teacher\/submissions\/([^/]+)$/)) && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.getSubmissionDetail(req, res, user, m[1]);
    }
    if (pathname === "/api/teacher/stats" && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.getStats(req, res, user, url.searchParams);
    }
    if (pathname === "/api/teacher/export.csv" && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.exportCsv(req, res, user, url.searchParams);
    }
    if ((m = pathname.match(/^\/api\/teacher\/submissions\/([^/]+)\/override$/)) && req.method === "POST") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.overrideScore(req, res, user, m[1]);
    }
    if (pathname === "/api/teacher/tests" && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.listTests(req, res, user);
    }
    if (pathname === "/api/teacher/tests" && req.method === "POST") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.createTest(req, res, user);
    }
    if ((m = pathname.match(/^\/api\/teacher\/tests\/([^/]+)$/)) && (req.method === "PATCH" || req.method === "PUT")) {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.updateTest(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/teacher\/tests\/([^/]+)$/)) && req.method === "DELETE") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.deleteTest(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/teacher\/tests\/([^/]+)\/questions$/)) && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.listQuestions(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/teacher\/tests\/([^/]+)\/questions$/)) && req.method === "POST") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.addQuestion(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/teacher\/tests\/([^/]+)\/questions\/bulk$/)) && req.method === "POST") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.bulkAddQuestions(req, res, user, m[1]);
    }
    if (pathname === "/api/teacher/signup-code" && req.method === "GET") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.getSignupCode(req, res, user);
    }
    if (pathname === "/api/teacher/signup-code" && req.method === "PATCH") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.updateSignupCode(req, res, user);
    }
    if ((m = pathname.match(/^\/api\/teacher\/questions\/([^/]+)$/)) && req.method === "PUT") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.updateQuestion(req, res, user, m[1]);
    }
    if ((m = pathname.match(/^\/api\/teacher\/questions\/([^/]+)$/)) && req.method === "DELETE") {
      const user = await requireAuth(req, res, "TEACHER");
      if (!user) return;
      return await teacherRoutes.deleteQuestion(req, res, user, m[1]);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

// Wait for the database schema to be ready before accepting any requests.
dbReady.then(() => {
  server.listen(PORT, HOST, async () => {
    console.log(`aiB Assessment v4.2.0 server running on http://localhost:${PORT}`);
    if (HOST === "0.0.0.0") {
      const addrs = lanAddresses();
      if (addrs.length) {
        console.log(`Reachable on your local network (no internet required) at:`);
        for (const a of addrs) console.log(`  http://${a}:${PORT}`);
      } else {
        console.log(`No local network interface detected — only http://localhost:${PORT} will work.`);
      }
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.log(`Google sign-in is disabled (set GOOGLE_CLIENT_ID to enable it when online).`);
    }
    console.log(IS_REMOTE ? "Database: Turso (remote)." : "Database: local file (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN to use Turso).");
    if (!(await getSetting("teacher_signup_code", ""))) {
      console.log(`Teacher sign-up is disabled (set TEACHER_SIGNUP_CODE, or set a code from the Teacher Dashboard once a teacher account exists).`);
    }
  });
}).catch((err) => {
  console.error("Could not initialise the database:", err.message);
  process.exit(1);
});

module.exports = { server };
