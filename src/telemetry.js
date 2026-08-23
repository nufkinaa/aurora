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

const sessions = new JsonStore(path.join(config.DATA_DIR, "watch-sessions.json"), []);
const hourly = new JsonStore(path.join(config.DATA_DIR, "telemetry-hours.json"), {});

const MAX_SESSIONS = 8000;
const HOURLY_KEEP_DAYS = 90;
const SAMPLE_MS = 30 * 1000;
const RING_HOURS = 24;
const RING_MAX = Math.ceil((RING_HOURS * 3600 * 1000) / SAMPLE_MS);

// A server restart leaves live sessions dangling - close them at their last
// known update so durations stay honest.
for (const s of sessions.data) {
  if (s.live) {
    s.live = false;
    s.endedAt = s.updatedAt || s.startedAt;
  }
}
sessions.save();

// clientId -> live session object (also present in sessions.data)
const liveByClient = new Map();

const now = () => new Date().toISOString();
const secondsBetween = (a, b) =>
  Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));

// ---------- session lifecycle ----------

const closeSession = (clientId) => {
  const s = liveByClient.get(clientId);
  if (!s) return;
  liveByClient.delete(clientId);
  s.live = false;
  s.endedAt = now();
  s.watchedSec = secondsBetween(s.startedAt, s.endedAt);
  // Discard accidental blips (opened and closed within a few seconds)
  if (s.watchedSec < 5) {
    const i = sessions.data.indexOf(s);
    if (i !== -1) sessions.data.splice(i, 1);
  }
  sessions.save();
};

// Called on every "Watching" activity ping. Starts a session on first sight,
// rolls to a new one when the content changes, refreshes progress otherwise.
// Returns { session, started } so callers can react to new plays only.
const onWatch = (client, content, position, duration) => {
  let s = liveByClient.get(client.id);
  let started = false;
  if (s && s.content !== content) {
    closeSession(client.id);
    s = null;
  }
  if (!s) {
    started = true;
    s = {
      id: crypto.randomBytes(6).toString("hex"),
      clientId: client.id,
      profile: client.profile,
      ip: client.ip,
      device: client.device,
      content,
      startedAt: now(),
      updatedAt: now(),
      endedAt: null,
      watchedSec: 0,
      position: typeof position === "number" ? Math.round(position) : null,
      duration: typeof duration === "number" ? Math.round(duration) : null,
      live: true,
    };
    liveByClient.set(client.id, s);
    sessions.data.unshift(s);
    if (sessions.data.length > MAX_SESSIONS) sessions.data.length = MAX_SESSIONS;
  } else {
    s.updatedAt = now();
    s.watchedSec = secondsBetween(s.startedAt, s.updatedAt);
    if (!s.profile && client.profile) s.profile = client.profile;
    if (typeof position === "number") s.position = Math.round(position);
    if (typeof duration === "number") s.duration = Math.round(duration);
  }
  sessions.save();
  return { session: s, started };
};

// Called when a client's activity moves away from Watching, or it disconnects.
const onStopWatching = (clientId) => closeSession(clientId);

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

const start = (getGauges) => {
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
    hourly.save();
  };
  sample();
  sampleTimer = setInterval(sample, SAMPLE_MS);
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
const wrappedFor = (profileName) => {
  const mine = sessions.data.filter((s) => s.profile === profileName && s.watchedSec > 0);
  if (!mine.length) return { empty: true };

  const dayKey = (iso) => new Date(iso).toLocaleDateString("sv"); // YYYY-MM-DD, local
  const byDay = new Map();
  const byTitle = new Map();
  const byWeekday = Array(7).fill(0);
  const byDevice = new Map();
  let totalSec = 0;
  let lateNightSessions = 0; // starting between midnight and 5am
  let latestFinishHour = null; // {hour, title}
  let longest = null;
  let oldest = mine[0].startedAt;

  for (const s of mine) {
    if (s.startedAt < oldest) oldest = s.startedAt;
    totalSec += s.watchedSec;
    byDay.set(dayKey(s.startedAt), (byDay.get(dayKey(s.startedAt)) || 0) + s.watchedSec);
    // shows log as "Title · S1 E2" — fold episodes into their show
    const title = String(s.content || "").replace(/\s*·\s*S\d+\s*E\d+.*$/i, "").trim() || "?";
    byTitle.set(title, (byTitle.get(title) || 0) + s.watchedSec);
    const started = new Date(s.startedAt);
    byWeekday[started.getDay()] += s.watchedSec;
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
  let streak = 1;
  let bestStreak = days.length ? 1 : 0;
  for (let i = 1; i < days.length; i++) {
    const gap = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
    streak = gap === 1 ? streak + 1 : 1;
    if (streak > bestStreak) bestStreak = streak;
  }
  let biggestDay = null;
  for (const [day, sec] of byDay) if (!biggestDay || sec > biggestDay.sec) biggestDay = { day, sec };

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, sec]) => ({ name, sec }));

  return {
    since: oldest,
    totalSec,
    plays: mine.length,
    distinctTitles: byTitle.size,
    topTitles: top(byTitle, 5),
    titlesFull: top(byTitle, 500), // for route-side genre attribution; stripped from the response
    topWeekday: byWeekday.indexOf(Math.max(...byWeekday)),
    byDevice: top(byDevice, 3),
    biggestDay,
    bestStreak,
    lateNightSessions,
    latestFinish: latestFinishHour,
    longestSession: longest,
    activeDays: byDay.size,
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
  analytics,
  todayWatchSec,
  wrappedFor,
  SAMPLE_MS,
};
