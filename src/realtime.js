// WebSocket hub: client presence + activity for the admin panel, watch
// history recording, game leaderboards, notifications, and IP bans.
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const config = require("./config");
const telemetry = require("./telemetry");
const { JsonStore } = require("./lib/jsonstore");

const bans = new JsonStore(path.join(config.DATA_DIR, "bans.json"), {});
const watchHistory = new JsonStore(path.join(config.DATA_DIR, "watch-history.json"), []);
const leaderboards = new JsonStore(path.join(config.DATA_DIR, "leaderboards.json"), {});

const clients = new Map(); // clientId -> {id, ip, device, profile, activity, ws...}
const connectionLog = [];
const MAX_LOG = 300;
const stats = {
  startedAt: Date.now(),
  totalConnections: 0,
  peakConcurrent: 0,
};

let wss = null;

const parseDevice = (ua = "") => {
  const browser = /edg/i.test(ua) ? "Edge"
    : /chrome/i.test(ua) ? "Chrome"
    : /safari/i.test(ua) ? "Safari"
    : /firefox/i.test(ua) ? "Firefox" : "Other";
  const os = /web0s|webos|smarttv|smart-tv/i.test(ua) ? "TV"
    : /android/i.test(ua) ? "Android"
    : /iphone|ipad/i.test(ua) ? "iOS"
    : /windows/i.test(ua) ? "Windows"
    : /mac/i.test(ua) ? "macOS"
    : /linux/i.test(ua) ? "Linux" : "Other";
  const device = os === "TV" ? "TV" : /mobile/i.test(ua) ? "Mobile" : "Desktop";
  return { browser, os, device };
};

const clientIp = (req) =>
  (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?")
    .replace("::ffff:", "");

const publicClient = (c) => ({
  id: c.id,
  ip: c.ip,
  device: c.device,
  profile: c.profile,
  activity: c.activity,
  details: c.details,
  position: c.position,
  mediaDuration: c.mediaDuration,
  streamDuration: c.streamDuration,
  streamReady: c.streamReady,
  connectedAt: c.connectedAt,
  lastSeen: c.lastSeen,
});

const broadcastAll = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    // authMode "closed": broadcasts can carry member data (download_update
    // has title names), so unauthenticated sockets don't get them. ws.authed
    // is stamped at upgrade time in attach(). Open/transition: everyone.
    if (require("./lib/authmode").get() === "closed" && !ws.authed && !ws.isAdmin) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
};

const broadcastAdmins = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.isAdmin && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
};

const logEvent = (entry) => {
  connectionLog.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (connectionLog.length > MAX_LOG) connectionLog.pop();
};

const recordWatch = (client, content) => {
  // Collapse repeat entries for the same content from the same IP
  const recent = watchHistory.data.find(
    (h) => h.ip === client.ip && h.content === content
  );
  if (recent) {
    recent.lastSeen = new Date().toISOString();
    recent.count = (recent.count || 1) + 1;
  } else {
    watchHistory.data.unshift({
      id: crypto.randomBytes(6).toString("hex"),
      ip: client.ip,
      device: client.device,
      profile: client.profile,
      content,
      timestamp: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      count: 1,
    });
    if (watchHistory.data.length > 2000) watchHistory.data.pop();
  }
  watchHistory.save();
  broadcastAdmins({ type: "watch_history_update" });
};

const submitScore = (gameId, name, score) => {
  if (typeof score !== "number" || !isFinite(score)) return null;
  const board = leaderboards.data[gameId] || (leaderboards.data[gameId] = []);
  board.push({
    name: String(name || "Player").slice(0, 16),
    score: Math.floor(score),
    date: new Date().toISOString(),
  });
  board.sort((a, b) => b.score - a.score);
  leaderboards.data[gameId] = board.slice(0, 25);
  leaderboards.save();
  return leaderboards.data[gameId];
};

const isLocal = (ip) => ip === "127.0.0.1" || ip === "::1" || ip === "localhost";

// Admin access requires the password from AURORA_ADMIN_PASSWORD in `.env` (or
// "adminPassword" in config.json). With none configured, every admin surface
// stays locked — there is no default and no localhost bypass.
// The password is NEVER remembered server-side (no cookie). It rides on each
// request: an `X-Admin-Password` header (admin panel API calls) or a `?pw=`
// query. The panel keeps it in page memory only, so a refresh forces re-entry.
const validAdminPassword = (pw) => {
  if (!config.ADMIN_PASSWORD || typeof pw !== "string" || !pw) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = crypto.createHash("sha256").update(pw).digest();
  const b = crypto.createHash("sha256").update(config.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};
const isAdmin = (req) => {
  const pw = (req.query && req.query.pw) || req.headers["x-admin-password"];
  return validAdminPassword(pw);
};

const handleMessage = (client, data, ws) => {
  switch (data.type) {
    case "hello":
      client.profile = String(data.profile || "").slice(0, 24) || null;
      broadcastAdmins({ type: "client_update", client: publicClient(client) });
      break;

    case "activity": {
      const wasWatching = client.activity === "Watching";
      client.activity = String(data.action || "Browsing").slice(0, 32);
      client.details = data.details ? String(data.details).slice(0, 120) : null;
      client.position = typeof data.position === "number" ? data.position : null;
      client.mediaDuration = typeof data.duration === "number" ? data.duration : null;
      // Diagnostics: what the DEVICE's own player believes (see the player's
      // report). Lets an iPhone's real state be read off the admin API instead
      // of guessed at from here.
      client.streamDuration = typeof data.streamDuration === "number" ? data.streamDuration : null;
      client.streamReady = typeof data.streamReady === "number" ? data.streamReady : null;
      client.lastSeen = new Date().toISOString();
      if (client.activity === "Watching" && client.details) {
        // Sessions carry the full record (start/end/progress); the collapsed
        // watch-history entry is only bumped when a new session begins, so
        // periodic progress pings don't inflate play counts.
        const { started } = telemetry.onWatch(client, client.details, client.position, client.mediaDuration);
        if (started) recordWatch(client, client.details);
      } else if (wasWatching) {
        telemetry.onStopWatching(client.id);
      }
      broadcastAdmins({ type: "client_update", client: publicClient(client) });
      break;
    }

    case "submit_score": {
      const board = submitScore(data.gameId, data.name, data.score);
      if (board) ws.send(JSON.stringify({ type: "leaderboard", gameId: data.gameId, board }));
      break;
    }

    case "request_leaderboard":
      ws.send(
        JSON.stringify({
          type: "leaderboard",
          gameId: data.gameId,
          board: leaderboards.data[data.gameId] || [],
        })
      );
      break;

    case "admin_subscribe":
      // The password rides in the subscribe message (page memory only, never a
      // cookie) — browsers can't set WS headers, so this is how the live
      // dashboard proves admin. No localhost bypass.
      if (validAdminPassword(data.pw)) {
        ws.isAdmin = true;
        ws.send(JSON.stringify({ type: "admin_ok" }));
      }
      break;
  }
};

const attach = (server) => {
  wss = new WebSocket.Server({ server });

  // Feed the telemetry sampler live gauges. Torrent stats come lazily so we
  // never force WebTorrent to load just to record zeros.
  telemetry.start(() => {
    let downloadSpeed = 0, uploadSpeed = 0, peers = 0;
    try {
      const torrent = require("./media/torrent");
      const cl = torrent.clientIfLoaded && torrent.clientIfLoaded();
      if (cl) {
        for (const t of cl.torrents) {
          downloadSpeed += t.downloadSpeed || 0;
          uploadSpeed += t.uploadSpeed || 0;
          peers += t.numPeers || 0;
        }
      }
    } catch {}
    let watching = 0;
    for (const c of clients.values()) if (c.activity === "Watching") watching++;
    return { clients: clients.size, watching, downloadSpeed, uploadSpeed, peers };
  });

  wss.on("connection", (ws, req) => {
    const ip = clientIp(req);

    // Session check at upgrade time (browsers send cookies on same-origin WS
    // upgrades; the TV can set X-Session). Only broadcastAll consults it, and
    // only in authMode "required" — see the note there. Lazy require: authz
    // pulls users→profiles, and realtime loads very early at boot.
    try {
      ws.authed = !!require("./lib/authz").sessionFor(req);
    } catch {
      ws.authed = false;
    }

    if (bans.data[ip]) {
      ws.send(JSON.stringify({ type: "banned", reason: bans.data[ip].reason || "" }));
      ws.close(1008, "Banned");
      return;
    }

    const client = {
      id: crypto.randomBytes(6).toString("hex"),
      ip,
      device: parseDevice(req.headers["user-agent"]),
      profile: null,
      activity: "Browsing",
      details: null,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      ws,
    };
    clients.set(client.id, client);
    stats.totalConnections++;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, clients.size);
    logEvent({ event: "connected", ...publicClient(client) });

    ws.send(JSON.stringify({ type: "welcome", clientId: client.id }));
    broadcastAdmins({ type: "client_connected", client: publicClient(client) });

    ws.on("message", (raw) => {
      try {
        handleMessage(client, JSON.parse(raw), ws);
      } catch {}
    });

    ws.on("close", () => {
      telemetry.onStopWatching(client.id);
      clients.delete(client.id);
      logEvent({ event: "disconnected", ...publicClient(client) });
      broadcastAdmins({ type: "client_disconnected", clientId: client.id });
    });

    ws.on("error", () => {});
  });
};

module.exports = {
  attach,
  broadcastAll,
  broadcastAdmins,
  clients,
  connectionLog,
  stats,
  bans,
  watchHistory,
  leaderboards,
  isLocal,
  isAdmin,
  validAdminPassword,
  clientIp,
  parseDevice,
  publicClient,
};
