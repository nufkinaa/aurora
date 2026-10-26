#!/usr/bin/env node
// How many people one Aurora server carries: a household evening, stepped up
// until it no longer holds. docs/qa/capacity-2026-10/REPORT.md is what came of it.
//
//   node tools/loadtest/capacity.js --mix typical --steps 5,10,15,20,30,40,60 --step-min 4 --out typical-r1
//   node tools/loadtest/capacity.js --mix direct  …      every viewer plays the file as it is
//   node tools/loadtest/capacity.js --mix worst   …      40 % encoded, 30 % torrents
//
// At every step n:
//   - n VIEWERS start together ("everyone presses Play at 9 pm"): each opens
//     the app (the website on a desktop or a phone, or the TV app), its Home,
//     the title page, the subtitle (60 % of them), then plays — the title's
//     path (direct / repackaged / encoded / torrent) set by the mix. The
//     viewers of the step before leave first (their goodbye sent, as a player
//     closing does), so each step's start is a cold burst.
//   - n/2 people BROWSE beside them (screens every 20–35 s: Home, grids,
//     title pages, search, My List, pictures) and n/2 more devices sit on
//     Home (WebSocket, polls). They stay from step to step.
//   - background downloads write to the media disk (--downloads k, 4 MB/s each).
//   Then one window of --step-min minutes is measured: time to first frame,
//   segments late / starved, stalls, API p95/p99, event-loop lag, CPU of the
//   server and of its ffmpeg, the graphics card's encoder sessions and use,
//   disk, RAM, refusals. "Supported" is the rule in `supported()` below.
//
// The library is media "cap" (instance.js genMediaCap): shaped like the house
// library (median 2.5 Mbit/s 1080p, HEVC 10-bit MKV + H.264 MP4, E-AC-3/AC-3
// sound). Torrent viewers play from a swarm on this machine (swarm.js). The
// instance is private (instance.js): its own port, data and TEMP, the network
// fence, synthetic profiles; the live server is never contacted.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { start, dirSize, genMediaCap } = require("./instance");
const { Device } = require("./devices");
const { Stats, sleep, round, pct, parseArgs, machineSampler, diskSampler, gpuSampler, treeSampler, writeJson, REPO, WORK } = require("./lib");
const { measure, makeCtx, loadLibrary, notable } = require("./run");

const OUT = process.env.LT_OUT || path.join(REPO, "docs", "qa", "capacity-2026-10", "results");
const say = (s) => process.stderr.write(`[cap ${new Date().toISOString().slice(11, 19)}] ${s}\n`);

// ---------- the mixes ----------
// kind = <form>-<path>; form: tv | web (desktop) | phone; path: direct |
// offset (TV repackaged) | jit (web repackaged) | transcode (an encoded rung) |
// torrent (file over the torrent) | tjit (repackaged over the torrent).
// Each mix is a cycle: viewer i plays MIXES[mix][i % length], so every step
// carries the shares as closely as its size allows.
const MIXES = {
  // what the house recorded (REPORT.md §1): TVs on the offset copy or the
  // file, phones and tablets on Apple's HLS copy, some desktops, a few encodes
  // (step-down on a slow line, a codec the device lacks) and a torrent now and then.
  typical: ["tv-offset", "tv-direct", "phone-jit", "web-direct", "tv-offset", "phone-jit", "tv-direct", "web-transcode", "tv-offset", "phone-jit",
    "tv-direct", "web-jit", "tv-offset", "phone-transcode", "tv-direct", "phone-jit", "tv-offset", "web-direct", "tv-torrent", "tv-offset"],
  // every viewer on the file as it is (the best case)
  direct: ["tv-direct", "web-direct", "phone-direct", "tv-direct", "tv-direct", "phone-direct", "web-direct", "tv-direct", "phone-direct", "tv-direct"],
  // the worst evening: 40 % encoded, 30 % torrents, 30 % repackaged
  worst: ["web-transcode", "tv-torrent", "phone-transcode", "tv-offset", "web-tjit", "web-transcode", "tv-torrent", "phone-transcode", "phone-jit", "tv-offset"],
};
const MIX_NOTE = {
  typical: "typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %",
  direct: "all direct play: TVs 50 %, phones 30 %, desktops 20 %",
  worst: "worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged",
};
const PATH_CLASS = { direct: "direct", offset: "copy", jit: "copy", transcode: "encode", torrent: "torrent", tjit: "torrent" };

// ---------- "supported" ----------
// A step is SUPPORTED when every one of these holds (REPORT.md §2 says why):
const RULE = {
  ttffP95Ms: 4000, // time to first frame, p95, of the 9 pm burst AND of starts inside the window
  lateSegPct: 1, // segments that took longer to arrive than they last
  stallPct: 0.5, // time spent stalled, of time watched
  apiP99Ms: 300, // the API a person waits for (not pictures), p99, in the window
  refused: 0, // streams refused (503 / never started) and 429s while browsing
};
const supported = (st) => {
  const why = [];
  if (st.burst.ttffP95 == null || st.burst.ttffP95 > RULE.ttffP95Ms) why.push(`burst TTFF p95 ${st.burst.ttffP95} ms > ${RULE.ttffP95Ms}`);
  if (st.window.ttffP95 != null && st.window.ttffP95 > RULE.ttffP95Ms) why.push(`window TTFF p95 ${st.window.ttffP95} ms > ${RULE.ttffP95Ms}`);
  if (st.window.lateSegPct > RULE.lateSegPct) why.push(`${st.window.lateSegPct} % late segments > ${RULE.lateSegPct}`);
  if (st.window.stallPct > RULE.stallPct) why.push(`stalled ${st.window.stallPct} % of watch time > ${RULE.stallPct}`);
  if (st.window.apiP99 > RULE.apiP99Ms) why.push(`API p99 ${st.window.apiP99} ms > ${RULE.apiP99Ms}`);
  const refused = st.burst.neverStarted + st.burst.refused + st.window.refused + st.window.neverStarted + st.window.s429 + st.burst.s429;
  if (refused > RULE.refused) why.push(`refused: ${st.burst.neverStarted + st.window.neverStarted} never started, ${st.burst.refused + st.window.refused} stream refusals, ${st.window.s429 + st.burst.s429} × 429`);
  return { ok: why.length === 0, why };
};

// ---------- background downloads (a writer on the media disk) ----------
// What a download costs the server's machine besides the network: steady
// writes to the library disk. k writers at 4 MB/s (32 Mbit/s each), 1 MB
// writes, an fsync every 16 MB, files of 512 MB turned over. A child process,
// so the driver's own loop is not in it.
const downloads = (dir, k, mbs = 4) => {
  if (!k) return { stop: () => {}, k: 0 };
  fs.mkdirSync(dir, { recursive: true });
  const code = `const fs=require("fs"),path=require("path");const dir=${JSON.stringify(dir)},k=${k},rate=${mbs}*1048576;const buf=Buffer.alloc(1048576,7);
for(let i=0;i<k;i++){let f=null,n=0,file=0;const open=()=>{if(f!=null){fs.closeSync(f);}const p=path.join(dir,"dl"+i+"-"+(file%2)+".part");f=fs.openSync(p,"w");n=0;file++;};open();
setInterval(()=>{fs.write(f,buf,0,buf.length,null,()=>{});n++;if(n%16===0)fs.fsync(f,()=>{});if(n>=512)open();},Math.round(1000*1048576/rate));}
process.stdin.on("end",()=>process.exit(0));process.stdin.resume();`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  return { k, mbs, pid: child.pid, stop: () => { try { child.kill(); } catch {} try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); } catch {} } };
};

// ---------- the local swarm ----------
const swarm = async (files, mbs = 10) => {
  const child = spawn(process.execPath, [path.join(__dirname, "swarm.js"), "--upload-mbs", String(mbs), ...files], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const torrents = [];
  let buf = "";
  const done = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (x) => {
      buf += x;
      let i;
      while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j = null; try { j = JSON.parse(line); } catch { continue; }
        if (j.ready) resolve(j); else torrents.push(j);
      }
    });
    child.stderr.on("data", (x) => { const t = String(x).trim(); if (t) say(t.split(String.fromCharCode(10)).pop()); });
    child.on("exit", (c) => reject(new Error(`swarm exited (${c})`)));
  });
  const ready = await done;
  return { torrents, tracker: ready.tracker, pid: child.pid, stop: () => { try { child.stdin.end(); child.kill(); } catch {} } };
};

// ---------- the people ----------
class Crowd {
  constructor(ctx, srv, opts) {
    this.ctx = ctx; this.srv = srv; this.opts = opts;
    this.free = { web: srv.sessions.filter((s) => s.kind === "web"), tv: srv.sessions.filter((s) => s.kind === "tv") };
    this.browsers = []; this.idle = []; this.viewers = []; this.k = 0; this.itemTurn = {};
  }
  session(kind) {
    const s = this.free[kind].shift();
    if (!s) throw new Error(`out of ${kind} sessions: start with more profiles`);
    return s;
  }
  give(kind, s) { this.free[kind].push(s); }
  device(form) {
    const kind = form === "tv" ? "tv" : "web";
    const s = this.session(kind);
    const d = new Device(this.ctx, { ...s, kind, form: form === "tv" ? undefined : form });
    d.session = s;
    return d;
  }
  // browsers and idle devices: TVs 40 %, phones 30 %, desktops 30 %
  async grow(nBrowse, nIdle) {
    const FORMS = ["tv", "phone", "web", "tv", "phone", "web", "tv", "web", "phone", "tv"];
    const starts = [];
    while (this.browsers.length < nBrowse) {
      const form = FORMS[this.browsers.length % FORMS.length];
      const d = this.device(form);
      this.browsers.push(d);
      starts.push(d.start({ boot: true, browse: (form === "tv" ? 35 : form === "phone" ? 25 : 20) * 1000 }));
      await sleep(300);
    }
    while (this.idle.length < nIdle) {
      const form = FORMS[(this.idle.length + 3) % FORMS.length];
      const d = this.device(form);
      this.idle.push(d);
      starts.push(d.start({ boot: true, browse: null }));
      await sleep(200);
    }
  }
  // the item a viewer of this kind plays: the pool's titles in turn, so viewers watch different titles
  item(kind) {
    const pool = this.ctx.capPools[kind] || [];
    if (!pool.length) throw new Error(`no title for ${kind}`);
    const t = (this.itemTurn[kind] = (this.itemTurn[kind] || 0) + 1);
    return pool[(t - 1) % pool.length];
  }
  // n viewers press Play within `spreadS` seconds: open the app, Home, the title, then play
  async burst(n, mix, spreadS = 10) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const kind = MIXES[mix][i % MIXES[mix].length];
      const [form, how] = kind.split("-");
      const d = this.device(form);
      const v = { kind, form, how, cls: PATH_CLASS[how], device: d, leaving: false, plays: [], startedAt: null };
      list.push(v);
      this.viewers.push(v);
      v.loop = (async () => {
        await sleep(Math.random() * spreadS * 1000);
        // the app's start (Home first); its background prefetch goes on while the person picks the title
        const booting = (form === "tv" ? d.tvBoot() : d.boot()).catch(() => {});
        await Promise.race([booting, sleep(3000)]);
        let first = true;
        while (!v.leaving && !d.stopped) {
          const item = this.item(kind);
          // the title page first (what a person opens before Play)
          if (!String(item.id).startsWith("torrent|")) {
            await Promise.all([d.hit("title", "GET", `/api/item/${item.id}?profile=${d.profileId}`), d.hit("state", "GET", `/api/profiles/${d.profileId}/state`)]);
          }
          await sleep(first ? 800 + Math.random() * 1500 : 2000);
          first = false;
          if (v.leaving) break;
          // half resume somewhere in the film, half start at the beginning
          const startAt = Math.random() < 0.5 ? Math.floor(item.duration * (0.05 + Math.random() * 0.7)) : 0;
          const mode = how === "offset" ? "offset" : how === "jit" ? "jit" : how === "transcode" ? "transcode" : how === "torrent" ? "torrent" : how === "tjit" ? "torrent-jit" : "direct";
          const variant = how === "transcode" ? (form === "phone" ? "h264-480" : "h264-720") : null;
          const seg = form === "phone" && (how === "jit" || how === "transcode" || how === "tjit") ? "fmp4" : null;
          const pr = d.play(item, mode, { seekEveryMin: this.opts.seekMin, variant, seg, startAt, subs: Math.random() < 0.6 && !String(item.id).startsWith("torrent|") });
          v.current = d.playing;
          const p = await pr;
          v.plays.push(p);
        }
      })();
    }
    return list;
  }
  // every viewer of the step before leaves (the player's goodbye is sent), then their devices close
  async leave() {
    const vs = this.viewers.splice(0);
    for (const v of vs) { v.leaving = true; if (v.device.playing && v.device.playing.stop) v.device.playing.stop(); }
    await Promise.race([Promise.all(vs.map((v) => v.loop)), sleep(30000)]);
    for (const v of vs) { v.device.stop(); this.give(v.device.kind, v.device.session); }
    return vs.length;
  }
  stop() { for (const d of [...this.browsers, ...this.idle, ...this.viewers.map((v) => v.device)]) d.stop(); }
}

// ---------- reading a step ----------
const q = (xs, p) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? Math.round(pct(s, p)) : null; };
const snapViewer = (p) => ({ ...p.buf.report(), bytes: p.bytes, segN: p.segN, segLate: p.segLate, segStarve: p.segStarve, refused: p.refused, segFails: p.segFails });
// the burst: every viewer's first play, from press to first frame (or not, after `maxS`)
const readBurst = async (ctx, list, maxS) => {
  const t0 = Date.now();
  for (;;) {
    const firsts = list.map((v) => v.current || (v.device.playing) || null);
    const started = firsts.filter((p) => p && p.buf.ttffMs != null).length;
    if (started === list.length || Date.now() - t0 > maxS * 1000) break;
    await sleep(500);
  }
  const firsts = list.map((v) => v.current || v.device.playing || v.plays[0] || null);
  const ttff = firsts.map((p) => (p && p.buf.ttffMs != null ? p.buf.ttffMs : null));
  const byClass = {};
  const byKind = {};
  list.forEach((v, i) => { (byClass[v.cls] = byClass[v.cls] || []).push(ttff[i]); (byKind[v.kind] = byKind[v.kind] || []).push(ttff[i]); });
  const api = ctx.stats.total((g) => ["home", "library", "state", "title", "grid", "search", "suggest", "person", "boot", "api-other", "tv"].includes(g));
  const subs = ctx.stats.rows().find((r) => r.group === "subtitle");
  return {
    n: list.length, secs: round((Date.now() - t0) / 1000, 1),
    ttffP50: q(ttff, 50), ttffP95: q(ttff, 95), ttffMax: q(ttff, 100),
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, xs]) => [k, { n: xs.length, p50: q(xs, 50), p95: q(xs, 95), max: q(xs, 100), never: xs.filter((x) => x == null).length }])),
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, xs]) => [k, { n: xs.length, p50: q(xs, 50), p95: q(xs, 95), max: q(xs, 100), never: xs.filter((x) => x == null).length }])),
    neverStarted: ttff.filter((x) => x == null).length,
    refused: firsts.reduce((a, p) => a + (p ? p.refused : 0), 0),
    apiP50: api.p50, apiP95: api.p95, apiP99: api.p99, apiN: api.n, s429: api.s429, s5xx: api.s5xx + api.s503 + api.net,
    subtitle: subs ? { n: subs.n, p95: subs.p95, err: subs.err } : null,
    groups: ctx.stats.rows().map((r) => ({ group: r.group, n: r.n, err: r.err, p50: r.p50, p95: r.p95, max: r.max, codes: r.codes })),
  };
};
const readWindow = (ctx, list, before, w, secs) => {
  const rows = [];
  for (const v of list) {
    for (const p of [...v.plays, v.device.playing].filter(Boolean)) {
      const a = before.get(p) || { stalls: 0, stallMs: 0, seeks: 0, seekMs: [], bytes: 0, segN: 0, segLate: 0, segStarve: 0, refused: 0, playedSec: 0, segFails: 0 };
      const b = snapViewer(p);
      if (p.endedAt && p.endedAt < w.t0) continue;
      rows.push({ kind: v.kind, cls: v.cls, title: p.title, state: b.state, startedInWindow: !before.has(p), ttffMs: !before.has(p) ? b.ttffMs : null, neverStarted: !before.has(p) && b.neverStarted && (p.endedAt || Date.now()) - p.t0 > 30000,
        stalls: b.stalls - a.stalls, stallMs: b.stallMs - a.stallMs, playedSec: b.playedSec - a.playedSec, seeks: b.seeks - a.seeks, seekMs: b.seekMs.slice(a.seekMs.length),
        bytes: b.bytes - a.bytes, segN: b.segN - a.segN, segLate: b.segLate - a.segLate, segStarve: b.segStarve - a.segStarve, refused: b.refused - a.refused, segFails: b.segFails - a.segFails });
    }
  }
  const sum = (f) => rows.reduce((x, r) => x + (f(r) || 0), 0);
  const segN = sum((r) => r.segN);
  const played = sum((r) => r.playedSec);
  const byClass = {};
  for (const r of rows) {
    const c = (byClass[r.cls] = byClass[r.cls] || { viewers: 0, bytes: 0, segN: 0, segLate: 0, stalls: 0, stallMs: 0 });
    c.viewers++; c.bytes += r.bytes; c.segN += r.segN; c.segLate += r.segLate; c.stalls += r.stalls; c.stallMs += r.stallMs;
  }
  for (const c of Object.values(byClass)) { c.mbitPerViewer = round((c.bytes * 8) / 1e6 / secs / Math.max(1, c.viewers / 1), 2); c.mbitTotal = round((c.bytes * 8) / 1e6 / secs, 1); }
  const api = w.client.api;
  return {
    viewers: list.length, plays: rows.length, startsInWindow: rows.filter((r) => r.startedInWindow).length,
    ttffP50: q(rows.filter((r) => r.startedInWindow).map((r) => r.ttffMs), 50), ttffP95: q(rows.filter((r) => r.startedInWindow).map((r) => r.ttffMs), 95),
    neverStarted: rows.filter((r) => r.neverStarted).length,
    seeks: sum((r) => r.seeks), seekP50: q(rows.flatMap((r) => r.seekMs), 50), seekP95: q(rows.flatMap((r) => r.seekMs), 95),
    segN, lateSegPct: segN ? round((100 * sum((r) => r.segLate)) / segN, 2) : 0, starvedSegPct: segN ? round((100 * sum((r) => r.segStarve)) / segN, 2) : 0,
    stalls: sum((r) => r.stalls), stallPct: played ? round((100 * sum((r) => r.stallMs) / 1000) / played, 3) : 0, watchedMin: round(played / 60, 1),
    refused: sum((r) => r.refused), segFails: sum((r) => r.segFails),
    egressMbit: round((sum((r) => r.bytes) * 8) / 1e6 / secs, 1), mbitPerViewer: round((sum((r) => r.bytes) * 8) / 1e6 / secs / Math.max(1, list.length), 2), byClass,
    apiP50: api.p50, apiP95: api.p95, apiP99: api.p99, apiN: api.n, s429: w.client.browse.s429, browseErr: w.client.browse.s5xx + w.client.browse.net + w.client.browse.s503,
    imagesP95: w.client.images.p95, browseP99: w.client.browse.p99, browseRps: round(w.client.browse.n / secs, 1),
    lagP50: w.client.lagProbe.p50, lagP99: w.client.lagProbe.p99, lagMax: w.client.lagProbe.max,
    loopP99: w.server.loop ? w.server.loop.p99 : null, loopMax: w.server.loop ? w.server.loop.max : null, elu: w.server.elu,
    stallLoopMsPerMin: w.server.stalls ? round(w.server.stalls.totalMs / (secs / 60), 0) : null, stallLoopMax: w.server.stalls ? w.server.stalls.max : null,
    serverCores: w.tree.serverCores, ffmpegCores: w.tree.kidsCores, ffmpegAlive: w.tree.kidsAlive, rssMb: w.tree.rssMb, ffmpegRssMb: w.tree.kidsRssMb,
    pcCpuPct: w.machine ? w.machine.cpuPctMean : null, pcCpuP95: w.machine ? w.machine.cpuPctP95 : null, pcFreeMbMin: w.machine ? w.machine.freeMbMin : null,
    diskBusyPct: w.disk ? w.disk.busyPctMean : null, diskReadMBs: w.disk ? w.disk.readMBsMean : null,
    dataGrewMb: round(w.dataDir.grewBytes / 1048576, 1), driverCores: w.driverCores,
    detail: rows.map((r) => ({ kind: r.kind, title: r.title, state: r.state, ttff: r.ttffMs, stalls: r.stalls, stallMs: r.stallMs, seeks: r.seeks, seekMs: r.seekMs, segN: r.segN, late: r.segLate, starved: r.segStarve, refused: r.refused, segFails: r.segFails, mbit: round((r.bytes * 8) / 1e6 / secs, 2) })),
  };
};

const adminGet = async (srv, p) => {
  try {
    const r = await fetch(srv.url + p, { headers: { "X-Admin-Password": srv.adminPassword }, signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
// the server's own count of encodes, every 10 s of the window
const encWatcher = (srv) => {
  const samples = [];
  let stop = false;
  (async () => {
    while (!stop) {
      const e = await adminGet(srv, "/api/admin/encoding");
      if (e) samples.push({ t: Date.now(), active: e.running ? e.running.active : null, limit: e.limit, otherShare: e.otherShare, overloaded: e.overloaded, hw: e.hardware && e.hardware.sessions, fallbacks: e.hardware && e.hardware.fallbacks });
      await sleep(10000);
    }
  })();
  return { samples, stop: () => { stop = true; } };
};

const main = async () => {
  const a = parseArgs();
  const mix = a.mix || "typical";
  if (!MIXES[mix]) throw new Error(`unknown mix ${mix} (${Object.keys(MIXES).join(", ")})`);
  const steps = String(a.steps || "5,10,15,20,30,40,60").split(",").map(Number);
  const stepMin = Number(a["step-min"]) || 4;
  const warm = Number(a.warm) || 40;
  const nDl = a.downloads != null ? Number(a.downloads) : 2;
  const seekMin = Number(a["seek-min"]) || 10;
  const maxN = Math.max(...steps);
  const nMax = maxN + Math.ceil(maxN / 2) * 2;
  const hasTorrent = MIXES[mix].some((k) => /-(torrent|tjit)$/.test(k));
  fs.mkdirSync(OUT, { recursive: true });
  const name = a.out || `cap-${mix}-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}`;
  const file = path.join(OUT, `${name}.json`);

  const machine = machineSampler();
  const gpu = gpuSampler(2000);
  // what the rest of the PC is doing before anything of this run exists (other programs share it)
  const tIdle = Date.now();
  await sleep((Number(a["idle-s"]) || 30) * 1000);
  const pcBefore = { ...machine.summary(tIdle), gpu: gpu.summary(tIdle) };
  say(`the PC before the run: CPU ${pcBefore.cpuPctMean} % (p95 ${pcBefore.cpuPctP95}), free RAM ${pcBefore.freeMbMin} MB, GPU encoder sessions ${pcBefore.gpu ? pcBefore.gpu.sessionsMax : "?"}`);
  const media = genMediaCap({ log: say });
  // torrents: hard links of one house-like release (HEVC + AAC in MKV) under their own names
  let sw = null;
  if (hasTorrent) {
    const src = path.join(WORK, "torrent-src");
    fs.mkdirSync(src, { recursive: true });
    const files = [];
    for (let k = 1; k <= 8; k++) {
      const f = path.join(src, `Cap Torrent ${k} (2024) 1080p WEB-DL HEVC.mkv`);
      if (!fs.existsSync(f)) fs.linkSync(path.join(media.dir, "masters", "hevc-aac.mkv"), f);
      files.push(f);
    }
    say(`seeding ${files.length} torrents on 127.0.0.1 (hashing first)`);
    sw = await swarm(files, a["swarm-mbs"] != null ? Number(a["swarm-mbs"]) : 10);
    say(`swarm ready: ${sw.torrents.length} torrents, tracker ${sw.tracker}`);
  }
  // profiles: each gives one web and one TV session; viewers + browsers + idle at the largest step
  const profiles = Math.max(8, Math.ceil(nMax * 0.7) + 6);
  say(`starting ${a.ref || "HEAD"} (${profiles} profiles, media cap${hasTorrent ? ", torrents on a local swarm" : ""})`);
  const srv = await start({ ref: a.ref, profiles, media: "cap", verbose: !!a.verbose, torrents: hasTorrent, network: false, config: { prewarmStreams: false, ...(a.config ? JSON.parse(a.config) : {}) } });
  say(`up: ${srv.ref} at ${srv.url} in ${srv.upMs} ms (pid ${srv.pid})`);
  if (sw) {
    const dir = path.join(srv.dataDir, "cache", "torrents");
    fs.mkdirSync(dir, { recursive: true });
    for (const t of sw.torrents) fs.writeFileSync(path.join(dir, `${t.infoHash}.torrent`), Buffer.from(t.torrent, "base64"));
  }
  const tree = treeSampler(srv.pid, 2000);
  tree.disk = diskSampler(media.dir);
  const dl = downloads(path.join(WORK, "downloads-sim"), nDl);
  const ctx = makeCtx(srv);
  // each device's own network (http.js linkMbit): a TV on the house Wi-Fi/Ethernet, a phone, a desktop
  const link = String(a.link || "tv=80,phone=50,desktop=200");
  ctx.link = link === "off" ? null : Object.fromEntries(link.split(",").map((x) => x.split("=")).map(([k, v]) => [k, Number(v)]));
  const crowd = new Crowd(ctx, srv, { seekMin });
  const result = { meta: { at: new Date().toISOString(), mix, note: MIX_NOTE[mix], cycle: MIXES[mix], steps, stepMin, warm, downloads: { k: nDl, mbsEach: 4 }, seekMin, rule: RULE,
    link: link, pcBefore,
    host: { cpus: os.cpus().length, cpu: os.cpus()[0].model, memGb: Math.round(os.totalmem() / 1073741824), platform: process.platform, node: process.version },
    ref: srv.ref, head: srv.head, dirty: srv.dirty, args: a }, steps: [] };
  try {
    const lib = await loadLibrary(ctx, srv);
    say(`library: ${lib.movies} films, ${lib.shows} shows, ${lib.playable} playable`);
    // the pools: house-like titles (30 min), by what each kind plays
    const cap = [...ctx.lib.items.values()].filter((it) => /^Cap /.test(it.title || "") && it.duration > 1500);
    const pools = {
      "tv-direct": cap.filter((it) => it.cls.tv === "direct"), "tv-offset": cap.filter((it) => it.cls.tv !== "direct"),
      "web-direct": cap.filter((it) => it.cls.web === "direct"), "phone-direct": cap.filter((it) => it.cls.web === "direct"),
      "web-jit": cap.filter((it) => it.cls.web !== "direct"), "phone-jit": cap.filter((it) => it.cls.web !== "direct"),
      "web-transcode": cap.filter((it) => !/Heavy/.test(it.title)), "phone-transcode": cap.filter((it) => !/Heavy/.test(it.title)),
    };
    if (sw) {
      const titems = sw.torrents.map((t) => ({ id: `torrent|${t.infoHash}|0`, title: t.name, infoHash: t.infoHash, fileIdx: 0, duration: 1800, sizeBytes: t.length, video: { codec: "hevc" } }));
      pools["tv-torrent"] = titems; pools["web-tjit"] = titems;
    }
    for (const k of Object.keys(pools)) pools[k].sort(() => Math.random() - 0.5);
    ctx.capPools = pools;
    result.meta.pools = Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]));
    result.meta.titles = cap.map((it) => ({ title: it.title, video: it.video && it.video.codec, audio: it.audio && it.audio.codec, mbit: round(it.cls.kbps / 1000, 2), web: it.cls.web, tv: it.cls.tv }));
    say(`pools ${JSON.stringify(result.meta.pools)}`);
    // a server that has been up all evening has its torrent engine loaded: load it now (the first
    // torrent request loads webtorrent's modules on the event loop, once per server life)
    if (sw) {
      const d = new Device(ctx, { ...srv.sessions.find((x) => x.kind === "tv"), kind: "tv" });
      await d.hit("setup", "GET", `/stream/torrent/${sw.torrents[0].infoHash}/0`, { headers: { Range: "bytes=0-65535" }, compressed: false, timeoutMs: 60000 });
      d.stop();
    }
    // the boot's background work and the graphics-card probe first
    for (let t0 = Date.now(), calm = 0; Date.now() - t0 < 300000;) {
      await sleep(5000);
      const s = await srv.snap(true);
      const e = await adminGet(srv, "/api/admin/encoding");
      // (the graphics-card check opens several encoders at once a while after the start: done first)
      const probed = !!(e && e.hardware && e.hardware.checked);
      calm = s.elu < 0.04 && probed ? calm + 1 : 0;
      if (calm >= 2) break;
    }
    const enc0 = await adminGet(srv, "/api/admin/encoding");
    result.meta.encoding = enc0;
    say(`encoding: ${enc0 ? JSON.stringify({ limit: enc0.limit, capacity: enc0.capacity, otherShare: enc0.otherShare, hw: enc0.hardware && enc0.hardware.sessions, family: enc0.hardware && enc0.hardware.family }) : "?"}`);
    let bad = 0;
    for (const n of steps) {
      const nb = Math.round(n / 2), ni = Math.round(n / 2);
      say(`step ${n}: ${n} viewers, ${nb} browsing, ${ni} idle`);
      await crowd.grow(nb, ni);
      const left = await crowd.leave();
      if (left) { say(`  ${left} viewers left; a breath`); await sleep(15000); }
      // the 9 pm burst
      ctx.stats = new Stats();
      await srv.snap(true);
      const tb = Date.now();
      const cpu0 = process.cpuUsage();
      // the event loop as anyone meets it, during the burst too
      const lag = []; let lagOn = true;
      (async () => { const { Client } = require("./http"); const lc = new Client(srv.url, { maxSockets: 1 }); while (lagOn) { const r = await lc.request("GET", "/healthz", { compressed: false, timeoutMs: 20000 }); lag.push(r.status === 200 ? r.ms : 20000); await sleep(200); } lc.close(); })();
      const list = await crowd.burst(n, mix, Number(a.spread) || 10);
      const burst = await readBurst(ctx, list, 90);
      lagOn = false;
      const tbe = Date.now();
      burst.gpu = gpu.summary(tb, tbe);
      const sb = await srv.snap(true);
      burst.server = { loop: sb.loop && { p50: sb.loop.p50, p99: sb.loop.p99, max: sb.loop.max }, stalls: sb.stalls && { n100: sb.stalls.n100, n1000: sb.stalls.n1000, totalMs: sb.stalls.totalMs, max: sb.stalls.max, waitMs: sb.stalls.waitMs, busyMs: sb.stalls.busyMs }, elu: sb.elu, slowSync: (sb.slowSync || []).slice(0, 10), http: sb.http };
      burst.lag = { n: lag.length, p50: q(lag, 50), p99: q(lag, 99), max: q(lag, 100) };
      burst.tree = tree.between(tb, tbe);
      burst.machine = machine.summary(tb);
      burst.driverCores = round((((c) => c.user + c.system)(process.cpuUsage(cpu0)) / 1e6) / ((tbe - tb) / 1000), 3);
      burst.egressMbit = round((list.reduce((x, v) => x + (v.current ? v.current.bytes : 0), 0) * 8) / 1e6 / ((tbe - tb) / 1000), 1);
      say(`  burst: TTFF p50/p95/max ${burst.ttffP50}/${burst.ttffP95}/${burst.ttffMax} ms, never ${burst.neverStarted}, refused ${burst.refused}, API p95/p99 ${burst.apiP95}/${burst.apiP99}, lag p99/max ${burst.lag.p99}/${burst.lag.max}, loop stalls>1s ${burst.server.stalls ? burst.server.stalls.n1000 : "?"}, server ${burst.tree ? burst.tree.serverCores : "?"} + ffmpeg ${burst.tree ? burst.tree.kidsCores : "?"} cores, driver ${burst.driverCores}, PC ${burst.machine.cpuPctMean} %, ${burst.egressMbit} Mbit/s`);
      await sleep(warm * 1000);
      // the window
      const before = new Map();
      for (const v of list) for (const p of [...v.plays, v.device.playing].filter(Boolean)) before.set(p, snapViewer(p));
      const ew = encWatcher(srv);
      const t0 = Date.now();
      const w = await measure({ srv, ctx, tree, machine, secs: stepMin * 60, label: `${mix} n=${n}` });
      w.t0 = t0;
      ew.stop();
      const win = readWindow(ctx, list, before, w, w.secs);
      win.gpu = gpu.summary(t0, Date.now());
      const es = ew.samples;
      win.encodes = es.length ? {
        activeMax: Math.max(...es.map((x) => x.active || 0)), limitMin: Math.min(...es.map((x) => (x.limit == null ? 99 : x.limit))), otherShareMax: Math.max(...es.map((x) => x.otherShare || 0)), overloaded: es.some((x) => x.overloaded),
        hwSessionsMax: Math.max(...es.map((x) => (x.hw && x.hw.running) || 0)), hwMax: es[0].hw && es[0].hw.max, fallbacks: es[es.length - 1].fallbacks,
      } : null;
      const st = { n, browsing: nb, idle: ni, devices: crowd.browsers.length + crowd.idle.length + list.length, burst, window: win };
      st.verdict = supported(st);
      st.raw = { groups: w.client.groups, server: { loop: w.server.loop, stalls: w.server.stalls, http: w.server.http, slowSync: w.server.slowSync, mem: w.server.mem }, tree: w.tree, disk: w.disk, machine: w.machine, counters: w.counters };
      result.steps.push(st);
      say(`  n=${n}: TTFF window p95 ${win.ttffP95}, late seg ${win.lateSegPct} %, stalled ${win.stallPct} %, API p95/p99 ${win.apiP95}/${win.apiP99}, lag p99 ${win.lagP99}, server ${win.serverCores} + ffmpeg ${win.ffmpegCores} cores, GPU enc ${win.gpu ? win.gpu.encPctMean : "?"} % (${win.gpu ? win.gpu.sessionsMax : "?"} sessions), egress ${win.egressMbit} Mbit/s — ${st.verdict.ok ? "SUPPORTED" : "NOT: " + st.verdict.why.join("; ")}`);
      writeJson(file, { ...result, partial: true });
      if (!st.verdict.ok) bad++;
      if (bad >= Number(a["stop-after"] || 2)) { say("not supported twice: the ramp stops"); break; }
      if (srv.exited()) { say("the server exited"); break; }
    }
    result.notable = notable(srv).slice(-300);
    result.exited = srv.exited();
  } finally {
    crowd.stop(); dl.stop(); tree.stop(); if (tree.disk) tree.disk.stop(); machine.stop(); gpu.stop();
    await srv.stop();
    if (sw) sw.stop();
  }
  writeJson(file, result);
  fs.writeFileSync(file.replace(/\.json$/, ".md"), render(result));
  say(`wrote ${file} and .md`);
  process.stdout.write(render(result) + "\n");
  process.exit(0);
};

// ---------- the table ----------
const render = (r) => {
  const head = `### ${r.meta.mix} — ${r.meta.ref} — ${r.meta.at}\n\n${r.meta.note}. Steps of ${r.meta.stepMin} min after a cold burst; ${r.meta.downloads.k} background downloads; host ${r.meta.host.cpu} (${r.meta.host.cpus} threads, ${r.meta.host.memGb} GB).\n\n`;
  const cols = ["n viewers", "browsing", "burst TTFF p50/p95 ms", "window TTFF p95", "late seg %", "starved seg %", "stall % of watch", "API p95/p99 ms", "pictures p95", "lag p99 ms", "server cores", "ffmpeg cores", "GPU enc % (sessions)", "encodes/limit (card/max)", "RSS MB (+ffmpeg)", "PC CPU %", "egress Mbit/s", "Mbit/viewer", "refused", "verdict"];
  const rows = r.steps.map((s) => {
    const w = s.window, b = s.burst;
    return [s.n, s.browsing, `${b.ttffP50}/${b.ttffP95}`, w.ttffP95, w.lateSegPct, w.starvedSegPct, w.stallPct, `${w.apiP95}/${w.apiP99}`, w.imagesP95, w.lagP99, w.serverCores, w.ffmpegCores,
      w.gpu ? `${w.gpu.encPctMean} (${w.gpu.sessionsMax})` : "", w.encodes ? `${w.encodes.activeMax}/${w.encodes.limitMin} (${w.encodes.hwSessionsMax}/${w.encodes.hwMax})` : "", `${w.rssMb} (+${w.ffmpegRssMb})`, w.pcCpuPct, w.egressMbit, w.mbitPerViewer,
      b.neverStarted + b.refused + w.refused + w.neverStarted + w.s429 + b.s429, s.verdict.ok ? "supported" : `**no**: ${s.verdict.why.join("; ")}`];
  });
  return head + `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n` + rows.map((x) => `| ${x.map((v) => (v == null ? "" : String(v))).join(" | ")} |`).join("\n") + "\n";
};

module.exports = { MIXES, RULE, supported, render };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
