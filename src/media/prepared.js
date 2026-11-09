// PREPARED FILES — what the overnight preparation made (media/overnight.js),
// kept with the title they were made from, and handed to the player in its
// place where the device cannot play the file as it is.
//
// One file per (library title, kind), in data/cache/prepared/:
//   <id>-<mtime of the source>-copy.mp4   the picture copied, the sound AAC stereo
//   <id>-<mtime of the source>-h264.mp4   1080p (never upscaled) 8-bit H.264 + AAC,
//                                         tone mapped when the source is HDR
// with an index (index.json there: who it was made for, why, the facts of
// the file it is — media/playpath.js's vocabulary — and when it was last
// played). The source's mtime is in the name: a replaced file ("Get another
// version", a re-download) never plays a copy of the old one — the clean-up
// removes it.
//
// HOW THE PLAYER GETS IT: /api/item/:id?caps=<device> carries `prepared`
// ({ url, kind, audioIndex, … }) when one of these plays DIRECTLY on that
// device and the file itself would not (overnightplan.pickReady). The
// website and the apps then open that URL as the file (/stream/prepared/:id
// ?k=<kind>, Range-capable) — no live conversion, every seek native. A person
// who picks another audio track gets the file the way it always played (only
// one track is in a prepared file: the one they start on, `audioIndex`).
//
// MAKING ONE (start): one ffmpeg, at the lowest priority the OS has, on half
// the machine's threads; it can be paused (lib/procpause.js: SIGSTOP, or
// NtSuspendProcess on Windows) and stopped at any moment — written to a
// .part file and renamed in only when it is whole.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");
const plan = require("./overnightplan");
const lazy = require("../lib/lazy");
const scannerLib = lazy(require, "./scanner");
const cpuworkLib = lazy(require, "./cpuwork");
const procpauseLib = lazy(require, "../lib/procpause");

let DIR = path.join(config.CACHE_DIR, "prepared");
const USED_SAVE_MS = 10 * 60 * 1000; // a played file's "last played" is written at most this often
const STALL_MS = 10 * 60 * 1000; // no word from ffmpeg for this long (not paused): stuck

let store = null;
const theStore = () => {
  if (store) return store;
  fs.mkdirSync(DIR, { recursive: true });
  const { JsonStore } = require("../lib/jsonstore");
  store = new JsonStore(path.join(DIR, "index.json"), { files: {} });
  if (!store.data.files || typeof store.data.files !== "object") store.data.files = {};
  return store;
};
const files = () => theStore().data.files;
const keyOf = (id, kind) => `${id}|${kind}`;
const fileName = (id, srcMtime, kind) => `${String(id).replace(/[^\w.-]/g, "_")}-${Math.floor(srcMtime)}-${kind}.mp4`;

// The library file behind an id, with its mtime — null when it is not (any more) in the library.
const sourceOf = (id) => {
  try {
    const e = scannerLib().resolve(id);
    if (!e || e.kind !== "video" || !e.path) return null;
    let st = null;
    try { st = scannerLib().walkedStat(e.path); } catch {}
    if (!st) st = fs.statSync(e.path);
    return { path: e.path, mtime: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
};

const abs = (rec) => path.join(DIR, rec.file);
const exists = (rec) => { try { return fs.statSync(abs(rec)).isFile(); } catch { return false; } };

/** Every prepared file (the index's records), newest first. */
const list = () => Object.entries(files()).map(([key, r]) => ({ key, ...r })).sort((a, b) => (b.madeAt || 0) - (a.madeAt || 0));
const usedBytes = () => list().reduce((n, r) => n + (r.bytes || 0), 0);

/** The ready files of one title: on disk, made from the file that is there now. */
const ready = (id) => {
  const src = sourceOf(id);
  if (!src) return [];
  return plan.KINDS.map((k) => files()[keyOf(id, k)]).filter((r) => r && r.srcMtime === src.mtime && exists(r));
};

/**
 * What a device plays for this title instead of its file, or null.
 *   caps      the device's report (media/avcaps.js)
 *   original  the decision for the file as it is (media/playpath.js)
 * → { url, kind, audioIndex, height, sizeBytes, play, why }
 */
const forItem = (id, caps, original) => {
  try {
    const have = ready(id);
    if (!have.length) return null;
    const pick = plan.pickReady(have, caps, original);
    if (!pick) return null;
    return {
      url: `/stream/prepared/${encodeURIComponent(id)}?k=${pick.kind}`,
      kind: pick.kind,
      audioIndex: pick.audioIndex || 0,
      height: (pick.facts && pick.facts.height) || 0,
      sizeBytes: pick.bytes || 0,
      play: pick.play,
      why: pick.kind === "h264" ? "a 1080p H.264 copy made overnight — no live encode" : "a copy made overnight — the picture as it is, the sound AAC: no live repackaging",
    };
  } catch {
    return null;
  }
};

/** The file for /stream/prepared/:id?k=, or null — and the record notes it was played. */
const fileFor = (id, kind) => {
  if (!plan.KINDS.includes(kind)) return null;
  const rec = files()[keyOf(id, kind)];
  if (!rec) return null;
  const src = sourceOf(id);
  if (!src || src.mtime !== rec.srcMtime || !exists(rec)) return null;
  const now = Date.now();
  if (now - (rec.usedAt || 0) > USED_SAVE_MS) { rec.usedAt = now; theStore().save(); }
  return abs(rec);
};

/** Remove one prepared file (and its record). → bytes freed */
const remove = (key, why = "") => {
  const rec = files()[key];
  if (!rec) return 0;
  let freed = 0;
  try { freed = fs.statSync(abs(rec)).size; } catch {}
  try { fs.unlinkSync(abs(rec)); } catch (e) { if (e && e.code !== "ENOENT") { console.warn(`[prepared] could not remove ${rec.file}: ${e.message} — next round`); return 0; } }
  delete files()[key];
  theStore().save();
  console.log(`[prepared] removed ${rec.label || rec.id} (${rec.kind}, ${(freed / 1e9).toFixed(2)} GB)${why ? ` — ${why}` : ""}`);
  return freed;
};

/** At boot and now and then: files nobody indexed (a crash mid-write, a lost index) go; records with no file go. */
const reconcile = (busy = new Set()) => {
  let names = [];
  try { fs.mkdirSync(DIR, { recursive: true }); names = fs.readdirSync(DIR); } catch { return { removed: 0, dropped: 0 }; }
  const known = new Set(Object.values(files()).map((r) => r.file));
  let removed = 0;
  for (const n of names) {
    if (n === "index.json" || n.startsWith("index.json")) continue;
    if (busy.has(n) || busy.has(n.replace(/\.part$/, ""))) continue;
    if (n.endsWith(".part") || (!known.has(n) && n.endsWith(".mp4"))) {
      try { fs.unlinkSync(path.join(DIR, n)); removed++; } catch {}
    }
  }
  let dropped = 0;
  for (const [k, r] of Object.entries(files())) if (!exists(r)) { delete files()[k]; dropped++; }
  if (dropped) theStore().save();
  if (removed || dropped) console.log(`[prepared] tidied the folder: ${removed} stray file${removed === 1 ? "" : "s"}, ${dropped} record${dropped === 1 ? "" : "s"} without a file`);
  return { removed, dropped };
};

/** Free space where the prepared files live (null when it cannot be read). */
const freeBytes = () => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const s = fs.statfsSync(DIR);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------- making one
/**
 * The ffmpeg arguments (pure, so the tests can read them).
 *   kind "copy": -c:v copy (+ the hvc1 tag Apple and Chrome want on HEVC in MP4), AAC stereo
 *   kind "h264": libx264 veryfast crf 21, High profile, `vf` (the scale, and
 *                the tone map for an HDR source), AAC stereo
 */
const argsFor = ({ src, tmp, kind, codec = null, audioIndex = 0, threads = 0, vf = null }) => {
  const cap = threads > 0 ? ["-threads", String(threads)] : [];
  const head = ["-v", "error", "-nostdin", "-y", ...cap, ...(threads > 0 ? ["-filter_threads", String(threads)] : []), "-i", src,
    "-map", "0:v:0", "-map", `0:a:${Math.max(0, audioIndex | 0)}?`, "-sn", "-dn", "-map_chapters", "-1"];
  const tail = ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", tmp];
  if (kind === "copy") return [...head, "-c:v", "copy", ...(codec === "hevc" ? ["-tag:v", "hvc1"] : []), ...tail];
  return [...head, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", "8M", "-bufsize", "16M", ...cap,
    "-profile:v", "high", "-vf", vf || "scale=-2:'min(1080,ih)'", "-pix_fmt", "yuv420p", ...tail];
};

// The -vf of an h264 one: its scale, and for an HDR source the tone map
// (media/tonemap.js — the same chain the live encodes use, without their
// real-time speed gate: nobody is waiting for this one). null = it cannot be
// made right here (HDR and no tone mapping): nothing is made.
const vfFor = async ({ src, srcMtime, height, hdr }) => {
  const scale = `scale=-2:${height}`;
  if (!hdr) return scale;
  const tm = require("./tonemap");
  if (!tm.enabled()) return null;
  const support = await tm.probeSupport().catch(() => null);
  if (!support || !support.ok) return null;
  const f = await tm.sourceFacts(`${src}:${srcMtime}`, src);
  if (!f || !tm.isHdr(f)) return null;
  const d = tm.decide({ ...f, scale, outHeight: height, available: support, env: { ...process.env, AURORA_TONEMAP: "force" } });
  return d && d.vf ? d.vf : null;
};

const seams = { spawn: (cmd, args, opts) => spawn(cmd, args, opts), now: () => Date.now() };

/**
 * Start making one. `job`: { id, kind, label, reason, persons, facts (the
 * source's), audioIndex, duration }. → a controller:
 *   { done: Promise<{ ok, bytes?, ms?, error?, stopped? }>, progress(), paused(),
 *     pause(), resume(), stop(why), pid }
 * or { error } when it cannot even start.
 */
const start = async (job, { threads = 0 } = {}) => {
  const src = sourceOf(job.id);
  if (!src) return { error: "the title is no longer in the library" };
  if (!config.FFMPEG) return { error: "this server has no ffmpeg" };
  const facts = job.facts || {};
  const out = plan.renditionFacts(job.kind, facts, { tonemap: true });
  if (!out) return { error: `no ${job.kind} copy can be made of this file` };
  let vf = null;
  if (job.kind === "h264") {
    vf = await vfFor({ src: src.path, srcMtime: src.mtime, height: out.height, hdr: !!(facts.video && facts.video.hdr) });
    if (!vf) return { error: "the picture is HDR and this server cannot tone map it — a grey copy would be worse than the live encode" };
  }
  fs.mkdirSync(DIR, { recursive: true });
  const name = fileName(job.id, src.mtime, job.kind);
  const final = path.join(DIR, name);
  const tmp = final + ".part";
  const args = argsFor({ src: src.path, tmp, kind: job.kind, codec: facts.video && facts.video.codec, audioIndex: job.audioIndex || 0, threads, vf });
  const startedAt = seams.now();
  let child;
  try {
    child = seams.spawn(config.FFMPEG, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { error: `ffmpeg would not start: ${e.message}` };
  }
  try { require("../lib/children").track(child, "prepared"); } catch {}
  try { cpuworkLib().background.lower(child, "prepared"); } catch {}
  const st = { progress: 0, paused: false, stopped: null, lastOutputAt: startedAt, err: "" };
  const duration = job.duration || 0;
  let buf = "";
  if (child.stdout) child.stdout.on("data", (d) => {
    st.lastOutputAt = seams.now();
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_(?:ms|us)=(\d+)/.exec(line);
      if (m && duration > 0) st.progress = Math.min(0.99, Number(m[1]) / 1e6 / duration);
    }
  });
  if (child.stderr) child.stderr.on("data", (d) => { st.lastOutputAt = seams.now(); st.err = (st.err + d.toString()).slice(-600); });
  const stall = setInterval(() => {
    if (st.paused || st.stopped) return;
    if (seams.now() - st.lastOutputAt > STALL_MS) { st.stopped = "it made no progress for 10 minutes"; try { child.kill("SIGKILL"); } catch {} }
  }, 30 * 1000);
  stall.unref?.();
  const done = new Promise((resolve) => {
    let ended = false;
    const finish = (code, failure) => {
      if (ended) return;
      ended = true;
      clearInterval(stall);
      const ms = seams.now() - startedAt;
      if (!st.stopped && !failure && code === 0 && fs.existsSync(tmp)) {
        try {
          fs.renameSync(tmp, final);
          const bytes = fs.statSync(final).size;
          const key = keyOf(job.id, job.kind);
          // a record made for the file that was here before goes with this one
          const old = files()[key];
          if (old && old.file !== name) { try { fs.unlinkSync(path.join(DIR, old.file)); } catch {} }
          files()[key] = {
            id: job.id, kind: job.kind, file: name, bytes, srcMtime: src.mtime, madeAt: seams.now(), usedAt: 0, ms,
            label: job.label || null, reason: job.reason || null, persons: (job.persons || []).slice(0, 20),
            audioIndex: job.audioIndex || 0, facts: out, episode: !!job.episode,
          };
          theStore().save();
          return resolve({ ok: true, bytes, ms });
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          return resolve({ ok: false, error: `could not keep the file: ${e.message}`, ms });
        }
      }
      try { fs.unlinkSync(tmp); } catch {}
      if (st.stopped) return resolve({ ok: false, stopped: st.stopped, ms });
      resolve({ ok: false, error: failure || st.err.trim().split("\n").pop() || `ffmpeg exited ${code}`, ms });
    };
    child.on("close", (code) => finish(code, null));
    child.on("error", (e) => finish(null, e.message));
  });
  const ctl = {
    pid: child.pid,
    file: name,
    done,
    progress: () => st.progress,
    paused: () => st.paused,
    // → Promise<boolean>: paused (false: it could not be — the caller stops it then)
    pause: async () => {
      if (st.paused || st.stopped) return st.paused;
      const ok = await procpauseLib().suspend(child.pid).catch(() => false);
      if (ok) st.paused = true;
      return ok;
    },
    resume: async () => {
      if (!st.paused) return true;
      const ok = await procpauseLib().resume(child.pid).catch(() => false);
      st.paused = false;
      st.lastOutputAt = seams.now();
      return ok;
    },
    stop: (why = "stopped") => {
      if (st.stopped) return;
      st.stopped = why;
      try { child.kill("SIGKILL"); } catch {}
    },
  };
  return ctl;
};

module.exports = {
  get DIR() { return DIR; }, list, usedBytes, ready, forItem, fileFor, remove, reconcile, freeBytes, start, sourceOf, keyOf,
  _internals: { argsFor, vfFor, fileName, seams, theStore, setStore: (s) => { store = s; }, files, setDir: (d) => { DIR = d; store = null; } },
};
