// Streaming endpoints: video (range requests), covers, subtitles, downloads.
const fs = require("fs");
const path = require("path");
const express = require("express");
const scanner = require("../media/scanner");
const subtitles = require("../media/subtitles");

const router = express.Router();

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const resolveKind = (id, kind) => {
  const entry = scanner.resolve(id);
  return entry && entry.kind === kind ? entry : null;
};

// Video streaming with HTTP range support
router.get("/stream/video/:id", (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");

  const stat = fs.statSync(entry.path);
  const total = stat.size;
  const mime = MIME[path.extname(entry.path).toLowerCase()] || "video/mp4";
  const range = req.headers.range;

  // Tear the read stream down on client disconnect (seek/close) so we don't
  // leak file descriptors on the hottest route, and handle read errors instead
  // of letting them throw up to the global uncaughtException net.
  const onErr = () => { if (!res.headersSent) res.status(500).end(); else res.end(); };

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start, end;
    if (m && !m[1] && m[2]) {
      // Suffix range (bytes=-N): the last N bytes
      const n = Math.min(parseInt(m[2], 10), total);
      start = total - n;
      end = total - 1;
    } else {
      start = m && m[1] ? parseInt(m[1], 10) : 0;
      end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (end >= total) end = total - 1;
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mime,
    });
    const s = fs.createReadStream(entry.path, { start, end });
    s.on("error", onErr);
    s.pipe(res);
    res.on("close", () => s.destroy());
  } else {
    res.writeHead(200, {
      "Content-Length": total,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
    });
    const s = fs.createReadStream(entry.path);
    s.on("error", onErr);
    s.pipe(res);
    res.on("close", () => s.destroy());
  }
});

// File download (videos and extras like APKs)
router.get("/stream/download/:id", (req, res) => {
  const entry = scanner.resolve(req.params.id);
  if (
    !entry ||
    (entry.kind !== "video" && entry.kind !== "extra") ||
    !fs.existsSync(entry.path)
  ) {
    return res.status(404).send("Not found");
  }
  res.download(entry.path, path.basename(entry.path));
});

// A sidecar subtitle downloaded next to its video: the original .srt/.vtt
// rather than the WebVTT conversion the player streams, named after the video
// so the viewer's own player finds it without being told.
router.get("/stream/download/:id/sub/:subId", (req, res) => {
  const video = resolveKind(req.params.id, "video");
  const sub = resolveKind(req.params.subId, "subtitle");
  if (!video || !sub || !fs.existsSync(sub.path)) return res.status(404).send("Not found");
  res.download(sub.path, scanner.subtitleDownloadName(video.path, sub.path));
});

// Cinematic backdrop: a real frame from the video, generated on demand
router.get("/img/still/:id", async (req, res) => {
  try {
    const entry = resolveKind(req.params.id, "video");
    if (!entry) return res.status(404).send("Not found");
    const stills = require("../media/stills");
    const file = await stills.getStill(entry.path);
    if (!file) return res.status(404).send("No still available");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.sendFile(file);
  } catch {
    res.status(500).send("Still generation failed");
  }
});

// Downloaded metadata posters (cached on disk by src/media/online.js)
router.get("/img/meta/:name", (req, res) => {
  const online = require("../media/online");
  const file = online.posterFile(req.params.name);
  if (!file) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.sendFile(file);
});

// Cover images
router.get("/img/:id", (req, res) => {
  const entry = resolveKind(req.params.id, "image");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(entry.path);
});

// Compatibility remux (HLS, video copied + audio -> AAC) for files whose
// audio the browser can't decode (AC-3, DTS...). Playlist request starts the
// job; segments stream as ffmpeg produces them.
const remux = require("../media/remux");

router.get("/stream/hls/:id/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!require("../config").ffmpegAvailable) return res.status(503).send("ffmpeg not available");

  try {
    const dir = await remux.ensure(entry.path, req.params.id);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dir, "index.m3u8"));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/stream/hls/:id/:file", (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry) return res.status(404).send("Not found");
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(entry.path).mtimeMs);
  } catch {
    return res.status(404).send("Not found");
  }
  remux.touch(req.params.id, mtime); // keep an actively-watched remux alive
  const abs = remux.filePath(`${req.params.id}-${mtime}`, req.params.file);
  if (!abs) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(abs);
});

// Offset-aware library transcode (HLS). ?v=h264 re-encodes video for devices
// that can't decode the file (HEVC/AV1/10-bit on phones); ?v=copy keeps the
// video and only fixes the audio. URL shape matches the torrent transcode
// (/base/:ss/index.m3u8?v=) so the player reuses one code path — and unlike
// torrents, the file is complete on disk so ANY offset works (resume + seek).
router.get("/stream/transcode/:id/:ss/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!require("../config").ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  const ss = Math.max(0, parseInt(req.params.ss, 10) || 0);
  // effectiveVcodec: an offset start always re-encodes (see remux.js). Applied
  // here too so the segment URIs below name the job dir that actually exists.
  const v = remux.effectiveVcodec(req.query.v === "copy" ? "copy" : "h264", ss);
  try {
    // ?seek=1 marks a deliberate seek by the viewer (the player probe sets it;
    // hls.js playlist refreshes never do). Only that may re-create an offset we
    // just retired — see `retired` in remux.js.
    const dir = await remux.ensure(entry.path, req.params.id, { vcodec: v, ss, seek: req.query.seek === "1" });
    // Segment URIs carry ?v= so the segment route can resolve this exact job
    // dir (an h264 and a copy job can coexist for the same file + offset).
    const text = fs
      .readFileSync(path.join(dir, "index.m3u8"), "utf-8")
      .split("\n")
      .map((line) => (line.trim().endsWith(".ts") ? `${line.trim()}?v=${v}` : line))
      .join("\n");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(text);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/stream/transcode/:id/:ss/:file", (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry) return res.status(404).send("Not found");
  let mtime = 0;
  try {
    mtime = fs.statSync(entry.path).mtimeMs;
  } catch {
    return res.status(404).send("Not found");
  }
  const ss = Math.max(0, parseInt(req.params.ss, 10) || 0);
  const v = remux.effectiveVcodec(req.query.v === "copy" ? "copy" : "h264", ss);
  remux.touch(req.params.id, mtime, v, ss); // keep an actively-watched job alive
  const abs = remux.filePath(remux.dirName(req.params.id, mtime, v, ss), req.params.file);
  if (!abs) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(abs);
});

// External subtitle file -> WebVTT
router.get("/stream/subtitle/:id", (req, res) => {
  const entry = resolveKind(req.params.id, "subtitle");
  if (!entry) return res.status(404).send("Not found");
  subtitles.serveExternal(entry.path, res);
});

// Embedded subtitle track -> WebVTT (extracted + cached)
router.get("/stream/embedded/:id/:track", (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry) return res.status(404).send("Not found");
  const track = parseInt(req.params.track, 10) || 0;
  subtitles.serveEmbedded(entry.path, track, res);
});

module.exports = router;
