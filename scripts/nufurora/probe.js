#!/usr/bin/env node
// A small helper for scripts/nufurora/update.sh: asks the running Aurora
// server what it is doing. No dependencies, and nothing from src/ (src/config.js
// creates folders and looks for tools when it is loaded).
//
//   node probe.js health   [--dir <repo>] [--port <n>]
//        prints "ok <version> <uptime-seconds>", exit 0
//        otherwise prints why ("no answer (ECONNREFUSED)", "503 stopping"), exit 1
//   node probe.js watching [--count-paused] [--dir <repo>] [--port <n>]
//        prints how many are watching now (GET /api/admin/overview: watchingNow,
//        plus pausedNow with --count-paused), exit 0
//        exit 1 when the server does not answer at all
//        exit 3 when the count cannot be read (no admin password, 403, bad answer)
//   node probe.js keeper   [--dir <repo>]
//        prints the keeper's pid when data/keeper-state.json names one that is
//        alive, exit 0; otherwise exit 1
//   node probe.js version-of < package.json
//        prints the "version" of the JSON on stdin, exit 0; otherwise exit 1
//
// Where the server is: env AURORA_URL (a base URL, used by the tests), else
// http://127.0.0.1:<port>, port = --port, else config.json "port", else 4000.
// The admin password: env AURORA_ADMIN_PASSWORD, else the repo's .env (read the
// way src/config.js reads it), else config.json "adminPassword". It is sent
// only as the X-Admin-Password header to that address, and never printed.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(`--${name}`);
const dir = path.resolve(opt("dir") || path.join(__dirname, "..", ".."));
const timeoutMs = Number(opt("timeout")) || 5000;

const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) || {}; } catch { return {}; }
};

// The same parsing as src/config.js: KEY=VALUE lines, # comments, optional
// quotes; a real environment variable wins over the file.
const readDotEnv = () => {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, ".env"), "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  return out;
};

const adminPassword = (cfg) => {
  if (process.env.AURORA_ADMIN_PASSWORD) return process.env.AURORA_ADMIN_PASSWORD;
  const env = readDotEnv();
  if (!("AURORA_ADMIN_PASSWORD" in process.env) && env.AURORA_ADMIN_PASSWORD) return env.AURORA_ADMIN_PASSWORD;
  return (cfg && typeof cfg.adminPassword === "string" && cfg.adminPassword) || null;
};

const baseUrl = (cfg) => {
  if (process.env.AURORA_URL) return process.env.AURORA_URL.replace(/\/+$/, "");
  const port = Number(opt("port")) || Number(cfg.port) || 4000;
  return `http://127.0.0.1:${port}`;
};

// GET, resolves { status, body } or { error }. Never throws.
const get = (url, headers) =>
  new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: "bad URL" }); }
    const lib = u.protocol === "https:" ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = lib.request(u, { method: "GET", headers: { Accept: "application/json", ...headers } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { if (body.length < 1e6) body += d; });
        res.on("end", () => finish({ status: res.statusCode, body }));
        res.on("error", (e) => finish({ error: e.code || "read error" }));
      });
    } catch {
      // e.g. a character a header may not carry: the message is not printed
      return finish({ error: "request error" });
    }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: "timeout" }); });
    req.on("error", (e) => finish({ error: e.code || "request error" }));
    req.end();
  });

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; }
};

const out = (s) => process.stdout.write(`${s}\n`);

const main = async () => {
  if (cmd === "version-of") {
    let s = "";
    process.stdin.setEncoding("utf8");
    for await (const d of process.stdin) s += d;
    const j = parse(s);
    if (j && typeof j.version === "string" && j.version) { out(j.version); return 0; }
    return 1;
  }

  if (cmd === "keeper") {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, "data", "keeper-state.json"), "utf8")); } catch {}
    const pid = s && Number(s.keeperPid);
    if (pid && pidAlive(pid)) { out(String(pid)); return 0; }
    return 1;
  }

  const cfg = readConfig();
  const base = baseUrl(cfg);

  if (cmd === "health") {
    const r = await get(`${base}/healthz`, {});
    if (r.error) { out(`no answer (${r.error})`); return 1; }
    const j = parse(r.body);
    if (r.status === 200 && j && j.ok === true) {
      out(`ok ${String(j.version || "unknown").replace(/\s+/g, "_")} ${Number.isFinite(j.uptime) ? Math.floor(j.uptime) : "?"}`);
      return 0;
    }
    out(`${r.status}${j && j.stopping ? " stopping" : " not ok"}`);
    return 1;
  }

  if (cmd === "watching") {
    const pw = adminPassword(cfg);
    if (!pw) { out("no admin password found (AURORA_ADMIN_PASSWORD in the environment or .env, or adminPassword in config.json)"); return 3; }
    const r = await get(`${base}/api/admin/overview`, { "X-Admin-Password": pw });
    if (r.error === "request error" || r.error === "bad URL") { out("the request could not be made"); return 3; }
    if (r.error) { out(`no answer (${r.error})`); return 1; }
    if (r.status === 403) { out("the server refused the admin password (403)"); return 3; }
    if (r.status !== 200) { out(`unexpected answer ${r.status}`); return 3; }
    const j = parse(r.body);
    if (!j || !Number.isFinite(j.watchingNow)) { out("the answer had no watchingNow"); return 3; }
    const paused = Number.isFinite(j.pausedNow) ? j.pausedNow : 0;
    out(String(j.watchingNow + (flag("count-paused") ? paused : 0)));
    return 0;
  }

  out("usage: probe.js health|watching|keeper|version-of [--dir <repo>] [--port <n>] [--count-paused]");
  return 2;
};

main().then((code) => process.exit(code), () => process.exit(2));
