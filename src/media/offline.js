// Offline copies for phones: a browser-playable file per library video.
//
// A phone that saves a title for the plane needs an MP4 it can decode on
// its own (H.264 + AAC) — most library files are MKV/HEVC/AC-3, which no
// phone browser plays without the server's help. So "prepare" makes one:
// a 720p H.264/AAC MP4 with faststart, once, cached under data/cache/
// offline and served with Range support by /offline/file/:id. A file that
// is already playable as-is (MP4 with H.264 + AAC) is served directly.
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

const jobs = new Map(); // id -> {state, progress, error, file, startedAt}
const queue = [];
let running = null;

const entryFor = (id) => {
  const e = scanner.resolve(id);
  return e && e.kind === "video" && fs.existsSync(e.path) ? e : null;
};

const mtimeOf = (p) => {
  try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
};

const outFileFor = (id, srcPath) => path.join(DIR, `${id}-${mtimeOf(srcPath)}.mp4`);

// Can the phone play the file as it is? Only when we KNOW the codecs are
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

// Where the phone should fetch from, and whether it exists yet.
const status = (id) => {
  const e = entryFor(id);
  if (!e) return { state: "error", error: "not found" };
  if (isDirect(e.path)) {
    return { state: "ready", direct: true, url: `/stream/video/${id}`, sizeBytes: fs.statSync(e.path).size };
  }
  const file = outFileFor(id, e.path);
  const job = jobs.get(id);
  if (fs.existsSync(file) && (!job || job.state !== "working")) {
    return { state: "ready", direct: false, url: `/offline/file/${id}`, sizeBytes: fs.statSync(file).size };
  }
  if (job) return { state: job.state, progress: job.progress || 0, error: job.error || null };
  if (!config.ffmpegAvailable) return { state: "unavailable", error: "the server has no ffmpeg, so this file can't be converted for a phone" };
  return { state: "idle" };
};

const prepare = (id) => {
  const st = status(id);
  if (st.state === "ready" || st.state === "working" || st.state === "queued") return st;
  if (st.state === "unavailable" || st.state === "error") return st;
  jobs.set(id, { state: "queued", progress: 0 });
  queue.push(id);
  pump();
  return status(id);
};

const pump = () => {
  if (running || queue.length === 0) return;
  const id = queue.shift();
  const e = entryFor(id);
  const job = jobs.get(id);
  if (!e || !job) return pump();
  fs.mkdirSync(DIR, { recursive: true });
  const out = outFileFor(id, e.path);
  const tmp = out + ".part";
  const meta = metadata.getCached(e.path);
  const duration = meta && meta.duration ? meta.duration : 0;
  job.state = "working";
  job.progress = 0;
  job.startedAt = Date.now();
  running = id;
  console.log(`[offline] preparing ${id} (${path.basename(e.path)})`);
  const args = [
    "-v", "error", "-nostdin", "-y",
    "-i", e.path,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-vf", "scale='min(1280,iw)':-2",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-f", "mp4", tmp,
  ];
  const child = spawn(config.FFMPEG, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      job.state = "ready";
      job.progress = 1;
      console.log(`[offline] ready ${id} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB in ${((Date.now() - job.startedAt) / 1000).toFixed(0)}s)`);
    } else {
      try { fs.unlinkSync(tmp); } catch {}
      job.state = "error";
      job.error = err.trim().split("\n").pop() || `ffmpeg exited ${code}`;
      console.warn(`[offline] failed ${id}: ${job.error}`);
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
const fileFor = (id) => {
  const e = entryFor(id);
  if (!e) return null;
  const file = outFileFor(id, e.path);
  return fs.existsSync(file) ? file : null;
};

module.exports = { status, prepare, fileFor, _internals: { isDirect, DIRECT_CONTAINERS } };
