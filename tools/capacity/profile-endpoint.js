#!/usr/bin/env node
// Where does the CPU go inside one request? A V8 CPU profile of the private
// instance while one endpoint is asked over and over.
//
//   node tools/capacity/profile-endpoint.js [/api/home?profile={P}] [--secs 8] [--films 150 --shows 30]
//
// The instance is started as always (no flags); the inspector is switched on
// from outside (process._debugProcess) and the profile read over its
// WebSocket. Output: the functions by self time, grouped by source file too.
const http = require("http");
const { Client, sleep, WebSocket } = require("./sim");
const { start } = require("./instance");
const { round, saveJson } = require("./lib");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/api/home?profile={P}";
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));

(async () => {
  const srv = await start({ films: +arg("films", 150), shows: +arg("shows", 30), profiles: 5 });
  const P = srv.sessions[0].profileId;
  const c = new Client(srv.url, { sid: srv.sessions[0].sid, maxSockets: 2 });
  for (let i = 0; i < 40; i++) await c.post(`/api/profiles/${P}/progress`, { itemId: srv.library.movies[i].id, position: 600 + i, duration: 5400 });
  const p = target.replace("{P}", P);
  for (let i = 0; i < 5; i++) await c.get(p);
  process._debugProcess(srv.pid);
  let info = null;
  for (let i = 0; i < 50 && !info; i++) { await sleep(200); try { info = (await getJson("http://127.0.0.1:9229/json"))[0]; } catch {} }
  if (!info) throw new Error("inspector did not come up on 9229");
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0; const pending = new Map();
  ws.on("message", (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
  const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 200 });
  await call("Profiler.start");
  const until = Date.now() + +arg("secs", 8) * 1000;
  let n = 0;
  while (Date.now() < until) { await c.get(p); n++; }
  const { profile } = await call("Profiler.stop");
  ws.close();
  const total = profile.samples.length;
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const self = new Map();
  for (const s of profile.samples) self.set(s, (self.get(s) || 0) + 1);
  const fn = new Map(), file = new Map();
  for (const [nid, k] of self) {
    const cf = byId.get(nid).callFrame;
    const short = (cf.url || "(native)").replace(/^file:\/\/\//, "").replace(/.*aurora-ui-[^/\\]+[/\\]/, "").replace(/.*node_modules[/\\]/, "node_modules/");
    const name = `${cf.functionName || "(anonymous)"}  ${short}${cf.lineNumber >= 0 ? ":" + (cf.lineNumber + 1) : ""}`;
    fn.set(name, (fn.get(name) || 0) + k);
    file.set(short, (file.get(short) || 0) + k);
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, v]) => ({ pct: round((100 * v) / total, 1), name }));
  const idle = [...fn].filter(([k]) => /^\(idle\)|^\(program\)/.test(k)).reduce((a, [, v]) => a + v, 0);
  console.log(`\n${p}: ${n} requests in ${arg("secs", 8)} s; ${round((100 * idle) / total, 0)}% of samples idle/program\n\nby function (self time):`);
  for (const r of top(fn, 28)) console.log(`  ${String(r.pct).padStart(5)}%  ${r.name}`);
  console.log("\nby file:");
  for (const r of top(file, 14)) console.log(`  ${String(r.pct).padStart(5)}%  ${r.name}`);
  saveJson(`profile-${p.split("?")[0].replace(/[^a-z0-9]+/gi, "-")}.json`, { endpoint: p, requests: n, byFunction: top(fn, 40), byFile: top(file, 20) });
  await srv.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
