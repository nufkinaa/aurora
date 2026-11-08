// The drives feature's decisions, all PURE (test/drives-rules.test.js):
//   reserveFor(total)        the room a drive keeps free
//   score(measured)          0–100 and a word, from the speed check
//   pick(candidates, ask)    which library folder a new download goes to
//   alertStep(state, obs)    when the admin is told a drive stopped answering
"use strict";

const GB = 1e9;
const MIN = 60 * 1000;

// A drive keeps 10% of itself free, or 50 GB, whichever is SMALLER (10% of a
// 4 TB disk is 400 GB — too much to leave idle; 50 GB of a 120 GB disk is
// almost half of it).
const RESERVE_PCT = 10;
const RESERVE_MAX = 50 * GB;
const reserveFor = (total) => Math.min(RESERVE_MAX, Math.max(0, (total || 0) * (RESERVE_PCT / 100)));

// ---------- the score ----------
// Each figure on a log scale between "too slow to stream from" and "as fast
// as anything in a house gets", weighted by what streaming needs most:
// reading a film from start to end, then landing new ones, then seeking.
//   sequential read   5 MB/s → 0,  1000 MB/s → 1     (45%)
//   sequential write  5 MB/s → 0,   500 MB/s → 1     (25%)
//   random 4K reads   50/s → 0,   20000/s → 1        (15%)
//   latency (median)  50 ms → 0,   0.1 ms → 1        (15%)
// One 4K film stream is about 12.5 MB/s (100 Mbit/s): `streams` says how many
// of those the drive reads at once, which is what a person can picture.
const STREAM_MBPS = 12.5;
const logPart = (v, lo, hi) => {
  if (!(v > 0)) return 0;
  const x = Math.log10(v / lo) / Math.log10(hi / lo);
  return Math.max(0, Math.min(1, x));
};
const score = (m) => {
  if (!m || !(m.readMBps > 0 || m.writeMBps > 0)) return null;
  const r = logPart(m.readMBps, 5, 1000);
  const w = logPart(m.writeMBps, 5, 500);
  const io = logPart(m.iops, 50, 20000);
  const lat = m.latencyMs > 0 ? logPart(1 / m.latencyMs, 1 / 50, 1 / 0.1) : 0;
  const value = Math.round(100 * (0.45 * r + 0.25 * w + 0.15 * io + 0.15 * lat));
  return {
    value,
    word: value >= 70 ? "Fast" : value >= 40 ? "Good" : "Slow",
    streams: m.readMBps > 0 ? Math.floor(m.readMBps / STREAM_MBPS) : 0,
  };
};

// ---------- where a new download goes ----------
// candidates: one per library folder of the kind wanted —
//   { root, drive, free, total, committed, score, accepts, answering, hasShow }
//   free/total    bytes (null when not measured)
//   committed     bytes already promised to downloads going to this drive
//   score         0–100 or null (not tested yet — counts as 50)
//   accepts       the drive is in use and not "stopped for new downloads"
//   answering     false when the drive stopped answering
//   hasShow       (shows) the show already has a folder there
// ask: { kind, sizeBytes }
// → { root, drive, why, full }  (root null only when there is no candidate at all)
//
// 1. Only drives that take new downloads and answer.
// 2. A show's new episode goes where the show already lives, when that drive
//    has room for it — seasons stay together.
// 3. Otherwise the drives with room (free − promised − this file ≥ reserve);
//    of those, the ones with about as much room as the roomiest (at least
//    75% of its free space) are equals, and the fastest of the equals wins
//    (then the roomiest). Free space first, so a big new drive fills up
//    instead of the full one; speed decides between drives that are alike.
// 4. No drive has room: the roomiest usable one, marked `full` — the disk
//    gate (media/downloads.js) then holds the download for the admin, as it
//    always did on a single drive.
const CLOSE_ENOUGH = 0.75;
const pick = (candidates, ask = {}) => {
  const size = Math.max(0, ask.sizeBytes || 0);
  const all = (candidates || []).filter((c) => c && c.root);
  if (!all.length) return { root: null, drive: null, why: "no library folder", full: false };
  const usable = all.filter((c) => c.accepts !== false && c.answering !== false);
  if (!usable.length) {
    // nothing takes new downloads: the first folder, as before this feature
    // existed (an admin who stops every drive still gets the old behaviour)
    const c = all.find((x) => x.answering !== false) || all[0];
    return { root: c.root, drive: c.drive || null, why: "no drive takes new downloads — the first library folder", full: false };
  }
  if (usable.length === 1) {
    const c = usable[0];
    return { root: c.root, drive: c.drive || null, why: "the only drive that takes new downloads", full: !hasRoom(c, size) };
  }
  if (ask.kind === "show") {
    const home = usable.find((c) => c.hasShow && hasRoom(c, size));
    if (home) return { root: home.root, drive: home.drive || null, why: "where the show already is", full: false };
  }
  const room = usable.filter((c) => hasRoom(c, size));
  if (!room.length) {
    const c = usable.slice().sort((a, b) => left(b) - left(a))[0];
    return { root: c.root, drive: c.drive || null, why: "no drive has room — the roomiest", full: true };
  }
  const best = Math.max(...room.map(left));
  const equals = room.filter((c) => left(c) >= best * CLOSE_ENOUGH);
  equals.sort((a, b) => scoreOf(b) - scoreOf(a) || left(b) - left(a));
  const c = equals[0];
  return { root: c.root, drive: c.drive || null, why: equals.length > 1 ? "room on several drives — the fastest of them" : "the drive with the most room", full: false };
};
const left = (c) => (c.free == null ? -Infinity : c.free - (c.committed || 0));
const hasRoom = (c, size) => c.free != null && left(c) - size >= reserveFor(c.total);
const scoreOf = (c) => (c.score == null ? 50 : c.score);

// ---------- telling the admin ----------
// state: { downSince, alertedAt, lastAlertAt, viewers }   obs: { down, now }
// → { state, send: null | { type: "down" | "back", minutes } }
// A drive that has not answered for DOWN_AFTER_MS is announced once. While it
// stays down nothing more is said. When it answers again after an announced
// outage: "answering again after N min". A drive that flaps is announced at
// most once per REPEAT_MS (a later outage inside that window is said when
// the window has passed, if it is still down then).
const DOWN_AFTER_MS = 60 * 1000;
const REPEAT_MS = 30 * MIN;
const freshAlert = () => ({ downSince: 0, alertedAt: 0, lastAlertAt: 0, viewers: [] });
const alertStep = (prev, obs) => {
  const s = { ...freshAlert(), ...(prev || {}) };
  const now = obs.now;
  if (obs.down) {
    if (!s.downSince) { s.downSince = now; s.alertedAt = 0; s.viewers = []; }
    if (!s.alertedAt && now - s.downSince >= DOWN_AFTER_MS && now - s.lastAlertAt >= REPEAT_MS) {
      s.alertedAt = now;
      s.lastAlertAt = now;
      return { state: s, send: { type: "down", minutes: Math.round((now - s.downSince) / MIN) } };
    }
    return { state: s, send: null };
  }
  if (!s.downSince) return { state: s, send: null };
  const told = !!s.alertedAt;
  const minutes = Math.max(1, Math.round((now - s.downSince) / MIN));
  const viewers = s.viewers.length;
  s.downSince = 0;
  s.alertedAt = 0;
  s.viewers = [];
  return { state: s, send: told ? { type: "back", minutes, viewers } : null };
};

module.exports = { reserveFor, score, pick, alertStep, freshAlert, DOWN_AFTER_MS, REPEAT_MS, STREAM_MBPS, RESERVE_MAX, RESERVE_PCT };
