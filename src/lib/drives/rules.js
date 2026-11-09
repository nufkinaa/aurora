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
// ask: { kind, sizeBytes, preferFast }  preferFast: why this one belongs on the
//      fast drive (wantsFast), or null

// → { root, drive, why, full }  (root null only when there is no candidate at all)
//
// 1. Only drives that take new downloads and answer.
// 2. A show's new episode goes where the show already lives, when that drive
//    has room for it — seasons stay together.
// 2b. A download that belongs on the fast drive (`preferFast`: top-quality 4K,
//    what someone is about to watch, a person's request) goes there when it
//    has room above its reserve.
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
  if (ask.preferFast) {
    const fast = fastDrive(usable.map((c) => ({ id: c.drive || c.root, score: c.score, answering: c.answering })));
    const c = fast && usable.find((x) => (x.drive || x.root) === fast && hasRoom(x, size));
    if (c) return { root: c.root, drive: c.drive || null, why: `${ask.preferFast} — the fast drive`, full: false };
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

// ---------- the fast drive: new and 4K titles there, cold ones off it ----------
// elia 2026-11-09: "Keep the fast drive for new and 4K titles" (admin → On
// disk, on by default). docs/storage-drives.md "The fast drive".
//
// The fast drive: of the drives in use that answer, the one with the highest
// speed score, at least FAST_MARGIN above every other (a drive not tested
// yet counts as 50). Two drives about as fast: no fast drive, nothing changes.
const FAST_MARGIN = 10;
const fastDrive = (drives) => {
  const up = (drives || []).filter((d) => d && d.id && d.answering !== false);
  const ids = [...new Set(up.map((d) => d.id))];
  if (ids.length < 2) return null;
  const best = new Map();
  for (const d of up) best.set(d.id, Math.max(best.has(d.id) ? best.get(d.id) : -1, d.score == null ? 50 : d.score));
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const top = up.find((d) => d.id === ranked[0][0]);
  if (!top || top.score == null) return null;
  return ranked[0][1] >= ranked[1][1] + FAST_MARGIN ? ranked[0][0] : null;
};

// A new download that belongs on the fast drive:
//   - top-quality 4K: a 2160p remux, or a 2160p copy big enough to be above
//     about 25 Mbit/s (a film of ~2 h ≥ 20 GB, an episode of ~50 min ≥ 8 GB)
//   - what someone is about to watch: what is on a screen now or its next
//     episode (priority class NOW), or a person's own request (PERSON)
// HD copies and automatic or background downloads go where there is most room.
// `job`: { type, quality, release, label, sizeBytes }; `cls`: dlprio's class
// (0 NOW, 1 PERSON, 2 AUTO, 3 BACKGROUND), null when not known.
const UHD_FILM_BYTES = 20e9;
const UHD_EPISODE_BYTES = 8e9;
const isTopUhd = (job) => {
  if (!job) return false;
  const words = `${job.quality || ""} ${job.release || ""} ${job.label || ""}`;
  if (!/(2160p|\b4k\b|\buhd\b)/i.test(words)) return false;
  if (/remux/i.test(words)) return true;
  return (job.sizeBytes || 0) >= (job.type === "show" ? UHD_EPISODE_BYTES : UHD_FILM_BYTES);
};
const wantsFast = (job, cls = null) => {
  if (isTopUhd(job)) return { fast: true, why: "top-quality 4K" };
  if (cls === 0) return { fast: true, why: "someone is about to watch it" };
  if (cls === 1) return { fast: true, why: "asked for by a person" };
  return { fast: false, why: null };
};

// The fast drive running low: its room above the reserve under COLD_START_PCT
// of the drive starts moving cold titles off it, until it is back at
// COLD_UNTIL_PCT (`active`: a round of moving has started and goes on until then).
// → the bytes still to move (0: nothing to do)
const COLD_START_PCT = 15;
const COLD_UNTIL_PCT = 20;
const COLD_IDLE_DAYS = 60;
const roomPct = (d) => (d && d.total > 0 && d.free != null ? ((d.free - reserveFor(d.total)) / d.total) * 100 : null);
const coldNeed = (d, active = false) => {
  const p = roomPct(d);
  if (p == null) return 0;
  if (p >= (active ? COLD_UNTIL_PCT : COLD_START_PCT)) return 0;
  return Math.ceil(((COLD_UNTIL_PCT - p) / 100) * d.total);
};

// Which titles may move, oldest first. titles: [{ id, sizeBytes, lastPlayed,
// addedAt, playing, onList, midway, downloading, skipUntil }]
//   never: being played, on someone's My List, in someone's Continue watching,
//   downloading, or skipped for a while (it started playing during a move)
//   only: nobody has played it (or, never played, it came) idleDays ago or more
// → the titles to move, up to `needBytes` (all of them when needBytes is null)
const coldTitles = (titles, { now, idleDays = COLD_IDLE_DAYS, needBytes = null } = {}) => {
  const cut = now - idleDays * 86400e3;
  const last = (t) => Math.max(t.lastPlayed || 0, t.addedAt || 0);
  const ok = (titles || []).filter((t) => t && !t.playing && !t.onList && !t.midway && !t.downloading && !(t.skipUntil > now) && last(t) <= cut);
  ok.sort((a, b) => last(a) - last(b) || (b.sizeBytes || 0) - (a.sizeBytes || 0));
  if (needBytes == null) return ok;
  const out = [];
  let n = 0;
  for (const t of ok) { if (n >= needBytes) break; out.push(t); n += t.sizeBytes || 0; }
  return out;
};

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

module.exports = { reserveFor, score, networkScore, HD_MBPS, UHD_MBPS, NET_HEADROOM, fastDrive, wantsFast, isTopUhd, roomPct, coldNeed, coldTitles, FAST_MARGIN, COLD_START_PCT, COLD_UNTIL_PCT, COLD_IDLE_DAYS, pick, alertStep, freshAlert, DOWN_AFTER_MS, REPEAT_MS, STREAM_MBPS, RESERVE_MAX, RESERVE_PCT };
