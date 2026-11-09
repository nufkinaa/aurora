// The drives feature's decisions, all PURE (test/drives-rules.test.js):
//   reserveFor(total)        the room a drive keeps free
//   score(measured, {network}) 0–100 and a word, from the speed check (a
//                            network drive: by the films it serves at once)
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
const score = (m, { network = false } = {}) => {
  if (network) return networkScore(m);
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

// ---------- the score of a NETWORK drive ----------
// A network drive is never as fast as an NVMe, and need not be: what matters
// is whether the house can watch from it. So its score says how many films
// it serves at once.
//   - the figure: several readers at once (the speed check's 4 together,
//     each with the system's read-ahead — how viewers really read), else one
//     buffered reader, else one direct reader, else the write speed
//   - 30% of it is kept back for seeking, a download landing, the scanner
//   - a 1080p web copy is about 1.5 MB/s, a 4K remux up to about 10 MB/s
// Words (what it is good for, not how it compares with a local disk):
//   Fast            10 or more 4K streams at once
//   Good            3 or more 4K streams at once
//   Fine for 1080p  3 or more 1080p streams, fewer than 3 4K
//   Too slow        fewer than 3 1080p streams
// The number: the usable MB/s on a log scale, 1.5 MB/s → 0, 150 MB/s → 100
// (Good starts near 65, Fast near 91).
const HD_MBPS = 1.5;
const UHD_MBPS = 10;
const NET_HEADROOM = 0.7;
const networkScore = (m) => {
  if (!m) return null;
  const pick = [["parallelMBps", "readers at once"], ["bufferedMBps", "one reader"], ["directMBps", "one direct reader"], ["readMBps", "one reader"], ["writeMBps", "the write speed (no read was measured)"]]
    .find(([k]) => m[k] > 0);
  if (!pick) return null;
  const basisMBps = m[pick[0]];
  const usable = basisMBps * NET_HEADROOM;
  const hd = Math.floor(usable / HD_MBPS);
  const uhd = Math.floor(usable / UHD_MBPS);
  const value = Math.round(100 * logPart(usable, HD_MBPS, 150));
  const word = uhd >= 10 ? "Fast" : uhd >= 3 ? "Good" : hd >= 3 ? "Fine for 1080p" : "Too slow";
  const plural = (n, one) => `${n} ${one} stream${n === 1 ? "" : "s"}`;
  const meaning = word === "Too slow"
    ? `Too slow to watch from — ${hd ? `about ${plural(hd, "1080p")}` : "not even one 1080p stream"} at once.`
    : `About ${plural(hd, "1080p")} and ${plural(uhd, "4K")} at once${word === "Fine for 1080p" ? " — fine for 1080p, tight for 4K" : " — good enough to watch from"}.`;
  return {
    value,
    word,
    scale: "network",
    streams: uhd, // (4K, as on a local drive's card)
    streams1080: hd,
    streams4k: uhd,
    basis: pick[1],
    basisMBps,
    meaning,
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

module.exports = { reserveFor, score, networkScore, HD_MBPS, UHD_MBPS, NET_HEADROOM, pick, alertStep, freshAlert, DOWN_AFTER_MS, REPEAT_MS, STREAM_MBPS, RESERVE_MAX, RESERVE_PCT };
