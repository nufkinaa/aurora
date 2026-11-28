#!/usr/bin/env node
// Where the server's event loop goes while several people watch: a private
// instance (scripts/ui-test-server.js, the rig's library), N viewers pulling
// films' jit streams the way hls.js does (a minute ahead, then 1x), and a CPU
// profile of the server for the whole time. Prints the loop's worst blocks
// (lib/looplag.js through /healthz) and the functions with the most time of
// their own.
//
//   node tools/stream-net-rig/loop-prof.js [--warm 120] [--viewers 5] [--enc 1] [--sec 90] [--out prof.cpuprofile] [--affinity 0xAAAA]
//   (Git Bash: export MSYS_NO_PATHCONV=1)
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VIEWERS = Number(arg("viewers", 5));
const ENC = Number(arg("enc", 1));
const SEC = Number(arg("sec", 90));
// --warm S: the profile and the loop figures only from S seconds on (a fresh server loads
// modules lazily for its first minute or two: one-time blocks, not what watching costs)
const WARM = Number(arg("warm", 0));
const MEDIA = String(arg("media", "E:/aurora-agents/research-stream-efficiency/media"));
const OUT = path.resolve(String(arg("out", path.join(os.tmpdir(), `aurora-loop-${Date.now()}.cpuprofile`))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the preload: profile from boot until RIG_PROF_SEC have passed, then write RIG_PROF_OUT
const PRELOAD = path.join(os.tmpdir(), `aurora-loop-prof-preload-${process.pid}.js`);
fs.writeFileSync(PRELOAD, `
const inspector = require("inspector");
const fs = require("fs");
const s = new inspector.Session();
s.connect();
const delay = Number(process.env.RIG_PROF_DELAY || 0) * 1000;
setTimeout(() => s.post("Profiler.enable", () => s.post("Profiler.setSamplingInterval", { interval: 1000 }, () => s.post("Profiler.start"))), delay).unref();
setTimeout(() => s.post("Profiler.stop", (err, r) => { if (!err) fs.writeFileSync(process.env.RIG_PROF_OUT, JSON.stringify(r.profile)); }), delay + Number(process.env.RIG_PROF_SEC) * 1000).unref();
`);

const main = async () => {
  const server = require("../../scripts/ui-test-server");
  const srv = await server.start({
    preload: [PRELOAD],
    env: { RIG_PROF_OUT: OUT, RIG_PROF_SEC: String(SEC - WARM), RIG_PROF_DELAY: String(WARM) },
    config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: "off" },
  });
  const aff = arg("affinity", "");
  if (aff && process.platform === "win32") {
    try { require("child_process").execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${srv.pid}).ProcessorAffinity = ${Number(aff)}`], { stdio: "pipe", windowsHide: true }); } catch (e) { console.warn("affinity:", String(e.message).split("\n")[0]); }
  }
  try {
    const lib = await (await fetch(`${srv.url}/api/library`)).json();
    const films = lib.movies.filter((m) => /^Rig (Jit|Hevc|Uhd|Mp4|Orig)$/.test(m.title));
    const st = { stop: false, segs: 0, bytes: 0, errors: 0, waits: [] };
    const one = async (film, v, from) => {
      const base = `${srv.url}/stream/transcode/${encodeURIComponent(film.id)}/jit`;
      const master = await (await fetch(`${base}/master.m3u8`)).text();
      const uris = master.split("\n").map((x) => x.trim()).filter((l) => l && !l.startsWith("#"));
      const u = uris.find((x) => (/[?&]v=([^&]+)/.exec(x) || [])[1] === v) || uris.find((x) => !/[?&]v=h264/.test(x)) || uris[0];
      const plUrl = new URL(u, `${base}/master.m3u8`).href;
      const pl = (await (await fetch(plUrl)).text()).split("\n").map((x) => x.trim());
      const segs = [];
      let at = 0;
      for (let i = 0; i < pl.length; i++) {
        const m = /^#EXTINF:([\d.]+)/.exec(pl[i]);
        if (!m) continue;
        let j = i + 1;
        while (j < pl.length && (!pl[j] || pl[j].startsWith("#"))) j++;
        if (j < pl.length) segs.push({ at, d: Number(m[1]), url: new URL(pl[j], plUrl).href });
        at += Number(m[1]);
        i = j;
      }
      const t0 = Date.now();
      for (const sg of segs) {
        if (st.stop) return;
        if (sg.at + sg.d < from) continue;
        while (!st.stop && sg.at - from - (Date.now() - t0) / 1000 > 60) await sleep(250);
        const a = Date.now();
        try { const r = await fetch(sg.url); const b = await r.arrayBuffer(); if (r.status >= 400) st.errors++; else { st.segs++; st.bytes += b.byteLength; st.waits.push(Date.now() - a); } } catch { st.errors++; }
      }
    };
    const loop = { max: 0, p99: 0, windows: [] };
    const startedAt = Date.now();
    const lp = setInterval(async () => {
      try { const j = await (await fetch(`${srv.url}/healthz`)).json(); if (j.loop && Date.now() - startedAt >= (WARM + 10) * 1000) { loop.windows.push(j.loop.maxMs); loop.max = Math.max(loop.max, j.loop.maxMs); loop.p99 = Math.max(loop.p99, j.loop.p99Ms); } } catch {}
    }, 5000);
    for (let i = 0; i < VIEWERS; i++) one(films[i % films.length], ENC && i < ENC ? "h264-720" : "copy", 60 * (i + 1)).catch(() => st.errors++);
    await sleep(SEC * 1000);
    st.stop = true;
    clearInterval(lp);
    await sleep(30000); // the profile is written
    const w = st.waits.sort((a, b) => a - b);
    console.log(`${VIEWERS} viewers (${ENC} on an encode), ${SEC} s: ${st.segs} segments, ${(st.bytes / 1e6).toFixed(0)} MB, ${st.errors} errors; segment wait p50 ${w[Math.floor(w.length / 2)]} ms, p95 ${w[Math.floor(w.length * 0.95)]} ms`);
    console.log(`event loop: worst block ${loop.max} ms, worst p99 ${loop.p99} ms; per 10-s window: ${loop.windows.join(" ")}`);
    if (fs.existsSync(OUT)) {
      const p = JSON.parse(fs.readFileSync(OUT, "utf8"));
      const self = new Map();
      const dt = (p.endTime - p.startTime) / p.samples.length / 1000;
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      const counts = new Map();
      for (const id of p.samples) counts.set(id, (counts.get(id) || 0) + 1);
      for (const [id, c] of counts) {
        const n = byId.get(id);
        const f = n.callFrame;
        const k = `${f.functionName || "(anon)"} ${path.basename(f.url || "")}:${f.lineNumber + 1}`;
        self.set(k, (self.get(k) || 0) + c * dt);
      }
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      const idle = self.get("(idle) :0") || 0;
      console.log(`profile ${OUT}: ${(total / 1000).toFixed(1)} s sampled, busy ${((total - idle) / total * 100).toFixed(1)} %`);
      for (const [k, ms] of [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${ms.toFixed(0).padStart(7)} ms  ${k}`);
      console.log(`  (gc ${((self.get("(garbage collector) :0") || 0)).toFixed(0)} ms, program ${((self.get("(program) :0") || 0)).toFixed(0)} ms)`);
    } else console.log("no profile written");
  } finally {
    await srv.stop();
    try { fs.unlinkSync(PRELOAD); } catch {}
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
