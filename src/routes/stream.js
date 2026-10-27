// Streaming endpoints: video (range requests), covers, subtitles, downloads.
const fs = require("fs");
const path = require("path");
const express = require("express");
const scanner = require("../media/scanner");
const subtitles = require("../media/subtitles");
const faststart = require("../media/faststart");

const router = express.Router();
// Imports that have to stay inside functions (circular), asked for once
// instead of on every call — lib/lazy.js has the why.
const lazy = require("../lib/lazy");
const configLib = lazy(require, "../config");
const admissionLib = lazy(require, "../lib/admission");
const stillsLib = lazy(require, "../media/stills");

// Every request for a library file's bytes says "someone is on this file
// right now" (lib/inuse.js) — what the admin's "delete this copy" asks
// before it deletes anything.
const inuse = require("../lib/inuse");
router.use(["/stream/video/:id", "/stream/hls/:id", "/stream/transcode/:id", "/stream/download/:id"], (req, res, next) => {
  inuse.touch(req.params.id);
  next();
});

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

// Video streaming with HTTP range support. What the RFC asks of a byte
// server (validators, If-Range, 416, HEAD) is lib/rangeserve.js; how the
// bytes leave the disk is lib/diskread.js — 1 MB reads that take turns per
// disk, so many viewers on one hard disk share it fairly instead of making
// its head jump between them on every 64 KB (measured: STREAMING.md).
const rangeserve = require("../lib/rangeserve");
const diskread = require("../lib/diskread");
const disktype = require("../lib/disktype");
router.get("/stream/video/:id", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  const stat = entry && rangeserve.statOf(entry.path);
  if (!stat) return res.status(404).send("Not found");

  const total = stat.size;
  const mime = MIME[path.extname(entry.path).toLowerCase()] || "video/mp4";

  // Tear the read stream down on client disconnect (seek/close) so we don't
  // leak file descriptors on the hottest route, and handle read errors instead
  // of letting them throw up to the global uncaughtException net.
  const onErr = () => {
    rangeserve.forgetStat(entry.path); // (the file may have changed under us)
    if (!res.headersSent) res.status(500).end(); else res.destroy();
  };
  // An MP4 with its index at the end goes out with the index in front
  // (media/faststart.js): the same length, the same film, two round trips
  // fewer before a player can show a frame. null = as it is on disk.
  // (looked at off the event loop: the index is megabytes — lib/faststart.js buildAsync)
  let plan = null;
  if (configLib().SERVE_FASTSTART) { try { plan = await faststart.planForAsync(entry.path, stat); } catch { plan = null; } }
  if (res.destroyed || res.writableEnded) return;
  const etag = rangeserve.etagOf(stat, plan ? "fs" : "");
  const lastModified = rangeserve.lastModifiedOf(stat);
  const common = {
    "Accept-Ranges": "bytes",
    "Content-Type": mime,
    ETag: etag,
    "Last-Modified": lastModified,
    // a signed-in viewer's film: never kept by a shared cache (a proxy)
    "Cache-Control": "private, max-age=0",
  };

  let range = rangeserve.parseRange(req.headers.range, total);
  if (!range.none && !rangeserve.ifRangeOk(req.headers, etag, lastModified)) range = { none: true }; // changed: all of it
  if (range.none && rangeserve.notModified(req.headers, etag, stat)) {
    res.writeHead(304, { ETag: etag, "Last-Modified": lastModified, "Cache-Control": common["Cache-Control"] });
    return res.end();
  }
  if (range.unsatisfiable) {
    res.writeHead(416, { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" });
    return res.end();
  }
  const start = range.none ? 0 : range.start;
  const end = range.none ? total - 1 : range.end;
  if (range.none) {
    res.writeHead(200, { ...common, "Content-Length": total });
  } else {
    res.writeHead(206, { ...common, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
  }
  // HEAD: the headers are the answer — the file is not read
  if (req.method === "HEAD" || total === 0) return res.end();
  rangeserve.watch(res); // a client that stopped reading for good is let go
  // big reads in turns on a spinning disk; on an SSD the plain reader, as
  // before (lib/diskread.js policyFor; lib/disktype.js asks the OS once per disk)
  const policy = diskread.policyFor(disktype.kindFor(entry.path, stat.dev));
  const disk = disktype.diskKey(entry.path, stat.dev);
  const open = policy
    ? (file, o) => diskread.createReadStream(file, { ...o, dev: disk, limit: policy.limit, highWaterMark: policy.read })
    : (file, o) => fs.createReadStream(file, o);
  if (plan) return faststart.pipe(entry.path, plan, start, end, res, onErr, open);
  const s = open(entry.path, { start, end });
  s.on("error", onErr);
  s.pipe(res);
  res.on("close", () => s.destroy());
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
    const stills = stillsLib();
    const file = await stills.getStill(entry.path);
    if (!file) return res.status(404).send("No still available");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.sendFile(file);
  } catch {
    res.status(500).send("Still generation failed");
  }
});

// The phone-playable copy made by media/offline.js (Range-capable, so the
// phone's cache can pull it in one go and the player can seek if it ever
// plays it straight from here).
router.get("/offline/file/:id", (req, res) => {
  const file = require("../media/offline").fileFor(req.params.id, req.query.q);
  if (!file) return res.status(404).send("Not prepared");
  res.setHeader("Cache-Control", "private, max-age=0");
  res.sendFile(file);
});

// A frame at a given second (?t=), for "resume from here" prompts.
router.get("/img/frame/:id", async (req, res) => {
  try {
    const entry = resolveKind(req.params.id, "video");
    if (!entry) return res.status(404).send("Not found");
    const t = Math.max(0, parseFloat(req.query.t) || 0);
    const stills = stillsLib();
    const file = await stills.getFrame(entry.path, t);
    if (!file) return res.status(404).send("No frame available");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.sendFile(file);
  } catch {
    res.status(500).send("Frame generation failed");
  }
});

// ---------- external artwork proxy-cache ----------
// Discover posters/backdrops hotlink external CDNs — measured 2026-08-23:
// ~319 unique posters per home load, all from one host, at 200–650ms each.
// That's the dominant real-world cold-load cost, and every CDN hiccup was a
// grey tile. Fetch once, keep on disk, serve at LAN speed forever after.
// STRICT allow-list — this must never become another open proxy (the /proxy
// SSRF lesson): exact host match, https only, bytes sniffed before caching.
// (the list itself: lib/imghosts.js)
const { extAllowed } = require("../lib/imghosts");
const EXT_IMG_DIR = path.join(configLib().CACHE_DIR, "posters-web");
const MAX_EXT_IMAGES = 4000; // count cap; the byte cap below bounds each file
const MAX_EXT_IMAGE_BYTES = 6 * 1024 * 1024; // backdrops can be big; originals aren't welcome
const { MIN_IMAGE_BYTES, magicOk, validImageFile, mimeOfFile } = require("../lib/imgcheck");
const crypto = require("crypto");
try { fs.mkdirSync(EXT_IMG_DIR, { recursive: true }); } catch {}
// Sweep with HYSTERESIS, every 100th write only: a per-write readdir+stat of
// a 4000-entry dir would run synchronously on the same event loop that
// serves video ranges — and at the cap it would run on EVERY write forever.
// Trimming down to cap-400 means a full dir walk at most once per 400 writes.
let extImgWrites = 0;
// (asynchronous since the server round of 2026-10-18: lib/dirsweep.js)
const extImgSweep = () =>
  require("../lib/dirsweep").trim(EXT_IMG_DIR, { max: MAX_EXT_IMAGES, down: MAX_EXT_IMAGES - 400, onRemoved: (f) => require("../lib/imgcheck").forget(f) }).catch(() => 0);
const extImgInflight = new Map(); // url -> promise (a row of 20 cards must fetch once)
// Negative cache: without it a CDN hiccup turns one home load (~300 distinct
// posters, each with a client-side retry) into waves of 15s upstream fetches.
const extImgFails = new Map(); // url -> failedAt
const EXT_FAIL_TTL = 5 * 60 * 1000;
const EXT_WAIT_MS = 4000;
const fetchExtImage = (url, file) => {
  let p = extImgInflight.get(url);
  if (p) return p;
  p = (async () => {
    // Redirects are validated hop-by-hop against the same allow-list — an
    // open redirect on a CDN must not turn this into a fetch of anything.
    let target = url;
    let res = null;
    for (let hop = 0; hop < 3; hop++) {
      // (Wikimedia refuses requests with no descriptive User-Agent)
      // (lib/upstream.js: timeout over the whole picture, a fair share per
      // picture host, its breaker, the size cap while reading)
      res = await require("../lib/upstream").fetch(target, { timeoutMs: 15000, maxBytes: MAX_EXT_IMAGE_BYTES, redirect: "manual", headers: { "User-Agent": "Aurora/1.6 (personal media server)" } });
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
    // (not blocking: this is on the way to answering the request)
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    try { require("../lib/imgcheck").forget(file); } catch {}
    if (++extImgWrites % 100 === 0) extImgSweep();
    return file;
  })();
  p.startedAt = Date.now();
  extImgInflight.set(url, p);
  const done = () => extImgInflight.delete(url);
  p.then(done, done);
  p.then(
    () => extImgFails.delete(url),
    (e) => {
      // (a picture host that was only BUSY — every slot taken by a cold Home —
      // has not said no: that picture is asked again at once next time)
      if (e && e.code === "busy") return;
      if (extImgFails.size > 2000) extImgFails.clear();
      extImgFails.set(url, Date.now());
    },
  );
  return p;
};
// ?w=<px>: a downscaled variant for the screen that asked (lib/imgvariant.js
// — ffmpeg, cached; the original when it can't be had). The catalogue's
// backdrops are 1920px, 0.8–1.3 MB JPEGs; a phone drew them 360px wide.
const { variant: imgVariant } = require("../lib/imgvariant");
// ?blur=<px>: pre-blurred (the TV's billboard layers — see imgvariant.js).
// ?fmt=webp: that blurred variant as WebP (opt-in; ignored otherwise).
// Who is asking, for the variant queue's per-client limit (lib/admission.js).
const artClient = (res) => { try { return admissionLib().heavy.clientKey(res.req); } catch { return null; } };
const sendArt = async (res, file, width, blur, fmt) => {
  const opts = { blur, fmt, client: artClient(res) };
  const v = width || blur ? await imgVariant(file, width, opts) : null;
  const out = v || file;
  res.setHeader("Content-Type", mimeOfFile(out) || "image/jpeg");
  // (the original sent because the variant queue was full is kept for a
  // minute only: the variant is asked for again once the rush is over)
  res.setHeader("Cache-Control", opts.shed ? "public, max-age=60" : "public, max-age=604800");
  res.sendFile(out);
};
router.get("/img/ext", async (req, res) => {
  const url = String(req.query.u || "");
  if (!extAllowed(url)) return res.status(403).send("host not allowed");
  const file = path.join(EXT_IMG_DIR, crypto.createHash("md5").update(url).digest("hex") + ".img");
  try {
    if (!validImageFile(file)) {
      const failedAt = extImgFails.get(url) || 0;
      if (Date.now() - failedAt < EXT_FAIL_TTL) throw new Error("recently failed");
      // a picture that has to be FETCHED counts against the client's
      // allowance (lib/ratelimit.js); one already kept never does
      const rl = require("../lib/ratelimit").take("img-fetch", req);
      if (!rl.ok) return require("../lib/ratelimit").refuse(res, "img-fetch", rl.retryAfterSec);
      // A card waits EXT_WAIT_MS for a picture it does not have: past that it
      // gets its placeholder now, and the fetch goes on — the picture lands on
      // disk for the next ask. A host that keeps not answering in time opens
      // its breaker (lib/upstream.js), and then misses fail in microseconds.
      // (a fetch already in flight for this picture counts from when IT
      // began: a card asking again for a picture that is still coming does
      // not wait a second EXT_WAIT_MS — it gets its placeholder at once)
      const p = fetchExtImage(url, file);
      const left = Math.max(0, EXT_WAIT_MS - (Date.now() - (p.startedAt || Date.now())));
      let timer = null;
      const late = left === 0 || await Promise.race([p.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), left); })]).finally(() => clearTimeout(timer));
      if (late) {
        p.catch(() => {});
        if (!p.struck) { p.struck = true; require("../lib/upstream").tooSlow(url, p, p.startedAt || Date.now()); }
        throw new Error("still being fetched");
      }
    }
    await sendArt(res, file, req.query.w, req.query.blur, req.query.fmt);
  } catch (e) {
    // said out loud: a TV with no pictures is otherwise a silent 502 (2026-10-09)
    // (a picture the catalogue does not have is one line, not one per screen that asks again)
    if (!e || (e.message !== "recently failed" && e.message !== "still being fetched" && e.code !== "open" && e.code !== "busy")) console.warn(`[img] ext ${url.slice(0, 80)} w=${req.query.w || "-"} failed: ${(e && e.message) || e}`);
    if (!res.headersSent) res.status(502).send("artwork unavailable");
  }
});

// The backup poster for a title, by IMDb id (media/posterfallback.js): the
// chain of other sources a card falls back to when its own cover is missing
// or won't load. Answers the image itself (so an <img> can point straight at
// it); 404 when no source anywhere has one — remembered for a week.
router.get("/img/poster/:imdbId", async (req, res) => {
  try {
    // a backup poster not found yet costs provider calls: it counts against
    // the client's picture allowance (lib/ratelimit.js); one already found never does
    const pf = require("../media/posterfallback");
    if (typeof pf.known === "function" && !pf.known(req.params.imdbId)) {
      const rl = require("../lib/ratelimit").take("img-fetch", req);
      if (!rl.ok) return require("../lib/ratelimit").refuse(res, "img-fetch", rl.retryAfterSec);
    }
    // (the card waits EXT_WAIT_MS at most, as for /img/ext: past it, "none
    // yet" — not kept by the client — and the search goes on and is kept)
    const looking = pf.resolve({
      imdbId: req.params.imdbId,
      type: req.query.type === "show" ? "show" : "movie",
      title: req.query.t ? String(req.query.t).slice(0, 80) : "",
      year: parseInt(req.query.y, 10) || null,
    });
    let timer = null;
    const LATE = Symbol("late");
    const left = Math.max(0, EXT_WAIT_MS - (Date.now() - (looking.startedAt || Date.now())));
    const name = left === 0 ? LATE : await Promise.race([looking, new Promise((r) => { timer = setTimeout(() => r(LATE), left); })]).finally(() => clearTimeout(timer));
    if (name === LATE) {
      looking.catch(() => {});
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).send("No poster yet");
    }
    const file = name && require("../media/online").posterFile(name);
    if (!file) return res.status(404).send("No poster");
    await sendArt(res, file, req.query.w, req.query.blur, req.query.fmt);
  } catch {
    if (!res.headersSent) res.status(404).send("No poster");
  }
});

// Downloaded metadata posters (cached on disk by src/media/online.js)
router.get("/img/meta/:name", async (req, res) => {
  const online = require("../media/online");
  const file = online.posterFile(req.params.name);
  if (!file) return res.status(404).send("Not found");
  try {
    await sendArt(res, file, req.query.w, req.query.blur, req.query.fmt); // ?w= as on /img/:id
  } catch {
    if (!res.headersSent) res.status(404).send("Not found");
  }
});

// Cover images (?w= for a downscaled variant — library posters are ~200 KB
// scans, drawn 150–260px wide)
router.get("/img/:id", async (req, res) => {
  const entry = resolveKind(req.params.id, "image");
  // (no existsSync first: a cover the library walk listed is there, and one
  // removed since is a 404 all the same — sendFile's ENOENT, server.js — so a
  // blocking call per picture was paid for nothing; server round 2026-10-18)
  if (!entry) return res.status(404).send("Not found");
  try {
    const opts = { blur: req.query.blur, fmt: req.query.fmt, client: artClient(res) };
    const v = req.query.w || req.query.blur ? await imgVariant(entry.path, req.query.w, opts) : null;
    res.setHeader("Cache-Control", opts.shed ? "public, max-age=60" : "public, max-age=86400");
    res.sendFile(v || entry.path);
  } catch (e) {
    console.warn(`[img] ${req.params.id} w=${req.query.w || "-"} blur=${req.query.blur || "-"} failed: ${(e && e.message) || e}`);
    if (!res.headersSent) res.status(404).send("Not found");
  }
});

// Compatibility remux (HLS, video copied + audio -> AAC) for files whose
// audio the browser can't decode (AC-3, DTS...). Playlist request starts the
// job; segments stream as ffmpeg produces them.
const remux = require("../media/remux");
// "The server is busy" (no room in the encode budget) is 503 with
// Retry-After on every stream route — the older single-rendition routes
// answered 500, which a monitor and a client both read as a fault.
const sendStreamError = (res, err) => {
  if (err && err.busy) {
    res.setHeader("Retry-After", String(err.retryAfter || 5));
    return res.status(503).send(err.message);
  }
  res.status(500).send((err && err.message) || "stream failed");
};

router.get("/stream/hls/:id/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!configLib().ffmpegAvailable) return res.status(503).send("ffmpeg not available");

  try {
    const dir = await remux.ensure(entry.path, req.params.id);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dir, "index.m3u8"));
  } catch (err) {
    sendStreamError(res, err);
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
  remux.touch(req.params.id, mtime, "copy", 0, null, 0, null, req.params.file); // keep an actively-watched remux alive (and how far it is read)
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
const ladder = require("../media/ladder");
const { timed } = require("../lib/servertiming");

// Who is reading a stream, for "whose goodbye is it" (jit.release, and
// remux.release for the offset jobs): the sign-in session, the TV app's own
// tag, else the device's address and browser — lib/viewer.js.
const { viewerOf } = require("../lib/viewer");

// The version of a file a jit segment URL names (&m=): its mtime, base 36.
const segVersion = (st) => Math.floor(st.mtimeMs).toString(36);

// The file's segment table (cached by jit; read from the file when it is not).
// (the index is read with async reads: on a sleeping hard disk a read of
// the cues at the far end of a film is a seek, and it used to be a
// synchronous one on the event loop)
const libraryTable = async (entry, key, size) => {
  const cached = await jit.tableFor(key, null, 0).catch(() => null);
  if (cached) return cached;
  const fh = await fs.promises.open(entry.path, "r");
  const readRange = async (start, len) => {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, start);
    void bytesRead; // (a short read leaves zeros, as the synchronous read did)
    return b;
  };
  return jit.tableFor(key, readRange, size, { mp4: true }).finally(() => fh.close().catch(() => {}));
};

// THE START HINT. A player that is about to start says so on its first
// playlist request (X-Aurora-Start: where in the film, what its line carried
// last time, or the rendition it will begin on — ladder.parseStartHint), and
// the making of its first segment begins HERE, while the playlists are still
// travelling: by the time the segment is asked for — two round trips later
// on a master, one on a single playlist — it is made, or well on its way.
// Nothing is waited for and nothing is answered differently; the bounds are
// jit.warmSegment's (never a second producer, an encode only on an idle
// server, a few starts a minute, the producer stops by itself).
const warmStart = async (req, { entry, key, table, fmt, rungs = null, name = null }) => {
  const hint = ladder.parseStartHint(req.get("x-aurora-start"));
  if (!hint) return;
  try {
    // which rendition: the one the client named, else by its line (the
    // website's own rule), else the single playlist's own
    let v = name;
    if (!v) {
      if (!rungs || !rungs.length) return;
      const named = hint.v ? rungs.find((r) => r.name === hint.v) : null;
      v = (named || rungs[Math.max(0, ladder.startRung(rungs, hint.kbps))]).name;
    }
    const audio = ladder.audioFromQuery(req.query.a);
    const k = jit.segmentAt(table.table, hint.at);
    if (k < 0) return;
    let dir = path.join(require("../config").CACHE_DIR, "jit", ladder.dirName(key, v, fmt, audio));
    let input = { url: entry.path, extra: [], fmt, vtagHvc1: req.query.vtag === "hvc1", audio };
    let hw = false;
    if (v !== "copy") {
      if (jit.encodeDeclined(key)) return;
      const use = await ladder.useHw({ key, dir, input: entry.path, jit });
      input = await ladder.encInput(input, { key, name: v, fmt, audio, jit, label: path.basename(entry.path), hw: use.hw, why: use.why });
      if (!input) return;
      hw = !!input.enc.hw;
      if (hw) dir += "-hw";
    }
    jit.warmSegment(dir, jit.jobFor(dir, table, { enc: v !== "copy", hw }), input, k);
  } catch {}
};

// ---------- the quality ladder (library files) ----------
// A MASTER playlist over the jit stream: the file's video as it is (or the
// full encode, ?top=h264) and 720p / 480p encodes below it, all cut by the
// same segment table — the player switches between them by itself. A new
// URL: the single-rendition playlist below answers exactly as it always did.
// Parameters and answers: media/ladder.js (master).
router.get("/stream/transcode/:id/jit/master.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!configLib().ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  // (the free space as last read, kept fresh off the event loop: lib/disk.js freeBytesCached)
  if (require("../lib/disk").freeBytesCached(configLib().CACHE_DIR) < 2 * 1024 * 1024 * 1024) {
    return res.status(503).send("Server disk is nearly full — free space to stream");
  }
  try {
    const st = fs.statSync(entry.path);
    const key = `${req.params.id}-${Math.floor(st.mtimeMs)}`;
    const table = await timed(res, "table", () => libraryTable(entry, key, st.size));
    if (!table) return res.status(404).send("No usable index in this file");
    const m = await timed(res, "ladder", () => ladder.master(table, { key, input: entry.path, query: req.query, jit }));
    if (!m.text) {
      // (busy — not "this file cannot be encoded": say when to ask again, as every stream route does)
      if (m.status === 503) res.setHeader("Retry-After", "5");
      return res.status(m.status).send(m.message);
    }
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(m.text);
    warmStart(req, { entry, key, table, fmt: req.query.seg === "fmp4" ? "fmp4" : null, rungs: m.rungs });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/stream/transcode/:id/jit/index.m3u8", async (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).send("Not found");
  if (!configLib().ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  // Same disk guard as the other transcoders: on a nearly-full disk the
  // producer grinds/fails silently and every segment request hangs to its
  // 90s deadline — refuse up front so the player falls back cleanly.
  // (the free space as last read, kept fresh off the event loop: lib/disk.js freeBytesCached)
  if (require("../lib/disk").freeBytesCached(configLib().CACHE_DIR) < 2 * 1024 * 1024 * 1024) {
    return res.status(503).send("Server disk is nearly full — free space to stream");
  }
  try {
    const st = fs.statSync(entry.path);
    const key = `${req.params.id}-${Math.floor(st.mtimeMs)}`;
    // The index already in memory (every playlist after the first for this
    // file): the film is not opened just to be closed again.
    // (the same lookup the master playlist makes: libraryTable — memory
    // first, then the file's own index, an MP4's included)
    const table = await timed(res, "table", () => libraryTable(entry, key, st.size));
    // Permanent property of the file (not MKV / no usable Cues) — 404, so
    // the client falls back and nothing reads it as a server fault.
    if (!table) return res.status(404).send("No usable index in this file");
    // ?seg=fmp4 → fragmented-MP4 segments (Apple native HLS; required for
    // HEVC there) with the hvc1 tag riding along when the client asked.
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
    // ?v= names a rendition of the ladder (h264 / h264-720 / h264-480) and
    // ?a= an audio track; without them this is the copy with the first
    // track, and the answer is what it always was.
    const v = ladder.renditionFromQuery(req.query.v);
    const audio = ladder.audioFromQuery(req.query.a);
    if (v !== "copy") {
      if (jit.encodeDeclined(key)) return res.status(404).send("This file cannot be re-encoded on the full timeline");
      // no encoder free: say so now, before the player commits to the rendition
      // (&need=1: the master playlist offered this rung because the full
      // encode did not fit — it is this viewer's only way to play)
      // (a rendition the graphics card would make costs the CPU a sliver)
      const onCard = (await ladder.useHw({ key, dir: path.join(configLib().CACHE_DIR, "jit", ladder.dirName(key, v, fmt, audio)), input: entry.path, jit })).hw;
      if (!jit.encodeRoom(key, v === "h264" || req.query.need === "1", onCard ? ladder.HW_COST : 0)) {
        try { require("../lib/signals").hit("no-encoder", "rendition"); } catch {}
        res.setHeader("Retry-After", "5");
        return res.status(503).send("Server is busy — that rendition isn't available right now");
      }
    }
    // &m=: which version of the file the segments were cut from (its mtime) —
    // so a segment URL names bytes that never change, and may be kept by the
    // player's own cache (see the segment route); the routes ignore it otherwise
    const suffix = `?v=${v}${fmt ? "&seg=fmp4" : ""}${req.query.vtag === "hvc1" ? "&vtag=hvc1" : ""}${audio ? `&a=${audio}` : ""}${v !== "copy" && req.query.need === "1" ? "&need=1" : ""}&m=${segVersion(st)}`;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(jit.playlistText(table, suffix, fmt));
    warmStart(req, { entry, key, table, fmt, name: v });
  } catch (err) {
    res.status(500).send(err.message);
  }
});
// The player closed (or went on to the next episode): this title's producers
// that nobody is waiting on stop now, so the encoder is free for whatever is
// played next (jit.release). A beacon — nothing is answered.
// Behind the same walls as the stream itself (sign-in, a forced password
// reset, the kids gate: all run before any /stream route), and it only ever
// stops what the one who says it was reading (viewerOf): a goodbye from
// anybody else — or for a film they are not in — stops nothing.
// The SAME goodbye stops the viewer's OFFSET transcodes of the file too
// (remux.release, same ownership rule — media/goodbye.js): the TV app plays
// those, and sends this beacon on leaving the player; before, its job ran on
// until the idle sweep, 2.5 minutes later, holding an encoder for nobody.
router.post("/stream/transcode/:id/jit/bye", (req, res) => {
  const entry = resolveKind(req.params.id, "video");
  if (!entry) return res.status(204).end();
  try {
    const st = fs.statSync(entry.path);
    const viewer = viewerOf(req);
    jit.release(`${req.params.id}-${Math.floor(st.mtimeMs)}`, viewer);
    remux.release(req.params.id, st.mtimeMs, viewer);
  } catch {}
  res.status(204).end();
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
    // Normally the playlist fetch populated the table cache — but after a
    // server restart mid-watch the player still holds the full playlist and
    // just asks for the next segment. Rebuild the table from the file
    // rather than 409ing a perfectly resumable stream.
    // (declined: the file's index lied once — 404, as the playlist says, so
    // the player falls back; it used to be 409 "Playlist first", which a
    // player can only retry)
    if (jit.declinedReason(key)) return res.status(404).send("No usable index in this file");
    const table = await libraryTable(entry, key, st.size).catch(() => null);
    if (!table) return res.status(404).send("No usable index in this file");
    // fMP4 producers get their own dir — same table, different segment
    // files; so does every rendition of the ladder, and every audio track.
    const v = ladder.renditionFromQuery(req.query.v);
    const audio = ladder.audioFromQuery(req.query.a);
    let dir = path.join(configLib().CACHE_DIR, "jit", ladder.dirName(key, v, fmt, audio));
    let input = { url: entry.path, extra: [], fmt, vtagHvc1: req.query.vtag === "hvc1", audio };
    let hw = false;
    if (v !== "copy") {
      if (jit.encodeDeclined(key)) return res.status(404).send("This file cannot be re-encoded on the full timeline");
      // made on the graphics card, or not (ladder.useHw — sticky per rendition)
      const use = await ladder.useHw({ key, dir, input: entry.path, jit });
      input = await ladder.encInput(input, { key, name: v, fmt, audio, jit, label: path.basename(entry.path), need: req.query.need === "1", hw: use.hw, why: use.why });
      if (!input) return res.status(404).send("No such rendition of this file");
      hw = !!input.enc.hw;
      if (hw) dir += "-hw";
    }
    const job = jit.jobFor(dir, table, { enc: v !== "copy", hw });
    // &warm=1: a start is coming (the pointer is on Play, or the player is
    // still loading its playlists) — begin making this segment now, send
    // nothing. Bounded in jit.warmSegment; the answer says what was done.
    if (req.query.warm === "1") {
      const did = isInit ? "no" : jit.warmSegment(dir, job, input, parseInt(m[1], 10));
      res.setHeader("X-Aurora-Warm", did);
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    }
    const askedAt = Date.now();
    jit.noteViewer(job, viewerOf(req)); // (whose goodbye may stop this job's producers: jit.release)
    const onDisk = !isInit && fs.existsSync(jit.segPath(dir, parseInt(m[1], 10), fmt));
    // The client hanging up (a seek, a level change, the player closing)
    // ends the wait for a segment still being made — see jit.ensureSegment.
    let hungUp = false;
    res.on("close", () => { if (!res.writableEnded) hungUp = true; });
    const file = await timed(res, "seg", () => (isInit
      ? jit.ensureInit(dir, job, input)
      : jit.ensureSegment(dir, job, input, parseInt(m[1], 10), { gone: () => hungUp })), onDisk ? "ready" : "made");
    if (hungUp) return; // nobody to answer
    // how long a player waited for this segment — a tally, for the healer
    if (!isInit) { try { require("../lib/signals").hit("seg-wait", !file ? "none" : Date.now() - askedAt >= 4000 ? "slow" : "ok"); } catch {} }
    // an encoded rendition with no encoder free: 503, so the player moves to
    // another rendition instead of waiting on this one
    if (!file && jit.refusedJustNow(job)) {
      res.setHeader("Retry-After", "5");
      return res.status(503).send("Server is busy — that rendition isn't available right now");
    }
    if (!file) return res.status(504).send("Segment not ready");
    res.setHeader("Content-Type", fmt ? "video/mp4" : "video/mp2t");
    // A published copy segment never changes (jit.js: its bytes depend only on
    // the file), so one named for THIS version of the file (&m=) is kept by the
    // player's cache for a day: a seek back, a second look, a replay is not
    // asked for again. Private: a signed-in viewer's film is never kept by a
    // shared cache. Without &m= (an older playlist): revalidated, as before.
    // (the COPY only: an encoded rendition's bytes also depend on how it was
    // encoded — tone mapped or not, on the CPU or the card — which can differ
    // from one job to the next; those are revalidated, as before)
    res.setHeader("Cache-Control", v === "copy" && req.query.m && req.query.m === segVersion(st) ? "private, max-age=86400, immutable" : "no-cache");
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
  if (!configLib().ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  const ss = Math.max(0, parseInt(req.params.ss, 10) || 0);
  // effectiveVcodec (now the identity — offset copy is PTS-honest, see
  // remux.js) is still applied here so the segment URIs below always name
  // the same job dir the segment route computes.
  const v = remux.effectiveVcodec(remux.vcodecFromQuery(req.query.v), ss);
  try {
    // ?seek=1 marks a deliberate seek by the viewer (the player probe sets it;
    // hls.js playlist refreshes never do). Only that may re-create an offset we
    // just retired — see `retired` in remux.js.
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null; // Apple's HEVC-in-HLS format (S4)
    const vtag = req.query.vtag === "hvc1";
    const audio = Math.max(0, Math.min(31, parseInt(req.query.a, 10) || 0)); // which audio stream (multi-dub)
    const dir = await timed(res, "job", () => remux.ensure(entry.path, req.params.id, { vcodec: v, ss, seek: req.query.seek === "1", fmt, vtag, audio }));
    remux.noteViewer(dir, viewerOf(req)); // whose goodbye may stop it (the bye route below)
    // Segment URIs carry ?v= (and &seg= for fMP4 jobs, &a= for a chosen audio
    // stream, EXT-X-MAP included) so the segment route can resolve this
    // exact job dir.
    const q = `?v=${v}${fmt ? "&seg=fmp4" : ""}${audio ? `&a=${audio}` : ""}`;
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
    if (v === "copy" && ss > 0 && fmt === "fmp4") {
      // the iPhone's copy job: zero-based, so the header says what content
      // time its media 0 is (streamprobe.fmp4ClockBase) — no EXT-X-START,
      // the native player starts where the job starts
      const sp = require("../media/streamprobe");
      const meta = require("../media/metadata").getCached(entry.path);
      const base = await sp.fmp4ClockBase(entry.path, dir, ss, meta && meta.start).catch(() => null);
      if (base != null) {
        res.setHeader("X-Aurora-Base", String(base));
        res.setHeader("X-Aurora-Offset", "0");
      }
    } else if (v === "copy" && ss > 0) {
      const sp = require("../media/streamprobe");
      const s = await sp.segmentStart(path.join(dir, "seg00000.ts"));
      if (s) {
        // The clock in the FILM's time. -copyts keeps the file's own
        // timestamps, which begin at its start time — nearly always 0, but a
        // cut from a TV capture starts seconds in, and every other path (the
        // file itself, jit, the subtitles ffmpeg extracts, the sidecars)
        // counts from that start. Measured with tools/subs-rig: a file
        // starting at 1.5 s had every cue 1.53 s early after a resume here.
        const meta = require("../media/metadata").getCached(entry.path);
        res.setHeader("X-Aurora-Base", String(sp.clockBase(s.base, meta && meta.start)));
        res.setHeader("X-Aurora-Offset", String(s.offset));
        text = text.replace("#EXTM3U", `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${s.offset},PRECISE=YES`);
      }
    }
    res.send(text);
  } catch (err) {
    sendStreamError(res, err);
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
  const v = remux.effectiveVcodec(remux.vcodecFromQuery(req.query.v), ss);
  const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
  const audio = Math.max(0, Math.min(31, parseInt(req.query.a, 10) || 0));
  remux.touch(req.params.id, mtime, v, ss, fmt, audio, viewerOf(req), req.params.file); // keep an actively-watched job alive (whose it is, and how far they have read)
  const abs = remux.filePath(remux.dirName(req.params.id, mtime, v, ss, fmt, audio), req.params.file);
  if (!abs) return res.status(404).send("Not found");
  res.setHeader("Content-Type", /\.(m4s|mp4)$/.test(req.params.file) ? "video/mp4" : "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(abs);
});

// ---------- AirPlay: the film WITH its subtitles, for an Apple TV ----------
// A film handed to an Apple TV is fetched by the Apple TV (lib/airtoken.js),
// and it shows no subtitles the page draws or adds as <track>s: only the
// subtitle renditions a MASTER playlist names (Apple's HLS rules). So a
// library title with subtitles goes to the receiver through this master: the
// jit stream (exactly the playlist the player would name — the same query,
// passed through) as its one variant, and every subtitle of the title as a
// WebVTT rendition the receiver's own subtitle menu offers.
//   ?sub=<n>   the one showing on the sender: DEFAULT=YES (the receiver
//              starts with it on); the rest AUTOSELECT=YES, DEFAULT=NO
// Each subtitle is ONE segment as long as the film; its cues are timed from
// the film's start, and X-TIMESTAMP-MAP ties them to the jit media clock
// (movie time + jit.TS_OFFSET_SEC, in 90 kHz units).
const airItem = (id) => {
  const entry = resolveKind(id, "video");
  if (!entry || !fs.existsSync(entry.path)) return null;
  return { entry, item: scanner.findById(id) || {} };
};
const airQuery = (q) => {
  const parts = [];
  const v = ladder.renditionFromQuery(q.v);
  if (v !== "copy") parts.push(`v=${v}`);
  if (q.seg === "fmp4") parts.push("seg=fmp4");
  if (q.vtag === "hvc1") parts.push("vtag=hvc1");
  const a = ladder.audioFromQuery(q.a);
  if (a) parts.push(`a=${a}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const airLabel = (s) => String(s || "Subtitles").replace(/["\r\n]/g, "'").slice(0, 60);
// What the one variant IS — its picture size, frame rate and codecs — as the
// ladder's own master says it of the same stream (media/ladder.js describe):
// a receiver that is told there is a picture, and which, never has to guess
// (one that cannot decode it refuses the variant — an error the player
// answers with the H.264 encode — instead of playing the sound alone).
// Whatever cannot be said for certain is left out, never guessed; a probe
// that is slow to answer leaves it all out.
const airVariant = async (entry, v) => {
  if (v !== "copy" && v !== "h264") return null;
  try {
    const st = fs.statSync(entry.path);
    const key = `${entry.id || ""}-${Math.floor(st.mtimeMs)}`;
    const facts = await Promise.race([
      ladder.probe(key, entry.path),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (!facts) return null;
    return ladder.describe({ facts, rate: null, top: v, lower: false, anyRate: true })[0] || null;
  } catch {
    return null;
  }
};
router.get("/stream/airplay/:id/master.m3u8", async (req, res) => {
  const found = airItem(req.params.id);
  if (!found) return res.status(404).send("Not found");
  const { entry, item } = found;
  const subs = Array.isArray(item.subtitles) ? item.subtitles.slice(0, 40) : [];
  const def = parseInt(req.query.sub, 10);
  // BANDWIDTH is required on a variant: the file's own rate (the copy) or
  // the full encode's ceiling, with the audio on top — an upper bound, as
  // the attribute is defined
  const v = ladder.renditionFromQuery(req.query.v);
  const fileBps = item.sizeBytes && item.duration ? (item.sizeBytes * 8) / item.duration : 0;
  const bandwidth = Math.ceil(v === "copy" && fileBps > 0 ? fileBps * 1.25 + 192000 : 12000000);
  const rung = await airVariant({ ...entry, id: req.params.id }, v);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  subs.forEach((s, i) => {
    // LANGUAGE from the track's language (media/subnames.js: ISO 639-1, or
    // the 3-letter code) so the receiver's own menu and auto-pick know it
    const lang = /^[a-z]{2,3}$/i.test(String(s.lang || "")) ? `,LANGUAGE="${String(s.lang).toLowerCase()}"` : "";
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${airLabel(s.label)}"${lang},DEFAULT=${i === def ? "YES" : "NO"},AUTOSELECT=YES,FORCED=NO,URI="sub/${i}.m3u8"`);
  });
  const attrs = [`BANDWIDTH=${bandwidth}`];
  if (rung && rung.w > 0 && rung.h > 0) attrs.push(`RESOLUTION=${rung.w}x${rung.h}`);
  if (rung && rung.fps > 0) attrs.push(`FRAME-RATE=${rung.fps.toFixed(3)}`);
  // (the hvc1 tag is what the copy carries when the player asked for it —
  // every HEVC title it sends here does; without it the string would be a lie)
  const hevcUntagged = rung && /^hvc1\./.test(rung.codecs || "") && req.query.vtag !== "hvc1";
  if (rung && rung.codecs && !hevcUntagged) attrs.push(`CODECS="${rung.codecs}"`);
  if (subs.length) attrs.push('SUBTITLES="subs"');
  lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`);
  // relative: under /air/<token>/stream/airplay/<id>/ this is
  // /air/<token>/stream/transcode/<id>/jit/index.m3u8 — the token rides along
  lines.push(`../../transcode/${encodeURIComponent(req.params.id)}/jit/index.m3u8${airQuery(req.query)}`);
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache");
  res.send(lines.join("\n") + "\n");
});
router.get("/stream/airplay/:id/sub/:file", async (req, res) => {
  const m = /^(\d{1,2})\.(m3u8|vtt)$/.exec(req.params.file);
  const found = m ? airItem(req.params.id) : null;
  if (!found) return res.status(404).send("Not found");
  const { entry, item } = found;
  const sub = (item.subtitles || [])[Number(m[1])];
  if (!sub) return res.status(404).send("Not found");
  if (m[2] === "m3u8") {
    const dur = item.duration > 0 ? item.duration : 4 * 3600;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    return res.send([
      "#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.ceil(dur)}`, "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD", `#EXTINF:${dur.toFixed(3)},`, `${m[1]}.vtt`, "#EXT-X-ENDLIST", "",
    ].join("\n"));
  }
  // the subtitle's own text: a sidecar file, or a track inside the film
  let text = null;
  const ext = /^\/stream\/subtitle\/([^/?]+)$/.exec(sub.url || "");
  const emb = /^\/stream\/embedded\/[^/]+\/(\d+)$/.exec(sub.url || "");
  if (ext) {
    const s = resolveKind(ext[1], "subtitle");
    if (s) text = await subtitles.vttText({ subPath: s.path });
  } else if (emb) {
    text = await subtitles.vttText({ videoPath: entry.path, trackIndex: parseInt(emb[1], 10) || 0 });
  }
  if (text == null) return res.status(404).send("Subtitle not available");
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(airVtt(text, jit.TS_OFFSET_SEC || 10));
});
// The WebVTT with Apple's timestamp map in its header (kept when it has one).
const airVtt = (text, offsetSec) => {
  const t = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^X-TIMESTAMP-MAP=/m.test(t.split("\n\n")[0])) return t;
  const map = `X-TIMESTAMP-MAP=MPEGTS:${Math.round(offsetSec * 90000)},LOCAL:00:00:00.000`;
  if (!/^WEBVTT/.test(t)) return `WEBVTT\n${map}\n\n${t}`;
  const nl = t.indexOf("\n");
  return nl < 0 ? `${t}\n${map}\n` : `${t.slice(0, nl)}\n${map}${t.slice(nl)}`;
};
router._internals = { airVtt, airQuery };

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
