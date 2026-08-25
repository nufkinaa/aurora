// Admin API - restricted to localhost.
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const config = require("../config");
const scanner = require("../media/scanner");
const metadata = require("../media/metadata");
const subtitles = require("../media/subtitles");
const realtime = require("../realtime");
const telemetry = require("../telemetry");
const torrent = require("../media/torrent");
const profiles = require("../profiles");
const logbuffer = require("../lib/logbuffer");
const disk = require("../lib/disk");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

router.use("/api/admin", adminOnly);

router.get("/api/admin/overview", (req, res) => {
  const { movies, shows } = scanner.index;
  const episodeCount = shows.reduce((n, s) => n + s.episodeCount, 0);
  let watchingNow = 0;
  for (const c of realtime.clients.values()) if (c.activity === "Watching") watchingNow++;
  const today = telemetry.analytics(1);
  res.json({
    startedAt: realtime.stats.startedAt,
    totalConnections: realtime.stats.totalConnections,
    peakConcurrent: realtime.stats.peakConcurrent,
    currentClients: realtime.clients.size,
    watchingNow,
    today: {
      watchSec: today.totals.watchSec,
      plays: today.totals.plays,
      uniqueViewers: today.totals.uniqueViewers,
    },
    movieCount: movies.length,
    showCount: shows.length,
    episodeCount,
    scannedAt: scanner.index.scannedAt,
    enriched: scanner.index.enriched,
    tools: {
      ffmpeg: config.ffmpegAvailable,
      ocr: config.ocrAvailable,
    },
  });
});

router.get("/api/admin/clients", (req, res) => {
  res.json([...realtime.clients.values()].map(realtime.publicClient));
});

router.get("/api/admin/log", (req, res) => {
  res.json(realtime.connectionLog);
});

// The server's own console output (see lib/logbuffer.js), with the real level
// on each line so "warnings and errors" is a filter rather than a guess.
// `sinceId` lets the live tail ask for just what's new instead of the lot.
router.get("/api/admin/logs", (req, res) => {
  const { level, q, sinceId, limit } = req.query;
  res.json({
    entries: logbuffer.read({
      level: typeof level === "string" ? level : "all",
      q: typeof q === "string" ? q : "",
      sinceId: parseInt(sinceId, 10) || 0,
      // clamp to the buffer's own capacity (1500) — the download button asks
      // for everything, and a lower clamp silently dropped the oldest third
      limit: Math.min(1500, Math.max(1, parseInt(limit, 10) || 400)),
    }),
    counts: logbuffer.counts(),
    stats: logbuffer.stats(),
  });
});

router.post("/api/admin/logs/clear", (req, res) => {
  logbuffer.clear();
  console.log("[admin] log buffer cleared");
  res.json({ ok: true });
});

router.get("/api/admin/watch-history", (req, res) => {
  res.json(realtime.watchHistory.data);
});

router.post("/api/admin/watch-history/clear", (req, res) => {
  realtime.watchHistory.data = [];
  realtime.watchHistory.flush();
  res.json({ ok: true });
});

// ---------- disk space & library management ----------

// Free/total bytes for every configured library root (deduped). `minFreePct` is
// the threshold below which download requests stop starting by themselves and
// wait for an admin, so the panel can show where that line sits.
router.get("/api/admin/disk", async (req, res) => {
  const roots = [...new Set([...config.LIBRARIES.movies, ...config.LIBRARIES.shows])];
  const out = [];
  for (const root of roots) {
    const s = await disk.space(root);
    out.push(s ? { root, free: s.free, total: s.total } : { root, free: null, total: null });
  }
  res.json({ disks: out, minFreePct: config.DOWNLOAD_MIN_FREE_PERCENT });
});

// Every title with its on-disk size, for the "free up space" list.
router.get("/api/admin/library", (req, res) => {
  const movies = scanner.index.movies.map((m) => ({
    id: m.id, type: "movie", title: m.title, year: m.year,
    sizeBytes: m.sizeBytes || 0, addedAt: m.addedAt || 0,
  }));
  const shows = scanner.index.shows.map((s) => ({
    id: s.id, type: "show", title: s.title, year: s.year,
    episodeCount: s.episodeCount,
    sizeBytes: s.seasons.reduce(
      (n, se) => n + se.episodes.reduce((x, e) => x + (e.sizeBytes || 0), 0), 0),
    addedAt: s.addedAt || 0,
  }));
  res.json({ movies, shows });
});

// True when `dir` is strictly INSIDE one of the roots (never a root itself) —
// the only folders this API is ever allowed to delete.
const insideARoot = (dir, roots) =>
  roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(dir));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });

// Delete a movie's folder or a whole show's folder from disk, then rescan.
router.delete("/api/admin/library/:type/:id", (req, res) => {
  const { type, id } = req.params;
  let folder = null;

  if (type === "movie") {
    const movie = scanner.index.movies.find((m) => m.id === id);
    const entry = movie && scanner.resolve(id);
    if (!entry || entry.kind !== "video") return res.status(404).json({ error: "Movie not found" });
    folder = path.dirname(entry.path); // one folder per movie, under the root
    if (!insideARoot(folder, config.LIBRARIES.movies)) {
      return res.status(400).json({ error: "Refusing to delete outside the movies library" });
    }
  } else if (type === "show") {
    const show = scanner.index.shows.find((s) => s.id === id);
    const firstEp = show && show.seasons[0] && show.seasons[0].episodes[0];
    const entry = firstEp && scanner.resolve(firstEp.id);
    if (!entry) return res.status(404).json({ error: "Show not found" });
    // The show folder is the first path segment under whichever root holds it.
    for (const root of config.LIBRARIES.shows) {
      const rel = path.relative(path.resolve(root), path.resolve(entry.path));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        folder = path.join(root, rel.split(path.sep)[0]);
        break;
      }
    }
    if (!folder || !insideARoot(folder, config.LIBRARIES.shows)) {
      return res.status(400).json({ error: "Refusing to delete outside the shows library" });
    }
  } else {
    return res.status(400).json({ error: "type must be movie or show" });
  }

  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (err) {
    // A file can be locked mid-stream on Windows — report instead of half-deleting silently.
    return res.status(500).json({ error: `Delete failed: ${err.message}` });
  }
  scanner.scan();
  realtime.broadcastAll({ type: "library_updated" });
  console.log(`[admin] deleted ${type} "${req.params.id}" → ${folder}`);
  res.json({ ok: true });
});

// ---------- analytics & telemetry ----------

// Full analytics rollup computed from watch sessions. ?days=7|14|30|90
router.get("/api/admin/analytics", (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 14));
  res.json(telemetry.analytics(days));
});

// Session log: who watched what, when, for how long, how far they got.
// ?limit=200&profile=alex&q=silo
router.get("/api/admin/sessions", (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const profile = (req.query.profile || "").toLowerCase();
  const q = (req.query.q || "").toLowerCase();
  let out = telemetry.sessions.data;
  if (profile) out = out.filter((s) => (s.profile || "").toLowerCase() === profile);
  if (q) out = out.filter((s) => (s.content || "").toLowerCase().includes(q));
  res.json(out.slice(0, limit));
});

// 24h ring of 30s samples + persisted hourly rollups for long-range charts.
router.get("/api/admin/timeseries", (req, res) => {
  res.json({
    sampleMs: telemetry.SAMPLE_MS,
    ring: telemetry.ring,
    hourly: telemetry.hourly.data,
  });
});

// Server + torrent health for the Server tab.
router.get("/api/admin/server", (req, res) => {
  const mem = process.memoryUsage();
  const cl = torrent.clientIfLoaded();
  const torrents = (cl ? cl.torrents : []).map((t) => ({
    infoHash: t.infoHash,
    name: t.name || t.infoHash,
    peers: t.numPeers || 0,
    progress: t.progress || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    downloaded: t.downloaded || 0,
    uploaded: t.uploaded || 0,
    length: t.length || 0,
    ready: !!t.ready,
    done: !!t.done,
    // Complete: peer discovery stopped, served straight off disk.
    quiesced: !!t._auroraQuiesced,
    // Progress of the file being streamed (see servedFileProgress) — the honest
    // number for a torrent scoped to one file. null before a file is picked.
    fileName: (t._auroraFile && t._auroraFile.name) || null,
    fileProgress: torrent.servedFileProgress(t),
  }));
  res.json({
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    uptimeSec: Math.floor(process.uptime()),
    startedAt: realtime.stats.startedAt,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      systemFree: os.freemem(),
      systemTotal: os.totalmem(),
    },
    torrents,
    tools: {
      ffmpeg: config.ffmpegAvailable,
      ocr: config.ocrAvailable,
      torrentsEnabled: config.TORRENTS,
      onlineMetadata: config.ONLINE_METADATA,
      // Downloads run on aria2; without it the queue can't start anything, so
      // it belongs next to ffmpeg rather than buried in a log line.
      aria2: config.aria2Available,
      aria2Path: config.ARIA2 || null,
    },
  });
});

// A human title for one progress entry. Library items resolve through the
// scanner; streamed items ("torrent|<hash>|<idx>") aren't in the library at
// all, so their title comes from the play-item meta stored alongside the
// progress — without it the panel showed a raw torrent id.
const progressTitle = (profileId, itemId) => {
  if (itemId.startsWith("torrent|")) {
    const meta = profiles.getStreamItem(profileId, itemId);
    if (meta && meta.title) {
      // The stored title for an episode already reads "Show · S1 E2"; a movie
      // is just its name. Mark it as a stream so admins can tell the two apart.
      return `${meta.title} (stream)`;
    }
    return "Streamed title (details not stored)";
  }
  const item = scanner.findById(itemId);
  if (!item) return itemId;
  return item.showId ? `${item.showTitle} · S${item.season} E${item.episode}` : item.title;
};

// Profiles with progress summaries: what each household member is in the
// middle of, straight from the resume-state store.
router.get("/api/admin/profiles", (req, res) => {
  res.json(
    profiles.list().map((p) => {
      const progress = profiles.getProgress(p.id);
      const entries = Object.entries(progress);
      const inProgress = entries
        .filter(([, v]) => !v.finished && v.position > 10)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 8)
        .map(([itemId, v]) => ({
          itemId,
          title: progressTitle(p.id, itemId),
          position: v.position,
          duration: v.duration,
          updatedAt: v.updatedAt,
        }));
      return {
        // Public shape only — the raw profile carries the password hash/salt,
        // which has no business in an HTTP response, even an admin one.
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        // Given at request time so the admin can tell whose profile this is.
        realName: p.realName || null,
        hasPassword: !!p.passwordHash,
        locked: !!p.locked,
        started: entries.length,
        finished: entries.filter(([, v]) => v.finished).length,
        watchlistCount: (profiles.watchlistItems(p.id) || []).length,
        inProgress,
      };
    })
  );
});

// ---------- new-profile approval ----------
// Nobody gets a profile without passing through here (see routes/profiles.js).
router.get("/api/admin/profile-requests", (req, res) => {
  res.json(profiles.pendingList());
});

router.post("/api/admin/profile-requests/:id/approve", (req, res) => {
  const p = profiles.approveRequest(req.params.id);
  // Already approved (or rejected) — a second click, not an error worth a 500.
  if (!p) return res.status(404).json({ error: "No such pending request" });
  // The username/email got claimed while the request waited — surfaced, not minted.
  if (p.error) return res.status(409).json(p);
  res.json(p);
});

router.post("/api/admin/profile-requests/:id/reject", (req, res) => {
  if (!profiles.rejectRequest(req.params.id)) {
    return res.status(404).json({ error: "No such pending request" });
  }
  res.json({ ok: true });
});

// ---------- per-profile device / IP history + flags ----------
// Flags are DERIVED on read, never stored: nothing to migrate, nothing to get
// out of sync, and changing a threshold takes effect immediately.
const WRONG_PW_FLAG = 5;      // wrong passwords from one device before we say so
const NEW_DEVICE_MS = 24 * 60 * 60 * 1000;
const MANY_IPS_FLAG = 4;      // distinct IPs on one profile before we say so

// LAN ranges — anything outside them reached this server from off-network, which
// on a household box is worth a second look.
const isPrivate = (ip) =>
  /^10\./.test(ip) ||
  /^192\.168\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  /^169\.254\./.test(ip) ||
  /^f[cd]/i.test(ip) || // fc00::/7 unique-local IPv6
  /^fe80/i.test(ip);

const flagsFor = (row, allRows) => {
  const flags = [];
  if (row.fails >= WRONG_PW_FLAG) flags.push(`${row.fails} wrong passwords`);
  // "New" is only interesting on a profile that already had an established
  // device — the first device on a fresh profile is just the owner.
  const others = allRows.filter((r) => r.key !== row.key);
  const established = others.some((r) => Date.now() - r.first > NEW_DEVICE_MS);
  if (established && Date.now() - row.first < NEW_DEVICE_MS) flags.push("new device");
  if (!realtime.isLocal(row.ip) && !isPrivate(row.ip)) flags.push("off-network IP");
  if (realtime.bans.data[row.ip]) flags.push("banned");
  return flags;
};

router.get("/api/admin/profile-access", (req, res) => {
  res.json(
    profiles.list().map((p) => {
      const rows = profiles.accessFor(p.id);
      const ips = new Set(rows.map((r) => r.ip));
      const devices = rows.map((r) => ({
        ip: r.ip,
        device: r.device,
        first: r.first,
        last: r.last,
        count: r.count,
        fails: r.fails,
        banned: !!realtime.bans.data[r.ip],
        flags: flagsFor(r, rows),
      }));
      const profileFlags = [];
      if (ips.size >= MANY_IPS_FLAG) profileFlags.push(`used from ${ips.size} IPs`);
      const totalFails = rows.reduce((n, r) => n + (r.fails || 0), 0);
      if (totalFails >= WRONG_PW_FLAG) profileFlags.push(`${totalFails} failed unlocks`);
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        realName: p.realName || null,
        locked: !!p.locked,
        devices,
        flags: profileFlags,
      };
    })
  );
});

// Lock or unlock a profile. Locked profiles can't be entered or unlocked (even
// with the right password) and all their live sessions are revoked on lock.
router.post("/api/admin/profiles/:id/lock", (req, res) => {
  const locked = !!(req.body || {}).locked;
  const p = profiles.setLocked(req.params.id, locked);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

// Delete a profile and all its state (progress, watchlist, ratings). Admin
// override — no profile token needed, unlike the user-facing delete.
router.delete("/api/admin/profiles/:id", (req, res) => {
  if (profiles.list().length <= 1) {
    return res.status(400).json({ error: "Can't delete the last profile" });
  }
  if (!profiles.remove(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ ok: true });
});

router.post("/api/admin/sessions/clear", (req, res) => {
  telemetry.sessions.data = telemetry.sessions.data.filter((s) => s.live);
  telemetry.sessions.flush();
  res.json({ ok: true });
});

router.get("/api/admin/bans", (req, res) => {
  res.json(realtime.bans.data);
});

router.post("/api/admin/ban", (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: "ip required" });
  // Bans apply to HTTP as well as websockets (see the middleware in server.js),
  // so banning the address you are administering FROM locks you out of this API
  // with no way back but hand-editing bans.json. The per-device Ban button in
  // the Profiles tab makes that one mis-click away — refuse it outright.
  if (ip === realtime.clientIp(req) || realtime.isLocal(ip)) {
    return res.status(400).json({
      error: "That's this machine — banning it would lock you out of the admin panel",
    });
  }
  realtime.bans.data[ip] = { reason: reason || "", at: new Date().toISOString() };
  realtime.bans.save();
  // Kick any connected clients from that IP
  for (const c of realtime.clients.values()) {
    if (c.ip === ip) {
      try {
        c.ws.send(JSON.stringify({ type: "banned", reason: reason || "" }));
        c.ws.close(1008, "Banned");
      } catch {}
    }
  }
  res.json({ ok: true });
});

router.post("/api/admin/unban", (req, res) => {
  const { ip } = req.body || {};
  delete realtime.bans.data[ip];
  realtime.bans.save();
  res.json({ ok: true });
});

router.post("/api/admin/kick/:clientId", (req, res) => {
  const c = realtime.clients.get(req.params.clientId);
  if (!c) return res.status(404).json({ error: "Not found" });
  try {
    c.ws.send(JSON.stringify({ type: "kicked", reason: (req.body || {}).reason || "" }));
    c.ws.close(1000, "Kicked");
  } catch {}
  res.json({ ok: true });
});

router.post("/api/admin/broadcast", (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  realtime.broadcastAll({ type: "admin_message", message: String(message).slice(0, 500) });
  res.json({ ok: true });
});

router.post("/api/admin/rescan", (req, res) => {
  scanner.scan();
  scanner.enrich();
  realtime.broadcastAll({ type: "library_updated" });
  res.json({ ok: true, scannedAt: scanner.index.scannedAt });
});

router.post("/api/admin/clear-caches", (req, res) => {
  metadata.clearCache();
  subtitles.clearCache();
  res.json({ ok: true });
});

// ---------- prompt 7: operator capabilities ----------

// Pending work at a glance (badges on the admin tabs): title requests
// awaiting an answer + download jobs awaiting approval.
router.get("/api/admin/pending-counts", (req, res) => {
  let requests = 0;
  let downloads = 0;
  try {
    requests = require("./requests").pendingCount();
  } catch {}
  try {
    downloads = require("../media/downloads")
      .list()
      .filter((j) => j.status === "pending").length;
  } catch {}
  res.json({ requests, downloads });
});

// Skip-intro marks manager: list everything the household has marked, with
// enough context to recognize a bad one, and delete it. (The user-facing
// POST /api/intro/:key stays unauthenticated on purpose — same household
// trust model as watch progress; the admin page is where mistakes get fixed.)
router.get("/api/admin/intros", (req, res) => {
  const intros = require("../lib/introstore");
  const items = Object.entries(intros.data).map(([key, range]) => {
    let title = null;
    if (key.startsWith("show:")) {
      const show = scanner.findById(key.slice(5));
      title = show ? show.title : null;
    }
    return { key, start: range.start, end: range.end, title };
  });
  res.json({ intros: items });
});

router.delete("/api/admin/intros/:key", (req, res) => {
  const intros = require("../lib/introstore");
  if (!Object.hasOwn(intros.data, req.params.key)) return res.status(404).json({ error: "Not found" });
  delete intros.data[req.params.key];
  intros.save();
  res.json({ ok: true });
});

// Update checker: read-only, cached an hour, silent when offline. ?force=1
// refreshes the cache (the button in the Server tab).
router.get("/api/admin/update-check", async (req, res) => {
  const result = await require("../lib/updatecheck").check(req.query.force === "1");
  res.json(result);
});

// The Pull button (admin-gated like everything under /api/admin). ff-only —
// see updatecheck.pull() for why.
router.post("/api/admin/update/pull", async (req, res) => {
  const r = await require("../lib/updatecheck").pull();
  if (!r.ok) return res.status(500).json({ error: "git pull failed", output: r.output });
  res.json({ ok: true, output: r.output, state: await require("../lib/updatecheck").check(true) });
});

// The Restart button. The reply goes out first, then the process exits and
// pm2's autorestart brings it back up on the NEW code — this server has no
// in-place reload, a clean death is the honest restart. (Run outside pm2,
// this just stops the server; the button's confirm says as much.)
router.post("/api/admin/update/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 400);
});

// aria2 global speed caps. GET reports the EFFECTIVE daemon values when it
// runs (plus what's persisted); POST validates, persists (so every future
// daemon spawn re-applies), and applies live when the daemon is up.
const ARIA2_LIMIT = /^\d{1,9}[KM]?$/i; // aria2 format: 0=unlimited, 500K, 5M, bytes
router.get("/api/admin/aria2-limits", async (req, res) => {
  const aria2 = require("../media/aria2");
  const settings = require("../lib/settings");
  const out = {
    available: aria2.available(),
    running: aria2.running(),
    saved: {
      download: String(settings.data.aria2MaxDownload || "0"),
      upload: String(settings.data.aria2MaxUpload || "0"),
    },
    effective: null,
  };
  if (out.running) {
    try {
      const opts = await aria2.getGlobalOptions();
      out.effective = {
        download: opts["max-overall-download-limit"],
        upload: opts["max-overall-upload-limit"],
        downloadSpeed: null,
      };
    } catch {}
  }
  res.json(out);
});

router.post("/api/admin/aria2-limits", async (req, res) => {
  const aria2 = require("../media/aria2");
  const settings = require("../lib/settings");
  const download = String((req.body && req.body.download) ?? "0").trim().toUpperCase();
  const upload = String((req.body && req.body.upload) ?? "0").trim().toUpperCase();
  if (!ARIA2_LIMIT.test(download) || !ARIA2_LIMIT.test(upload)) {
    return res.status(400).json({ error: "limits look like 0 (unlimited), 500K or 5M" });
  }
  settings.data.aria2MaxDownload = download;
  settings.data.aria2MaxUpload = upload;
  settings.save();
  let applied = false;
  if (aria2.running()) {
    try {
      await aria2.setGlobalLimits({ download, upload });
      applied = true;
    } catch {}
  }
  // Not running = nothing to throttle right now; ensure() re-applies the
  // persisted values on the next spawn, so "saved" is the honest answer.
  res.json({ ok: true, saved: { download, upload }, applied });
});

module.exports = router;
