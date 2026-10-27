#!/usr/bin/env node
// A private instance of this working tree that stays up (for the TV: point
// the QA build at it with `adb reverse tcp:4000 tcp:<port>`), with the stall
// rig's copied films as its library and a test profile on it.
//
//   node tools/stall-rig/serve.js --media E:/aurora-stall-media --info <file> [--hw off] [--keeper] [--tree base]
//   (--keeper: under its keeper, so `node scripts/keeper.js --restart --data <dataDir>` restarts it)
//
// Writes { url, port, adminPassword, profile } to --info (the admin password
// is a throwaway made by ui-test-server for this instance only). CTRL-C / kill
// tears it down and removes its folder.
"use strict";
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const INFO = String(arg("info", path.join(__dirname, ".runs", "serve.json")));
const HW = String(arg("hw", "off"));

(async () => {
  const server = require("../../scripts/ui-test-server");
  const TREE = arg("tree", null);
  const srvMod = TREE ? require(path.join(require("../ttff/snapshot").treeDir(TREE), "scripts", "ui-test-server.js")) : server;
  const srv = await srvMod.start({
    verbose: true,
    waitForLibrary: false, // (below, with more patience: real films on a spinning disk)
    keeper: argv.includes("--keeper"),
    config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: HW },
  });
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  for (const until = Date.now() + 600000; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
    let lib = null;
    try { lib = await call("GET", "/api/library"); } catch {}
    if (lib && lib.enriched && lib.movies.length && lib.movies.every((m) => m.duration > 0)) break;
  }
  // the test profile the TV signs in with (test values, this instance only)
  const { request } = await call("POST", "/api/profiles", { name: "Claude QA", password: "qa1234", realName: "Claude QA", avatar: "🙂", color: "#e0612c" });
  const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
  fs.mkdirSync(path.dirname(INFO), { recursive: true });
  fs.writeFileSync(INFO, JSON.stringify({ url: srv.url, port: srv.port, adminPassword: srv.adminPassword, profile: p.id, root: srv.root, dataDir: srv.dataDir, pid: process.pid }, null, 1));
  console.log(`[serve] ${srv.url} (profile ${p.id}) — info in ${INFO}`);
  const stop = async () => { try { await srv.stop(); } catch {} process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error(e); process.exit(1); });
