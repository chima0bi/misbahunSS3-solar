// server/src/googleAuth.js
// Verifies a Google Identity Services ID token (JWT) server-side, with zero
// external dependencies — only node:https and node:crypto. This is only used
// for the OPTIONAL "Sign in / up with Google" flow, which requires internet
// access; the rest of the app (username/password auth, the test itself)
// works entirely offline on a local network without this module ever being
// reached.

const https = require("node:https");
const crypto = require("node:crypto");

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

let cachedKeys = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Request to ${url} failed with ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(6000, () => req.destroy(new Error("Google JWKS request timed out")));
  });
}

async function getGoogleKeys() {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CACHE_TTL_MS) return cachedKeys;
  const jwks = await fetchJson(JWKS_URL);
  cachedKeys = jwks.keys || [];
  cachedAt = now;
  return cachedKeys;
}

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a Google ID token's signature, issuer, audience, and expiry.
 * Returns the decoded payload { sub, email, email_verified, name, ... } on
 * success, or throws on any failure.
 */
async function verifyGoogleIdToken(idToken, expectedAudience) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf-8"));
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8"));

  if (!ISSUERS.has(payload.iss)) throw new Error("Unexpected token issuer");
  if (payload.aud !== expectedAudience) throw new Error("Token audience mismatch");
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error("Token expired");

  const keys = await getGoogleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching signing key found");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signedData = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(signedData);
  verifier.end();
  const ok = verifier.verify(publicKey, signature);
  if (!ok) throw new Error("Invalid token signature");

  return payload;
}

module.exports = { verifyGoogleIdToken };
