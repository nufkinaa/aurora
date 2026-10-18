#!/usr/bin/env node
// JIT / LADDER VIEWERS UNDER LOAD: simulated hls.js players on the library's
// full-timeline stream (/stream/transcode/:id/jit/index.m3u8?v=…), each on
// its own film, starting somewhere in the middle, reading segments the way a
// player does: as fast as it can until BUFFER_SEC is in hand, then one more
// each time the buffer falls under it. A stall is a segment that arrives
// after the moment playback needed it.
//
//   node tools/streamload/hls.js --movies <folder> --trees after=<dir> --viewers 2,4,6
//        --v h264 [--hw auto] [--secs 90] [--codec hevc] [--label x]
//
// Reported per run: answers (200 / 503 busy / other), time to first segment
// (p50 / max), stalls, server CPU and memory (stats-preload), and the CPU of
// the instance's own ffmpeg children (sampled from the OS by parent pid).
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { REPO, arg, sleep, pct, round, startInstance, readStats, rng } = require("./lib");

const movies = arg("movies");
const trees = arg("trees", `after=${REPO}`).split(",").map((s) => { const [name, dir] = s.split("="); return { name, dir }; });
const counts = arg("viewers", "2,4").split(",").map(Number);
const v = arg("v", "h264");
const secs = parseFloat(arg("secs", "90"));
const hw = arg("hw", "off");
const codec = arg("codec", "");
const label = arg("label", "run");
const rounds = parseInt(arg("rounds", "1"), 10);
const extraConfig = JSON.parse(arg("config", "{}")); // e.g. {"hwEncodeSessions":2}
const BUFFER_SEC = 30;

const get = (url, agent) => new Promise((resolve) => {
  const t0 = Date.now();
  const req = http.get(url, { agent }, (res) => {
    let n = 0;
    const parts = [];
    res.on("data", (d) => { n += d.length; if (parts.length < 2000) parts.push(d); });
    res.on("end", () => resolve({ status: res.statusCode, bytes: n, ms: Date.now() - t0, text: res.headers["content-type"] && /mpegurl/.test(res.headers["content-type"]) ? Buffer.concat(parts).toString() : null }));
    res.on("error", () => resolve({ status: 0, bytes: n, ms: Date.now() - t0 }));
  });
  req.setTimeout(120000, () => req.destroy());
  req.on("error", () => resolve({ status: 0, bytes: 0, ms: Date.now() - t0 }));
});

// ffmpeg children of a pid: total CPU seconds, from the OS (Windows: CIM;
// elsewhere: ps). Sampled; a child's last sample stands for it.
const childCpu = (ppid) => new Promise((resolve) => {
  if (process.platform === "win32") {
    execFile("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' AND ParentProcessId=${ppid}" | ForEach-Object { "$($_.ProcessId) $($_.UserModeTime + $_.KernelModeTime) $($_.WorkingSetSize)" }`], { windowsHide: true }, (e, so) => {
      const rows = String(so || "").trim().split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number));
      resolve(rows.map(([pid, t, ws]) => ({ pid, cpu: t / 1e7, rssMb: ws / 1048576 })));
    });
  } else {
    execFile("ps", ["-o", "pid=,cputime=,rss=", "--ppid", String(ppid)], (e, so) => {
      const rows = String(so || "").trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/));
      resolve(rows.map(([pid, t, rss]) => { const [h, m, s] = t.split(":").map(Number); return { pid: Number(pid), cpu: h * 3600 + m * 60 + s, rssMb: Number(rss) / 1024 }; }));
    });
  }
});

const viewer = async ({ base, film, startAt, agent, until }) => {
  const r = { film: film.title, ttfs: null, stalls: 0, stallSec: 0, segs: 0, status: {}, playlist: 0, bytes: 0 };
  const q = `?v=${v}`;
  const pl = await get(`${base}/stream/transcode/${film.id}/jit/index.m3u8${q}`, agent);
  r.playlist = pl.status;
  if (pl.status !== 200 || !pl.text) { r.status[pl.status] = 1; return r; }
  const lines = pl.text.split("\n");
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (m) segs.push({ dur: parseFloat(m[1]), uri: lines[i + 1].trim() });
  }
  let t = 0;
  let k = 0;
  while (k < segs.length && t + segs[k].dur <= startAt) { t += segs[k].dur; k++; }
  const t0 = Date.now();
  let buffered = 0; // seconds of film in hand
  let playStart = null; // wall time playback began
  let played = 0; // seconds of film that should have played by now
  const clock = () => (playStart == null ? 0 : (Date.now() - playStart) / 1000 - r.stallSec);
  while (Date.now() < until && k < segs.length) {
    // the player's buffer: what is in hand minus what has played
    const ahead = buffered - clock();
    if (playStart != null && ahead >= BUFFER_SEC) { await sleep(250); continue; }
    const s = segs[k];
    const askedAt = Date.now();
    const a = await get(`${base}/stream/transcode/${film.id}/jit/${s.uri}`, agent);
    r.status[a.status] = (r.status[a.status] || 0) + 1;
    if (a.status !== 200) {
      if (a.status === 503) { await sleep(2000); continue; } // a player waits and asks again (or moves rung)
      await sleep(1000);
      continue;
    }
    r.segs++;
    r.bytes += a.bytes;
    if (r.ttfs == null) { r.ttfs = Date.now() - t0; playStart = Date.now(); }
    else {
      // did playback run dry while this segment was on its way?
      const dry = clock() - buffered;
      if (dry > 0) { r.stalls++; r.stallSec += dry; }
    }
    buffered += s.dur;
    k++;
    void askedAt;
  }
  r.stallSec = round(r.stallSec, 1);
  return r;
};

(async () => {
  const insts = [];
  for (const t of trees) {
    const srv = await startInstance({ movies, tree: t.dir, config: { hwEncode: hw, ...extraConfig } });
    insts.push({ ...t, srv });
    console.log(`[${t.name}] up at ${srv.url}, ${srv.films.length} films, hw ${hw}`);
  }
  // the hardware probe runs 40 s after start; give it time
  await sleep(60000); // the encode calibration (25 s in) and the hardware probe (40 s in)
  // …and, unless switched off, until the graphics card has been checked
  for (const inst of insts) {
    const until = Date.now() + 5 * 60000;
    for (;;) {
      let hwst = null;
      try { hwst = (await (await fetch(`${inst.srv.url}/api/admin/encoding`, { headers: { "X-Admin-Password": inst.srv.adminPassword } })).json()).hardware; } catch {}
      if (hw === "off" || (hwst && hwst.checked) || Date.now() > until) {
        console.log(`[${inst.name}] ${hwst ? hwst.sentence : "?"}`);
        break;
      }
      await sleep(3000);
    }
  }
  const rand = rng(Date.now() & 0xffff);
  const results = [];
  try {
    for (let rd = 0; rd < rounds; rd++) {
      for (const n of counts) {
        for (const inst of rd % 2 ? [...insts].reverse() : insts) {
          let films = inst.srv.films.filter((f) => f.duration > 1800 && (!codec || (f.video && f.video.codec === codec)));
          films = films.sort(() => rand() - 0.5).slice(0, n);
          const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
          const t0 = Date.now();
          const until = t0 + secs * 1000;
          const cpuSeen = new Map();
          let sampling = true;
          const sampler = (async () => {
            while (sampling) {
              for (const c of await childCpu(inst.srv.pid)) { const p = cpuSeen.get(c.pid) || { cpu: 0, rssMb: 0 }; cpuSeen.set(c.pid, { cpu: Math.max(p.cpu, c.cpu), rssMb: Math.max(p.rssMb, c.rssMb) }); }
              await sleep(2000);
            }
          })();
          // halfway: which encoder each running encode uses, and why (the admin page's own answer)
          let encoders = null;
          setTimeout(async () => {
            try {
              const e = await (await fetch(`${inst.srv.url}/api/admin/encoding`, { headers: { "X-Admin-Password": inst.srv.adminPassword } })).json();
              encoders = (e.cpu && e.cpu.viewers || []).map((x) => `${x.encoder || "?"}${x.why ? ` — ${x.why}` : ""}`);
            } catch {}
          }, (secs * 1000) / 2).unref?.();
          const out = await Promise.all(films.map((film) => viewer({ base: inst.srv.url, film, startAt: 600 + Math.floor(rand() * (film.duration - 1500)), agent, until })));
          const t1 = Date.now();
          sampling = false;
          await sampler;
          agent.destroy();
          // bye: the players leave (the producers stop)
          for (const f of films) await new Promise((r) => { const q = http.request(`${inst.srv.url}/stream/transcode/${f.id}/jit/bye`, { method: "POST" }, (res) => { res.resume(); res.on("end", r); }); q.on("error", r); q.end(); });
          await sleep(1500);
          const st = readStats(inst.srv.statsFile, t0, t1);
          const ff = [...cpuSeen.values()];
          const filmSec = out.reduce((a, r) => a + r.segs * 6, 0);
          const row = {
            tree: inst.name, round: rd, hw, v, viewers: n, secs,
            admitted: out.filter((r) => r.segs > 0).length,
            busy503: out.reduce((a, r) => a + (r.status[503] || 0), 0),
            other: out.reduce((a, r) => a + Object.entries(r.status).filter(([c]) => c !== "200" && c !== "503").reduce((x, [, n2]) => x + n2, 0), 0),
            ttfsP50: pct(out.map((r) => r.ttfs), 50), ttfsMax: Math.max(...out.map((r) => r.ttfs ?? 0)),
            stalled: out.filter((r) => r.stalls > 0).length, stallSec: round(out.reduce((a, r) => a + r.stallSec, 0), 1),
            segs: out.reduce((a, r) => a + r.segs, 0),
            ffmpegProcs: ff.length, ffmpegCpuSec: round(ff.reduce((a, x) => a + x.cpu, 0), 1),
            ffmpegCpuPerFilmSec: filmSec ? round(ff.reduce((a, x) => a + x.cpu, 0) / filmSec, 3) : null,
            ffmpegRssMaxMb: round(Math.max(0, ...ff.map((x) => x.rssMb)), 0),
            ...st,
            encoders,
          };
          results.push(row);
          console.log(JSON.stringify(row));
          await sleep(5000);
        }
      }
    }
  } finally {
    for (const i of insts) await i.srv.stop();
  }
  const dir = path.join(REPO, "docs", "qa", "server-round", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `hls-${label}.json`), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
