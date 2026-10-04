// Offline copies: a browser-playable file per library video, at the quality
// the person asked for.
//
// A device that saves a title for the plane needs an MP4 it can decode on its
// own — most library files are MKV/HEVC/AC-3, which no browser plays without
// the server's help. So "prepare" makes one, once, cached under
// data/cache/offline and served with Range support by /offline/file/:id.
//
// Four qualities, and three ways of getting there, cheapest first:
//
//   original   the file as it is. Already an MP4 with H.264 + AAC/MP3: served
//              directly, nothing to prepare. Otherwise, when the VIDEO is one
//              the device decodes (H.264 anywhere; HEVC where the device says
//              it can), a REMUX — the video copied untouched into an MP4, only
//              the audio re-encoded to AAC. That runs at disk speed (seconds,
//              not the length of the film) and keeps full picture quality.
//   1080 / 720 / 480
//              a real re-encode to H.264 at that height (never upscaled),
//              stereo AAC. Slow, small, plays everywhere.
//
// The old behaviour was "720p re-encode, always" — a laptop waited through a
// full encode to get a worse picture than the file it could have had in
// seconds. `options()` lays the choices out with honest sizes so the client
// can ask (elia: "we should ask the user what resolution he prefers").
//
// One ffmpeg at a time (a phone can wait; the streaming server can't be
// starved), progress parsed from ffmpeg's own -progress stream.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");
const scanner = require("./scanner");
const metadata = require("./metadata");

const DIR = path.join(config.CACHE_DIR, "offline");
const DIRECT_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const DIRECT_AUDIO = new Set(["aac", "mp3"]);
const QUALITIES = ["original", "1080", "720", "480"];
// What a veryfast crf-23 encode tends to weigh, for the size shown BEFORE
// anything is made (kbit/s, video + stereo AAC). An estimate, said as one.
const KBPS = { 1080: 4200 + 128, 720: 2100 + 128, 480: 950 + 128 };

// The server's disk is small and these copies are DUPLICATES of files it
// already holds (an "original" copy is the whole film again). A copy exists
// for one purpose — a device fetching it — so it is kept only as long as that
// takes: removed half a day after it was last asked for, the oldest go first
// once the folder passes its cap, and nothing is made when the disk has no
// room for it. Making one again later costs seconds (remux) or one encode.
const KEEP_MS = 12 * 3600 * 1000;
const MAX_BYTES = Math.max(1, Number(config.offlineCacheGb) || 8) * 1024 ** 3;
const IN_USE_MS = 30 * 60 * 1000;
const HEADROOM_BYTES = 5 * 1024 ** 3; // free space that must remain after a copy is made

const jobs = new Map(); // "<id>|<quality>" -> {state, progress, error, startedAt}
const queue = [];
let running = null;

const normQuality = (q) => (QUALITIES.includes(String(q)) ? String(q) : "720");
const jobKey = (id, q) => `${id}|${q}`;

const entryFor = (id) => {
  const e = scanner.resolve(id);
  return e && e.kind === "video" && fs.existsSync(e.path) ? e : null;
};

const mtimeOf = (p) => {
  try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
};

// 720 keeps the pre-quality file name, so copies prepared before this
// existed are still found.
const outFileFor = (id, srcPath, q = "720") =>
  path.join(DIR, `${id}-${mtimeOf(srcPath)}${q === "720" ? "" : `-${q}`}.mp4`);

// Can a browser play the file as it is? Only when we KNOW the codecs are
// H.264 + AAC/MP3 in an MP4-family container; an unprobed MP4 is assumed
// fine (ffprobe missing means no transcode is possible anyway).
const isDirect = (srcPath) => {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!DIRECT_CONTAINERS.has(ext)) return false;
  const m = metadata.getCached(srcPath);
  if (!m) return true;
  const v = m.video && m.video.codec;
  const a = (m.audioStreams || [])[0];
  if (v && v !== "h264") return false;
  if (a && a.codec && !DIRECT_AUDIO.has(a.codec)) return false;
  return true;
};

// How "original" is reached for this file on this device: served as is,
// remuxed (video copied), or not at all (the device can't decode the video).
// `caps.hevc`: the client says its browser plays HEVC in MP4.
const originalMode = (srcPath, caps = {}) => {
  if (isDirect(srcPath)) return "direct";
  const m = metadata.getCached(srcPath);
  const v = m && m.video && m.video.codec;
  if (!v) return null; // unprobed: no way to promise it plays
  const tenBit = m.video.bitDepth && m.video.bitDepth > 8;
  if (v === "h264" && !tenBit) return "remux";
  if (v === "hevc" && caps.hevc) return "remux";
  return null;
};

const sourceHeight = (srcPath) => {
  const m = metadata.getCached(srcPath);
  return (m && m.height) || 0;
};

// What is in the folder: [{ file, size, usedAt }], oldest use first.
const listCopies = () => {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(DIR, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ file, name, size: st.size, usedAt: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => a.usedAt - b.usedAt);
};

// Which copies go, given the folder's contents: pure, so it can be tested.
// `busy(file)`: a job is writing it right now.
const toRemove = (copies, { now = Date.now(), keepMs = KEEP_MS, maxBytes = MAX_BYTES, busy = () => false } = {}) => {
  const gone = [];
  let total = 0;
  const kept = [];
  for (const c of copies) {
    if (busy(c.file)) { total += c.size; continue; }
    // a .part with no job behind it is a crashed conversion; a copy nobody
    // has asked for in half a day has done its job
    if (c.name.endsWith(".part") || now - c.usedAt > keepMs) gone.push(c);
    else { kept.push(c); total += c.size; }
  }
  for (const c of kept) { // oldest use first
    if (total <= maxBytes) break;
    // asked for in the last half hour: a device is probably fetching it
    // right now — a copy bigger than the whole cap must still get delivered
    // (a copy dated in the future is a kept one, not one in use: the cap still wins)
    if (now >= c.usedAt && now - c.usedAt < IN_USE_MS) continue;
    gone.push(c);
    total -= c.size;
  }
  return gone;
};

const sweep = () => {
  const writing = new Set();
  if (running) {
    const [id, q] = running.split("|");
    const e = entryFor(id);
    if (e) { const out = outFileFor(id, e.path, q); writing.add(out); writing.add(out + ".part"); }
  }
  const gone = toRemove(listCopies(), { busy: (f) => writing.has(f) });
  let freed = 0;
  for (const c of gone) {
    try { fs.unlinkSync(c.file); freed += c.size; } catch {} // in use on Windows: next round
  }
  if (freed) console.log(`[offline] cleared ${gone.length} copy(ies), ${(freed / 1e9).toFixed(2)} GB back`);
  return freed;
};

// A copy that is being fetched stays: every request for it moves its date.
// (Never backwards: a play-ready copy made ahead of time carries a date in
// the future — its keep-until — and being played must not shorten that.)
const touchCopy = (file) => {
  try {
    const now = new Date();
    if (fs.statSync(file).mtimeMs < now.getTime()) fs.utimesSync(file, now, now);
  } catch {}
};

// Is there room to make a copy of about `bytes`? (null when the disk can't be asked)
const roomFor = (bytes) => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const s = fs.statfsSync(DIR);
    return s.bavail * s.bsize - bytes >= HEADROOM_BYTES;
  } catch { return null; }
};

// The choices for one title, sizes included, for the client's sheet.
const options = (id, caps = {}) => {
  const e = entryFor(id);
  if (!e) return { error: "not found", options: [] };
  const m = metadata.getCached(e.path);
  const duration = (m && m.duration) || 0;
  const srcSize = (() => { try { return fs.statSync(e.path).size; } catch { return 0; } })();
  const h = sourceHeight(e.path);
  const w = (m && m.width) || 0;
  const out = [];
  const mode = originalMode(e.path, caps);
  if (mode) {
    out.push({
      quality: "original",
      label: "Original quality",
      detail: [h ? (w >= 3200 || h >= 2000 ? "4K" : w >= 1600 || h >= 1000 ? "1080p" : w >= 1100 || h >= 700 ? "720p" : `${h}p`) : null, m && m.video && m.video.codec ? String(m.video.codec).toUpperCase() : null].filter(Boolean).join(" · "),
      sizeBytes: srcSize,
      estimated: mode !== "direct",
      instant: true,
      note: mode === "direct" ? "The file as it is — nothing to convert." : "The picture untouched, repackaged in seconds.",
      ready: mode === "direct" || fs.existsSync(outFileFor(id, e.path, "original")),
    });
  }
  if (config.ffmpegAvailable) {
    // never offer an "upscale": a 720p source has no 1080p option. The
    // smallest stays regardless (the encode itself never scales up).
    const wanted = ["1080", "720", "480"].filter((q) => q === "480" || !h || Number(q) <= h * 1.15);
    for (const q of wanted) {
      out.push({
        quality: q,
        label: `${q}p`,
        detail: "H.264 · stereo — plays on anything",
        sizeBytes: duration ? Math.round((KBPS[q] * 1000 / 8) * duration) : 0,
        estimated: true,
        instant: false,
        note: "Converted on the server first; that takes a while for a long film.",
        ready: fs.existsSync(outFileFor(id, e.path, q)),
      });
    }
  }
  return { options: out, duration, ffmpeg: !!config.ffmpegAvailable };
};

// Where the device should fetch from, and whether it exists yet.
const status = (id, quality, caps = {}) => {
  const q = normQuality(quality);
  const e = entryFor(id);
  if (!e) return { state: "error", error: "not found" };
  if (q === "original") {
    const mode = originalMode(e.path, caps);
    if (mode === "direct") {
      return { state: "ready", quality: q, direct: true, url: `/stream/video/${id}`, sizeBytes: fs.statSync(e.path).size };
    }
    if (!mode) return { state: "error", error: "this device can't play the original's video — pick 1080p or lower" };
  }
  const file = outFileFor(id, e.path, q);
  const job = jobs.get(jobKey(id, q));
  if (fs.existsSync(file) && (!job || job.state !== "working")) {
    return { state: "ready", quality: q, direct: false, url: `/offline/file/${id}?q=${q}`, sizeBytes: fs.statSync(file).size };
  }
  if (job) return { state: job.state, quality: q, progress: job.progress || 0, error: job.error || null };
  if (!config.ffmpegAvailable) return { state: "unavailable", error: "the server has no ffmpeg, so this file can't be converted for this device" };
  return { state: "idle", quality: q };
};

// `keepMs`: keep the finished copy at least this long (preconvert.js) —
// stamped as a date in the future, which the sweep reads as "used then".
const prepare = (id, quality, caps = {}, { keepMs = 0 } = {}) => {
  const q = normQuality(quality);
  const st = status(id, q, caps);
  if (st.state === "ready" || st.state === "working" || st.state === "queued") return st;
  if (st.state === "unavailable" || st.state === "error") return st;
  // Room first: clear what is no longer needed, then refuse rather than fill
  // the disk the library and the downloads live on.
  sweep();
  const e = entryFor(id);
  const opt = (options(id, caps).options || []).find((o) => o.quality === q);
  const need = (opt && opt.sizeBytes) || (e ? fs.statSync(e.path).size : 0);
  if (roomFor(need) === false) {
    return { state: "error", quality: q, error: "the server is short on disk space — try a smaller size, or again later" };
  }
  jobs.set(jobKey(id, q), { state: "queued", progress: 0, caps, keepMs });
  queue.push({ id, q });
  pump();
  return status(id, q, caps);
};

// The ffmpeg arguments for one job. Exported for tests: this is where
// "original" becomes a copy instead of an encode.
const argsFor = (srcPath, tmp, q, caps = {}) => {
  const m = metadata.getCached(srcPath);
  const head = ["-v", "error", "-nostdin", "-y", "-i", srcPath, "-map", "0:v:0", "-map", "0:a:0?"];
  const tail = ["-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", tmp];
  if (q === "original" && originalMode(srcPath, caps) === "remux") {
    const hevc = m && m.video && m.video.codec === "hevc";
    const a = m && (m.audioStreams || [])[0];
    const audioOk = a && DIRECT_AUDIO.has(a.codec);
    return [
      ...head,
      "-c:v", "copy",
      ...(hevc ? ["-tag:v", "hvc1"] : []), // the tag Apple (and Chrome) want on HEVC in MP4
      ...(audioOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]),
      ...tail,
    ];
  }
  const target = q === "original" ? 1080 : Number(q);
  return [
    ...head,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-vf", `scale=-2:'min(${target},ih)'`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    ...tail,
  ];
};

const pump = () => {
  if (running || queue.length === 0) return;
  const { id, q } = queue.shift();
  const e = entryFor(id);
  const job = jobs.get(jobKey(id, q));
  if (!e || !job) return pump();
  fs.mkdirSync(DIR, { recursive: true });
  const out = outFileFor(id, e.path, q);
  const tmp = out + ".part";
  const meta = metadata.getCached(e.path);
  const duration = meta && meta.duration ? meta.duration : 0;
  job.state = "working";
  job.progress = 0;
  job.startedAt = Date.now();
  running = jobKey(id, q);
  console.log(`[offline] preparing ${id} at ${q} (${path.basename(e.path)})`);
  const child = spawn(config.FFMPEG, argsFor(e.path, tmp, q, job.caps || {}), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_ms=(\d+)/.exec(line) || /^out_time_us=(\d+)/.exec(line);
      if (m && duration) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / duration);
    }
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d.toString().slice(-500); });
  child.on("close", (code) => {
    running = null;
    if (code === 0 && fs.existsSync(tmp)) {
      try { fs.renameSync(tmp, out); } catch {}
      if (job.keepMs > 0) {
        try { const until = new Date(Date.now() + job.keepMs - KEEP_MS); fs.utimesSync(out, until, until); } catch {}
      }
      job.state = "ready";
      job.progress = 1;
      console.log(`[offline] ready ${id} at ${q} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB in ${((Date.now() - job.startedAt) / 1000).toFixed(0)}s)`);
    } else {
      try { fs.unlinkSync(tmp); } catch {}
      job.state = "error";
      job.error = err.trim().split("\n").pop() || `ffmpeg exited ${code}`;
      console.warn(`[offline] failed ${id} at ${q}: ${job.error}`);
    }
    pump();
  });
  child.on("error", (e2) => {
    running = null;
    job.state = "error";
    job.error = e2.message;
    pump();
  });
};

// The prepared file for /offline/file/:id, or null.
const fileFor = (id, quality) => {
  const e = entryFor(id);
  if (!e) return null;
  const file = outFileFor(id, e.path, normQuality(quality));
  if (!fs.existsSync(file)) return null;
  touchCopy(file);
  return file;
};

// hourly, and once shortly after boot (leftovers from before a restart)
setTimeout(sweep, 60 * 1000).unref();
setInterval(sweep, 3600 * 1000).unref();

// For the healer: the conversion in progress (if any) and what is queued.
const load = () => {
  const j = running ? jobs.get(running) : null;
  return { running: running || null, since: j ? j.startedAt : null, progress: j ? j.progress || 0 : 0, queued: queue.length };
};

module.exports = { status, prepare, fileFor, options, sweep, load, DIR, MAX_BYTES, QUALITIES, _internals: { toRemove, KEEP_MS, isDirect, originalMode, argsFor, normQuality, outFileFor, DIRECT_CONTAINERS } };
