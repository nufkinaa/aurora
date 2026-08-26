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

// ---------- external artwork proxy-cache ----------
// Discover posters/backdrops hotlink external CDNs — measured 2026-08-23:
// ~319 unique posters per home load, all from one host, at 200–650ms each.
// That's the dominant real-world cold-load cost, and every CDN hiccup was a
// grey tile. Fetch once, keep on disk, serve at LAN speed forever after.
// STRICT allow-list — this must never become another open proxy (the /proxy
// SSRF lesson): exact host match, https only, bytes sniffed before caching.
const EXT_IMG_HOSTS = new Set([
  "image.tmdb.org",
  "images.metahub.space",
  "live.metahub.space",
  "static.tvmaze.com",
]);
const EXT_IMG_DIR = path.join(require("../config").CACHE_DIR, "posters-web");
const MAX_EXT_IMAGES = 4000; // count cap; the byte cap below bounds each file
const MAX_EXT_IMAGE_BYTES = 6 * 1024 * 1024; // backdrops can be big; originals aren't welcome
const { MIN_IMAGE_BYTES, magicOk, sniffMime, validImageFile, readHead } = require("../lib/imgcheck");
const crypto = require("crypto");
try { fs.mkdirSync(EXT_IMG_DIR, { recursive: true }); } catch {}
// Sweep with HYSTERESIS, every 100th write only: a per-write readdir+stat of
// a 4000-entry dir would run synchronously on the same event loop that
// serves video ranges — and at the cap it would run on EVERY write forever.
// Trimming down to cap-400 means a full dir walk at most once per 400 writes.
let extImgWrites = 0;
const extImgSweep = () => {
  try {
    const entries = fs.readdirSync(EXT_IMG_DIR);
    if (entries.length <= MAX_EXT_IMAGES) return;
    entries
      .map((f) => ({ f, m: fs.statSync(path.join(EXT_IMG_DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m)
      .slice(0, entries.length - (MAX_EXT_IMAGES - 400))
      .forEach(({ f }) => { try { fs.unlinkSync(path.join(EXT_IMG_DIR, f)); } catch {} });
  } catch {}
};
const extImgInflight = new Map(); // url -> promise (a row of 20 cards must fetch once)
// Negative cache: without it a CDN hiccup turns one home load (~300 distinct
// posters, each with a client-side retry) into waves of 15s upstream fetches.
const extImgFails = new Map(); // url -> failedAt
const EXT_FAIL_TTL = 5 * 60 * 1000;
const extAllowed = (u) => {
  try {
    return u.startsWith("https://") && EXT_IMG_HOSTS.has(new URL(u).host);
  } catch {
    return false;
  }
};
const fetchExtImage = (url, file) => {
  let p = extImgInflight.get(url);
  if (p) return p;
  p = (async () => {
    // Redirects are validated hop-by-hop against the same allow-list — an
    // open redirect on a CDN must not turn this into a fetch of anything.
    let target = url;
    let res = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetch(target, { signal: AbortSignal.timeout(15000), redirect: "manual" });
      if (res.status < 300 || res.status >= 400) break;
      const loc = new URL(res.headers.get("location") || "", target).href;
      if (!extAllowed(loc)) throw new Error("redirect off allow-list");
      target = loc;
      res = null;
    }
    if (!res || !res.ok) throw new Error(`upstream ${res ? res.status : "redirect loop"}`);
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len > MAX_EXT_IMAGE_BYTES) throw new Error("image too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_EXT_IMAGE_BYTES) throw new Error("image too large");
    if (buf.length < MIN_IMAGE_BYTES || !magicOk(buf)) throw new Error("not an image");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    if (++extImgWrites % 100 === 0) extImgSweep();
    return file;
  })();
  extImgInflight.set(url, p);
  const done = () => extImgInflight.delete(url);
  p.then(done, done);
  p.then(
    () => extImgFails.delete(url),
    () => {
      if (extImgFails.size > 2000) extImgFails.clear();
      extImgFails.set(url, Date.now());
    },
  );
  return p;
};
router.get("/img/ext", async (req, res) => {
  const url = String(req.query.u || "");
  if (!extAllowed(url)) return res.status(403).send("host not allowed");
  const file = path.join(EXT_IMG_DIR, crypto.createHash("md5").update(url).digest("hex") + ".img");
  try {
    if (!validImageFile(file)) {
      const failedAt = extImgFails.get(url) || 0;
      if (Date.now() - failedAt < EXT_FAIL_TTL) throw new Error("recently failed");
      await fetchExtImage(url, file);
    }
    const head = readHead(file);
    res.setHeader("Content-Type", head ? sniffMime(head) : "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.sendFile(file);
  } catch {
    res.status(502).send("artwork unavailable");
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
// ---------- S7: JIT full-timeline VOD (library files) ----------
// One COMPLETE playlist, exact duration + boundaries from the file's own
// MKV index; segments materialize on demand (media/jit.js). Registered
// BEFORE the /:ss routes so the literal "jit" path can't parse as an offset.
const jit = require("../media/jit");
router.get("/stream/transcode/:id/jit/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!require("../config").ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  // Same disk guard as the other transcoders: on a nearly-full disk the
  // producer grinds/fails silently and every segment request hangs to its
  // 90s deadline — refuse up front so the player falls back cleanly.
  try {
    const sfs = fs.statfsSync(require("../config").CACHE_DIR);
    if (sfs.bavail * sfs.bsize < 2 * 1024 * 1024 * 1024) {
      return res.status(503).send("Server disk is nearly full — free space to stream");
    }
  } catch {}
  try {
    const st = fs.statSync(entry.path);
    const key = `${req.params.id}-${Math.floor(st.mtimeMs)}`;
    const fd = fs.openSync(entry.path, "r");
    const readRange = async (start, len) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      return b;
    };
    const table = await jit.tableFor(key, readRange, st.size).finally(() => {
      try { fs.closeSync(fd); } catch {}
    });
    if (!table) return res.status(503).send("No usable index in this file");
    // ?seg=fmp4 → fragmented-MP4 segments (Apple native HLS; required for
    // HEVC there) with the hvc1 tag riding along when the client asked.
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
    const suffix = `?v=copy${fmt ? "&seg=fmp4" : ""}${req.query.vtag === "hvc1" ? "&vtag=hvc1" : ""}`;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(jit.playlistText(table, suffix, fmt));
  } catch (err) {
    res.status(500).send(err.message);
  }
});
router.get("/stream/transcode/:id/jit/:file", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry) return res.status(404).send("Not found");
  const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
  const m = String(req.params.file).match(fmt ? /^seg(\d{5})\.m4s$/ : /^seg(\d{5})\.ts$/);
  const isInit = fmt && req.params.file === "init.mp4";
  if (!m && !isInit) return res.status(404).send("Not found");
  try {
    const st = fs.statSync(entry.path);
    const key = `${req.params.id}-${Math.floor(st.mtimeMs)}`;
    const table = await jit.tableFor(key, null, 0).catch(() => null);
    if (!table) return res.status(409).send("Playlist first");
    // fMP4 producers get their own dir — same table, different segment files.
    const dir = path.join(require("../config").CACHE_DIR, "jit", key + (fmt ? "-f4" : ""));
    const job = jit.jobFor(dir, table);
    const input = { url: entry.path, extra: [], fmt, vtagHvc1: req.query.vtag === "hvc1" };
    const file = isInit
      ? await jit.ensureInit(dir, job, input)
      : await jit.ensureSegment(dir, job, input, parseInt(m[1], 10));
    if (!file) return res.status(504).send("Segment not ready");
    res.setHeader("Content-Type", fmt ? "video/mp4" : "video/mp2t");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// (/base/:ss/index.m3u8?v=) so the player reuses one code path — and unlike
// torrents, the file is complete on disk so ANY offset works (resume + seek).
router.get("/stream/transcode/:id/:ss/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!require("../config").ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  const ss = Math.max(0, parseInt(req.params.ss, 10) || 0);
  // effectiveVcodec (now the identity — offset copy is PTS-honest, see
  // remux.js) is still applied here so the segment URIs below always name
  // the same job dir the segment route computes.
  const v = remux.effectiveVcodec(req.query.v === "copy" ? "copy" : "h264", ss);
  try {
    // ?seek=1 marks a deliberate seek by the viewer (the player probe sets it;
    // hls.js playlist refreshes never do). Only that may re-create an offset we
    // just retired — see `retired` in remux.js.
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null; // Apple's HEVC-in-HLS format (S4)
    const vtag = req.query.vtag === "hvc1";
    const dir = await remux.ensure(entry.path, req.params.id, { vcodec: v, ss, seek: req.query.seek === "1", fmt, vtag });
    // Segment URIs carry ?v= (and &seg= for fMP4 jobs, EXT-X-MAP included) so
    // the segment route can resolve this exact job dir.
    const q = `?v=${v}${fmt ? "&seg=fmp4" : ""}`;
    let text = fs
      .readFileSync(path.join(dir, "index.m3u8"), "utf-8")
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (t.endsWith(".ts") || t.endsWith(".m4s")) return `${t}${q}`;
        if (t.startsWith("#EXT-X-MAP:")) return t.replace(/URI="[^"]*init\.mp4"/, `URI="init.mp4${q}"`);
        return line;
      })
      .join("\n");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    // A copy job at an offset keeps the source's real timestamps (-copyts,
    // see remux.js): tell the player where playback begins — audio starts
    // exactly at ss, video rolls back to its keyframe. Header for our own
    // player, EXT-X-START for native HLS (iPhone).
    if (v === "copy" && ss > 0) {
      const s = await require("../media/streamprobe").segmentStart(path.join(dir, "seg00000.ts"));
      if (s) {
        res.setHeader("X-Aurora-Base", String(s.base));
        res.setHeader("X-Aurora-Offset", String(s.offset));
        text = text.replace("#EXTM3U", `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${s.offset},PRECISE=YES`);
      }
    }
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
  const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
  remux.touch(req.params.id, mtime, v, ss, fmt); // keep an actively-watched job alive
  const abs = remux.filePath(remux.dirName(req.params.id, mtime, v, ss, fmt), req.params.file);
  if (!abs) return res.status(404).send("Not found");
  res.setHeader("Content-Type", /\.(m4s|mp4)$/.test(req.params.file) ? "video/mp4" : "video/mp2t");
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
