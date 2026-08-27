// Torrent routes: list stream sources for a title, and stream the chosen
// file (with range support) or its embedded subtitles.
const path = require("path");
const express = require("express");
const torrent = require("../media/torrent");
const transcode = require("../media/torrent-transcode");
const config = require("../config");
const perf = require("../lib/perf");

const router = express.Router();

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
};

// Head-probe: the REAL codecs of a stream, read from its first bytes (see
// src/media/streamprobe.js). The client asks at play time and, when this
// answers, its library-grade capability logic replaces the release-tag
// guess entirely. 504 = can't know yet (no head pieces / weak swarm) — the
// client just keeps the tag guess; it can ask again later.
router.get("/api/torrents/probe/:infoHash/:fileIdx", async (req, res) => {
  if (!/^[0-9a-f]{40}$/i.test(req.params.infoHash)) return res.status(400).json({ error: "bad hash" });
  try {
    const t = await torrent.readyTorrent(req.params.infoHash);
    const file = torrent.pickVideoFile(t, parseInt(req.params.fileIdx, 10));
    if (!file) return res.status(404).json({ error: "no video file" });
    torrent.scopeToFile(t, file);
    const r = await require("../media/streamprobe").probe(
      req.params.infoHash.toLowerCase(),
      parseInt(req.params.fileIdx, 10) || 0,
    );
    res.setHeader("Cache-Control", "no-cache");
    res.json(r);
  } catch (err) {
    res.status(504).json({ error: "probe not ready: " + err.message });
  }
});

// Client-side halves of a stream's story (watchdog switch forensics, far-seek
// outcomes) land in the SAME per-torrent perf record as the server's own
// marks, so one grep of sessions.jsonl tells the whole tale. Names are
// whitelisted to a client_ prefix and values clamped — this must never
// become a free-form log sink.
router.post("/api/torrents/perf-mark/:infoHash", (req, res) => {
  if (!/^[0-9a-f]{40}$/i.test(req.params.infoHash)) return res.status(400).json({ error: "bad hash" });
  const b = req.body || {};
  const name = String(b.name || "");
  if (!/^client_[a-z_]{1,30}$/.test(name)) return res.status(400).json({ error: "bad name" });
  const extra = {};
  for (const k of ["reason", "from", "to", "outcome", "position", "target", "wallMs"]) {
    if (b[k] === undefined) continue;
    extra[k] = typeof b[k] === "number" && isFinite(b[k]) ? Math.round(b[k]) : String(b[k]).slice(0, 60);
  }
  perf.event(req.params.infoHash.toLowerCase(), name, Math.max(0, Math.round(Number(b.ms) || 0)), extra);
  res.json({ ok: true });
});

// GET /api/torrents/sources?type=movie&title=Tenet&year=2020
// GET /api/torrents/sources?type=series&title=The%20Office&year=2005&season=2&episode=1
router.get("/api/torrents/sources", async (req, res) => {
  try {
    const { type = "movie", title = "", year, season, episode } = req.query;
    if (!title.trim()) return res.json({ streams: [] });
    const t0 = Date.now();
    const result = await torrent.getSources(
      type,
      title.trim(),
      year ? parseInt(year, 10) : null,
      season ? parseInt(season, 10) : null,
      episode ? parseInt(episode, 10) : null
    );
    // <60ms is a cache hit; anything slower is Torrentio/Cinemeta on the wire.
    console.log(
      `[perf] sources "${title.trim().slice(0, 40)}" ${Date.now() - t0}ms (${(result.streams || []).length} streams)`,
    );
    res.json(result);
    // The viewer is choosing right now — pre-warm the recommended pick's
    // swarm so Play starts warm. Fire-and-forget, self-bounded (see
    // warmTorrent: one slot, one piece, 5-min TTL).
    const best = (result.streams || []).find((s) => s.recommended);
    if (best && best.infoHash) torrent.warmTorrent(best.infoHash);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// External subtitle tracks (Hebrew + English) for a title / episode
router.get("/api/torrents/subtitles/:type/:id", async (req, res) => {
  try {
    const { season, episode } = req.query;
    const subs = await torrent.getSubtitles(
      req.params.type,
      req.params.id,
      season ? parseInt(season, 10) : null,
      episode ? parseInt(episode, 10) : null
    );
    res.json({ subtitles: subs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Proxy + convert an external subtitle to WebVTT (browser-playable).
// Host allow-list: this endpoint fetches server-side, so an open proxy here
// would be an SSRF hole (any LAN client could make the server fetch internal
// URLs). Only the subtitle providers we actually use are allowed.
const SUB_PROXY_HOSTS =
  /(^|\.)strem\.io$|(^|\.)strem\.fun$|(^|\.)opensubtitles\.(org|com)$|(^|\.)wizdom\.xyz$/i;
// An external subtitle track, as WebVTT. The browser can't fetch these itself:
// Wizdom serves a ZIP, OpenSubtitles serves Windows-1255 as often as UTF-8, and
// neither sets CORS. `p` is the provider and `r` its reference (a URL for
// OpenSubtitles, an id for Wizdom); the legacy `u=<url>` form is still accepted
// so subtitle URLs handed out before this change keep working.
router.get("/stream/websub", async (req, res) => {
  const { p, r, u } = req.query;
  let track = null;

  if (p && r) {
    if (!["os", "wz"].includes(p)) return res.status(400).send("unknown provider");
    if (p === "os") {
      // An OpenSubtitles ref is a URL, so it still has to clear the allowlist —
      // this endpoint must never become an open proxy.
      try {
        if (!/^https?:\/\//.test(r) || !SUB_PROXY_HOSTS.test(new URL(r).hostname)) {
          return res.status(400).send("host not allowed");
        }
      } catch {
        return res.status(400).send("bad url");
      }
    }
    track = { provider: p, ref: r };
  } else if (u) {
    if (!/^https?:\/\//.test(u)) return res.status(400).send("bad url");
    try {
      if (!SUB_PROXY_HOSTS.test(new URL(u).hostname)) return res.status(400).send("host not allowed");
    } catch {
      return res.status(400).send("bad url");
    }
    track = { provider: "os", ref: u };
  } else {
    return res.status(400).send("missing track");
  }

  try {
    const vtt = await torrent.fetchSubtitleAsVtt(track);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(vtt);
  } catch (err) {
    res.status(502).send(err.message);
  }
});

// Subtitle track from inside a torrent (registered before the file route)
const SUB_EXT = new Set([".srt", ".vtt", ".sub", ".ass", ".ssa"]);
const MAX_SUB_BYTES = 5 * 1024 * 1024; // subtitles are ~100KB; refuse anything video-sized

router.get("/stream/torrent/sub/:infoHash/:fileIdx", async (req, res) => {
  if (!/^[a-f0-9]{40}$/i.test(req.params.infoHash)) return res.status(400).send("Bad info hash");
  try {
    const t = await torrent.readyTorrent(req.params.infoHash);
    const file = t.files[parseInt(req.params.fileIdx, 10)];
    if (!file) return res.status(404).send("Subtitle not found");
    // getBuffer() loads the whole file into RAM — only ever do that for an
    // actual subtitle file, never a multi-GB video index.
    if (!SUB_EXT.has(path.extname(file.name).toLowerCase()) || file.length > MAX_SUB_BYTES) {
      return res.status(400).send("Not a subtitle file");
    }
    const buf = await file.getBuffer();
    let content = buf.toString("utf-8");
    if (!content.startsWith("WEBVTT")) {
      content = "WEBVTT\n\n" + content
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(content);
  } catch (err) {
    res.status(502).send(err.message);
  }
});

// Transcoded HLS for torrent sources the browser can't decode (HEVC/AV1/10-bit
// video, or AC-3/DTS audio). `?v=h264` transcodes video, `?v=copy` only the
// audio. `:ss` is the seek/resume offset in seconds (0 = from the start).
// Registered BEFORE the raw file route so "hls" isn't read as an infoHash.
// GET /stream/torrent/hls/:infoHash/:fileIdx/:ss/index.m3u8
// ---------- S7b: JIT full-timeline VOD (torrents) ----------
// Same machinery as the library route (media/jit.js): one COMPLETE playlist
// from the torrent's own MKV index, segments produced on demand. The index
// reads and the producer both go through the torrent, so pieces anywhere on
// the timeline are prioritized exactly when the viewer asks for them —
// a seek fetches segment N instead of restarting a transcode.
// Registered BEFORE the /:ss routes so "jit" can't parse as an offset.
const jit = require("../media/jit");

// readRange over the torrent: collect a recovering read stream into a buffer.
// createReadStream is what marks those exact pieces critical in webtorrent,
// so this both reads AND prioritizes (head + Cues tail on a cold swarm).
const torrentReadRange = (t, file) => (start, len) =>
  new Promise((resolve, reject) => {
    const end = Math.min(start + len, file.length) - 1;
    if (end < start) return resolve(Buffer.alloc(0));
    const s = torrent.recoveringStream(file, { start, end, torrent: t });
    const chunks = [];
    s.on("data", (c) => chunks.push(c));
    s.on("end", () => resolve(Buffer.concat(chunks)));
    s.on("error", reject);
  });

// How long the playlist request will wait for the MKV index (head + Cues)
// to arrive from the swarm before telling the client to use the legacy
// event-playlist path instead. The reads keep prioritizing those pieces,
// so a retry after the swarm warms usually succeeds.
const JIT_INDEX_TIMEOUT_MS = 20000;

router.get("/stream/torrent/hls/:infoHash/:fileIdx/jit/index.m3u8", async (req, res) => {
  if (!config.ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  // Same disk guard as every transcoder: a full disk makes producers grind
  // silently and segment requests hang to their deadline.
  try {
    const sfs = require("fs").statfsSync(config.CACHE_DIR);
    if (sfs.bavail * sfs.bsize < 2 * 1024 * 1024 * 1024) {
      return res.status(503).send("Server disk is nearly full — free space to stream");
    }
  } catch {}
  try {
    const t0 = Date.now();
    const t = await torrent.readyTorrent(req.params.infoHash);
    const fileIdx = parseInt(req.params.fileIdx, 10);
    const file = torrent.pickVideoFile(t, fileIdx);
    if (!file) return res.status(404).send("No video file in torrent");
    torrent.scopeToFile(t, file);
    const key = `jt-${req.params.infoHash}-${fileIdx}`;
    const table = await Promise.race([
      jit.tableFor(key, torrentReadRange(t, file), file.length),
      new Promise((r) => setTimeout(r, JIT_INDEX_TIMEOUT_MS, "timeout")),
    ]);
    perf.event(req.params.infoHash, "jit_index", Date.now() - t0, { ok: !!(table && table !== "timeout") });
    // null = the file has no usable MKV index (permanent → 404, client falls
    // back for good). "timeout" = the swarm hasn't delivered the head/Cues
    // yet (temporary → 503, a later attempt can succeed).
    if (table === "timeout") return res.status(503).send("Index not ready yet");
    if (!table) return res.status(404).send("No usable index in this file");
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
    const suffix = `?v=copy${fmt ? "&seg=fmp4" : ""}${req.query.vtag === "hvc1" ? "&vtag=hvc1" : ""}`;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(jit.playlistText(table, suffix, fmt));
  } catch (err) {
    res.status(504).send("Torrent not ready: " + err.message);
  }
});

router.get("/stream/torrent/hls/:infoHash/:fileIdx/jit/:file", async (req, res) => {
  const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
  const m = String(req.params.file).match(fmt ? /^seg(\d{5})\.m4s$/ : /^seg(\d{5})\.ts$/);
  const isInit = fmt && req.params.file === "init.mp4";
  if (!m && !isInit) return res.status(404).send("Not found");
  try {
    torrent.touchTorrent(req.params.infoHash); // don't idle-evict mid-watch
    const t = await torrent.readyTorrent(req.params.infoHash);
    const fileIdx = parseInt(req.params.fileIdx, 10);
    const file = torrent.pickVideoFile(t, fileIdx);
    if (!file) return res.status(404).send("No video file in torrent");
    const key = `jt-${req.params.infoHash}-${fileIdx}`;
    // After a server restart mid-watch the table cache is empty while the
    // player still holds the full playlist — rebuild through the torrent
    // instead of 409ing (the reads re-prioritize the head/Cues pieces).
    let table = await jit.tableFor(key, null, 0).catch(() => null);
    if (!table) {
      table = await Promise.race([
        jit.tableFor(key, torrentReadRange(t, file), file.length),
        new Promise((r) => setTimeout(r, JIT_INDEX_TIMEOUT_MS, null)),
      ]).catch(() => null);
    }
    if (!table) return res.status(409).send("Playlist first");
    // Producer input: the complete file straight from disk; otherwise our
    // own blocking range route, so ffmpeg's reads pull the exact pieces
    // from the swarm (same contract as torrent-transcode's http mode).
    let complete = false;
    try { complete = !!file.done; } catch {}
    const absPath = path.join(t.path, file.path);
    const input = complete
      ? { url: absPath, extra: [] }
      : {
          url: `http://127.0.0.1:${config.PORT}/stream/torrent/${req.params.infoHash}/${fileIdx}`,
          extra: ["-seekable", "1", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"],
        };
    input.fmt = fmt;
    input.vtagHvc1 = req.query.vtag === "hvc1";
    // fMP4 producers get their own dir — same table, different segment files.
    const dir = path.join(config.CACHE_DIR, "jit", key + (fmt ? "-f4" : ""));
    const job = jit.jobFor(dir, table);
    const seg = isInit
      ? await jit.ensureInit(dir, job, input)
      : await jit.ensureSegment(dir, job, input, parseInt(m[1], 10));
    if (!seg) return res.status(504).send("Segment not ready");
    res.setHeader("Content-Type", fmt ? "video/mp4" : "video/mp2t");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(seg);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/stream/torrent/hls/:infoHash/:fileIdx/:ss/index.m3u8", async (req, res) => {
  if (!config.ffmpegAvailable) return res.status(503).send("ffmpeg not available");
  const vcodec = req.query.v === "copy" ? "copy" : "h264";
  const ss = Math.max(0, Math.floor(Number(req.params.ss) || 0));
  try {
    const tReady = Date.now();
    const t = await torrent.readyTorrent(req.params.infoHash);
    const readyMs = Date.now() - tReady;
    const fileIdx = parseInt(req.params.fileIdx, 10);
    const file = torrent.pickVideoFile(t, fileIdx);
    if (!file) return res.status(404).send("No video file in torrent");
    torrent.scopeToFile(t, file); // packs: never let 250k pieces run the main-thread piece loop
    const absPath = path.join(t.path, file.path); // on-disk path (for -ss seeking)
    // ?seek=1 marks a deliberate seek by the viewer (the player's probe sets it;
    // hls.js's own playlist refreshes never do). Only that may re-create an
    // offset we just retired — see `retired` in torrent-transcode.js.
    const seek = req.query.seek === "1";
    const fmt = req.query.seg === "fmp4" ? "fmp4" : null; // Apple's HEVC-in-HLS format (S4)
    const vtag = req.query.vtag === "hvc1"; // Apple-mandated HEVC sample tag
    const t0 = Date.now();
    const dir = await transcode.ensure(file, absPath, req.params.infoHash, fileIdx, vcodec, ss, seek, fmt, vtag);
    // Timing for deliberate viewer seeks only — playlist refreshes are noise.
    // readyMs isolates readyTorrent (metadata/re-add wait) from ensure; the
    // matching seek_ensure_detail event breaks ensure down further.
    if (seek) perf.event(req.params.infoHash, "seek_playlist_ready", Date.now() - t0, { ss, readyMs });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    // Copy jobs at an offset keep the source's real timestamps (-copyts, see
    // torrent-transcode.js): publish where playback begins — header for our
    // player, EXT-X-START for native HLS. hls.js playlist refreshes hit this
    // same route, so the tag stays present across reloads.
    if (vcodec === "copy" && ss > 0 && !fmt) {
      // TS only: hls.js needs the clock; the fMP4/native path keeps raw PTS
      // (copyts) so its clock is already honest and ffprobe can't read a
      // bare .m4s fragment anyway.
      const s = await require("../media/streamprobe").segmentStart(path.join(dir, "seg00000.ts"));
      let text = require("fs").readFileSync(path.join(dir, "index.m3u8"), "utf-8");
      if (s) {
        res.setHeader("X-Aurora-Base", String(s.base));
        res.setHeader("X-Aurora-Offset", String(s.offset));
        text = text.replace("#EXTM3U", `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${s.offset},PRECISE=YES`);
      }
      return res.send(text);
    }
    if (fmt === "fmp4") {
      // Segment URIs are relative and lose the query string — carry the
      // format on every .m4s line and on the EXT-X-MAP init URI, or the
      // segment route resolves the TS dir and 404s.
      const text = require("fs")
        .readFileSync(path.join(dir, "index.m3u8"), "utf-8")
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (t.endsWith(".m4s")) return `${t}?seg=fmp4`;
          if (t.startsWith("#EXT-X-MAP:")) return t.replace(/URI="[^"]*init\.mp4"/, 'URI="init.mp4?seg=fmp4"');
          return line;
        })
        .join("\n");
      return res.send(text);
    }
    res.sendFile(path.join(dir, "index.m3u8"));
  } catch (err) {
    res.status(504).send("Transcode not ready: " + err.message);
  }
});

// HLS segments (and the playlist on refresh) for the transcode above.
router.get("/stream/torrent/hls/:infoHash/:fileIdx/:ss/:file", (req, res) => {
  const fmt = req.query.seg === "fmp4" ? "fmp4" : null;
  transcode.touch(req.params.infoHash, req.params.fileIdx, req.params.ss, fmt); // keep the transcode alive
  torrent.touchTorrent(req.params.infoHash); // and its torrent (so it isn't idle-evicted)
  const abs = transcode.filePath(req.params.infoHash, req.params.fileIdx, req.params.ss, req.params.file, fmt);
  if (!abs) return res.status(404).send("Not found");
  res.setHeader("Content-Type", req.params.file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : /\.(m4s|mp4)$/.test(req.params.file) ? "video/mp4" : "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(abs);
});

// Stream a video file from a torrent by file index, with range support.
// GET /stream/torrent/:infoHash/:fileIdx
router.get("/stream/torrent/:infoHash/:fileIdx", async (req, res) => {
  perf.mark(req.params.infoHash, "stream_req");
  let t;
  try {
    t = await torrent.readyTorrent(req.params.infoHash);
  } catch (err) {
    return res.status(504).send("Torrent not ready: " + err.message);
  }
  perf.mark(req.params.infoHash, "stream_torrent_ready");

  // Everything below runs AFTER the await, so a synchronous throw here (e.g.
  // createReadStream on a torrent evicted between ready and now) rejects the
  // handler promise, which Express 4 does not catch — the response would hang.
  try {

  const file = torrent.pickVideoFile(t, parseInt(req.params.fileIdx, 10));
  if (!file) return res.status(404).send("No video file in torrent");

  // Scope piece-selection to THIS file (deselect-all + select in one tick —
  // see scopeToFile). For collection packs the old whole-torrent selection
  // made webtorrent's piece loop walk every piece per wire on the main
  // thread: measured 100%+ CPU and 5-6s HTTP latency on a 250-movie pack.
  torrent.scopeToFile(t, file);

  const total = file.length;
  const mime = MIME[path.extname(file.name).toLowerCase()] || "video/mp4";
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");

  // Once Content-Length has gone out, res.end() would hand the client a SHORT
  // body with a clean finish — which ffmpeg reads as end-of-file ("Invalid data
  // found", transcode dies, seek 504s) and the browser reports as
  // ERR_CONTENT_LENGTH_MISMATCH. Destroy the socket instead: a broken transfer
  // is the truth, and it's what makes ffmpeg's -reconnect retry.
  const onErr = () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); };

  if (!range) {
    res.writeHead(200, { "Content-Length": total, "Content-Type": mime });
    const s = torrent.recoveringStream(file, { torrent: t }); // disk fast-path + self-healing
    s.on("error", onErr);
    s.pipe(res);
    res.on("close", () => s.destroy());
    return;
  }

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
    "Content-Length": end - start + 1,
    "Content-Type": mime,
  });
  const s = torrent.recoveringStream(file, { start, end, torrent: t }); // disk fast-path + self-healing
  s.on("error", onErr);
  s.pipe(res);
  res.on("close", () => s.destroy());

  } catch (err) {
    if (!res.headersSent) res.status(500).send("Stream failed: " + err.message);
    else res.end();
  }
});

// Live status for the buffering UI: peers + download progress.
// GET /api/torrents/status/:infoHash
router.get("/api/torrents/status/:infoHash", async (req, res) => {
  try {
    torrent.touchTorrent(req.params.infoHash); // keep alive while the buffering UI polls
    const cl = await torrent.getClient();
    const t = cl.torrents.find((x) => x.infoHash === req.params.infoHash);
    if (!t) return res.json({ ready: false, peers: 0, progress: 0, downloadSpeed: 0 });
    res.json({
      ready: !!t.ready,
      peers: t.numPeers || 0,
      progress: t.progress || 0,
      downloadSpeed: t.downloadSpeed || 0,
      subtitles: t.ready ? torrent.torrentSubtitles(t, t.infoHash) : [],
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- admin: streaming-client visibility + manual evict ----------
const realtime = require("../realtime");
const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

// What the streaming client is holding right now (find stray giants).
router.get("/api/admin/torrents", adminOnly, (req, res) => {
  res.json(torrent.listTorrents());
});

// Drop a stream torrent immediately (frees CPU/RAM/staging without waiting
// for the 30-min idle eviction).
router.post("/api/admin/torrents/:infoHash/remove", adminOnly, async (req, res) => {
  const ok = await torrent.removeTorrent(req.params.infoHash);
  res.json({ removed: ok });
});

module.exports = router;
