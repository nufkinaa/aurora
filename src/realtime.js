// WebSocket hub: client presence + activity for the admin panel, watch
// history recording, notifications, and IP bans.
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const config = require("./config");
const telemetry = require("./telemetry");
const { JsonStore } = require("./lib/jsonstore");
// Imports that have to stay inside functions (circular), asked for once
// instead of on every call — lib/lazy.js has the why.
// (One ran per socket per broadcast, another per WebSocket message.)
const lazy = require("./lib/lazy");
const authmodeLib = lazy(require, "./lib/authmode");
const resetgateLib = lazy(require, "./lib/resetgate");
const authzLib = lazy(require, "./lib/authz");
const profilesLib = lazy(require, "./profiles");
const torrentLib = lazy(require, "./media/torrent");

const bans = new JsonStore(path.join(config.DATA_DIR, "bans.json"), {});
const watchHistory = new JsonStore(path.join(config.DATA_DIR, "watch-history.json"), []);

const clients = new Map(); // clientId -> {id, ip, device, profile, activity, ws...}
const connectionLog = [];
const MAX_LOG = 300;
const stats = {
  startedAt: Date.now(),
  totalConnections: 0,
  peakConcurrent: 0,
};

let wss = null;

// ---------- staying healthy (WebSocket hygiene) ----------
// A socket is a promise of memory and a timer on this one thread, so each
// one is held to four rules:
//   MESSAGES ARE SMALL: at most maxMessageKb (64 kB; the biggest real one, a
//     party's state, is under 1 kB). ws's own default was 100 MB.
//   A DEAD PEER IS NOTICED: every HEARTBEAT_MS each socket is pinged; one
//     that has not answered the previous ping (browsers and the TV's OkHttp
//     answer by themselves) is ended. A phone that left the house without
//     closing used to count as "connected" until the OS gave up, hours later.
//   A SLOW READER DOES NOT GROW MEMORY: what is waiting to go out to a socket
//     (bufferedAmount) is looked at before each send. Above SEND_SKIP_BYTES
//     a broadcast is skipped for that socket (it is a "something changed"
//     message; the next one, or the client's own reconnect, catches it up);
//     above SEND_CLOSE_BYTES the socket is ended.
//   A CHATTY CLIENT IS SLOWED: MSG_RATE messages a second (MSG_BURST at once)
//     are read; past that they are dropped, and a socket that keeps on is
//     closed (1008).
// Plus at most maxPerAddress (64) sockets from one address (LAN addresses four
// times that) — counted and logged in "log" mode, refused in "enforce"
// (config "ws": { "mode" }, else "rateLimits"'s mode), like the HTTP limits.
const wsCfg = () => (config.WS && typeof config.WS === "object" ? config.WS : {});
const HEARTBEAT_MS = 30 * 1000;
const SEND_SKIP_BYTES = 1024 * 1024;
const SEND_CLOSE_BYTES = 8 * 1024 * 1024;
const MSG_RATE = 50;
const MSG_BURST = 200;
const MSG_DROP_CLOSE = 1000; // dropped within MSG_DROP_WINDOW_MS before the socket is closed
const MSG_DROP_WINDOW_MS = 10 * 1000;
const maxMessageBytes = () => Math.max(1, Number(wsCfg().maxMessageKb) || 64) * 1024;
const maxPerAddress = () => Math.max(1, Number(wsCfg().maxPerAddress) || 64);
const wsMode = () => {
  const m = wsCfg().mode;
  if (["log", "enforce", "off"].includes(m)) return m;
  const r = config.RATE_LIMITS;
  const rm = typeof r === "string" ? r : r && typeof r === "object" ? r.mode : null;
  return ["log", "enforce", "off"].includes(rm) ? rm : "enforce"; // (the rate limits' own default)
};
const hygiene = { deadPeers: 0, skippedSends: 0, closedSlow: 0, oversize: 0, droppedMessages: 0, closedChatty: 0, overAddressLimit: 0, refusedAddressLimit: 0 };
const isPrivateIp = (a) => a === "127.0.0.1" || a === "::1" || a.startsWith("10.") || a.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
let saidAddressAt = 0;

// One beat: a socket that has not answered the last ping is ended, the
// others are pinged.
const heartbeat = () => {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      hygiene.deadPeers++;
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
};

// Every send goes through here. `skippable`: a broadcast a slow reader can
// miss. Returns whether it was sent.
const send = (ws, msg, skippable = false) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const queued = ws.bufferedAmount || 0;
  if (queued > SEND_CLOSE_BYTES) {
    hygiene.closedSlow++;
    try { ws.terminate(); } catch {}
    return false;
  }
  if (skippable && queued > SEND_SKIP_BYTES) {
    hygiene.skippedSends++;
    return false;
  }
  try { ws.send(msg); return true; } catch { return false; }
};

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
    if (authmodeLib().get() === "closed" && !ws.authed && !ws.isAdmin) return;
    send(ws, msg, true);
  });
};

// "Something changed — ask again": a message that makes EVERY device refetch
// (library_updated: the library list, its state, Home). A scan, the probes
// finishing, a download landing and the admin's rescan can each say it within
// the same second, and each one used to go out — a rescan alone sent two, so
// 100 devices made 600 requests and the server stood still for 4–8 s
// (measured). These are now collected: one message goes out once things have
// been quiet for QUIET_MS, and at the latest MAX_MS after the first — never
// one per cause. Nothing is lost by the wait: the message carries no data,
// only "ask again", and the clients spread their asking out on top of this.
const QUIET_MS = 1500;
const MAX_MS = 5000;
const soon = new Map(); // type -> { data, firstAt, timer, n }
// (the timers and the way out are replaceable: the tests drive them by hand)
const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now(), send: null };
const coalesced = { asked: 0, sent: 0 };
const broadcastSoon = (data) => {
  const type = data && data.type;
  if (!type) return;
  coalesced.asked++;
  const now = clock.now();
  let p = soon.get(type);
  if (!p) { p = { data, firstAt: now, timer: null, n: 0 }; soon.set(type, p); }
  p.data = data;
  p.n++;
  if (p.timer) clock.clearTimeout(p.timer);
  const wait = Math.max(0, Math.min(QUIET_MS, p.firstAt + MAX_MS - now));
  p.timer = clock.setTimeout(() => {
    soon.delete(type);
    coalesced.sent++;
    (clock.send || broadcastAll)(p.data);
  }, wait);
  if (p.timer && p.timer.unref) p.timer.unref();
};
// The one every caller means.
const libraryUpdated = () => broadcastSoon({ type: "library_updated" });

// One payload PER CLIENT (fn(client) → data, or null to skip that socket):
// for messages whose shape depends on who is listening — download updates
// say "mine" to the requester and nothing about who asked to everyone else.
const broadcastEach = (fn) => {
  if (!wss) return;
  const closed = authmodeLib().get() === "closed";
  for (const c of clients.values()) {
    const ws = c.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (closed && !ws.authed && !ws.isAdmin) continue;
    let data = null;
    try { data = fn(c, ws); } catch { data = null; }
    if (data) send(ws, JSON.stringify(data), true);
  }
};

// One client, by id (parties address members this way).
const sendTo = (clientId, data) => {
  const c = clients.get(clientId);
  if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) return false;
  return send(c.ws, JSON.stringify(data));
};
const party = require("./lib/party");

const broadcastAdmins = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.isAdmin) send(ws, msg, true);
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

// Who is this socket? Read once, when it connects, from the session the
// upgrade request carries (browsers send their cookie on a same-origin
// upgrade; the TV sets X-Session). Lazy require: authz pulls profiles, and
// realtime loads very early at boot.
// A session of a profile that owes a new password (lib/resetgate.js) is a
// RESTRICTED credential here as everywhere: the socket is a stranger's — not
// signed in, in no profile — and what it says is dropped, until the password
// is saved and the device connects again. `ws.restricted` keeps the profile's
// id so the socket can still be found when that profile is signed out.
const stampSocket = (ws, req) => {
  ws.authed = false;
  ws.profileId = null;
  ws.restricted = null;
  try {
    const rid = resetgateLib().restrictedProfile(req);
    if (rid) {
      ws.restricted = rid;
      return;
    }
    const sess = authzLib().sessionFor(req);
    ws.authed = !!sess;
    ws.profileId = sess ? sess.profile.id : null;
  } catch {}
};

// Every open socket that is this profile's: by what it said hello as (name or
// id), by the session it connected with, or by the must-reset session it
// connected with.
const clientsOfProfile = (p) => {
  const out = [];
  if (!p) return out;
  for (const c of clients.values()) {
    const ws = c.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    const mine =
      (c.profile && (c.profile === p.name || c.profile === p.id)) ||
      c.profileId === p.id || ws.profileId === p.id || ws.restricted === p.id;
    if (mine) out.push(c);
  }
  return out;
};

const handleMessage = (client, data, ws) => {
  // A socket of a profile that owes a new password says nothing that counts
  // (presence, activity, watch parties) — in every sign-in mode.
  if (data.type !== "admin_subscribe" && ws.restricted) {
    let due = false;
    try { due = profilesLib().resetDue(ws.restricted); } catch {}
    if (due) return;
  }
  // authMode "closed": an unauthenticated socket may still ASK to become
  // admin, but its hello/activity writes (presence, telemetry, watch history)
  // are dropped — signed-in devices only.
  if (
    data.type !== "admin_subscribe" &&
    !ws.authed && !ws.isAdmin &&
    authmodeLib().get() === "closed"
  ) {
    return;
  }
  switch (data.type) {
    case "hello":
      client.profile = String(data.profile || "").slice(0, 24) || null;
      // the id too (the name is for presence; "is this download mine?" needs
      // the id). In closed mode the session is the truth, not the message.
      client.profileId = ws.authed && ws.profileId
        ? ws.profileId
        : String(data.profileId || "").slice(0, 24) || null;
      // The TV app's socket carries no browser user-agent (it read as
      // "Desktop · Other · Other"), so the app says what it is: a TV, which
      // build, which set. Only the app's own shape is accepted, tidied.
      if (data.app === "tv") {
        const tidy = (v, n) => String(v == null ? "" : v).replace(/[^\w .·()+-]/g, "").slice(0, n);
        client.device = { device: "TV", browser: tidy(data.build, 24) || "Aurora TV", os: tidy(data.model, 40) || "Android TV" };
      }
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

    // ---------- watch parties (lib/party.js) ----------
    case "party_create": {
      const r = party.create(client, data.item, sendTo);
      send(ws, JSON.stringify(r.error ? { type: "party_error", message: r.error } : { type: "party_created", party: r.party }));
      if (!r.error) broadcastAll({ type: "party_list", parties: party.list() });
      break;
    }
    case "party_join": {
      const r = party.join(client, data.code, sendTo);
      send(ws, JSON.stringify(r.error ? { type: "party_error", message: r.error } : { type: "party_joined", party: r.party }));
      if (!r.error) broadcastAll({ type: "party_list", parties: party.list() });
      break;
    }
    case "party_leave":
      if (party.leave(client, sendTo)) broadcastAll({ type: "party_list", parties: party.list() });
      break;
    case "party_item": {
      const r = party.setItem(client, data.item, sendTo);
      if (r.error) send(ws, JSON.stringify({ type: "party_error", message: r.error }));
      else broadcastAll({ type: "party_list", parties: party.list() });
      break;
    }
    case "party_state":
      party.setState(client, data, sendTo);
      break;
    case "party_avatar":
      // presence knows the name; the party chips want the face too
      client.avatar = String(data.avatar || "").slice(0, 8) || null;
      client.avatarImage = typeof data.avatarImage === "string" && data.avatarImage.startsWith("/avatars/") ? data.avatarImage.slice(0, 200) : null;
      break;

    case "admin_subscribe":
      // The password rides in the subscribe message (page memory only, never a
      // cookie) — browsers can't set WS headers, so this is how the live
      // dashboard proves admin. No localhost bypass.
      if (validAdminPassword(data.pw)) {
        ws.isAdmin = true;
        send(ws, JSON.stringify({ type: "admin_ok" }));
      }
      break;
  }
};

const attach = (server) => {
  wss = new WebSocket.Server({ server, maxPayload: maxMessageBytes() });

  // the heartbeat (see "staying healthy" above)
  const beat = setInterval(heartbeat, HEARTBEAT_MS);
  beat.unref?.();
  wss.on("close", () => clearInterval(beat));

  // Feed the telemetry sampler live gauges. Torrent stats come lazily so we
  // never force WebTorrent to load just to record zeros.
  telemetry.start(() => {
    let downloadSpeed = 0, uploadSpeed = 0, peers = 0;
    try {
      const torrent = torrentLib();
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
    try { require("./lib/signals").hit("ws", ip); } catch {}
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    // sockets from one address
    {
      const mode = wsMode();
      // the address as lib/ratelimit.js reads it: X-Forwarded-For only from
      // the proxy on this machine, so a LAN device cannot pick a fresh one
      let addr = ip;
      try { addr = require("./lib/ratelimit")._internals.addressOf(req); } catch {}
      ws._addr = addr;
      if (mode !== "off") {
        let mine = 0;
        wss.clients.forEach((o) => { if (o !== ws && o._addr === addr) mine++; });
        const cap = maxPerAddress() * (isPrivateIp(addr) ? 4 : 1);
        if (mine >= cap) {
          hygiene.overAddressLimit++;
          if (Date.now() - saidAddressAt > 60 * 1000) {
            saidAddressAt = Date.now();
            console.warn(`[ws] ${mode === "enforce" ? "refused" : "would refuse (log mode)"} a socket: ${mine} already open from one ${isPrivateIp(addr) ? "LAN " : ""}address (limit ${cap})`);
          }
          if (mode === "enforce") {
            hygiene.refusedAddressLimit++;
            try { ws.close(1013, "too many connections from this address"); } catch {}
            return;
          }
        }
      }
    }

    // Session check at upgrade time (stampSocket). broadcastAll consults it
    // in authMode "closed" — see the note there.
    stampSocket(ws, req);

    if (bans.data[ip]) {
      send(ws, JSON.stringify({ type: "banned", reason: bans.data[ip].reason || "" }));
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

    send(ws, JSON.stringify({ type: "welcome", clientId: client.id }));
    // (a client that knows the message raises its "pick a new password" screen)
    if (ws.restricted) send(ws, JSON.stringify({ type: "password_reset_required", profileId: ws.restricted }));
    broadcastAdmins({ type: "client_connected", client: publicClient(client) });

    // messages: MSG_RATE a second, MSG_BURST at once (see above)
    let tokens = MSG_BURST;
    let refilled = Date.now();
    let dropped = 0;
    let dropWindowAt = 0;
    ws.on("message", (raw) => {
      ws.isAlive = true;
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - refilled) / 1000) * MSG_RATE);
      refilled = now;
      if (tokens < 1) {
        hygiene.droppedMessages++;
        if (now - dropWindowAt > MSG_DROP_WINDOW_MS) { dropWindowAt = now; dropped = 0; }
        if (++dropped === MSG_DROP_CLOSE) {
          hygiene.closedChatty++;
          try { ws.close(1008, "too many messages"); } catch {}
        }
        return;
      }
      tokens -= 1;
      try {
        handleMessage(client, JSON.parse(raw), ws);
      } catch {}
    });

    ws.on("close", () => {
      telemetry.onStopWatching(client.id);
      // a dropped socket leaves its party (the host's drop ends it)
      if (party.leave(client, sendTo)) broadcastAll({ type: "party_list", parties: party.list() });
      clients.delete(client.id);
      logEvent({ event: "disconnected", ...publicClient(client) });
      broadcastAdmins({ type: "client_disconnected", clientId: client.id });
    });

    // (ws closes a socket whose message is over maxPayload with 1009 and says so here)
    ws.on("error", (e) => { if (e && /max payload/i.test(e.message || "")) hygiene.oversize++; });
  });
};

const clientCount = () => clients.size;
// For the admin's metrics: sockets, what the hygiene rules did, and how much
// is waiting to go out to the slowest socket.
const wsStatus = () => {
  let buffered = 0;
  let maxBuffered = 0;
  const perAddress = new Map();
  if (wss) wss.clients.forEach((ws) => { const b = ws.bufferedAmount || 0; buffered += b; if (b > maxBuffered) maxBuffered = b; });
  if (wss) wss.clients.forEach((ws) => perAddress.set(ws._addr, (perAddress.get(ws._addr) || 0) + 1));
  return {
    open: wss ? wss.clients.size : 0, clients: clients.size, buffered, maxBuffered,
    maxPerAddressSeen: Math.max(0, ...perAddress.values()),
    limits: { maxMessageBytes: maxMessageBytes(), maxPerAddress: maxPerAddress(), mode: wsMode(), heartbeatMs: HEARTBEAT_MS, sendSkipBytes: SEND_SKIP_BYTES, sendCloseBytes: SEND_CLOSE_BYTES, msgRate: MSG_RATE, msgBurst: MSG_BURST },
    ...hygiene,
  };
};

// The server is going away (lib/shutdown.js): say so to every socket, then
// close it with a code that means "come back" (1012, service restart). The
// clients reconnect after a random delay. Returns how many were told.
const closeAll = (data, code = 1012) => {
  if (!wss) return 0;
  const msg = data ? JSON.stringify(data) : null;
  let n = 0;
  wss.clients.forEach((ws) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        if (msg) send(ws, msg);
        ws.close(code, "restarting");
        n++;
      }
    } catch {}
  });
  // a peer that never answers the close must not hold the exit
  setTimeout(() => { try { wss.clients.forEach((ws) => { try { ws.terminate(); } catch {} }); } catch {} }, 1500).unref?.();
  return n;
};

module.exports = {
  clientCount,
  wsStatus,
  closeAll,
  attach,
  broadcastAll,
  broadcastSoon,
  libraryUpdated,
  broadcastEach,
  sendTo,
  broadcastAdmins,
  clients,
  clientsOfProfile,
  _internals: { stampSocket, handleMessage, soon, clock, coalesced, QUIET_MS, MAX_MS, send, hygiene, heartbeat },
  connectionLog,
  stats,
  bans,
  watchHistory,
  isLocal,
  isAdmin,
  validAdminPassword,
  clientIp,
  parseDevice,
  publicClient,
};
