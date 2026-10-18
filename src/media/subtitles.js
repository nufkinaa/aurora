// Subtitle delivery: external SRT->WebVTT conversion and embedded-track
// extraction via ffmpeg, disk-cached so repeat loads are instant.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const config = require("../config");
const scannerLib = require("../lib/lazy")(require, "./scanner");
const childrenLib = require("../lib/lazy")(require, "../lib/children");

const VTT_CACHE_DIR = path.join(config.CACHE_DIR, "vtt");
const inflight = new Map(); // cacheFile -> Promise<boolean>

const srtToVtt = (srt) =>
  "WEBVTT\n\n" +
  srt
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

// Decode subtitle bytes: strict UTF-8 first, then the legacy code page that
// yields real letters — Windows-1255 for Hebrew, Windows-1251 for Russian
// (subs from the wild are often ANSI-encoded, and the same bytes are one
// alphabet in one page and the other in the other) — and strip any BOM.
const decodeSubtitle = (buf) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      const heb = new TextDecoder("windows-1255").decode(buf);
      const rus = new TextDecoder("windows-1251").decode(buf);
      const hebLetters = (heb.match(/[\u05d0-\u05ea]/g) || []).length;
      const rusLetters = (rus.match(/[\u0410-\u044f\u0451\u0401]/g) || []).length;
      text = rusLetters > hebLetters ? rus : heb;
    } catch {
      text = buf.toString("utf-8");
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
};

// An external subtitle file as it should be PLAYED: lined up against the
// video's own track when the background check found it off (media/sublang.js
// syncFor — the file on disk is never rewritten), and with the punctuation of
// a Hebrew/Arabic file authored for renderers without bidi put back
// (media/subsync.js). -> { text (WebVTT), how: [what was done] }
const playable = (subPath, content) => {
  const subsync = require("./subsync");
  const ext = path.extname(subPath).toLowerCase();
  const how = [];
  let text = content;
  let srt = ext === ".srt";
  // Lined up with the FILM'S AUDIO (media/subaudio.js: the Resync button, or
  // the background's confident result) goes first — it is what is actually
  // said; else lined up with the video's own text track (media/sublang.js).
  let audio = null;
  let trackSync = true;
  try {
    const subaudio = require("./subaudio");
    audio = subaudio.planFor({ kind: "file", path: subPath });
    trackSync = subaudio.trackSyncAllowed({ kind: "file", path: subPath });
  } catch {}
  let sync = null;
  if (!audio && trackSync) { try { sync = require("./sublang").syncFor(subPath); } catch {} }
  if (audio && (ext === ".srt" || ext === ".vtt")) {
    const cues = subsync.parse(text);
    if (cues.length) {
      text = subsync.toSrt(require("./audiosync").applyPlan(cues, audio.plan));
      srt = true;
      how.push(`audio: ${audio.words}${audio.source === "resync" ? " (resync)" : ""}`);
    }
  } else if (sync && (ext === ".srt" || ext === ".vtt")) {
    const cues = subsync.parse(text);
    if (cues.length) {
      text = subsync.toSrt(subsync.retime(cues, sync.scale, sync.offset));
      srt = true;
      how.push(`${sync.how}: x${sync.scale.toFixed(4)} ${sync.offset >= 0 ? "+" : ""}${sync.offset.toFixed(2)}s`);
    }
  }
  const rtl = subsync.fixRtlPunctuation(text);
  if (rtl.changed) {
    text = rtl.text;
    how.push(`rtl punctuation x${rtl.changed}`);
  }
  return { text: srt ? srtToVtt(text) : text, how };
};

// Serve an external subtitle file as WebVTT
// (read without blocking; the dates the timing checks compare come from the
// library walk where it dated the file — media/scanner.js withLastWalk)
const serveExternal = async (subPath, res) => {
  let content;
  try {
    content = decodeSubtitle(await fs.promises.readFile(subPath));
  } catch {
    return res.status(404).send("Subtitle not found");
  }
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  // revalidated (a cheap 304 by ETag) rather than kept for an hour: a timing
  // repair can land while somebody is watching, and the next load must get it
  res.setHeader("Cache-Control", "no-cache");
  let out;
  try { out = scannerLib().withLastWalk(() => playable(subPath, content), { knownOnly: true }); } catch { out = playable(subPath, content); }
  if (out.how.length) res.setHeader("X-Aurora-Subtitle-Repair", out.how.join("; ").slice(0, 200));
  res.send(out.text);
};

// Where an extracted track is kept (one file per video, mtime and track).
const cacheFileFor = (videoPath, mtime, trackIndex) =>
  path.join(VTT_CACHE_DIR, `${crypto.createHash("md5").update(`${videoPath}|${mtime}|${trackIndex}`).digest("hex")}.vtt`);

// Every listed embedded text track of a video in ONE pass over the file (a
// subtitle stream is spread through the whole file, so each extraction is a
// full read — forty tracks one at a time would be forty reads). Written to the
// same cache the player's requests are answered from, so a track this has
// seen is instant to play. Tracks already cached are read, not extracted.
//   -> Promise<{ [trackIndex]: vttText }>   (a track that failed is missing)
// opts.spawned(child): handed the ffmpeg process (the background budget
// lowers and pauses it — media/cpuwork.js).
const extractAll = (videoPath, indices, opts = {}) =>
  new Promise((resolve) => {
    let mtime = 0;
    try { mtime = fs.statSync(videoPath).mtimeMs; } catch { return resolve({}); }
    const out = {};
    const todo = [];
    for (const i of indices) {
      const f = cacheFileFor(videoPath, mtime, i);
      try { out[i] = fs.readFileSync(f, "utf-8"); } catch { todo.push(i); }
    }
    if (!todo.length || !config.ffmpegAvailable) return resolve(out);
    fs.mkdirSync(VTT_CACHE_DIR, { recursive: true });
    const args = ["-v", "error", "-nostdin", "-i", videoPath];
    for (const i of todo) args.push("-map", `0:s:${i}`, "-f", "webvtt", "-y", `${cacheFileFor(videoPath, mtime, i)}.part`);
    let proc;
    try {
      proc = spawn(config.FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch {
      return resolve(out);
    }
    if (opts.spawned) { try { opts.spawned(proc); } catch {} }
    let stderr = "";
    proc.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
    const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, opts.timeoutMs || 30 * 60 * 1000);
    const finish = (code) => {
      clearTimeout(killer);
      for (const i of todo) {
        const f = cacheFileFor(videoPath, mtime, i);
        try {
          if (code === 0) {
            fs.renameSync(`${f}.part`, f);
            out[i] = fs.readFileSync(f, "utf-8");
          } else fs.unlinkSync(`${f}.part`);
        } catch {}
      }
      if (code !== 0) console.error(`[subs] extracting ${todo.length} track(s) from ${path.basename(videoPath)} failed:`, stderr.trim().slice(-200) || code);
      resolve(out);
    };
    proc.on("error", () => finish(-1));
    proc.on("close", finish);
  });

// Extract an embedded text subtitle track as WebVTT, streaming to the
// response while also caching to disk for instant repeats.
// An embedded track somebody pressed Resync on is served moved to the audio
// (media/subaudio.js), for everyone; the extraction cache stays the file's.
// Revalidated (no-cache, a 304 by ETag) rather than kept for a day, so such
// a correction reaches the other devices on their next load.
const serveEmbedded = (videoPath, trackIndex, res) => {
  if (!config.ffmpegAvailable)
    return res.status(503).send("ffmpeg not available");
  const audio = embeddedPlan(videoPath, trackIndex);
  if (audio) {
    return vttText({ videoPath, trackIndex, original: true }).then((text) => {
      if (text == null) return res.status(500).send("Failed to extract subtitle");
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Aurora-Subtitle-Repair", `audio: ${audio.words} (resync)`.slice(0, 200));
      res.send(moveEmbedded(text, audio));
    }, () => res.status(500).send("Failed to extract subtitle"));
  }
  return extractEmbedded(videoPath, trackIndex, res);
};

const embeddedPlan = (videoPath, trackIndex) => {
  try { return require("./subaudio").planFor({ kind: "emb", video: videoPath, index: trackIndex }); } catch { return null; }
};
const moveEmbedded = (text, audio) => {
  const subsync = require("./subsync");
  return srtToVtt(subsync.toSrt(require("./audiosync").applyPlan(subsync.parse(text), audio.plan)));
};

// The extraction itself (the file's own timing).
const extractEmbedded = (videoPath, trackIndex, res) => {

  let mtime = 0;
  try {
    mtime = fs.statSync(videoPath).mtimeMs;
  } catch {
    return res.status(404).send("Video not found");
  }

  const cacheFile = cacheFileFor(videoPath, mtime, trackIndex);

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (fs.existsSync(cacheFile)) return res.sendFile(cacheFile);

  if (inflight.has(cacheFile)) {
    inflight.get(cacheFile).then((ok) => {
      if (ok) res.sendFile(cacheFile);
      else res.status(500).send("Failed to extract subtitle");
    });
    return;
  }

  fs.mkdirSync(VTT_CACHE_DIR, { recursive: true });
  const tmpFile = `${cacheFile}.part`;
  const ffmpeg = spawn(
    config.FFMPEG,
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-map",
      `0:s:${trackIndex}`,
      "-f",
      "webvtt",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  const fileStream = fs.createWriteStream(tmpFile);
  ffmpeg.stdout.pipe(res);
  ffmpeg.stdout.pipe(fileStream);

  try { childrenLib().track(ffmpeg, "subtitle"); } catch {}
  // (bounded: the end of what it said is what is logged; and a time limit —
  // a hung read kept this subtitle's "in flight" entry, and every later
  // request for it waiting, for ever)
  let stderr = "";
  ffmpeg.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  const hung = setTimeout(() => { try { ffmpeg.kill("SIGKILL"); } catch {} }, 10 * 60 * 1000);
  hung.unref?.();
  ffmpeg.on("close", () => clearTimeout(hung));

  let resolveJob;
  inflight.set(cacheFile, new Promise((r) => (resolveJob = r)));
  const finish = (ok) => {
    inflight.delete(cacheFile);
    resolveJob(ok);
  };

  ffmpeg.on("error", (err) => {
    console.error("ffmpeg spawn error:", err.message);
    fileStream.destroy();
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    finish(false);
    if (!res.headersSent) res.status(500).send("Failed to extract subtitle");
    else res.end();
  });

  ffmpeg.on("close", (code) => {
    fileStream.end(() => {
      if (code === 0) {
        try {
          fs.renameSync(tmpFile, cacheFile);
          finish(true);
        } catch {
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
          finish(false);
        }
      } else {
        try {
          fs.unlinkSync(tmpFile);
        } catch {}
        finish(false);
        console.error(
          `ffmpeg failed extracting track ${trackIndex} from ${videoPath}:`,
          stderr.trim().slice(-300) || "(no stderr)",
        );
        if (!res.headersSent)
          res.status(500).send("Failed to extract subtitle");
        else res.end();
      }
    });
  });

  // Client gone? Keep extracting to warm the cache; just stop piping.
  res.on("close", () => ffmpeg.stdout.unpipe(res));
};

// A subtitle's WebVTT as TEXT (null when it can't be had), for a caller that
// has to change it before it goes out — the AirPlay subtitle playlist adds
// the timestamp map Apple's players want (routes/stream.js). The same
// conversion and the same extraction cache as the two routes above.
// `original`: the embedded track as the file has it, without a Resync's
// correction (what the alignment itself reads).
const vttText = async ({ subPath = null, videoPath = null, trackIndex = 0, original = false } = {}) => {
  if (videoPath && !subPath && !original) {
    const audio = embeddedPlan(videoPath, trackIndex);
    if (audio) {
      const text = await vttText({ videoPath, trackIndex, original: true });
      return text == null ? null : moveEmbedded(text, audio);
    }
  }
  if (subPath) {
    try {
      // as the player gets it (serveExternal): lined up and with the
      // punctuation repaired, so the Apple TV shows the same timing
      return playable(subPath, decodeSubtitle(fs.readFileSync(subPath))).text;
    } catch {
      return null;
    }
  }
  if (!videoPath || !config.ffmpegAvailable) return null;
  let mtime = 0;
  try { mtime = fs.statSync(videoPath).mtimeMs; } catch { return null; }
  const cacheFile = cacheFileFor(videoPath, mtime, trackIndex);
  const read = () => { try { return fs.readFileSync(cacheFile, "utf-8"); } catch { return null; } };
  if (fs.existsSync(cacheFile)) return read();
  // run the extraction into a sink that keeps nothing: what is wanted is
  // the cache file it leaves behind
  const { Writable } = require("stream");
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  Object.assign(sink, { headersSent: false, setHeader() {}, status() { return sink; }, send() { sink.end(); }, sendFile() { sink.end(); } });
  extractEmbedded(videoPath, trackIndex, sink);
  if (fs.existsSync(cacheFile)) return read();
  const job = inflight.get(cacheFile);
  if (!job) return null;
  return (await job) ? read() : null;
};

const clearCache = () => {
  try {
    fs.rmSync(VTT_CACHE_DIR, { recursive: true, force: true });
  } catch {}
};

module.exports = { serveExternal, serveEmbedded, vttText, clearCache, extractAll, cacheFileFor, decodeSubtitle, srtToVtt, playable };
