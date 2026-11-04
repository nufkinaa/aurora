// The admin's Activity, in one answer: GET /api/admin/activity
// (elia 2026-11-04: "make sure the activity tab in admin shows correct updated
// data that keeps updating without reloading the page"). docs/watch-time.md.
//
//   now       who is watching right now: title, episode, where they are,
//             playing or paused, on which screen, how long this sitting has
//             really played
//   screens   every connected screen, one row per screen (several tabs of one
//             browser for one person are one row, "2 tabs"), with what it is
//             doing: watching · paused · browsing · away · profile wall ·
//             quiet (said "watching", then nothing for 45 s)
//   counts    the numbers on top
//   today     real watch time since local midnight, per person and per title
//   week      the same for the last 7 days
//   recent    the latest viewings, newest first (a live one says so)
//
// build() is pure (test/activity.test.js); gather() reads the modules.
"use strict";

const DAY = 86400 * 1000;

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// "Only Murders in the Building S2E10" -> { title, episode: "S2 E10" }
const splitLabel = (content) => {
  const m = String(content || "").match(/^(.*?)\s*·?\s*S(\d+)\s*E(\d+)(.*)$/i);
  if (!m || !m[1]) return { title: String(content || ""), episode: null };
  return { title: m[1].trim(), episode: `S${+m[2]} E${+m[3]}${m[4] ? m[4] : ""}`.trim() };
};

const PRESENCE_RANK = { watching: 6, paused: 5, browsing: 4, wall: 3, away: 2, quiet: 1 };

// x: { now, clients: [publicClient + {session}], sessions: [...] newest first }
const build = (x = {}) => {
  const now = x.now || Date.now();
  const clients = x.clients || [];
  const sessions = x.sessions || [];

  const nowRows = [];
  for (const c of clients) {
    if (c.activity !== "Watching" || c.presence === "quiet") continue; // (quiet: not answering — not watching)
    const s = c.session || null;
    const { title, episode } = splitLabel(c.details);
    nowRows.push({
      key: c.id,
      clientId: c.id,
      profile: c.profile || null,
      content: c.details || null,
      title,
      episode,
      position: typeof c.position === "number" ? Math.round(c.position) : null,
      duration: typeof c.mediaDuration === "number" && c.mediaDuration > 0 ? Math.round(c.mediaDuration) : (s && s.duration) || null,
      // when the position was read, so the page can move it on while playing
      posAt: c.lastSeen ? Date.parse(c.lastSeen) : now,
      state: c.presence === "watching" ? "playing" : (s && s.state) || c.playState || "paused",
      rate: (s && s.rate) || 1,
      device: c.device || null,
      app: c.app || null,
      ip: c.ip,
      since: (s && s.startedAt) || c.connectedAt,
      sittingSec: s ? s.watchedSec || 0 : 0,
    });
  }
  nowRows.sort((a, b) => (a.state === "playing" ? 0 : 1) - (b.state === "playing" ? 0 : 1) || String(a.profile).localeCompare(String(b.profile)));

  // one row per screen: same person, same address, same kind of device
  const groups = new Map();
  for (const c of clients) {
    const d = c.device || {};
    const key = [c.profile || "", c.ip, d.device, d.browser, d.os].join("|");
    let g = groups.get(key);
    if (!g) {
      g = { key, ids: [], tabs: 0, profile: c.profile || null, device: d, ip: c.ip, app: c.app || null, presence: c.presence, doing: null, since: c.connectedAt, lastBeatAt: c.lastBeatAt || c.lastSeen };
      groups.set(key, g);
    }
    g.ids.push(c.id);
    g.tabs++;
    if ((PRESENCE_RANK[c.presence] || 0) > (PRESENCE_RANK[g.presence] || 0)) g.presence = c.presence;
    if (c.activity === "Watching" && c.details) g.doing = c.details;
    if (c.connectedAt < g.since) g.since = c.connectedAt;
    if ((c.lastBeatAt || "") > (g.lastBeatAt || "")) g.lastBeatAt = c.lastBeatAt;
  }
  const screens = [...groups.values()].sort((a, b) => (PRESENCE_RANK[b.presence] || 0) - (PRESENCE_RANK[a.presence] || 0) || String(a.profile || "~").localeCompare(String(b.profile || "~")) || String(a.since).localeCompare(String(b.since)));
  for (const g of screens) g.key = g.ids.slice().sort()[0]; // a stable key the page can keep a row by

  const counts = {
    watching: nowRows.filter((r) => r.state === "playing").length,
    paused: nowRows.filter((r) => r.state !== "playing").length,
    screens: screens.filter((g) => g.presence !== "away" && g.presence !== "quiet").length,
    away: screens.filter((g) => g.presence === "away" || g.presence === "quiet").length,
  };

  const roll = (fromMs) => {
    const people = new Map();
    const titles = new Map();
    let watchSec = 0;
    let plays = 0;
    for (const s of sessions) {
      const at = Date.parse(s.startedAt);
      if (!(at >= fromMs)) continue;
      const sec = s.watchedSec || 0;
      if (sec < 5 && !s.live) continue; // opened, never played
      watchSec += sec;
      plays++;
      const who = s.profile || "No profile";
      const p = people.get(who) || { name: who, watchSec: 0, plays: 0 };
      p.watchSec += sec; p.plays++;
      people.set(who, p);
      const t = titles.get(s.content) || { content: s.content, ...splitLabel(s.content), watchSec: 0, plays: 0, viewers: new Set() };
      t.watchSec += sec; t.plays++; t.viewers.add(who);
      titles.set(s.content, t);
    }
    return {
      watchSec: Math.round(watchSec),
      plays,
      people: [...people.values()].map((p) => ({ ...p, watchSec: Math.round(p.watchSec) })).sort((a, b) => b.watchSec - a.watchSec),
      titles: [...titles.values()].map((t) => ({ content: t.content, title: t.title, episode: t.episode, watchSec: Math.round(t.watchSec), plays: t.plays, viewers: [...t.viewers] }))
        .sort((a, b) => b.watchSec - a.watchSec).slice(0, 10),
    };
  };

  const recent = [];
  const newestFirst = sessions.slice(0, 400).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const s of newestFirst) {
    if (recent.length >= 12) break;
    if (!s.live && (s.watchedSec || 0) < 5) continue;
    const { title, episode } = splitLabel(s.content);
    recent.push({
      id: s.id, profile: s.profile || null, content: s.content, title, episode,
      startedAt: s.startedAt, endedAt: s.endedAt || null, watchedSec: s.watchedSec || 0,
      position: s.position != null ? s.position : null, duration: s.duration || null,
      device: s.device || null, live: !!s.live, state: s.state || null, offline: !!s.offline,
    });
  }

  return { at: now, now: nowRows, screens, counts, today: roll(startOfDay(now)), week: roll(now - 7 * DAY), recent };
};

const gather = () => {
  const realtime = require("../realtime");
  const telemetry = require("../telemetry");
  // (an admin page's own socket is not a screen anyone watches on)
  const clients = [...realtime.clients.values()].filter((c) => !(c.ws && c.ws.isAdmin)).map((c) => ({ ...realtime.publicClient(c), session: telemetry.liveSessionOf(c.id) }));
  return build({ now: Date.now(), clients, sessions: telemetry.sessions.data });
};

module.exports = { build, gather, splitLabel };
