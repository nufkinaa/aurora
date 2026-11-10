// Telemetry: watch sessions + server time-series for the admin dashboard.
//
// Sessions are the ground truth for "who watched what, when, for how long".
// One session = one continuous viewing of one title by one client. The player
// reports position/duration with its activity pings, so each session also
// knows how far the viewer got.
//
// The sampler records a point every SAMPLE_MS (connected clients, watching
// count, torrent bandwidth, memory) into a 24h in-memory ring, and rolls
// finished hours into a persisted hourly history for the long-range charts.
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { JsonStore } = require("./lib/jsonstore");
const watchtime = require("./lib/watchtime");

const sessions = new JsonStore(path.join(config.DATA_DIR, "watch-sessions.json"), []);
const hourly = new JsonStore(path.join(config.DATA_DIR, "telemetry-hours.json"), {});

const MAX_SESSIONS = 8000;
// A live session is written when it starts, when it ends, on a seek, and
// otherwise at most this often (the players report every 5 s: writing the
// whole viewing history at every report was ~730 rewrites per viewer-hour).
// Memory always holds the latest; a graceful shutdown writes it; a hard kill
// loses at most this much of a live session's end time and position.
const LIVE_WRITE_MS = 60 * 1000;
const SEEK_SEC = 30; // a position this far off where playback would be is a seek
const HOURLY_KEEP_DAYS = 90;
const SAMPLE_MS = 30 * 1000;
const RING_HOURS = 24;
const RING_MAX = Math.ceil((RING_HOURS * 3600 * 1000) / SAMPLE_MS);

// A server restart leaves live sessions dangling - close them at the last
// moment they actually played (watch-time accounting 2: lastPlayAt; older
// records: their last update) so durations stay honest. The stored watch
// time is the credited play, so nothing more is added here.
let closedAtBoot = 0;
for (const s of sessions.data) {
  if (s.live) {
    s.live = false;
    s.endedAt = s.lastPlayAt || s.updatedAt || s.startedAt;
    s.endReason = "restart";
    closedAtBoot++;
  }
}
// Written when something was closed (or when the file is not there yet, so a
// fresh data folder still gets one): saving regardless rewrote the whole
// viewing history at every boot to say nothing new.
// (A store kept in SQLite has no file: lib/sqlitestore.js.)
if (closedAtBoot || (sessions.backend !== "sqlite" && !require("fs").existsSync(sessions.filePath))) sessions.save();

// The one-off repair of the watch time recorded the old way (lib/watchfix.js
// has the rules): once per VERSION, marked in data/watch-time-fix.json, after
// a copy of the file is put in the backups folder. Never fatal.
const runWatchFix = () => {
  const fs = require("fs");
  const watchfix = require("./lib/watchfix");
  const marker = path.join(path.dirname(sessions.filePath), "watch-time-fix.json"); // (beside the file it repaired)
  let done = null;
  try { done = JSON.parse(fs.readFileSync(marker, "utf-8")); } catch {}
  if (done && done.version >= watchfix.VERSION) return null;
  const p = watchfix.plan(sessions.data);
  let backup = null;
  const inSql = sessions.backend === "sqlite";
  if (p.changes.length && (inSql || fs.existsSync(sessions.filePath))) {
    const dir = config.BACKUP_DIR || path.join(config.DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, `watch-sessions.before-watch-fix-${watchfix.VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    if (inSql) fs.writeFileSync(backup, JSON.stringify(sessions.data)); // (in SQLite: what it holds, as its file would)
    else fs.copyFileSync(sessions.filePath, backup);
  }
  const changed = watchfix.apply(sessions.data, p);
  if (changed) sessions.save();
  fs.writeFileSync(marker, JSON.stringify({ version: watchfix.VERSION, at: new Date().toISOString(), changed, beforeSec: p.before, afterSec: p.after, backup }, null, 2));
  if (changed) console.log(`[watch-time] repaired ${changed} old viewings: ${Math.round(p.before / 360) / 10} h → ${Math.round(p.after / 360) / 10} h on record (backup: ${backup})`);
  return { changed, ...p };
};
try { runWatchFix(); } catch (e) { console.warn(`[watch-time] the repair of old viewings did not run: ${e && e.message}`); }

// ---------- real watch time (lib/watchtime.js has the rules) ----------
// Every time here is the SERVER's clock — a device whose clock is wrong
// changes nothing. Replaceable: the tests drive it by hand.
const clock = { now: () => Date.now() };
const iso = (ms) => new Date(ms).toISOString();
// A live session that hears nothing for this long is closed at its last
// report (the players report every 5 s while the player is open: nine missed).
const STALE_MS = 45 * 1000;
// A session that has stood paused this long is over: it is closed at the last
// moment it played; playing again starts a new one (a new sitting).
const PAUSE_CLOSE_MS = 30 * 60 * 1000;
// A person+title's bank (watchtime.js) not touched for this long is dropped.
const BANK_KEEP_MS = 10 * 60 * 1000;
const SWEEP_MS = 15 * 1000;

// clientId -> live session object (also present in sessions.data)
const liveByClient = new Map();
// session id -> its accounting { lastAt, lastPos, credited, duration } (memory only)
const acct = new Map();
// "<person>|<title>" -> bank { at, sec }: shared by every device of that
// person playing that title, so two screens of one episode count it once
const banks = new Map();
// clientId -> { content, st }: a session closed for standing paused; its
// reports are not a new play until the media moves again
const pausedOut = new Map();

const personOf = (x) => x.profileId || x.profile || `client:${x.clientId || x.id}`;
const bankFor = (x, content, nowMs) => {
  const key = `${personOf(x)}|${content}`;
  let b = banks.get(key);
  if (!b) { b = watchtime.newBank(nowMs); banks.set(key, b); }
  return b;
};

// ---------- session lifecycle ----------

// `opts.at` (ms): when it ended, if not now — the sweeper closes a session
// at its last report, not at the moment it noticed.
const closeSession = (clientId, opts = {}) => {
  const s = liveByClient.get(clientId);
  if (!s) return;
  liveByClient.delete(clientId);
  const st = acct.get(s.id);
  acct.delete(s.id);
  s.live = false;
  const endMs = Math.min(clock.now(), opts.at || clock.now());
  // It ended when it last PLAYED; a session that never played ends at its
  // last report (so the abnormal-end and span readings still work).
  s.endedAt = s.lastPlayAt || iso(Math.max(Date.parse(s.startedAt), Math.min(endMs, Date.parse(s.updatedAt) || endMs)));
  if (opts.reason) s.endReason = opts.reason;
  if (st) s.watchedSec = Math.round(st.credited);
  if (opts.reason === "paused" && st) pausedOut.set(clientId, { content: s.content, st: { lastAt: st.lastAt, lastPos: st.lastPos } });
  else pausedOut.delete(clientId);
  // Did it end in trouble? A viewer who vanished mid-film with a stall that
  // never ended (or an error) just before is an abnormal end — the healer's
  // sessions check counts these (lib/playmarks.js has the marks).
  try {
    const unfinished = !(s.duration > 0 && s.position != null && s.position / s.duration > 0.93);
    if (unfinished && require("./lib/playmarks").troubledJustNow(s.ip)) s.abnormal = true;
  } catch {}
  // Discard accidental blips: opened and closed within a few seconds, and
  // never really played
  const spanSec = (Date.parse(s.updatedAt) - Date.parse(s.startedAt)) / 1000;
  if (spanSec < 5 && (s.watchedSec || 0) < 5) {
    const i = sessions.data.indexOf(s);
    if (i !== -1) sessions.data.splice(i, 1);
  }
  sessions.save();
};

// A jump of the position away from where steady playback (or a pause) would
// have it. Pure.
const isSeek = (prevPos, prevAtMs, pos, nowMs) => {
  if (typeof prevPos !== "number" || typeof pos !== "number") return false;
  const elapsed = Math.max(0, (nowMs - prevAtMs) / 1000);
  const moved = pos - prevPos;
  return moved < -SEEK_SEC || moved > elapsed + SEEK_SEC;
};

// The report a player sends, tidied. `played` / `state` / `rate` come from
// new clients only (old ones send position and duration).
const tidyReport = (r = {}) => {
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const out = { position: n(r.position), duration: n(r.duration) };
  if (n(r.played) != null) out.played = Math.max(0, Math.min(watchtime.BEAT_MAX_SEC * 4, r.played));
  if (["playing", "paused", "buffering", "ended"].includes(r.state)) out.state = r.state;
  if (n(r.rate) != null && r.rate > 0 && r.rate <= 4) out.rate = r.rate;
  return out;
};

// Called on every "Watching" activity report. Starts a session on first
// sight, rolls to a new one when the content changes, credits real play
// otherwise (lib/watchtime.js). Returns { session, started, credit, state } so
// callers can react to new plays only. `report` is { position, duration,
// played?, state?, rate? } (an older caller passes position, duration).
const onWatch = (client, content, report, durationArg) => {
  const r = tidyReport(typeof report === "object" && report !== null ? report : { position: report, duration: durationArg });
  const nowMs = clock.now();
  let s = liveByClient.get(client.id);
  let started = false;
  // the same socket, now in another profile: that viewing is over
  if (s && (s.content !== content || (client.profile && s.profile && s.profile !== client.profile))) {
    closeSession(client.id, { reason: s.content !== content ? "next" : "profile" });
    s = null;
  }
  if (!s) {
    // paused out earlier: a report that still stands paused is not a new play
    const out = pausedOut.get(client.id);
    if (out && out.content === content) {
      const { claim } = watchtime.claimOf(out.st, r, nowMs);
      out.st.lastAt = nowMs;
      if (r.position != null) out.st.lastPos = r.position;
      if (!(claim > 0)) return { session: null, started: false, credit: 0, state: r.state || "paused" };
    }
    pausedOut.delete(client.id);
    started = true;
    s = {
      id: crypto.randomBytes(6).toString("hex"),
      clientId: client.id,
      profile: client.profile,
      profileId: client.profileId || null,
      ip: client.ip,
      device: client.device,
      content,
      startedAt: iso(nowMs),
      updatedAt: iso(nowMs),
      lastPlayAt: null,
      endedAt: null,
      watchedSec: 0,
      position: r.position != null ? Math.round(r.position) : null,
      duration: r.duration != null ? Math.round(r.duration) : null,
      state: r.state || null,
      acct: 2, // watch time = credited play (lib/watchtime.js), not wall time
      live: true,
    };
    if (r.rate && r.rate !== 1) s.rate = r.rate;
    const st = { lastAt: nowMs, lastPos: null, credited: 0, duration: r.duration };
    acct.set(s.id, st);
    // The first report of a viewing credits what a new client says it played
    // since its last report — out of the person+title's bank, which is new
    // (empty) for a first play and holds the real wall time when the same
    // title goes on after a moment (a player remade, a socket back). Old
    // clients' first report has nothing to compare and credits nothing.
    let credit0 = 0;
    if (r.played > 0) {
      credit0 = watchtime.credit(st, bankFor(s, content, nowMs), r, nowMs).credit;
      s.watchedSec = Math.round(st.credited);
      if (credit0 > 0) s.lastPlayAt = iso(nowMs);
    } else bankFor(s, content, nowMs); // the bank starts accruing now
    st.lastPos = r.position;
    liveByClient.set(client.id, s);
    sessions.data.unshift(s);
    if (sessions.data.length > MAX_SESSIONS) sessions.data.length = MAX_SESSIONS;
    sessions.save();
    return { session: s, started, credit: credit0, state: s.state };
  }
  let st = acct.get(s.id);
  if (!st) { st = { lastAt: Date.parse(s.updatedAt), lastPos: s.position, credited: s.watchedSec || 0, duration: s.duration }; acct.set(s.id, st); }
  const prevAt = st.lastAt;
  const prevPos = st.lastPos;
  const res = watchtime.credit(st, bankFor(s, content, nowMs), r, nowMs);
  s.updatedAt = iso(nowMs);
  s.watchedSec = Math.round(st.credited);
  if (res.credit > 0) s.lastPlayAt = iso(nowMs);
  if (res.state) s.state = res.state;
  if (!s.profile && client.profile) s.profile = client.profile;
  if (!s.profileId && client.profileId) s.profileId = client.profileId;
  if (r.position != null) s.position = Math.round(r.position);
  if (r.duration != null) s.duration = Math.round(r.duration);
  if (r.rate) { if (r.rate !== 1) s.rate = r.rate; else delete s.rate; }
  sessions.save(isSeek(prevPos, prevAt, r.position, nowMs) ? undefined : { within: LIVE_WRITE_MS });
  return { session: s, started, credit: res.credit, state: s.state };
};

// Called when a client's activity moves away from Watching, or it disconnects.
const onStopWatching = (clientId, reason) => closeSession(clientId, reason ? { reason } : {});

// The live session of a client (the admin's "watching now" reads its state).
const liveSessionOf = (clientId) => liveByClient.get(clientId) || null;

// Sessions that stopped hearing from their player, or stood paused too long,
// are closed — the server does not wait for a clean goodbye that a device
// switched off at the wall never sends. Returns how many were closed.
const sweep = (nowMs = clock.now()) => {
  let n = 0;
  for (const [clientId, s] of [...liveByClient]) {
    const last = Date.parse(s.updatedAt) || 0;
    if (nowMs - last > STALE_MS) { closeSession(clientId, { at: last, reason: "silent" }); n++; continue; }
    const played = Date.parse(s.lastPlayAt || s.startedAt) || 0;
    if (s.state !== "playing" && nowMs - played > PAUSE_CLOSE_MS) { closeSession(clientId, { reason: "paused" }); n++; }
  }
  for (const [k, b] of banks) if (nowMs - b.at > BANK_KEEP_MS) banks.delete(k);
  for (const [k, o] of pausedOut) if (nowMs - (o.st.lastAt || 0) > 6 * 3600 * 1000) pausedOut.delete(k);
  return n;
};
let sweepTimer = null;
const startSweep = () => {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { try { sweep(); } catch {} }, SWEEP_MS);
  sweepTimer.unref?.();
};

// ---------- a saved copy watched with no server (the phone's offline queue) ----------
// The phone measures what it played (its watchClock) and sends it when the
// server answers again: one closed session per sitting. Bounded like a live
// one: by the wall span the phone measured (its own clock, so only the
// DIFFERENCE is used), by the media's length (x2 + 5 min) and by 6 h; dated
// by the phone's clock, held between 30 days ago and now. Sent twice (a retry
// whose answer was lost) is recorded once: `reportId`.
const OFFLINE_MAX_SEC = 6 * 3600;
const REPORT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const addOfflinePlay = (x = {}) => {
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const reportId = typeof x.reportId === "string" ? x.reportId : null;
  const content = typeof x.content === "string" ? x.content.slice(0, 120).trim() : "";
  const played = n(x.played);
  if (!reportId || !REPORT_ID_RE.test(reportId) || !content || played == null || played < 0) return { error: "bad report" };
  if (sessions.data.some((s) => s.reportId === reportId)) return { ok: true, duplicate: true };
  const nowMs = clock.now();
  const firstAt = Math.min(nowMs, Math.max(nowMs - 30 * 86400 * 1000, n(x.firstAt) || nowMs));
  const lastAt = Math.min(nowMs, Math.max(firstAt, n(x.lastAt) || firstAt));
  const dur = n(x.duration) > 0 ? n(x.duration) : null;
  let sec = Math.min(played, (lastAt - firstAt) / 1000 + watchtime.BANK_MAX_SEC, OFFLINE_MAX_SEC);
  if (dur) sec = Math.min(sec, dur * watchtime.SESSION_DUR_FACTOR + watchtime.SESSION_DUR_EXTRA_SEC);
  sec = Math.max(0, Math.round(sec));
  if (sec < 5) return { ok: true, ignored: true };
  const s = {
    id: crypto.randomBytes(6).toString("hex"),
    clientId: null,
    profile: x.profile || null,
    profileId: x.profileId || null,
    ip: x.ip || null,
    device: x.device || { device: "Mobile", browser: "Aurora phone", os: "Android phone" },
    content,
    startedAt: iso(firstAt),
    updatedAt: iso(lastAt),
    lastPlayAt: iso(lastAt),
    endedAt: iso(lastAt),
    watchedSec: sec,
    position: n(x.position) != null ? Math.round(x.position) : null,
    duration: dur != null ? Math.round(dur) : null,
    acct: 2,
    offline: true,
    reportId,
    live: false,
  };
  // newest first, by start
  let i = 0;
  while (i < sessions.data.length && sessions.data[i].startedAt > s.startedAt) i++;
  sessions.data.splice(i, 0, s);
  if (sessions.data.length > MAX_SESSIONS) sessions.data.length = MAX_SESSIONS;
  sessions.save();
  return { ok: true, session: s };
};

// ---------- time-series sampler ----------

const ring = []; // [{t, clients, watching, downKBs, upKBs, peers, memMB}]
let sampleTimer = null;

const hourKey = (d = new Date()) => d.toISOString().slice(0, 13); // "2026-07-23T14"

const pruneHourly = () => {
  const cutoff = hourKey(new Date(Date.now() - HOURLY_KEEP_DAYS * 86400 * 1000));
  for (const k of Object.keys(hourly.data)) {
    if (k < cutoff) delete hourly.data[k];
  }
};

let lastHour = null;
const HOUR_GRACE_MS = 5 * 1000;
const msToNextHour = (now = Date.now()) => 3600 * 1000 - (now % (3600 * 1000));

const start = (getGauges) => {
  startSweep(); // (sessions whose player went quiet are closed by the server)
  if (sampleTimer) return;
  const sample = () => {
    let g = {};
    try {
      g = getGauges() || {};
    } catch {}
    const point = {
      t: Date.now(),
      clients: g.clients || 0,
      watching: g.watching || 0,
      downKBs: Math.round((g.downloadSpeed || 0) / 1024),
      upKBs: Math.round((g.uploadSpeed || 0) / 1024),
      peers: g.peers || 0,
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    ring.push(point);
    if (ring.length > RING_MAX) ring.shift();

    // Roll into the persisted hourly history
    const k = hourKey();
    const h = hourly.data[k] || (hourly.data[k] = {
      samples: 0, maxClients: 0, sumClients: 0, maxWatching: 0, sumWatching: 0, downKB: 0,
    });
    h.samples++;
    h.maxClients = Math.max(h.maxClients, point.clients);
    h.sumClients += point.clients;
    h.maxWatching = Math.max(h.maxWatching, point.watching);
    h.sumWatching += point.watching;
    h.downKB += Math.round((point.downKBs * SAMPLE_MS) / 1000);
    pruneHourly();
    // Written when an hour closes (the first sample of the next one) and at
    // a graceful shutdown — not every 30 s: that kept the data disk awake
    // (27.5 MB an hour on an idle server). The open hour lives in memory,
    // where the admin page reads it; a hard kill loses at most that hour.
    if (lastHour !== null && k !== lastHour) hourly.save();
    else hourly.save({ within: msToNextHour() + HOUR_GRACE_MS });
    lastHour = k;
  };
  sample();
  sampleTimer = setInterval(sample, SAMPLE_MS);
  sampleTimer.unref?.(); // the server is kept up by its port, not by this
};

// ---------- analytics (computed from sessions) ----------

const dayKey = (iso) => {
  // Local calendar day, so the charts match the household's clock
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Seconds this profile has watched TODAY (local calendar day, same as the
// charts). Read-only over the sessions already recorded — nothing new is
// stored. Sessions carry the profile NAME, which is what the presence layer
// reports, so callers pass the name rather than the id.
const todayWatchSec = (profileName) => {
  if (!profileName) return 0;
  const today = dayKey(new Date().toISOString());
  let sec = 0;
  for (const s of sessions.data) {
    if (s.profile !== profileName) continue;
    if (dayKey(s.startedAt) !== today) continue;
    sec += s.watchedSec || 0;
  }
  return Math.round(sec);
};

const analytics = (days = 14) => {
  const cutoff = Date.now() - days * 86400 * 1000;
  const inRange = sessions.data.filter((s) => new Date(s.startedAt).getTime() >= cutoff);

  const byDay = {};
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0)); // [weekday][hour] watch seconds
  const byProfile = {};
  const byDevice = {};
  const byOs = {};
  const byTitle = {};
  const byViewer = {};

  for (const s of inRange) {
    const started = new Date(s.startedAt);
    const watched = s.watchedSec || 0;

    const dk = dayKey(s.startedAt);
    const day = byDay[dk] || (byDay[dk] = { watchSec: 0, plays: 0 });
    day.watchSec += watched;
    day.plays++;

    heatmap[started.getDay()][started.getHours()] += watched;

    const pk = s.profile || "(no profile)";
    const p = byProfile[pk] || (byProfile[pk] = { watchSec: 0, plays: 0, titles: new Set(), lastSeen: null });
    p.watchSec += watched;
    p.plays++;
    p.titles.add(s.content);
    if (!p.lastSeen || s.startedAt > p.lastSeen) p.lastSeen = s.startedAt;

    const dev = s.device || {};
    const dvk = dev.device || "Other";
    byDevice[dvk] = (byDevice[dvk] || { watchSec: 0, plays: 0 });
    byDevice[dvk].watchSec += watched;
    byDevice[dvk].plays++;
    const osk = dev.os || "Other";
    byOs[osk] = (byOs[osk] || { watchSec: 0, plays: 0 });
    byOs[osk].watchSec += watched;
    byOs[osk].plays++;

    const t = byTitle[s.content] || (byTitle[s.content] = {
      watchSec: 0, plays: 0, viewers: new Set(), completions: [], lastPlayed: null,
    });
    t.watchSec += watched;
    t.plays++;
    t.viewers.add(s.profile || s.ip);
    if (s.duration > 0 && s.position != null) t.completions.push(Math.min(1, s.position / s.duration));
    if (!t.lastPlayed || s.startedAt > t.lastPlayed) t.lastPlayed = s.startedAt;

    const v = byViewer[s.ip] || (byViewer[s.ip] = {
      watchSec: 0, plays: 0, profiles: new Set(), devices: new Set(), lastSeen: null,
    });
    v.watchSec += watched;
    v.plays++;
    if (s.profile) v.profiles.add(s.profile);
    v.devices.add(dvk);
    if (!v.lastSeen || s.startedAt > v.lastSeen) v.lastSeen = s.startedAt;
  }

  // Fill every day in range so the bar chart has no gaps
  const daysOut = [];
  for (let i = days - 1; i >= 0; i--) {
    const dk = dayKey(new Date(Date.now() - i * 86400 * 1000).toISOString());
    daysOut.push({ day: dk, watchSec: byDay[dk]?.watchSec || 0, plays: byDay[dk]?.plays || 0 });
  }

  const setSize = (s) => (s instanceof Set ? s.size : 0);
  return {
    days,
    totals: {
      watchSec: inRange.reduce((n, s) => n + (s.watchedSec || 0), 0),
      plays: inRange.length,
      uniqueTitles: Object.keys(byTitle).length,
      uniqueViewers: Object.keys(byViewer).length,
    },
    byDay: daysOut,
    heatmap,
    byProfile: Object.entries(byProfile)
      .map(([name, p]) => ({ name, watchSec: p.watchSec, plays: p.plays, titles: setSize(p.titles), lastSeen: p.lastSeen }))
      .sort((a, b) => b.watchSec - a.watchSec),
    byDevice: Object.entries(byDevice)
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.watchSec - a.watchSec),
    byOs: Object.entries(byOs)
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.watchSec - a.watchSec),
    topTitles: Object.entries(byTitle)
      .map(([content, t]) => ({
        content,
        watchSec: t.watchSec,
        plays: t.plays,
        viewers: setSize(t.viewers),
        avgCompletion: t.completions.length
          ? t.completions.reduce((a, b) => a + b, 0) / t.completions.length
          : null,
        lastPlayed: t.lastPlayed,
      }))
      .sort((a, b) => b.watchSec - a.watchSec)
      .slice(0, 30),
    byViewer: Object.entries(byViewer)
      .map(([ip, v]) => ({
        ip,
        watchSec: v.watchSec,
        plays: v.plays,
        profiles: [...v.profiles],
        devices: [...v.devices],
        lastSeen: v.lastSeen,
      }))
      .sort((a, b) => b.watchSec - a.watchSec),
  };
};

// ---------- Aurora Wrapped: one profile's viewing, aggregated ----------
// Honesty note baked into the payload: the session store is a ring buffer of
// MAX_SESSIONS, so `since` is the oldest surviving session — the UI says
// "since <date>", never "this year".
// What the story draws (2026-11-10, all additive — older apps read none of it):
//   byWeekday  seconds per weekday, Sunday first (the week as seven columns)
//   byHour     seconds per hour the sittings STARTED in, 0–23 (the day as a dial)
//   nights     every day with any watching, oldest first, as [days after
//              nightsFrom, minutes] — the sky of stars (at most WRAP_NIGHTS,
//              the most recent)
//   streak     the best streak's span { from, to } (the latest one when two
//              are as long) — those stars are joined into a constellation
//   topTitles[].show  true when it was an episode of a show
const WRAP_NIGHTS = 400;
const wrappedFor = (profileName) => {
  const mine = sessions.data.filter((s) => s.profile === profileName && s.watchedSec > 0);
  if (!mine.length) return { empty: true };

  const dayKey = (iso) => new Date(iso).toLocaleDateString("sv"); // YYYY-MM-DD, local
  const byDay = new Map();
  const byTitle = new Map();
  const byWeekday = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  const shows = new Set();
  const byDevice = new Map();
  let totalSec = 0;
  let lateNightSessions = 0; // starting between midnight and 5am
  let latestFinishHour = null; // {hour, title}
  let longest = null;
  let oldest = mine[0].startedAt;
  let newest = mine[0].startedAt;

  for (const s of mine) {
    if (s.startedAt < oldest) oldest = s.startedAt;
    if (s.startedAt > newest) newest = s.startedAt;
    totalSec += s.watchedSec;
    byDay.set(dayKey(s.startedAt), (byDay.get(dayKey(s.startedAt)) || 0) + s.watchedSec);
    // shows log as "Title · S1 E2" — fold episodes into their show
    const title = String(s.content || "").replace(/\s*·\s*S\d+\s*E\d+.*$/i, "").trim() || "?";
    if (title !== String(s.content || "").trim()) shows.add(title);
    byTitle.set(title, (byTitle.get(title) || 0) + s.watchedSec);
    const started = new Date(s.startedAt);
    byWeekday[started.getDay()] += s.watchedSec;
    byHour[started.getHours()] += s.watchedSec;
    const dev = (s.device && s.device.device) || "?";
    byDevice.set(dev, (byDevice.get(dev) || 0) + s.watchedSec);
    if (started.getHours() < 5) lateNightSessions++;
    const finish = new Date(started.getTime() + s.watchedSec * 1000);
    const fh = finish.getHours();
    if (fh < 6 && (latestFinishHour == null || ((fh + 24) % 24) > latestFinishHour.hour)) {
      latestFinishHour = { hour: fh, title };
    }
    if (!longest || s.watchedSec > longest.watchedSec) {
      longest = { title, watchedSec: s.watchedSec, at: s.startedAt };
    }
  }

  // longest run of consecutive days with ANY watching
  const days = [...byDay.keys()].sort();
  // (the gap in whole days: a span over a clock change is 23 or 25 hours)
  const gapOf = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  let streak = 1;
  let bestStreak = days.length ? 1 : 0;
  let bestEnd = 0; // index of the best streak's last day (the latest of equals)
  for (let i = 1; i < days.length; i++) {
    streak = gapOf(days[i - 1], days[i]) === 1 ? streak + 1 : 1;
    if (streak >= bestStreak) { bestStreak = streak; bestEnd = i; }
  }
  const recent = days.slice(-WRAP_NIGHTS);
  const nightsFrom = recent[0];
  const nights = recent.map((d) => [gapOf(nightsFrom, d), Math.round(byDay.get(d) / 60)]);
  let biggestDay = null;
  for (const [day, sec] of byDay) if (!biggestDay || sec > biggestDay.sec) biggestDay = { day, sec };

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, sec]) => ({ name, sec }));
  const topTitles = top(byTitle, 5).map((t) => (shows.has(t.name) ? { ...t, show: true } : t));

  return {
    since: oldest,
    lastWatchedAt: newest, // the greeting's "long time no see" / "up late" cues
    totalSec,
    plays: mine.length,
    distinctTitles: byTitle.size,
    topTitles,
    titlesFull: top(byTitle, 500), // for route-side genre attribution; stripped from the response
    topWeekday: byWeekday.indexOf(Math.max(...byWeekday)),
    byDevice: top(byDevice, 3),
    biggestDay,
    bestStreak,
    lateNightSessions,
    latestFinish: latestFinishHour,
    longestSession: longest,
    activeDays: byDay.size,
    byWeekday,
    byHour,
    nightsFrom,
    nights,
    streak: days.length ? { from: days[bestEnd - bestStreak + 1], to: days[bestEnd] } : null,
  };
};

module.exports = {
  sessions,
  hourly,
  ring,
  start,
  onWatch,
  onStopWatching,
  closeSession,
  liveSessionOf,
  sweep,
  startSweep,
  addOfflinePlay,
  STALE_MS,
  PAUSE_CLOSE_MS,
  analytics,
  todayWatchSec,
  wrappedFor,
  SAMPLE_MS,
  LIVE_WRITE_MS,
  _internals: { isSeek, msToNextHour, clock, banks, acct, liveByClient, pausedOut, tidyReport },
};
