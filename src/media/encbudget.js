// How many viewers this machine can encode for at once — worked out, not
// written down.
//
// The limit used to be the number 2, in three files. On a desktop i5 that
// left three quarters of the CPU idle while a third transcoding viewer was
// told "the server is busy"; on a small laptop CPU two 4K encodes were more
// than it could do in real time. The right number depends on the machine and
// on what is being asked, so both are measured.
//
// THE UNIT is a thread-second per second of film: one logical CPU, busy for
// one second, to produce one second of the film (docs/qa/capacity/REPORT.md
// §2, where the costs below were measured — on the reference machine, an
// i7-10700K, with its sibling threads busy).
//
// WHAT A JOB COSTS (costOf): decoding the source (per megapixel; HEVC more
// than H.264), encoding the output (per megapixel, a little more than
// linear), tone mapping when the source is HDR, all scaled by the frame rate.
// The measured table it is fitted to:
//     1080p H.264 → 480p 0.44      1080p HEVC → 1080p 1.23    4K HDR → 720p tone-mapped 2.8
//     1080p H.264 → 720p 0.60      4K HEVC   → 720p  1.9      4K HDR → 1080p tone-mapped 3.7–4.2
//     1080p HEVC  → 720p 0.73      4K HEVC   → 1080p 2.3–2.5
//
// WHAT THE MACHINE HAS (capacity): logical CPUs — less the share other
// programs on it are using (watched while Aurora itself is encoding nothing:
// a server that shares its box with a game or a build must not count their
// cores as its own) — × this machine's speed relative to the reference ×
// HEADROOM (0.70: the event loop, direct play, downloads and the OS keep the
// rest, and every encode keeps running faster than the film — measured: at
// the limit each one makes about 1.2× real time). The speed is MEASURED: the ladder's own x264 settings on a
// generated 1080p picture, counted in CPU seconds (which do not move with
// how busy the machine is at that moment), kept in
// data/cache/encode-calibration.json and measured again when the CPU or
// ffmpeg changes, or after a month.
//
// Memory is a second limit: an encoder holds 0.3–1.1 GB (memOf); none is
// started that would not fit in what is free, less a reserve.
//
// THE NUMBER shown to a person ("Automatic: 5 now") is how many standard
// 1080p transcodes fit: capacity ÷ 1.23. Admission itself is by cost, so a
// 4K HDR source takes the room of three, and a 480p rung a third of one.
//
// WHILE RUNNING: if an encoder that somebody is waiting on makes less than
// one second of film per second for a while, on a machine whose CPUs are
// busy, the server is over its real capacity whatever the sums said. New
// encodes are then refused (the same quick "busy" as at the limit) and the
// newest background job is shed, until it has caught up.
//
// THE OVERRIDE: settings "maxEncodes" — "auto" (the default), or a number
// 1–16, which is then a plain count as it always was (every encode one slot).
// Until start() is called (the tests, the first moments of a boot) the limit
// is the old fixed 2.
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HEADROOM = 0.7;
const COST_REF = 1.23; // 1080p HEVC → 1080p H.264 at 24 fps: "one transcode"
const MEM_RESERVE_MB = 1024; // left free for the server, the page cache, everything else
const MEM_SHARE = 0.6; // of all RAM, at the very most, to encoders
const MAX_FIXED = 16;
// CPU seconds per second of film for the calibration job (below) on the
// reference machine (i7-10700K, ffmpeg 6.0 / libx264): the least of 24
// runs, 2026-10-11 (0.71–0.76 when its cores were free, up to 1.16 with
// every sibling thread busy). The least is the machine's own figure; the
// costs above already carry the busy-sibling penalty.
const REF_CAL = 0.74;
const CAL_FRAMES = 240; // ten seconds of 1080p at 24 fps
const CAL_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const UNKNOWN_SPEED = 0.6; // before the first measurement: assume a slow machine
const BEHIND_SPEED = 1.0; // film seconds per second
const BEHIND_FOR_MS = 15 * 1000;
const OVERLOAD_HOLD_MS = 30 * 1000;
const BUSY_CPU = 0.85;

const deps = {
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  now: () => Date.now(),
  ffmpeg: () => require("../config").FFMPEG,
  cacheFile: () => path.join(require("../config").CACHE_DIR, "encode-calibration.json"),
  setting: () => { try { return require("../lib/settings").data.maxEncodes; } catch { return undefined; } },
  viewerBusy: () => { try { return require("./cpuwork").viewer.busy(); } catch { return false; } },
  shed: (why) => { try { return require("./cpuwork").background.shedNewest(why); } catch { return null; } },
  run: null, // (args) => Promise<{ cpuSec, wallSec } | null> — the calibration encode; the tests replace it
  version: null, // () => Promise<string> — ffmpeg's version line
};

const state = {
  started: false,
  cal: null, // { speed, cpuSecPerFilmSec, wallSpeed, threads, at, key: { cpu, logical, ffmpeg } }
  calibrating: null,
  progress: new Map(), // key -> { samples: [{ t, film }], waited }
  overloadedUntil: 0,
  overloadWhy: null,
  cpuSample: null, // { t, busy, total }
  cpuBusy: null,
  other: { last: null, shares: [] }, // CPU share taken by everything else, sampled while nothing is being encoded
  otherTimer: null,
  refusedForLoad: 0,
};

// ------------------------------------------------------------ what a job costs

const mp = (w, h) => (w > 0 && h > 0 ? (w * h) / 1e6 : 0);
// The output size a rung makes from a source (the ladder's own rule:
// a capped rung folds to its height, the full one folds anything over 1920).
const outDims = (srcW, srcH, outH) => {
  const w = srcW > 0 ? srcW : 1920;
  const h = srcH > 0 ? srcH : 1080;
  if (outH > 0 && outH < h) return { w: Math.round((w * outH) / h), h: outH };
  if (w > 1920) return { w: 1920, h: Math.round((h * 1920) / w) };
  return { w, h };
};
// { srcW, srcH, outH, codec, fps, tonemap, legacy } -> thread-seconds per film-second
const costOf = (j = {}) => {
  const srcW = j.srcW > 0 ? j.srcW : 1920;
  const srcH = j.srcH > 0 ? j.srcH : 1080;
  const out = outDims(srcW, srcH, j.outH || 0);
  const srcMP = mp(srcW, srcH);
  const outMP = mp(out.w, out.h);
  const h264 = /^(h264|avc)/i.test(String(j.codec || ""));
  const decode = h264 ? srcMP * 0.14 + 0.02 : srcMP * 0.189 + 0.04; // unknown codec: the dearer one
  const encode = outMP * 0.26 + outMP * outMP * 0.06;
  const tone = j.tonemap ? outMP * 0.72 + 0.2 : 0;
  const rate = Math.min(2.5, Math.max(1, (j.fps > 0 ? j.fps : 24) / 24));
  const cost = (decode + encode + tone) * rate * (j.legacy ? 1.06 : 1);
  return Math.round(cost * 100) / 100;
};
// Peak memory of the same job, MB.
const memOf = (j = {}) => {
  const srcW = j.srcW > 0 ? j.srcW : 1920;
  const srcH = j.srcH > 0 ? j.srcH : 1080;
  const out = outDims(srcW, srcH, j.outH || 0);
  return Math.round(150 + mp(srcW, srcH) * 72 + mp(out.w, out.h) * 90 + (j.tonemap ? 60 : 0) + (j.legacy ? 110 : 0));
};

// ------------------------------------------------------------- the machine

// The CPUs this process may use: all of them, unless it was started with
// fewer (an affinity mask, `taskset`, `start /affinity`, a container's
// cpuset, a cgroup CPU quota — lib/cpucount.js). A 2-core slice of a
// 16-thread box is sized as 2 cores.
const restricted = () => { try { return require("../lib/cpucount").restricted(); } catch { return 0; } };
const logicalCpus = () => restricted() || Math.max(1, deps.cpus().length);

const cpuKey = () => {
  const c = deps.cpus();
  return { cpu: (c[0] && c[0].model ? c[0].model : "unknown").trim(), logical: logicalCpus() };
};

// "auto" | n (1..MAX_FIXED) — what the admin chose; anything else is auto.
const override = () => {
  const v = deps.setting();
  const n = Number(v);
  if (v !== "auto" && v !== undefined && v !== null && Number.isInteger(n) && n >= 1 && n <= MAX_FIXED) return n;
  return "auto";
};
const mode = () => {
  if (!state.started) return { fixed: 2, why: "not started" };
  const o = override();
  return o === "auto" ? { fixed: 0 } : { fixed: o, why: "set by the admin" };
};

// This machine's per-thread speed relative to the reference machine.
const speed = () => (state.cal && state.cal.speed > 0 ? state.cal.speed : UNKNOWN_SPEED);

// The share of the CPUs that other programs (and the rest of Aurora) are
// using: the median of the samples taken while no encode of ours was running
// (OTHER_KEEP of them, one every OTHER_EVERY_MS — the last ten minutes of
// such moments). 0 until there is one. Capped: however busy the box, a
// quarter of it is still counted as ours to try.
const OTHER_EVERY_MS = 15 * 1000;
const OTHER_KEEP = 40;
const OTHER_MAX = 0.75;
const OTHER_MIN = 0.05;
const otherShare = () => {
  const a = state.other.shares;
  if (!a.length) return 0;
  const sorted = a.slice().sort((x, y) => x - y);
  const median = Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
  if (median < OTHER_MIN) return 0; // an idle machine is never quite at zero: that is not somebody else using it
  return Math.min(OTHER_MAX, median);
};
const cpuTotals = () => {
  let busy = 0;
  let total = 0;
  for (const c of deps.cpus()) {
    const t = c.times || {};
    const b = (t.user || 0) + (t.sys || 0) + (t.nice || 0) + (t.irq || 0);
    busy += b;
    total += b + (t.idle || 0);
  }
  return { busy, total };
};
// One look. `encoding`: something of ours is encoding right now — then the
// reading says nothing about the others, and the next one starts afresh.
const sampleOther = (encoding) => {
  const now = cpuTotals();
  const prev = state.other.last;
  state.other.last = encoding ? null : now;
  if (encoding || !prev || now.total <= prev.total) return null;
  const share = (now.busy - prev.busy) / (now.total - prev.total);
  state.other.shares.push(Math.max(0, Math.min(1, share)));
  while (state.other.shares.length > OTHER_KEEP) state.other.shares.shift();
  return share;
};

// Units available to viewer encodes.
const capacity = () => {
  const m = mode();
  if (m.fixed) return m.fixed;
  return Math.round(logicalCpus() * (1 - otherShare()) * speed() * HEADROOM * 100) / 100;
};
// What one job counts as. A fixed limit is a plain count: every job is 1.
const costFor = (spec) => (mode().fixed ? 1 : costOf(spec));
const unit = () => (mode().fixed ? 1 : COST_REF);
// Kept free for a device that cannot play its file any other way: a courtesy
// rung (a lighter stream for a slow line) never takes the last of the room.
const reserve = () => (mode().fixed ? 1 : Math.min(COST_REF, capacity() / 2));
// The number a person is shown: standard 1080p transcodes that fit.
const slots = () => (mode().fixed ? mode().fixed : Math.max(1, Math.floor(capacity() / COST_REF + 1e-9)));

const memBudgetMb = () => Math.max(0, Math.min(deps.freemem() / 1048576 - MEM_RESERVE_MB, (deps.totalmem() / 1048576) * MEM_SHARE));

// May a job of this cost start, given what is running (in units)?
//   running   everything already encoding that this job does not replace
//   essential the only way its viewer can play the file (else: a courtesy)
//   alone     nothing else is encoding at all — one encode is always allowed,
//             whatever it costs (a 4K HDR title on a small machine still plays)
// Returns { ok, why }.
const admit = ({ cost, memMb = 0, running = 0, essential = true, replacing = false } = {}) => {
  const now = deps.now();
  const c = cost > 0 ? cost : unit();
  if (running <= 1e-9) {
    if (memMb > 0 && !mode().fixed && memMb > memBudgetMb() + MEM_RESERVE_MB / 2) return { ok: false, why: "memory" };
    return { ok: true, why: "alone" };
  }
  if (!replacing && now < state.overloadedUntil) { state.refusedForLoad++; return { ok: false, why: "falling-behind" }; }
  const cap = capacity();
  const limit = essential ? cap : cap - reserve();
  if (running + c > limit + 1e-9) return { ok: false, why: essential ? "cpu" : "cpu-courtesy" };
  if (memMb > 0 && !mode().fixed && memMb > memBudgetMb()) return { ok: false, why: "memory" };
  return { ok: true, why: "fits" };
};

// ------------------------------------------------------- measuring the speed

const runFfmpeg = (args) =>
  new Promise((resolve) => {
    const ffmpeg = deps.ffmpeg();
    if (!ffmpeg) return resolve(null);
    const t0 = process.hrtime.bigint();
    const child = execFile(ffmpeg, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(String(stderr || ""));
      if (!m) return resolve(null);
      resolve({ cpuSec: parseFloat(m[1]) + parseFloat(m[2]), wallSec: Number(process.hrtime.bigint() - t0) / 1e9 });
    });
    try { require("./cpuwork").background.lower(child); } catch {}
  });
const ffmpegVersion = () =>
  new Promise((resolve) => {
    const ffmpeg = deps.ffmpeg();
    if (!ffmpeg) return resolve("");
    execFile(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(err ? "" : String(out).split(/\r?\n/)[0].trim()));
  });

// The calibration job: the ladder's encoder settings (superfast, crf 18,
// High, under the 1080p ceiling) on a moving test picture with grain.
const calArgs = (threads) => [
  "-hide_banner", "-benchmark", "-nostats", "-v", "info", "-nostdin",
  "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24,noise=alls=12:allf=t",
  "-frames:v", String(CAL_FRAMES),
  "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
  "-threads", String(threads), "-maxrate", "10000k", "-bufsize", "20000k",
  "-f", "null", "-",
];

const readCache = () => { try { return JSON.parse(fs.readFileSync(deps.cacheFile(), "utf8")); } catch { return null; } };
const writeCache = (cal) => { try { require("../lib/jsonstore").atomicWriteSync(deps.cacheFile(), JSON.stringify(cal, null, 1), { durable: false }); } catch {} };
const sameKey = (a, b) => !!a && !!b && a.cpu === b.cpu && a.logical === b.logical && a.ffmpeg === b.ffmpeg;

// Measure (twice; the cheaper run counts — a moment's contention only ever
// makes it dearer). Resolves the calibration, or null when it could not run.
const measure = async (key) => {
  const threads = Math.max(2, Math.floor(key.logical / 2));
  const run = deps.run || runFfmpeg;
  const filmSec = CAL_FRAMES / 24;
  let best = null;
  for (let i = 0; i < 2; i++) {
    const r = await run(calArgs(threads));
    if (r && r.cpuSec > 0 && (!best || r.cpuSec < best.cpuSec)) best = r;
  }
  if (!best) return null;
  const cpuSecPerFilmSec = best.cpuSec / filmSec;
  return {
    key, at: deps.now(), threads,
    cpuSecPerFilmSec: Math.round(cpuSecPerFilmSec * 1000) / 1000,
    // per-thread speed against the reference machine
    speed: Math.round((module.exports.REF_CAL / cpuSecPerFilmSec) * 1000) / 1000,
    wallSpeed: Math.round((filmSec / best.wallSec) * 100) / 100,
  };
};

// One timing is one moment: a machine that was busy for those seconds would
// call itself slow for a month. Timed again a little later, the FASTER
// answer is kept — the question is what the machine can do (tonemap.js
// re-times its filter the same way, for the same reason).
const refine = async () => {
  if (!state.cal || deps.viewerBusy() || state.calibrating) return state.cal;
  const again = await measure(state.cal.key);
  if (again && again.speed > state.cal.speed) {
    console.log(`[encode] re-timed: ${state.cal.speed}× → ${again.speed}× the reference per thread — ${slots()} at once`);
    state.cal = again;
    writeCache(again);
  }
  return state.cal;
};

// Use the kept measurement if it is this CPU and this ffmpeg and not old;
// otherwise measure — not while somebody's stream is being encoded.
const calibrate = ({ force = false } = {}) => {
  if (state.calibrating) return state.calibrating;
  state.calibrating = (async () => {
    try {
      const version = deps.version ? await deps.version() : await ffmpegVersion();
      const key = { ...cpuKey(), ffmpeg: version };
      const kept = readCache();
      if (!force && kept && sameKey(kept.key, key) && deps.now() - (kept.at || 0) < CAL_MAX_AGE_MS && kept.speed > 0) {
        state.cal = kept;
        return kept;
      }
      if (!version) return state.cal; // no ffmpeg: nothing to measure, nothing to encode
      if (deps.viewerBusy()) return state.cal; // later (start() asks again)
      const cal = await measure(key);
      if (!cal) return state.cal;
      const before = state.cal ? slots() : null;
      state.cal = cal;
      writeCache(cal);
      console.log(`[encode] measured this machine: ${cal.cpuSecPerFilmSec} CPU-seconds per second of 1080p film (${cal.speed}× the reference per thread, ${cal.wallSpeed}× real time alone) — ${explain().sentence}${before != null && before !== slots() ? ` (was ${before})` : ""}`);
      return cal;
    } finally {
      state.calibrating = null;
    }
  })();
  return state.calibrating;
};

// ------------------------------------------------------------ while running

const sampleCpu = () => {
  let busy = 0;
  let total = 0;
  for (const c of deps.cpus()) {
    const t = c.times || {};
    const b = (t.user || 0) + (t.sys || 0) + (t.nice || 0) + (t.irq || 0);
    busy += b;
    total += b + (t.idle || 0);
  }
  const now = deps.now();
  const prev = state.cpuSample;
  state.cpuSample = { t: now, busy, total };
  if (prev && total > prev.total) state.cpuBusy = (busy - prev.busy) / (total - prev.total);
  return state.cpuBusy;
};

// An encoder reports how much film it has made since it started. `waited`:
// somebody is waiting on what it makes right now (an encoder running ahead of
// its reader, or parked, is not behind anything).
const progress = (key, filmSec, waited) => {
  const now = deps.now();
  let p = state.progress.get(key);
  if (!p) { p = { samples: [] }; state.progress.set(key, p); }
  p.samples.push({ t: now, film: filmSec, waited: !!waited });
  while (p.samples.length > 2 && now - p.samples[0].t > BEHIND_FOR_MS * 2) p.samples.shift();
  judge(key, p, now);
};
const forget = (key) => { state.progress.delete(key); };

const speedOf = (p, now) => {
  const first = p.samples.find((s) => now - s.t <= BEHIND_FOR_MS * 2);
  const last = p.samples[p.samples.length - 1];
  if (!first || !last || last.t - first.t < BEHIND_FOR_MS) return null;
  return (last.film - first.film) / ((last.t - first.t) / 1000);
};

const judge = (key, p, now) => {
  const s = speedOf(p, now);
  if (s == null || s >= BEHIND_SPEED) return;
  // only when it was being waited on the whole time (a reader was short of film)…
  if (!p.samples.every((x) => x.waited || now - x.t > BEHIND_FOR_MS * 2)) return;
  // …and the CPUs are busy: a torrent that is slow to arrive also makes an
  // encoder slow, and refusing other viewers would not help it
  const busy = sampleCpu();
  if (busy != null && busy < BUSY_CPU) return;
  // …and it is AURORA's encoders that keep them busy. Other programs on the
  // machine (a build, a game, another server) used to be enough: their load
  // slowed an encode, and every new viewer was refused for it — at 24
  // streams beside foreign load, encoded starts took 62–83 s (load test,
  // 2026-10-18). Refusing our own viewers does not give their CPU back. So
  // the gate closes only when our encoders' own use is at least OWN_SHARE of
  // what is busy: on a box that only serves, that is always so when it is
  // behind; beside other work it is said, and nobody is refused for it.
  const own = ownShare(now);
  if (busy != null && own < OWN_SHARE * busy) {
    if (now - (state.foreignSaidAt || 0) > 60 * 1000) {
      state.foreignSaidAt = now;
      console.warn(`[encode] an encode is behind real time (${s.toFixed(2)}×) while the CPUs are ${Math.round(busy * 100)}% busy, ${Math.round(own * 100)}% of the machine ours — other programs are the load; new viewers are not refused for it`);
    }
    return;
  }
  if (now >= state.overloadedUntil) {
    state.overloadWhy = `an encode somebody is watching is making ${s.toFixed(2)} s of film per second`;
    console.warn(`[encode] falling behind real time (${state.overloadWhy}; CPUs ${busy == null ? "?" : Math.round(busy * 100)}% busy) — no new encodes for ${OVERLOAD_HOLD_MS / 1000} s, background work set aside`);
    deps.shed("the viewers' encoders are behind real time");
  }
  state.overloadedUntil = now + OVERLOAD_HOLD_MS;
};
const overloaded = () => deps.now() < state.overloadedUntil;
// What share of the whole machine Aurora's own encoders are using now: each
// running encoder's cost (thread-seconds per film-second, on the reference
// machine) × the film it is making per second ÷ this machine's speed per
// thread, over all logical CPUs. An encoder too new to have a speed counts
// as running at real time.
const OWN_SHARE = 0.5;
const ownShare = (now = deps.now()) => {
  let threads = 0;
  for (const [key, p] of state.progress) {
    const last = p.samples[p.samples.length - 1];
    if (!last || now - last.t > BEHIND_FOR_MS * 2) continue;
    const cost = key && typeof key === "object" && key.cost > 0 ? key.cost : unit();
    const sp = speedOf(p, now);
    threads += (cost * (sp == null ? 1 : Math.max(0, sp))) / Math.max(0.05, speed());
  }
  return Math.min(1, threads / logicalCpus());
};

// ------------------------------------------------------------ for a person

const explain = () => {
  const m = mode();
  const logical = logicalCpus();
  const cap = capacity();
  const freeMb = Math.round(deps.freemem() / 1048576);
  const base = {
    mode: m.fixed ? (state.started ? "fixed" : "unstarted") : "auto",
    setting: override(),
    limit: slots(),
    capacity: cap,
    unit: unit(),
    reserve: reserve(),
    logical,
    cpu: cpuKey().cpu,
    headroom: HEADROOM,
    otherShare: m.fixed ? null : otherShare(),
    speed: m.fixed ? null : speed(),
    measured: !!state.cal,
    calibration: state.cal ? { at: state.cal.at, cpuSecPerFilmSec: state.cal.cpuSecPerFilmSec, wallSpeed: state.cal.wallSpeed, ffmpeg: state.cal.key && state.cal.key.ffmpeg } : null,
    memory: { freeMb, budgetMb: Math.round(memBudgetMb()), reserveMb: MEM_RESERVE_MB },
    overloaded: overloaded(),
    overloadWhy: overloaded() ? state.overloadWhy : null,
    cpuBusy: state.cpuBusy,
    examples: m.fixed ? null : {
      "1080p → 1080p": Math.max(1, Math.floor(cap / costOf({ srcW: 1920, srcH: 1080 }) + 1e-9)),
      "1080p → 720p": Math.max(1, Math.floor(cap / costOf({ srcW: 1920, srcH: 1080, outH: 720 }) + 1e-9)),
      "4K → 1080p": Math.max(1, Math.floor(cap / costOf({ srcW: 3840, srcH: 2160 }) + 1e-9)),
      "4K HDR → 1080p, tone-mapped": Math.max(1, Math.floor(cap / costOf({ srcW: 3840, srcH: 2160, tonemap: true }) + 1e-9)),
    },
  };
  base.sentence = m.fixed
    ? state.started
      ? `Fixed at ${m.fixed} at once (set by the admin); every encode counts as one.`
      : "2 at once (the encoder limit has not been started yet)."
    : `Automatic: ${base.limit} now, because ${logical} CPU threads${otherShare() >= 0.05 ? ` (other programs on this machine are using ${Math.round(otherShare() * 100)}% of them)` : ""} × ${speed()} (this machine's measured speed against the reference${state.cal ? "" : " — not measured yet, a cautious guess"}) × ${Math.round(HEADROOM * 100)}% = ${cap} thread-seconds per second of film, and a 1080p transcode costs ${COST_REF}.`;
  return base;
};

// Called once the server is up. Reads the kept measurement at once (so the
// limit is right from the first request) and measures when there is none.
const start = () => {
  if (state.started) return;
  state.started = true;
  try {
    const kept = readCache();
    if (kept && kept.speed > 0 && sameKey({ cpu: kept.key && kept.key.cpu, logical: kept.key && kept.key.logical, ffmpeg: "" }, { ...cpuKey(), ffmpeg: "" })) state.cal = kept;
  } catch {}
  const bootAt = deps.now();
  let fresh = false; // measured during this boot (as opposed to read from the kept file)
  const later = (ms, fn) => { const t = setTimeout(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); t.unref?.(); };
  // after the boot's own work; also notices a changed ffmpeg or CPU
  later(25 * 1000, async () => { const cal = await calibrate(); fresh = !!cal && cal.at >= bootAt; });
  // a boot that had viewers at once gets its measurement here; a measurement
  // made today is timed once more, and the faster one kept
  later(10 * 60 * 1000, async () => { if (!state.cal || !state.cal.at) return calibrate(); if (fresh) return refine(); });
  // what the rest of the machine is doing, looked at while we encode nothing
  if (!state.otherTimer) {
    state.otherTimer = setInterval(() => {
      let encoding = !!state.calibrating;
      try { const cw = require("./cpuwork"); encoding = encoding || cw.viewer.busy() || cw.background.list().some((j) => j.pid); } catch {}
      try { sampleOther(encoding); } catch {}
    }, OTHER_EVERY_MS);
    state.otherTimer.unref?.();
  }
  console.log(`[encode] ${explain().sentence}`);
};

const _reset = () => {
  state.started = false;
  state.cal = null;
  state.calibrating = null;
  state.progress.clear();
  state.overloadedUntil = 0;
  state.overloadWhy = null;
  state.cpuSample = null;
  state.cpuBusy = null;
  state.refusedForLoad = 0;
  state.other = { last: null, shares: [] };
  if (state.otherTimer) { clearInterval(state.otherTimer); state.otherTimer = null; }
};

module.exports = {
  start, calibrate, refine, capacity, costFor, costOf, memOf, unit, reserve, slots, admit, progress, forget, overloaded, explain, override, ownShare,
  HEADROOM, COST_REF, REF_CAL, MAX_FIXED,
  _internals: { deps, state, measure, calArgs, outDims, memBudgetMb, speed, sampleCpu, sampleOther, otherShare, _reset, BEHIND_FOR_MS, OVERLOAD_HOLD_MS, UNKNOWN_SPEED, MEM_RESERVE_MB },
};
