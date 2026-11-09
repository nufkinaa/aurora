// Preview pictures for the progress bar (the scrub previews, like Netflix):
// while a person drags or seeks, the picture at that point of the film is
// shown above the scrub point — on the website, the TV and the phone app.
//
// WHAT IS MADE, per library video: one small frame every INTERVAL_S seconds,
// TILE_W pixels wide, laid out COLS x ROWS to a JPEG "sheet", and an
// index.json that says where each frame is:
//
//   data/cache/scrub/<key>/index.json   { v, interval, w, h, cols, rows, count, sheets, duration, bytes, cpuMs, wallMs }
//   data/cache/scrub/<key>/0.jpg, 1.jpg …  (all the same size; the last one padded)
//
// `key` is the file's path and date (a replaced file gets new pictures; the
// old ones are swept). Frame i is the picture at i * interval seconds: a
// client at second t shows frame round(t / interval) — sheet floor(i / per),
// column i % cols, row floor((i % per) / cols) (tileAt below; the clients
// carry the same three lines).
//
// HOW: ONE ffmpeg run per file that decodes only the KEY frames
// (-skip_frame nokey) and keeps one every INTERVAL_S (fps=1/INTERVAL_S), scaled
// down and tiled in the same filter chain. Measured on this house's library
// (i7-10700K, ffmpeg 6.0, 2 threads): a 52-minute 1080p HEVC episode in 22 s
// wall / 24 s CPU, a 2 h 1080p H.264 film in 13 s / 16 s — against 235 s /
// 342 s for decoding every frame. The price: a picture is the key frame at or
// just before its second (2-10 s early on most encodes) — fine for "where am
// I", which is what a scrub preview is for. HDR sources are tone-mapped
// (media/tonemap.js) so the pictures are not grey. Disk: ~0.7-0.9 MB a title
// (about 15 KB a minute of video).
//
// WHEN — never in the way of somebody watching:
//   - a download that lands asks for its pictures at once (landed(), from
//     media/downloads.js beside the play-ready copy), and they are made as
//     BACKGROUND work (media/cpuwork.js): a place in the background budget,
//     only when no viewer has been encoded for in the last 20 s, at the
//     lowest priority the OS has; should a viewer's encode start while it
//     runs, the run is STOPPED and tried again later;
//   - also not while the machine is busy with other things (Linux: the
//     one-minute load above 75 % of the CPUs);
//   - everything else in the library (titles from before this existed, a
//     file copied in by hand, an upload, a run that was stopped) is made in
//     the QUIET HOURS (02:00-07:00 server time by default; AURORA_SCRUB_QUIET
//     = "2-7"), one title at a time, newest first. AURORA_SCRUB=off switches
//     the whole thing off (nothing is made, the clients scrub as before).
//
// Where no pictures exist yet the route answers { ready: false } and every
// client scrubs exactly as it did before.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const config = require("../config");
const lazy = require("../lib/lazy");
const scannerLib = lazy(require, "./scanner");
const metadataLib = lazy(require, "./metadata");
const cpuworkLib = lazy(require, "./cpuwork");
const tonemapLib = lazy(require, "./tonemap");

const V = 1; // bump when what is made changes: every title is made again (quiet hours)
const INTERVAL_S = 10;
const TILE_W = 240;
const COLS = 10;
const ROWS = 10;
const PER = COLS * ROWS;
const MAX_FRAMES = 1200; // a very long file gets a wider interval instead of more sheets (> 3 h 20 min)
const JPEG_Q = 6; // ffmpeg's mjpeg scale, 2 (best) .. 31: ~2-3 KB a frame at 240 px
const DIR = path.join(config.CACHE_DIR, "scrub");

// ------------------------------------------------------------------ pure
// The plan for a file of `duration` seconds.
const planFor = (duration) => {
  const d = Number(duration) || 0;
  if (!(d > 0)) return null;
  const interval = Math.max(INTERVAL_S, Math.ceil(d / MAX_FRAMES));
  const count = Math.max(1, Math.ceil(d / interval));
  return { interval, cols: COLS, rows: ROWS, per: PER, count, sheets: Math.ceil(count / PER) };
};
// Which picture a client shows at second `t`: { i, sheet, x, y, w, h } in the
// sheet's own pixels, or null.
const tileAt = (index, t) => {
  if (!index || !(index.count > 0) || !(index.interval > 0) || !(index.w > 0) || !(index.h > 0)) return null;
  const cols = index.cols || COLS;
  const per = cols * (index.rows || ROWS);
  const i = Math.max(0, Math.min(index.count - 1, Math.round((Number(t) || 0) / index.interval)));
  const k = i % per;
  return { i, sheet: Math.floor(i / per), x: (k % cols) * index.w, y: Math.floor(k / cols) * index.h, w: index.w, h: index.h };
};
// The ffmpeg arguments that make the sheets of `file` into `outDir`.
const argsFor = (file, outDir, plan, { threads = 1, vf = null } = {}) => [
  "-hide_banner", "-nostdin", "-nostats", "-benchmark",
  "-threads", String(threads),
  "-skip_frame", "nokey",
  "-i", file,
  "-map", "0:v:0", "-an", "-sn", "-dn",
  "-vf", `fps=1/${plan.interval}:eof_action=pass,${vf || `scale=${TILE_W}:-2:flags=bilinear`},tile=${COLS}x${ROWS}`,
  "-fps_mode", "vfr",
  "-q:v", String(JPEG_Q),
  "-start_number", "0",
  "-f", "image2",
  "-y", path.join(outDir, "%d.jpg"),
];
// The CPU time ffmpeg says it used (its -benchmark line), in ms, or null.
const cpuMsOf = (stderr) => {
  const m = /bench:\s+utime=([\d.]+)s\s+stime=([\d.]+)s/.exec(String(stderr || ""));
  return m ? Math.round((parseFloat(m[1]) + parseFloat(m[2])) * 1000) : null;
};
// A JPEG's size from its first SOF marker: { width, height } or null.
const jpegSize = (buf) => {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
};
// "2-7" -> { from: 2, to: 7 } (hours, server time; "22-6" wraps midnight)
const parseQuiet = (s) => {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(s || ""));
  if (!m) return { from: 2, to: 7 };
  const from = Math.min(23, +m[1]);
  const to = Math.min(24, +m[2]);
  return { from, to };
};
const inQuiet = (q, date) => {
  const h = date.getHours();
  return q.from <= q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
};
const keyOf = (file, mtime) => crypto.createHash("md5").update(`${file}|${mtime}|${V}`).digest("hex").slice(0, 20);

// -------------------------------------------------------------- the disk
const deps = {
  dir: null,
  now: () => Date.now(),
  date: () => new Date(),
  env: process.env,
  ffmpeg: () => config.FFMPEG,
  available: () => !!config.ffmpegAvailable,
  // the machine is busy with something other than our viewers' encodes
  // (cpuwork already waits for those): Linux's one-minute load
  cpuBusy: () => {
    if (process.platform !== "linux") return false;
    try { return os.loadavg()[0] > 0.75 * Math.max(1, require("../lib/cpucount").count()); } catch { return false; }
  },
  spawn: (file, args) => spawn(file, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  log: (...a) => console.log(...a),
};
const enabled = () => String(deps.env.AURORA_SCRUB || "").toLowerCase() !== "off";

const mtimeOf = (file) => {
  try {
    const st = scannerLib().walkedStat(file);
    if (st) return Math.floor(st.mtimeMs);
  } catch {}
  try { return Math.floor(fs.statSync(file).mtimeMs); } catch { return null; }
};
// (deps.dir: the tests' own folder)
const baseDir = () => deps.dir || DIR;
const dirFor = (file, mtime) => path.join(baseDir(), keyOf(file, mtime));

// The index of a library video's pictures, when they are made; else null.
const memo = new Map(); // dir -> index (a made index never changes)
const readIndex = (file) => {
  const mtime = mtimeOf(file);
  if (mtime == null) return null;
  const dir = dirFor(file, mtime);
  if (memo.has(dir)) return memo.get(dir);
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    if (!idx || idx.v !== V || !(idx.count > 0)) return null;
    idx.dir = dir;
    if (memo.size > 5000) memo.clear();
    memo.set(dir, idx);
    return idx;
  } catch {
    return null;
  }
};
const status = (id) => {
  const entry = scannerLib().resolve(id);
  if (!entry || entry.kind !== "video") return null;
  return readIndex(entry.path);
};
// The file of sheet n of a library video, or null.
const sheetFile = (id, n) => {
  const idx = status(id);
  if (!idx || !Number.isInteger(n) || n < 0 || n >= idx.sheets) return null;
  return path.join(idx.dir, `${n}.jpg`);
};
// What a client is told (GET /api/scrub/:id).
const answerFor = (id) => {
  if (!enabled()) return { ready: false };
  const idx = status(id);
  if (!idx) return { ready: false, ...(queue.has(id) || current === id ? { queued: true } : {}) };
  const k = path.basename(idx.dir);
  const sheets = Array.from({ length: idx.sheets }, (_, n) => `/img/scrub/${encodeURIComponent(id)}/${n}.jpg?k=${k}`);
  return { ready: true, v: idx.v, interval: idx.interval, w: idx.w, h: idx.h, cols: idx.cols, rows: idx.rows, count: idx.count, sheets };
};

// ------------------------------------------------------------- the making
// Make the pictures of one file. Resolves { ok, index } | { aborted } |
// { failed, why }. `opts.onChild(child)`: the process, once started.
const make = async (file, duration, opts = {}) => {
  const plan = planFor(duration);
  if (!plan) return { failed: true, why: "no duration" };
  const mtime = mtimeOf(file);
  if (mtime == null) return { failed: true, why: "unreadable" };
  const dir = dirFor(file, mtime);
  const part = `${dir}.part`;
  try { fs.rmSync(part, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(part, { recursive: true });
  // an HDR source: tone-mapped to SDR in the same chain (media/tonemap.js);
  // anything unknown or unsupported keeps the plain scale
  let vf = null;
  try {
    const tm = tonemapLib();
    const facts = tm.enabled(deps.env) && (await tm.probeVideo(file));
    if (facts && tm.isHdr(facts)) {
      const support = await tm.probeSupport();
      vf = tm.decide({ ...facts, scale: `scale=${TILE_W}:-2:flags=bilinear`, available: support, env: { ...deps.env, AURORA_TONEMAP: "force" } }).vf || null;
    }
  } catch {
    vf = null;
  }
  const args = argsFor(file, part, plan, { threads: opts.threads || 1, vf });
  const started = deps.now();
  const r = await new Promise((resolve) => {
    let child;
    try { child = deps.spawn(deps.ffmpeg(), args); } catch (e) { return resolve({ code: -1, stderr: String(e && e.message) }); }
    if (opts.onChild) { try { opts.onChild(child); } catch {} }
    let err = "";
    if (child.stderr) child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    // (at the idle priority a busy machine may take a while: half the film's
    // own length, fifteen minutes at least, then it is given up on)
    const timer = deps.setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, Math.max(15 * 60 * 1000, duration * 500));
    let settled = false;
    const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stderr: err }); };
    child.once("close", (code) => done(code));
    child.once("error", () => done(-1));
  });
  const wallMs = deps.now() - started;
  if (opts.aborted && opts.aborted()) {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch {}
    return { aborted: true };
  }
  const sheets = [];
  try { for (const f of fs.readdirSync(part)) if (/^\d+\.jpg$/.test(f)) sheets.push(f); } catch {}
  if (r.code !== 0 || !sheets.length) {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch {}
    return { failed: true, why: (String(r.stderr || "").trim().split(/\r?\n/).filter((l) => !/^bench:/.test(l)).pop() || `ffmpeg exited ${r.code}`).slice(0, 200) };
  }
  let size = null;
  try { size = jpegSize(fs.readFileSync(path.join(part, "0.jpg"))); } catch {}
  if (!size || size.width < COLS || size.height < ROWS) {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch {}
    return { failed: true, why: "unreadable sheet" };
  }
  let bytes = 0;
  for (const f of sheets) { try { bytes += fs.statSync(path.join(part, f)).size; } catch {} }
  // the frames actually made: full sheets before the last, which may be part-filled
  const count = Math.min(plan.count, sheets.length * PER);
  const index = {
    v: V, interval: plan.interval, w: Math.round(size.width / COLS), h: Math.round(size.height / ROWS), cols: COLS, rows: ROWS,
    count, sheets: sheets.length, duration: Math.round(duration), bytes, cpuMs: cpuMsOf(r.stderr), wallMs, at: deps.now(),
    file: path.basename(file), mtime, ...(vf ? { tonemapped: true } : {}),
  };
  fs.writeFileSync(path.join(part, "index.json"), JSON.stringify(index));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.renameSync(part, dir);
  memo.delete(dir);
  return { ok: true, index };
};

// ------------------------------------------------------------- the queue
// `queue`: library ids that asked (a landing) — before the quiet hours' walk.
const queue = new Set();
let current = null;
let pumping = false;
const failures = new Map(); // `${file}|${mtime}` -> { at, why }: not tried again for a day
const FAIL_RETRY_MS = 24 * 3600 * 1000;
const BUSY_WAIT_MS = 60 * 1000;
const stats = { made: 0, failed: 0, aborted: 0, cpuMs: 0, bytes: 0, last: null };

const wantsPictures = (id, now = deps.now()) => {
  const entry = scannerLib().resolve(id);
  if (!entry || entry.kind !== "video") return null;
  if (readIndex(entry.path)) return null;
  const mtime = mtimeOf(entry.path);
  const fail = failures.get(`${entry.path}|${mtime}`);
  if (fail && now - fail.at < FAIL_RETRY_MS) return null;
  const meta = metadataLib().getCached(entry.path);
  if (!meta || !(meta.duration > 0)) return null; // enrichment has not reached it yet
  return { entry, duration: meta.duration, mtime };
};

// One title, as background work. Resolves "made" | "aborted" | "failed" | "skipped".
const runOne = async (id, label = id) => {
  const want = wantsPictures(id);
  if (!want) return "skipped";
  const cpuwork = cpuworkLib();
  const ref = { child: null, aborted: false };
  const stop = () => { ref.aborted = true; try { if (ref.child) ref.child.kill("SIGKILL"); } catch {} };
  const place = await cpuwork.background.gate("sprites", { label: `${label} (scrub pictures)`, onShed: stop });
  const watch = deps.setInterval(() => { if (cpuwork.viewer.busy()) stop(); }, 1000);
  current = id;
  try {
    if (cpuwork.viewer.busy()) return "aborted";
    const out = await make(want.entry.path, want.duration, {
      threads: 1,
      aborted: () => ref.aborted,
      onChild: (c) => { ref.child = c; place.attach(c); if (ref.aborted) stop(); },
    });
    if (out.aborted) { stats.aborted++; return "aborted"; }
    if (out.failed) {
      stats.failed++;
      failures.set(`${want.entry.path}|${want.mtime}`, { at: deps.now(), why: out.why });
      if (failures.size > 2000) failures.delete(failures.keys().next().value);
      console.warn(`[scrub] no pictures for ${label}: ${out.why}`);
      return "failed";
    }
    stats.made++;
    stats.cpuMs += out.index.cpuMs || 0;
    stats.bytes += out.index.bytes || 0;
    stats.last = { label, at: deps.now(), cpuMs: out.index.cpuMs, wallMs: out.index.wallMs, bytes: out.index.bytes, sheets: out.index.sheets };
    deps.log(`[scrub] pictures for ${label}: ${out.index.count} frames in ${out.index.sheets} sheet(s), ${Math.round(out.index.bytes / 1024)} KB, ${out.index.cpuMs != null ? `${(out.index.cpuMs / 1000).toFixed(1)} s CPU, ` : ""}${(out.index.wallMs / 1000).toFixed(1)} s`);
    return "made";
  } finally {
    current = null;
    clearInterval(watch);
    try { place.release(); } catch {}
  }
};

const labelOf = (id) => {
  try {
    const it = scannerLib().findById(id);
    if (it && it.title) return it.season != null && it.episode != null ? `${it.showTitle || it.title} S${it.season}E${it.episode}` : it.title;
  } catch {}
  return id;
};
const waitWhileBusy = async () => {
  while (deps.cpuBusy()) await new Promise((r) => deps.setTimeout(r, BUSY_WAIT_MS));
};

// Every library video, newest file first (what just arrived is what people open).
const libraryVideos = () => {
  const out = [];
  const scanner = scannerLib();
  for (const m of scanner.index.movies || []) out.push(m.id);
  for (const show of scanner.index.shows || []) {
    for (const season of show.seasons || []) for (const ep of season.episodes || []) out.push(ep.id);
  }
  const at = new Map();
  for (const id of out) {
    const e = scanner.resolve(id);
    at.set(id, e ? mtimeOf(e.path) || 0 : 0);
  }
  return out.filter((id) => at.get(id)).sort((a, b) => at.get(b) - at.get(a));
};

const quietNow = () => inQuiet(parseQuiet(deps.env.AURORA_SCRUB_QUIET), deps.date());

// Works through the asked-for titles, then — in the quiet hours only — the
// rest of the library. One title at a time.
const pump = async () => {
  if (pumping || !enabled() || !deps.available()) return;
  pumping = true;
  try {
    for (;;) {
      let id = null;
      let night = false;
      if (queue.size) {
        id = queue.values().next().value;
        queue.delete(id);
      } else if (quietNow()) {
        id = libraryVideos().find((x) => wantsPictures(x));
        night = true;
      }
      if (!id) break;
      await waitWhileBusy();
      if (night && !quietNow() && !queue.size) break;
      const r = await runOne(id, labelOf(id));
      // stopped for a viewer: back in line (a landing first); the gate waits for the quiet
      if (r === "aborted" && !night) queue.add(id);
      await new Promise((res) => setImmediate(res));
    }
    sweep();
  } catch (e) {
    console.warn("[scrub] pass failed:", e && e.message ? e.message : e);
  } finally {
    pumping = false;
  }
};

// A title that just landed (media/downloads.js): its pictures now, in the background.
const landed = (id) => {
  if (!id || !enabled()) return;
  queue.add(id);
  deps.setTimeout(() => { pump(); }, 5000); // (after the scan and the enrichment that give it a duration)
};

// The admin's "make them now": every library title still without pictures
// goes in the queue (newest first), whatever the hour. Returns how many.
const runAll = () => {
  if (!enabled()) return 0;
  let n = 0;
  for (const id of libraryVideos()) if (!queue.has(id) && wantsPictures(id)) { queue.add(id); n++; }
  pump();
  return n;
};

// Pictures of files that are no longer in the library (replaced, deleted) go
// — never while a library folder cannot be read (an unplugged drive makes
// every title on it "gone").
let lastSweep = 0;
const sweep = (now = deps.now()) => {
  if (now - lastSweep < 6 * 3600 * 1000) return 0;
  lastSweep = now;
  try { if (require("../lib/libroots").missing().length > 0) return 0; } catch { return 0; }
  let names;
  try { names = fs.readdirSync(baseDir()); } catch { return 0; }
  const keep = new Set();
  const scanner = scannerLib();
  for (const id of libraryVideos()) {
    const e = scanner.resolve(id);
    const m = e && mtimeOf(e.path);
    if (m != null) keep.add(keyOf(e.path, m));
  }
  if (!keep.size) return 0; // an empty library is not a reason to throw everything away
  let n = 0;
  for (const name of names) {
    const base = name.replace(/\.part$/, "");
    if (keep.has(base) && !name.endsWith(".part")) continue;
    if (name.endsWith(".part") && current) continue; // (the one being made)
    try { fs.rmSync(path.join(baseDir(), name), { recursive: true, force: true }); n++; } catch {}
  }
  memo.clear();
  if (n) deps.log(`[scrub] swept the pictures of ${n} file(s) no longer in the library`);
  return n;
};

// The quiet hours' clock: looked at every ten minutes.
let ticker = null;
const start = () => {
  if (ticker || !enabled()) return;
  ticker = deps.setInterval(() => { if (quietNow()) pump(); }, 10 * 60 * 1000);
  deps.setTimeout(() => { if (quietNow()) pump(); }, 2 * 60 * 1000);
};

// For the admin and the report: how much the pictures cost.
const summary = () => {
  let titles = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(baseDir())) {
      if (name.endsWith(".part")) continue;
      try { const idx = JSON.parse(fs.readFileSync(path.join(baseDir(), name, "index.json"), "utf8")); titles++; bytes += idx.bytes || 0; } catch {}
    }
  } catch {}
  return { titles, bytes, queued: queue.size, current, quietHours: parseQuiet(deps.env.AURORA_SCRUB_QUIET), enabled: enabled(), ...stats };
};

module.exports = {
  answerFor, sheetFile, landed, runAll, start, pump, summary, runOne, make, sweep,
  V, INTERVAL_S, TILE_W, COLS, ROWS, DIR,
  _internals: { planFor, tileAt, argsFor, cpuMsOf, jpegSize, parseQuiet, inQuiet, keyOf, deps, queue, memo, failures, stats, readIndex, wantsPictures, libraryVideos, quietNow },
};
