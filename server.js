// Aurora - personal streaming platform.
// Boot: load config, scan the library, start HTTP + WebSocket, enrich
// metadata in the background, auto-OCR bitmap subtitles as they're found.
// FIRST: patching console must happen before anything else logs, or the boot
// lines (library scan, ffmpeg/OCR availability) never reach the admin log view.
require("./src/lib/logbuffer");

const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");

const config = require("./src/config");
const scanner = require("./src/media/scanner");
const ocr = require("./src/media/ocr");
const online = require("./src/media/online");
const realtime = require("./src/realtime");

// Keep the server alive through library-internal throws. WebTorrent parses
// data from untrusted peers and can throw from deep async callbacks (e.g. the
// piece-picker's "null.missing"); those must never take the whole server down
// mid-stream. Log and carry on.
// A web peer (wss:// tracker) dropping its data channel makes webrtc-polyfill
// dispatch an 'error' event nobody listens for, which Node escalates to an
// uncaught exception. It is benign — the channel closes normally straight
// after — but it fired 38 times in a single session, and stack-traced noise
// that loud buries the exceptions that DO matter. Count them, don't narrate.
const isDroppedWebPeer = (err) =>
  !!err && /User-Initiated Abort|Ice connection closed/i.test(err.message || "");
let droppedWebPeers = 0;

process.on("uncaughtException", (err) => {
  if (isDroppedWebPeer(err)) {
    droppedWebPeers++;
    // One line per 25 so a genuine storm is still visible.
    if (droppedWebPeers % 25 === 1) {
      console.warn(`[webrtc] ${droppedWebPeers} web peer(s) dropped mid-handshake (benign)`);
    }
    return;
  }
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// Sweep stale torrent staging from previous runs (evictions whose
// destroyStore failed on Windows file locks, killed processes…) — it was
// found piling up 60+ GB on C:. Entries younger than 6h are kept so an
// in-flight download's staging survives a server restart. Runs BEFORE any
// torrent client exists, so nothing is locked.
{
  const fs = require("fs");
  const cutoff = Date.now() - 6 * 3600 * 1000;
  let freed = 0;
  // Both staging roots: WebTorrent's default store (streaming) and aria2's
  // download staging (see STAGING_ROOT in media/aria2.js).
  for (const stage of [path.join(os.tmpdir(), "webtorrent"), path.join(os.tmpdir(), "aurora-downloads")]) {
    try {
      for (const e of fs.readdirSync(stage, { withFileTypes: true })) {
        const abs = path.join(stage, e.name);
        try {
          if (fs.statSync(abs).mtimeMs < cutoff) {
            fs.rmSync(abs, { recursive: true, force: true });
            freed++;
          }
        } catch {}
      }
    } catch {}
  }
  if (freed) console.log(`[boot] swept ${freed} stale torrent staging entries`);
}

const app = express();
const server = http.createServer(app);

app.use(express.json());

// Gzip/deflate for text payloads. Measured on this library (35 titles):
// /api/home 1,060,613 B -> 174,613 B, /api/library 249,107 -> 39,875, the five
// stylesheets 92 KB -> ~18 KB, the eager module graph 260 KB -> ~70 KB. Nothing
// else on the box moves that much data for that little work.
//
// The filter is an allow-list, not `compression`'s default, on purpose: video,
// HLS segments and the APK must stream untouched. Re-compressing an .mp4 wastes
// CPU for nothing, and buffering a range response to deflate it is how you turn
// instant seeking into a stall.
const compression = require("compression");
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|xml|manifest)|text\/|image\/svg)/i;
app.use(
  compression({
    threshold: 1024, // below ~1 KB the header overhead is most of the packet
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      // 206 Partial Content is the seek path. Leave it alone.
      if (res.statusCode === 206) return false;
      return COMPRESSIBLE.test(String(res.getHeader("Content-Type") || ""));
    },
  })
);

// IP bans apply to HTTP too
app.use((req, res, next) => {
  const ip = (req.ip || "").replace("::ffff:", "");
  if (realtime.bans.data[ip]) return res.status(403).send("Banned");
  next();
});

// authMode "required" is the internet-facing posture (nufurora.com): every
// data and stream route needs a session, not just the profile-parameterized
// ones — an open /api/library or /stream/* would hand the whole catalog and
// the videos themselves to anyone who finds the port. Sessionless holes are
// an explicit allowlist: health, auth itself, and non-secret display config.
// Admin surfaces pass on their own X-Admin-Password check, and the static
// shell stays open (the login screen needs its HTML/JS/CSS). Registered only
// in required mode — open and hybrid behave exactly as before this existed.
if (config.AUTH_MODE === "required") {
  const authz = require("./src/lib/authz");
  const OPEN_PATHS = /^\/api\/(ping|me|server-info|auth\/)/;
  app.use((req, res, next) => {
    if (!/^\/(api|stream|avatars)\//.test(req.path)) return next();
    if (OPEN_PATHS.test(req.path)) return next();
    if (authz.sessionFor(req)) return next();
    if (realtime.isAdmin(req)) return next();
    res.status(401).json({ error: "sign in first", signinRequired: true });
  });
}

app.use(require("./src/routes/auth"));
app.use(require("./src/routes/api"));
app.use(require("./src/routes/profiles"));
app.use(require("./src/routes/stream"));
app.use(require("./src/routes/ai"));
app.use(require("./src/routes/admin"));
app.use(require("./src/routes/requests"));
app.use(require("./src/routes/torrent"));
app.use(require("./src/routes/downloads"));
app.use(require("./src/routes/proxy"));

// Processed profile avatars (re-encoded 256px JPEGs — see routes/profiles.js).
// Immutable long-cache is safe: re-uploads change the ?v the clients use.
app.use("/avatars", express.static(path.join(__dirname, "data", "avatars"), {
  maxAge: "365d",
  immutable: true,
  fallthrough: false,
}));

app.get("/admin", (req, res) => {
  // The shell is just UI code (no data). It shows a password overlay on load
  // and makes NO admin API/WS calls until the password is entered; every one
  // of those is gated server-side (realtime.isAdmin). The password lives only
  // in page memory, so a refresh re-shows the prompt — nothing is remembered.
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/web", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "browser.html"));
});

// The Android TV build. /download is the one path a person has to remember:
// point a TV browser (or Downloader) at it and the install file starts coming
// down — no page, no button. Registered ahead of express.static so the old
// /aurora-tv.apk redirects here instead of being served directly; TVs already in
// the field have that URL baked into their update banner, and a 302 keeps them
// working without a rebuild.
const APK_PATH = path.join(__dirname, "public", "aurora-tv.apk");
app.get("/download", (req, res) => {
  res.download(APK_PATH, "aurora-tv.apk", (err) => {
    if (err && !res.headersSent) {
      res.status(404).type("text/plain").send("No Android TV build has been published yet.");
    }
  });
});
app.get("/aurora-tv.apk", (req, res) => res.redirect(302, "/download"));

// Code revalidates on every load (cheap 304s) so updates land instantly;
// images can cache for a day.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      // tv-version.json is UPDATE METADATA — a day-old cached copy means the
      // TV's update banner lags a release by up to 24h (measured on the
      // Streamer: the device kept serving the previous versionName from HTTP
      // cache). It must always revalidate, like code.
      if (/\.(js|css|html)$/i.test(filePath) || /tv-version\.json$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  })
);

// SPA fallback: any unknown non-API path serves the app shell. Unknown API and
// stream paths get a real 404 — clients expecting JSON must never parse HTML.
app.get("*", (req, res) => {
  if (/^\/(api|stream)\//.test(req.path)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

realtime.attach(server);

// Library events -> clients
scanner.events.on("updated", () => realtime.broadcastAll({ type: "library_updated" }));
scanner.events.on("enriched", () => {
  realtime.broadcastAll({ type: "library_updated" });
  // Now that embedded-subtitle info is known, queue OCR for bitmap-only videos
  for (const v of scanner.bitmapOnlyVideos()) ocr.enqueue(v.path, v.name);
});

// Online metadata (genres, synopsis, art) fills in after each scan
scanner.events.on("scanned", () => online.enrich(scanner.allItems()));
online.events.on("updated", () => {
  scanner.scan();
  realtime.broadcastAll({ type: "library_updated" });
});

ocr.events.on("job", (job) => {
  if (job.status === "done") {
    scanner.scan(); // pick up the new .srt
    realtime.broadcastAll({ type: "library_updated" });
  }
  realtime.broadcastAll({ type: "subtitle_ocr", ...job });
});

// Resume any downloads that were mid-flight when the server last stopped.
require("./src/media/downloads").resume();

// Sign-in rollout (prompt 10): the moment authMode leaves "open", make sure
// every existing profile has an account to log in with. Idempotent — already-
// migrated profiles are skipped — and it backs up profiles.json first.
if (config.AUTH_MODE !== "open") {
  const migrated = require("./src/users").migrateFromProfiles();
  console.log(
    `[auth] mode=${config.AUTH_MODE}` +
      (migrated.length ? ` — migrated ${migrated.length} profile(s) to accounts:\n  ${migrated.join("\n  ")}` : ""),
  );
}

// Initial scan + periodic rescan
scanner.scan();
scanner.enrich();
setInterval(() => {
  scanner.scan();
  scanner.enrich();
}, config.SCAN_INTERVAL_MS);

const lanAddress = () => {
  // Adapter names that are VPN tunnels or virtual bridges, not the real LAN.
  // The "Network" URL must point at an interface a TV/phone can actually reach
  // — an idle-but-"Up" VPN adapter (e.g. a stale NordLynx 10.x) would otherwise
  // win the naive "first 10.* wins" pick and advertise a dead address.
  const SKIP = /nord|hamachi|radmin|tailscale|wireguard|openvpn|vethernet|vmware|virtualbox|loopback|wsl|hyper-?v/i;
  const isPrivate = (a) =>
    a.startsWith("192.168.") ||
    a.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a);

  const named = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) named.push({ name, address: iface.address });
    }
  }
  const real = named.filter((c) => !SKIP.test(c.name));
  // Prefer a real (non-VPN) private-LAN address, then any real address, then
  // fall back to anything rather than nothing.
  return (
    (real.find((c) => isPrivate(c.address)) || real[0] || {}).address ||
    (named.find((c) => isPrivate(c.address)) || named[0] || {}).address ||
    "localhost"
  );
};

// Failing to bind must kill the process LOUDLY. Without this, EADDRINUSE is
// swallowed by the uncaughtException guard: a stale orphan keeps serving old
// code on the port while pm2 shows the new instance "online" — and both end
// up downloading the same torrents into the same staging files.
server.on("error", (err) => {
  console.error("[fatal] server failed to listen:", err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(config.PORT, () => {
  // Now that we OWN the port, clear last-run's transcode stumps. Deferred to
  // here (not module load) so a stale/second instance that loses the bind race
  // can't delete this live instance's in-progress transcodes. Synchronous, so
  // it finishes before any HTTP request handler runs.
  try { require("./src/media/remux").bootSweep(); } catch {}
  try { require("./src/media/torrent-transcode").bootSweep(); } catch {}

  const { movies, shows } = scanner.index;
  const network = lanAddress();
  console.log("");
  console.log("  ⌘ Aurora is running");
  console.log("");
  console.log(`    Local    http://localhost:${config.PORT}`);
  console.log(`    Network  http://${network}:${config.PORT}`);
  console.log(`    Admin    http://localhost:${config.PORT}/admin`);
  console.log("");
  console.log(`    Library  ${movies.length} movies, ${shows.length} shows`);
  console.log(`    ffmpeg   ${config.ffmpegAvailable ? "ok" : "MISSING - no embedded subtitles"}`);
  console.log(`    auto-OCR ${config.ocrAvailable ? "ok" : "unavailable (needs python + tesseract)"}`);
  console.log("");
  if (!config.ADMIN_PASSWORD) {
    console.warn(
      "    ⚠ No admin password set — /admin is disabled. Set AURORA_ADMIN_PASSWORD in .env (see .env.example)."
    );
  }
  // Aurora's APIs assume a trusted LAN. A non-private "Network" address means
  // this box may be reachable from the internet — say so loudly.
  const isPrivateIp = (a) =>
    a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    a === "localhost";
  if (!isPrivateIp(network)) {
    console.warn(
      `    ⚠ ${network} is not a private LAN address. Aurora has no authentication on most APIs — keep inbound connections firewalled.`
    );
  }
  if (!config.ADMIN_PASSWORD || !isPrivateIp(network)) console.log("");
});
