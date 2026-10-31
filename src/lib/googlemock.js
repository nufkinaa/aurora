// A STAND-IN FOR GOOGLE, for private test instances only (auth-round,
// 2026-10-31). No test can sign in to a real Google account, so a private
// instance answers Google's four calls itself (lib/googleauth.js asks here
// first) and serves Google's two pages: the account chooser the browser and
// the phone's Custom Tab are sent to, and the "enter the code" page of the
// TV's device flow. Everything else in the sign-in routes runs exactly as on
// the real server: the state, the hand-off codes, the outcomes.
//
// IT CAN NEVER BE ON IN PRODUCTION. active() is true only when EVERY one of
// these holds, checked once:
//   1. AURORA_GOOGLE_MOCK=1 in the environment;
//   2. NODE_ENV is not "production";
//   3. the process runs as "ui-instance.js" — the name scripts/ui-test-server.js
//      gives its private copy of server.js (the real server runs server.js);
//   4. the instance's root holds ".owner-pid", which only ui-test-server.js
//      writes (the root of a private copy in the temp folder);
//   5. the port is not 4000 (the household server's);
//   6. no real Google client secret is configured (a .env that holds one is
//      a real server's).
// test/googlemock.test.js proves each condition alone turns it off, and that
// the live tree (server.js on port 4000) could never pass.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WEB_CLIENT = "mock-web-client.apps.googleusercontent.test";
const TV_CLIENT = "mock-tv-client.apps.googleusercontent.test";
const AUTH_PATH = "/__mock-google/auth";
const BASE = "/__mock-google";

// The fake accounts the chooser offers (example.test: a domain that can never exist).
const ACCOUNTS = [
  { sub: "mock-sub-ana", email: "ana.test@example.test", name: "Ana Test" },
  { sub: "mock-sub-ben", email: "ben.test@example.test", name: "Ben Test" },
  { sub: "mock-sub-cy", email: "cy.test@example.test", name: "Cy Test" },
];
const accountFor = (sub, email) => {
  const known = ACCOUNTS.find((a) => a.sub === sub);
  if (known) return known;
  const e = String(email || "").trim().toLowerCase().slice(0, 80);
  if (!/^[^\s@]+@example\.test$/.test(e)) return null; // only made-up addresses
  return { sub: "mock-sub-" + crypto.createHash("sha256").update(e).digest("hex").slice(0, 12), email: e, name: e.split("@")[0] };
};

// PURE: the six conditions, from facts (so the test can try each one).
const evaluate = (f) =>
  f.env.AURORA_GOOGLE_MOCK === "1" &&
  f.env.NODE_ENV !== "production" &&
  f.entry === "ui-instance.js" &&
  f.ownerPidFile === true &&
  Number(f.port) !== 4000 &&
  !f.env.GOOGLE_WEB_CLIENT_SECRET && !f.env.GOOGLE_TV_CLIENT_SECRET && !f.env.GOOGLE_CLIENT_SECRET;

const factsNow = () => {
  const config = require("../config");
  return {
    env: process.env,
    entry: path.basename(process.argv[1] || ""),
    ownerPidFile: fs.existsSync(path.join(config.ROOT, ".owner-pid")),
    port: config.PORT,
  };
};

let decided = null;
const active = () => {
  if (decided === null) {
    decided = process.env.AURORA_GOOGLE_MOCK === "1" ? evaluate(factsNow()) : false;
    if (decided) console.warn("[auth] GOOGLE IS MOCKED on this private test instance (lib/googlemock.js) — never on a real server");
    else if (process.env.AURORA_GOOGLE_MOCK === "1") console.warn("[auth] AURORA_GOOGLE_MOCK is set but this is not a private test instance: ignored");
  }
  return decided;
};

// ---------- the calls ----------
const codes = new Map(); // auth code -> { account, redirectUri, at }
const idTokens = new Map(); // id token -> { account, aud }
const devices = new Map(); // device_code -> { userCode, at, account, denied }
const fresh = (n = 18) => crypto.randomBytes(n).toString("hex");
const sweep = (m, ms) => { const now = Date.now(); for (const [k, v] of m) if (now - v.at > ms) m.delete(k); };

const exchangeCode = async (code, redirectUri) => {
  sweep(codes, 10 * 60 * 1000);
  const c = codes.get(String(code || ""));
  codes.delete(String(code || ""));
  if (!c || c.redirectUri !== redirectUri) return { error: "invalid_grant", error_description: "Bad Request" };
  const t = "mock-id." + fresh();
  idTokens.set(t, { account: c.account, aud: WEB_CLIENT, at: Date.now() });
  return { id_token: t, access_token: "mock-access." + fresh(8), token_type: "Bearer", expires_in: 3599 };
};

const tokenInfo = async (idToken) => {
  sweep(idTokens, 10 * 60 * 1000);
  const t = idTokens.get(String(idToken || ""));
  if (!t) return { error: "invalid_token" };
  return { aud: t.aud, sub: t.account.sub, email: t.account.email, email_verified: "true", name: t.account.name };
};

const deviceStart = async () => {
  sweep(devices, 30 * 60 * 1000);
  const config = require("../config");
  const A = "BCDFGHJKLMNPQRSTVWXZ";
  const pick = () => Array.from(crypto.randomBytes(4), (b) => A[b % A.length]).join("");
  const userCode = `${pick()}-${pick()}`;
  const deviceCode = "mock-device." + fresh();
  devices.set(deviceCode, { userCode, at: Date.now(), account: null, denied: false });
  return { device_code: deviceCode, user_code: userCode, verification_url: `http://127.0.0.1:${config.PORT}${BASE}/device`, expires_in: 900, interval: 1 };
};

const devicePoll = async (deviceCode) => {
  const d = devices.get(String(deviceCode || ""));
  if (!d) return { error: "expired_token" };
  if (d.denied) { devices.delete(deviceCode); return { error: "access_denied" }; }
  if (!d.account) return { error: "authorization_pending" };
  devices.delete(deviceCode);
  const t = "mock-id." + fresh();
  idTokens.set(t, { account: d.account, aud: TV_CLIENT, at: Date.now() });
  return { id_token: t };
};

const approveDevice = (userCode, sub, email, deny = false) => {
  const want = String(userCode || "").trim().toUpperCase();
  for (const d of devices.values()) {
    if (d.userCode !== want) continue;
    if (deny) { d.denied = true; return { ok: true }; }
    const account = accountFor(sub, email);
    if (!account) return { error: "pick one of the test accounts, or an address @example.test" };
    d.account = account;
    return { ok: true, account };
  }
  return { error: "no such code" };
};

// ---------- the pages ----------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shell = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><body style="font:16px system-ui;background:#fff;color:#1f1f1f;max-width:420px;margin:0 auto;padding:24px">` +
  `<p style="background:#fde7e9;color:#8a1c22;padding:8px 10px;border-radius:6px;font-size:13px">TEST STAND-IN FOR GOOGLE (private test instance)</p>${body}</body>`;

const router = () => {
  const express = require("express");
  const r = express.Router();
  r.use(BASE, express.urlencoded({ extended: false, limit: "4kb" }));
  r.get(AUTH_PATH, (req, res) => {
    const q = req.query || {};
    if (q.client_id !== WEB_CLIENT) return res.status(400).type("html").send(shell("Error", "<h1>invalid_client</h1>"));
    const back = (extra) => `${BASE}/choose?${new URLSearchParams({ state: q.state || "", redirect_uri: q.redirect_uri || "", ...extra })}`;
    const list = ACCOUNTS.map((a) =>
      `<a id="acct-${esc(a.sub)}" href="${esc(back({ sub: a.sub }))}" style="display:block;padding:14px;border:1px solid #dadce0;border-radius:8px;margin:8px 0;color:#1f1f1f;text-decoration:none"><b>${esc(a.name)}</b><br><small>${esc(a.email)}</small></a>`).join("");
    res.type("html").send(shell("Choose an account",
      `<h1 style="font-size:22px">Choose an account</h1>${list}` +
      `<form method="get" action="${BASE}/choose"><input type="hidden" name="state" value="${esc(q.state)}"><input type="hidden" name="redirect_uri" value="${esc(q.redirect_uri)}">` +
      `<input name="email" id="mock-email" placeholder="someone@example.test" style="width:100%;padding:10px;margin:8px 0"><button id="mock-use" style="padding:10px 14px">Use another account</button></form>` +
      `<p><a id="mock-cancel" href="${esc(back({ error: "access_denied" }))}">Cancel</a></p>`));
  });
  r.get(`${BASE}/choose`, (req, res) => {
    const q = req.query || {};
    let target;
    try { target = new URL(String(q.redirect_uri || "")); } catch { return res.status(400).send("bad redirect_uri"); }
    if (q.error) {
      target.searchParams.set("error", "access_denied");
    } else {
      const account = accountFor(q.sub, q.email);
      if (!account) return res.status(400).type("html").send(shell("Error", "<p>Only the listed accounts or an address @example.test.</p>"));
      const code = "mock-code." + fresh();
      codes.set(code, { account, redirectUri: target.toString(), at: Date.now() });
      target.searchParams.set("code", code);
    }
    target.searchParams.set("state", String(q.state || ""));
    res.redirect(target.toString());
  });
  r.get(`${BASE}/device`, (req, res) => {
    const opts = ACCOUNTS.map((a) => `<option value="${esc(a.sub)}">${esc(a.name)} (${esc(a.email)})</option>`).join("");
    res.type("html").send(shell("Enter the code",
      `<h1 style="font-size:22px">Enter the code</h1><form method="post" action="${BASE}/device">` +
      `<input name="user_code" id="mock-code" placeholder="XXXX-XXXX" style="width:100%;padding:10px;margin:8px 0" value="${esc((req.query || {}).user_code || "")}">` +
      `<select name="sub" id="mock-sub" style="width:100%;padding:10px;margin:8px 0">${opts}</select>` +
      `<button id="mock-allow" style="padding:10px 14px">Allow</button> <button name="deny" value="1" id="mock-deny" style="padding:10px 14px">Deny</button></form>`));
  });
  r.post(`${BASE}/device`, (req, res) => {
    const b = req.body || {};
    const out = approveDevice(b.user_code, b.sub, b.email, b.deny === "1");
    res.type("html").send(shell("Done", out.ok ? "<h1>Done</h1><p>You can go back to your device.</p>" : `<p>${esc(out.error)}</p>`));
  });
  // JSON for the tests and the device helpers: approve (or deny) a TV code.
  r.post(`${BASE}/device/approve`, express.json({ limit: "4kb" }), (req, res) => {
    const b = req.body || {};
    const out = approveDevice(b.user_code, b.sub, b.email, !!b.deny);
    res.status(out.ok ? 200 : 404).json(out);
  });
  r.get(`${BASE}/accounts`, (req, res) => res.json({ accounts: ACCOUNTS }));
  return r;
};

module.exports = { active, evaluate, router, WEB_CLIENT, TV_CLIENT, AUTH_PATH, ACCOUNTS, _internals: { exchangeCode, tokenInfo, deviceStart, devicePoll, approveDevice }, exchangeCode, tokenInfo, deviceStart, devicePoll };
