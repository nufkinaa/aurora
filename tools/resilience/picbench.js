#!/usr/bin/env node
// Picture-heavy browsing against a PRIVATE instance, with the picture hosts
// played by a local fake that is fast, slow, down (refuses) or hanging.
//
//   node tools/resilience/picbench.js [--repo <checkout>] [--label x] [--households 16] [--modes fast,slow,down,hang]
//
// Per mode (a fresh instance each): HOUSEHOLDS devices (each a browser with
// six connections, as browsers have) from this machine's
// address (no session — the load-test rig's shape, and the strictest for the
// rate limits, which then share one bucket) each open a cold Home at once:
// 45 posters every household shares (the same rows) + 10 of its own, all
// /img/ext?w=240 misses, in parallel, plus 6 /img/poster backup posters. Then
// the same again (pass 2: everything is on disk now, or known to be missing).
// Reported: p50 / p95 / max per pass and the answers' statuses. Pictures on
// disk must not wait on anything; with the host down or hanging, a miss must
// fail fast, not queue.
"use strict";
const path = require("path");
const http = require("http");
const fs = require("fs");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(arg("repo", path.join(__dirname, "..", "..")));
const LABEL = arg("label", "run");
const HOUSEHOLDS = Number(arg("households", 16));
const MODES = arg("modes", "fast,slow,down,hang").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (l, q) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]); };

// a real JPEG (the server sniffs and downscales it)
const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "picbench-"));
const jpgPath = path.join(tmp, "p.jpg");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=500x750", "-frames:v", "1", "-q:v", "4", jpgPath]);
const JPG = fs.readFileSync(jpgPath);

let mode = "fast";
let inHand = 0, maxInHand = 0, asked = 0;
const fake = http.createServer((req, res) => {
  asked++;
  if (mode === "down") return req.socket.destroy();
  if (mode === "hang") return;
  inHand++; maxInHand = Math.max(maxInHand, inHand);
  const done = () => { inHand--; };
  res.on("close", done);
  const isMeta = req.url.includes("/meta/");
  setTimeout(() => {
    if (isMeta) {
      const id = (/(tt\d+)/.exec(req.url) || [])[1] || "tt1";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ meta: { id, name: "X", poster: `https://images.metahub.space/poster/medium/${id}/img` } }));
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": JPG.length });
    res.end(JPG);
  }, mode === "slow" ? 800 : 20);
});
const fakeSockets = new Set();
fake.on("connection", (s) => { fakeSockets.add(s); s.on("close", () => fakeSockets.delete(s)); });

// each household is a browser: its own six connections to the server
const agents = [];
const agentOf = (h) => agents[h] || (agents[h] = new http.Agent({ keepAlive: true, maxSockets: 6 }));
const get = (url, agent) => new Promise((resolve) => {
  const t0 = performance.now();
  const req = http.get(url, { agent, timeout: 60000 }, (res) => { res.resume(); res.on("end", () => resolve({ ms: performance.now() - t0, st: res.statusCode })); });
  req.on("timeout", () => req.destroy());
  req.on("error", () => resolve({ ms: performance.now() - t0, st: 0 }));
});

const home = (srv, h, run) => {
  const urls = [];
  for (let i = 0; i < 45; i++) urls.push(`/img/ext?u=${encodeURIComponent(`https://images.metahub.space/poster/medium/tt${run}${String(i).padStart(4, "0")}/img`)}&w=240`);
  for (let i = 0; i < 10; i++) urls.push(`/img/ext?u=${encodeURIComponent(`https://images.metahub.space/poster/medium/tt${run}${h}${String(i).padStart(3, "0")}9/img`)}&w=240`);
  for (let i = 0; i < 6; i++) urls.push(`/img/poster/tt${run}${h}${String(i).padStart(3, "0")}7?type=movie&t=X&w=240`);
  return urls;
};

(async () => {
  const { start } = require(path.join(REPO, "scripts", "ui-test-server.js"));
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const out = [];
  for (const m of MODES) {
    mode = m; inHand = 0; maxInHand = 0; asked = 0;
    const srv = await start({ preload: [path.join(__dirname, "preload.js")], env: { AURORA_FAKE_UPSTREAM: `http://127.0.0.1:${fake.address().port}` }, config: { onlineMetadata: false } });
    try {
      const run = 1000 + Math.floor(Math.random() * 8000);
      const r = { label: LABEL, mode: m };
      for (const pass of [1, 2, 3]) {
        const t0 = Date.now();
        const all = await Promise.all(Array.from({ length: HOUSEHOLDS }, (_, h) => Promise.all(home(srv, h, run).map((u) => get(srv.url + u, agentOf(h))))));
        const flat = all.flat();
        const st = {};
        for (const x of flat) st[x.st] = (st[x.st] || 0) + 1;
        r[`pass${pass}`] = { n: flat.length, p50: pct(flat.map((x) => x.ms), 0.5), p95: pct(flat.map((x) => x.ms), 0.95), max: pct(flat.map((x) => x.ms), 1), wallMs: Date.now() - t0, statuses: st };
        await sleep(500);
      }
      r.upstream = { asked, maxInHand };
      console.log(JSON.stringify(r));
      console.error(`${LABEL} ${m.padEnd(5)} pass1 p50/p95/max ${r.pass1.p50}/${r.pass1.p95}/${r.pass1.max} ms ${JSON.stringify(r.pass1.statuses)} | pass2 ${r.pass2.p50}/${r.pass2.p95}/${r.pass2.max} ms ${JSON.stringify(r.pass2.statuses)} | pass3 ${r.pass3.p50}/${r.pass3.p95}/${r.pass3.max} ms | upstream asked ${asked}, at once ${maxInHand}`);
      out.push(r);
    } finally {
      await srv.stop();
      for (const s of fakeSockets) s.destroy();
      await sleep(500);
    }
  }
  fake.close();
  for (const a of agents) if (a) a.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 300).unref();
})().catch((e) => { console.error(e); process.exit(1); });
