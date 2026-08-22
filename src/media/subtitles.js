// Subtitle delivery: external SRT->WebVTT conversion and embedded-track
// extraction via ffmpeg, disk-cached so repeat loads are instant.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const config = require("../config");

const VTT_CACHE_DIR = path.join(config.CACHE_DIR, "vtt");
const inflight = new Map(); // cacheFile -> Promise<boolean>

const srtToVtt = (srt) =>
  "WEBVTT\n\n" +
  srt
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

// Decode subtitle bytes: strict UTF-8 first, then Windows-1255 (Hebrew subs
// from the wild are often ANSI-encoded), and strip any BOM.
const decodeSubtitle = (buf) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder("windows-1255").decode(buf);
    } catch {
      text = buf.toString("utf-8");
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
};

// Serve an external subtitle file as WebVTT
const serveExternal = (subPath, res) => {
  let content;
  try {
    content = decodeSubtitle(fs.readFileSync(subPath));
  } catch {
    return res.status(404).send("Subtitle not found");
  }
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  const ext = path.extname(subPath).toLowerCase();
  res.send(ext === ".srt" ? srtToVtt(content) : content);
};

// Extract an embedded text subtitle track as WebVTT, streaming to the
// response while also caching to disk for instant repeats.
const serveEmbedded = (videoPath, trackIndex, res) => {
  if (!config.ffmpegAvailable)
    return res.status(503).send("ffmpeg not available");

  let mtime = 0;
  try {
    mtime = fs.statSync(videoPath).mtimeMs;
  } catch {
    return res.status(404).send("Video not found");
  }

  const key = crypto
    .createHash("md5")
    .update(`${videoPath}|${mtime}|${trackIndex}`)
    .digest("hex");
  const cacheFile = path.join(VTT_CACHE_DIR, `${key}.vtt`);

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");

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

  let stderr = "";
  ffmpeg.stderr.on("data", (d) => (stderr += d.toString()));

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

const clearCache = () => {
  try {
    fs.rmSync(VTT_CACHE_DIR, { recursive: true, force: true });
  } catch {}
};

module.exports = { serveExternal, serveEmbedded, clearCache };
