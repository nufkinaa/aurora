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
// TWO LANES, one ffmpeg in each (a phone can wait; the streaming server can't
// be starved), progress parsed from ffmpeg's own -progress stream:
//   copy     the repackagings ("original" with the video copied): the disk's
//            speed, seconds — never held back by anything heavy;
//   encode   the real re-encodes, which wait for their place (cpuwork.js).
// Before (2026-10-20, elia on his iPhone: "choosing Original just says
// 'Preparing on the server' and does not start"), there was ONE slot for
// both: a play-ready copy made ahead of time (preconvert.js, after every
// download) took it — and kept it while it waited for viewers to stop, or sat
// paused under one — and a person's ten-second repackaging queued behind an
// hour of somebody else's encode, saying nothing. Now:
//   - a repackaging never waits for an encode (its own lane);
//   - a person's own request goes ahead of every copy made ahead of time —
//     one waiting for its place is passed, one already running is SET ASIDE
//     (stopped, and queued again behind the person's);
//   - a job that waits says why (status().wait: behind another copy, the
//     server busy with somebody's stream, paused), and the log says so too;
//   - a person can cancel (cancel()), a failed copy can be asked for again,
//     a copy the sweep removed is made again, and a conversion that stops
//     producing anything for STALL_MS is stopped as failed instead of
//     "working" for ever.
//
// These are BACKGROUND jobs (cpuwork.js): they run at the lowest priority on
// half the machine's threads; an ENCODE is not started while somebody's
// stream is being encoded, is paused when one starts (Linux/macOS; on Windows
// the idle priority class does the yielding), and can be shed back into this
// queue. A copy somebody asked for goes ahead of the play-ready copies made
// after a download. (Before, they ran at normal priority on every thread —
// above the viewers' own encoders.)
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

// "<id>|<quality>" -> { state, progress, error, caps, keepMs, ahead, wanted,
//   lane, child, place, startedAt, queuedAt, lastOutputAt, shed, cancelled, stalled }
//   ahead   made ahead of time (preconvert.js): nobody is waiting for it
//   wanted  how many people's requests are waiting for it (cancel() counts down)
const jobs = new Map();
const queue = []; // { id, q, ahead, lane } — in the order asked; a person's go first (takeNext)
const lanes = { copy: null, encode: null }; // the job key running in each lane
let encodeAsk = null; // a place at cpuwork's gate is being asked for (which job gets it is chosen when it comes)
const STALL_MS = 10 * 60 * 1000; // no word from ffmpeg for this long (not paused): it is stuck

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
  for (const key of [lanes.copy, lanes.encode]) {
    if (!key) continue;
    const [id, q] = key.split("|");
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

// Why a job that is not running yet (or is paused) is not making progress —
// for the person looking at "Preparing…" (status().wait) and the log.
//   → { reason: "behind" | "viewers" | "busy" | "paused", text, before } or null
const waitOf = (key, job) => {
  if (!job) return null;
  if (job.state === "working") {
    return job.place && typeof job.place.paused === "function" && job.place.paused()
      ? { reason: "paused", text: "paused while somebody's stream is being converted — it carries on by itself", before: 0 }
      : null;
  }
  if (job.state !== "queued") return null;
  const lane = job.lane || "encode";
  // the people's requests in this lane that go before this one
  const mine = queue.findIndex((x) => jobKey(x.id, x.q) === key);
  const before = mine < 0 ? 0 : queue.slice(0, mine).filter((x) => x.lane === lane && (job.ahead || !x.ahead)).length;
  const more = before > 0 ? ` (${before} more before yours)` : "";
  const runningKey = lanes[lane];
  const runningJob = runningKey ? jobs.get(runningKey) : null;
  if (runningKey && runningKey !== key && !(runningJob && runningJob.ahead && !job.ahead)) {
    return { reason: "behind", text: `waiting for the server — another copy is being made${more}`, before: before + 1 };
  }
  if (lane === "encode" && !lanes.encode) {
    if (!cpuwork.viewer.quiet()) return { reason: "viewers", text: `waiting for the server — it is converting somebody's stream right now; yours starts when that is done${more}`, before };
    if (!cpuwork.background.mayStart("encode")) return { reason: "busy", text: `waiting for the server — it is finishing other background work${more}`, before };
  }
  return before > 0 ? { reason: "behind", text: `waiting for the server — another copy is being made${more}`, before } : null;
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
  const key = jobKey(id, q);
  let job = jobs.get(key);
  // made once, then cleared by the sweep (or by hand): it is made again —
  // "ready" with no file behind it used to send a device to a 404 for good
  if (job && job.state === "ready" && !fs.existsSync(file)) { jobs.delete(key); job = null; }
  if (fs.existsSync(file) && (!job || job.state !== "working")) {
    return { state: "ready", quality: q, direct: false, url: `/offline/file/${id}?q=${q}`, sizeBytes: fs.statSync(file).size };
  }
  if (job) {
    const wait = waitOf(key, job);
    return { state: job.state, quality: q, progress: job.progress || 0, error: job.error || null, lane: job.lane || null, ...(wait ? { wait } : {}) };
  }
  if (!config.ffmpegAvailable) return { state: "unavailable", error: "the server has no ffmpeg, so this file can't be converted for this device" };
  return { state: "idle", quality: q };
};

// `keepMs`: keep the finished copy at least this long (preconvert.js) —
// stamped as a date in the future, which the sweep reads as "used then".
// A request WITHOUT keepMs is a person's: it goes ahead of every copy made
// ahead of time, and one of those running in its lane is set aside for it.
const prepare = (id, quality, caps = {}, { keepMs = 0 } = {}) => {
  const q = normQuality(quality);
  const key = jobKey(id, q);
  const person = !(keepMs > 0);
  // a copy that failed before is tried again when somebody asks again (it
  // used to answer the old error until the server restarted)
  const old = jobs.get(key);
  if (old && old.state === "error") jobs.delete(key);
  const st = status(id, q, caps);
  if (st.state === "ready") return st;
  if (st.state === "working" || st.state === "queued") {
    const job = jobs.get(key);
    if (job && person) {
      job.wanted = (job.wanted || 0) + 1;
      if (job.ahead) {
        // the copy being made ahead of time is the one this person wants: it
        // is theirs now, with their place in the line
        job.ahead = false;
        for (const x of queue) if (jobKey(x.id, x.q) === key) x.ahead = false;
        console.log(`[offline] ${id} at ${q}: the copy being made ahead of time is now asked for by somebody — it goes first`);
        // (a repackaging already under way is somebody's now: up to their level —
        // where a priority can be raised again; elsewhere it stays where it is)
        if (job.state === "working" && job.child && job.lane === "copy" && require("../lib/prio").canRaise()) cpuwork.viewer.level(job.child);
      }
      makeRoomFor(key);
      pump();
      return status(id, q, caps);
    }
    return st;
  }
  if (st.state === "unavailable" || st.state === "error") return st;
  // Room first: clear what is no longer needed, then refuse rather than fill
  // the disk the library and the downloads live on.
  sweep();
  const e = entryFor(id);
  const opt = (options(id, caps).options || []).find((o) => o.quality === q);
  const need = (opt && opt.sizeBytes) || (e ? fs.statSync(e.path).size : 0);
  if (roomFor(need) === false) {
    console.warn(`[offline] ${id} at ${q}: not made — the server is short on disk space`);
    return { state: "error", quality: q, error: "the server is short on disk space — try a smaller size, or again later" };
  }
  const lane = isEncode(e.path, q, caps) ? "encode" : "copy";
  jobs.set(key, { state: "queued", progress: 0, caps, keepMs, ahead: !person, wanted: person ? 1 : 0, lane, queuedAt: Date.now() });
  queue.push({ id, q, ahead: !person, lane });
  if (person) makeRoomFor(key);
  pump();
  const out = status(id, q, caps);
  if (out.state === "queued") {
    console.log(`[offline] ${id} at ${q} queued (${person ? "asked for by somebody" : "made ahead of time"}, ${lane === "copy" ? "a repackaging" : "an encode"})${out.wait ? ` — waits: ${out.wait.reason}` : ""}`);
  }
  return out;
};

// A person's job is waiting in its lane: a copy made ahead of time that holds
// the lane is set aside (stopped; it is queued again and starts over later).
const makeRoomFor = (key) => {
  const job = jobs.get(key);
  if (!job || job.ahead || job.state !== "queued") return;
  const holder = lanes[job.lane] ? jobs.get(lanes[job.lane]) : null;
  if (!holder || !holder.ahead || holder.state !== "working" || !holder.child || holder.shed) return;
  holder.shed = true;
  console.log(`[offline] setting aside the copy made ahead of time (${lanes[job.lane]}) — ${key} was asked for by somebody`);
  try { holder.child.kill("SIGKILL"); } catch {}
};

// A person no longer wants the copy (the phone's Cancel). It stops when
// nobody else is waiting for it; a copy that is also being made ahead of
// time goes back to being that.
const cancel = (id, quality) => {
  const q = normQuality(quality);
  const key = jobKey(id, q);
  const job = jobs.get(key);
  if (!job || (job.state !== "queued" && job.state !== "working")) return { state: "idle", quality: q, cancelled: false };
  if (job.wanted > 0) job.wanted--;
  if (job.wanted > 0) return { ...status(id, q, job.caps || {}), cancelled: false };
  if (job.keepMs > 0) {
    job.ahead = true;
    for (const x of queue) if (jobKey(x.id, x.q) === key) x.ahead = true;
    return { ...status(id, q, job.caps || {}), cancelled: false };
  }
  if (job.state === "queued") {
    for (let i = queue.length - 1; i >= 0; i--) if (jobKey(queue[i].id, queue[i].q) === key) queue.splice(i, 1);
    jobs.delete(key);
    console.log(`[offline] ${id} at ${q}: cancelled before it started`);
  } else {
    job.cancelled = true;
    console.log(`[offline] ${id} at ${q}: cancelled — stopping it`);
    try { if (job.child) job.child.kill("SIGKILL"); } catch {}
  }
  pump();
  return { state: "idle", quality: q, cancelled: true };
};

// The ffmpeg arguments for one job. Exported for tests: this is where
// "original" becomes a copy instead of an encode.
// `threads` (the background cap, cpuwork.js): decoder, filters and encoder
// alike — without it ffmpeg takes every core for each.
const argsFor = (srcPath, tmp, q, caps = {}, { threads = 0 } = {}) => {
  const m = metadata.getCached(srcPath);
  const cap = threads > 0 ? ["-threads", String(threads)] : [];
  const head = ["-v", "error", "-nostdin", "-y", ...cap, ...(threads > 0 ? ["-filter_threads", String(threads)] : []), "-i", srcPath, "-map", "0:v:0", "-map", "0:a:0?"];
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
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", ...cap,
    "-vf", `scale=-2:'min(${target},ih)'`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    ...tail,
  ];
};

// Does this job re-encode the picture (heavy), or only repackage it (the
// disk's speed)?
const isEncode = (srcPath, q, caps) => !(q === "original" && originalMode(srcPath, caps) === "remux");

const cpuwork = require("./cpuwork");
const spawner = { spawn }; // (replaceable: the tests start no ffmpeg)

// The next job for a lane: a person's first, then the copies made ahead of
// time, each in the order asked. `take`: off the queue.
const nextIndex = (lane) => {
  let at = queue.findIndex((x) => x.lane === lane && !x.ahead);
  if (at < 0) at = queue.findIndex((x) => x.lane === lane);
  return at;
};
const takeNext = (lane) => {
  for (;;) {
    const at = nextIndex(lane);
    if (at < 0) return null;
    const ent = queue.splice(at, 1)[0];
    const key = jobKey(ent.id, ent.q);
    const job = jobs.get(key);
    const e = entryFor(ent.id);
    if (!job || job.state !== "queued") continue; // cancelled, or taken already
    if (!e) { job.state = "error"; job.error = "the file is no longer in the library"; continue; }
    return { ...ent, ahead: !!job.ahead, key, job, e };
  }
};

const failStart = (job, key, err) => {
  job.state = "error";
  job.error = (err && err.message) || String(err);
  job.child = null;
  console.warn(`[offline] failed ${key.split("|")[0]} at ${key.split("|")[1]}: could not start — ${job.error}`);
};

const pump = () => {
  pumpCopy();
  pumpEncode();
};

// Repackagings: one at a time, at once, whatever else is happening.
const pumpCopy = () => {
  while (!lanes.copy) {
    const n = takeNext("copy");
    if (!n) return;
    lanes.copy = n.key;
    try {
      start({ ...n, place: null });
      return;
    } catch (err) {
      lanes.copy = null;
      failStart(n.job, n.key, err);
    }
  }
};

// Encodes: one at a time, each when cpuwork gives it a place. WHICH job
// gets the place is chosen when the place comes — so a person who asks while
// a copy made ahead of time waits for viewers to stop is not behind it.
const pumpEncode = () => {
  if (lanes.encode || encodeAsk || nextIndex("encode") < 0) return;
  const peek = () => { const at = nextIndex("encode"); return at < 0 ? null : queue[at]; };
  if (!cpuwork.background.mayStart("encode")) {
    const p = peek();
    console.log(`[offline] ${p.id} at ${p.q} is waiting — ${cpuwork.viewer.quiet() ? "the server is finishing other background work" : "somebody's stream is being encoded"}`);
  }
  const meta = {
    // (read when the place is granted: the job that is about to get it)
    get label() {
      const p = lanes.encode ? null : peek();
      const key = lanes.encode || (p && jobKey(p.id, p.q));
      const job = key ? jobs.get(key) : null;
      const e = key ? entryFor(key.split("|")[0]) : null;
      return `${job && job.ahead ? "play-ready copy" : "copy"} of ${e ? path.basename(e.path) : "a film"}`;
    },
    pausable: true,
    // shed (the viewers' encoders fell behind): stop, and back to the front of this queue
    onShed: () => {
      const job = lanes.encode ? jobs.get(lanes.encode) : null;
      if (!job) return;
      job.shed = true;
      try { if (job.child) job.child.kill("SIGKILL"); } catch {}
    },
  };
  let ask;
  try { ask = cpuwork.background.gate("encode", meta); } catch (err) { console.warn(`[offline] could not ask for a place to encode: ${err.message}`); return; }
  encodeAsk = ask;
  ask.then((place) => {
    encodeAsk = null;
    for (;;) {
      const n = takeNext("encode");
      if (!n) { place.release(); return; }
      lanes.encode = n.key;
      try {
        start({ ...n, place });
        return;
      } catch (err) {
        lanes.encode = null;
        failStart(n.job, n.key, err);
      }
    }
  }).catch((err) => {
    encodeAsk = null;
    console.warn(`[offline] the wait for a place to encode failed: ${(err && err.message) || err}`);
    setTimeout(pump, 5000).unref();
  });
};

const start = ({ id, q, ahead, e, job, place }) => {
  fs.mkdirSync(DIR, { recursive: true });
  const out = outFileFor(id, e.path, q);
  const tmp = out + ".part";
  const meta = metadata.getCached(e.path);
  const duration = meta && meta.duration ? meta.duration : 0;
  const lane = job.lane || (place ? "encode" : "copy");
  job.state = "working";
  job.progress = 0;
  job.shed = false;
  job.cancelled = false;
  job.stalled = false;
  job.startedAt = Date.now();
  job.lastOutputAt = job.startedAt;
  job.place = place || null;
  console.log(`[offline] preparing ${id} at ${q} (${path.basename(e.path)})${ahead ? " — made ahead of time" : ""}`);
  const child = require("../lib/children").track(
    spawner.spawn(config.FFMPEG, argsFor(e.path, tmp, q, job.caps || {}, { threads: place ? cpuwork.background.threads() : 0 }), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
    "offline",
  );
  job.child = child;
  if (place) place.attach(child);
  // a repackaging: quick, and nobody's stream. Made ahead of time, nobody
  // waits for it: the lowest priority. A person's (Original on a phone): at
  // the viewers' level — at the lowest it starved behind any stream being
  // encoded on every core, and the phone said "Preparing" for minutes.
  else if (ahead) cpuwork.background.lower(child);
  else cpuwork.viewer.level(child);
  let buf = "";
  child.stdout.on("data", (d) => {
    job.lastOutputAt = Date.now();
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
  child.stderr.on("data", (d) => { job.lastOutputAt = Date.now(); err += d.toString().slice(-500); });
  let ended = false;
  const finish = (code, failure) => {
    if (ended) return;
    ended = true;
    if (lanes[lane] === jobKey(id, q)) lanes[lane] = null;
    job.child = null;
    job.place = null;
    const mine = jobs.get(jobKey(id, q)) === job;
    if (job.cancelled || !mine) {
      try { fs.unlinkSync(tmp); } catch {}
      if (mine) jobs.delete(jobKey(id, q));
      console.log(`[offline] ${id} at ${q}: stopped (cancelled)`);
      return pump();
    }
    if (job.shed) {
      // stopped to make room (viewers, or somebody's own request): nothing
      // failed, it is queued again
      try { fs.unlinkSync(tmp); } catch {}
      job.shed = false;
      job.state = "queued";
      job.progress = 0;
      job.queuedAt = Date.now();
      queue.unshift({ id, q, ahead: !!job.ahead, lane });
      console.log(`[offline] ${id} at ${q} was set aside — queued again`);
      return pump();
    }
    if (!failure && code === 0 && fs.existsSync(tmp)) {
      try { fs.renameSync(tmp, out); } catch {}
      if (job.keepMs > 0) {
        try { const until = new Date(Date.now() + job.keepMs - KEEP_MS); fs.utimesSync(out, until, until); } catch {}
      }
      job.state = "ready";
      job.progress = 1;
      let mb = 0;
      try { mb = fs.statSync(out).size / 1e6; } catch {}
      console.log(`[offline] ready ${id} at ${q} (${mb.toFixed(0)} MB in ${((Date.now() - job.startedAt) / 1000).toFixed(0)}s)`);
    } else {
      try { fs.unlinkSync(tmp); } catch {}
      job.state = "error";
      job.error = job.stalled
        ? "the conversion stopped making progress — try again, or pick a smaller size"
        : failure || err.trim().split("\n").pop() || `ffmpeg exited ${code}`;
      console.warn(`[offline] failed ${id} at ${q}: ${job.error}`);
    }
    pump();
  };
  child.on("close", (code) => finish(code, null));
  child.on("error", (e2) => finish(null, e2.message));
};

// Nothing from ffmpeg for STALL_MS, and not paused on purpose: stopped, as a
// failure the phone can show (it used to say "Preparing" for ever).
const checkStalls = (now = Date.now()) => {
  const stopped = [];
  for (const key of [lanes.copy, lanes.encode]) {
    const job = key ? jobs.get(key) : null;
    if (!job || job.state !== "working" || !job.child || job.stalled) continue;
    if (job.place && typeof job.place.paused === "function" && job.place.paused()) { job.lastOutputAt = now; continue; }
    if (now - (job.lastOutputAt || job.startedAt || now) < STALL_MS) continue;
    job.stalled = true;
    console.warn(`[offline] ${key.replace("|", " at ")} made no progress for ${Math.round(STALL_MS / 60000)} minutes — stopping it`);
    try { job.child.kill("SIGKILL"); } catch {}
    stopped.push(key);
  }
  return stopped;
};
setInterval(() => { try { checkStalls(); } catch {} }, 60 * 1000).unref();

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
// (the encode first: that is the one that can run long; `waiting`: the oldest
// request still in the queue, so a job that never starts is seen too)
const load = () => {
  const running = lanes.encode || lanes.copy;
  const j = running ? jobs.get(running) : null;
  let oldest = null;
  for (const x of queue) {
    const jj = jobs.get(jobKey(x.id, x.q));
    if (jj && !jj.ahead && jj.queuedAt && (!oldest || jj.queuedAt < oldest)) oldest = jj.queuedAt;
  }
  return { running: running || null, since: j ? j.startedAt : null, progress: j ? j.progress || 0 : 0, queued: queue.length, waitingSince: oldest };
};

module.exports = { status, prepare, cancel, fileFor, options, sweep, load, DIR, MAX_BYTES, QUALITIES, STALL_MS, _internals: { toRemove, KEEP_MS, isDirect, originalMode, argsFor, normQuality, outFileFor, DIRECT_CONTAINERS, isEncode, spawner, jobs, queue, lanes, pump, checkStalls, waitOf, _reset: () => { jobs.clear(); queue.length = 0; lanes.copy = null; lanes.encode = null; encodeAsk = null; } } };
