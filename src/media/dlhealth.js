// Is a running download ALIVE? Every rule that tells "slow but alive" from
// "stalled" from "dead", as pure functions over plain numbers. The queue
// (media/downloads.js) feeds it one attempt at a time and acts on the answer;
// nothing here knows about aria2, files or the wall clock (`t` is passed in,
// and the queue passes a MONOTONIC clock, so a clock jump on the server never
// makes every download look stuck at once).
//
// elia, 2026-11-03: "a lot of them get stuck at 0 data per second and stay
// there for a long time making other downloads not arrive because they are in
// queue". Before this, a stuck download held its "Downloads at once" slot
// until the healer restarted it after 12–15 minutes — with the SAME source,
// back into the same slot, again and again, for ever.
//
// THE STATES (one per attempt, recomputed on every look):
//
//   starting   still inside its grace: details being fetched, peers being found
//   ok         bytes are arriving at a useful rate
//   slow       alive — bytes keep arriving — but under SLOW_BPS for a while.
//              It keeps downloading. It stops counting against "Downloads at
//              once" ONLY when the line itself has room (if every download is
//              slow because the line or the admin's cap is full, starting
//              more would make each one slower still).
//   stalled    nothing is arriving: no details, nobody to connect to, or no
//              new bytes for a few minutes. It never holds a slot (the way
//              qBittorrent's "do not count slow torrents" and Transmission's
//              "stalled" work) but stays in the engine, still looking, so if
//              a seeder comes back it simply carries on.
//   dead       stalled for long enough that waiting is pointless: the queue
//              moves the job to the next-best copy (media/dlfallback.js).
//
// A stalled attempt only counts as healthy again once it has really moved
// (RECOVER_BYTES new bytes, or a burst of speed) — one stray piece from a
// peer passing by must not flip it back and forth (hysteresis).
//
// What the numbers are based on (docs/downloads-v2.md has the research):
//   * a healthy public swarm hands over a magnet's details in seconds and the
//     first bytes within a minute; aria2 measured on this server's rig:
//     details < 2 s, first byte < 3 s with one live seeder;
//   * Decluttarr / Sonarr users settle on "no metadata after ~10–30 min" and
//     "stalled for 3 strikes of 10 min" before replacing a torrent — far too
//     slow for a person waiting for an episode, so the PARKING happens in
//     minutes (it costs nothing: the download keeps looking) and only the
//     SWITCH to another copy waits the longer "dead" time.
"use strict";

const KIB = 1024;
const MIB = 1024 * 1024;
const MIN = 60 * 1000;

const DEFAULTS = {
  // ---- no torrent details (magnet metadata) ----
  metaStallMs: 3 * MIN,     // parked: stops holding a slot
  metaDeadMs: 10 * MIN,     // switched to another copy
  // ---- details in, but nobody at all to connect to ----
  peersStallMs: 3 * MIN,    // measured from the details' arrival
  peersDeadMs: 8 * MIN,
  // ---- connected, but no new bytes ----
  bytesStallMs: 4 * MIN,    // no new byte for this long (from the last byte, or from the first connection)
  bytesDeadMs: 12 * MIN,    // …and still nothing: no seeder connected
  zombieDeadMs: 20 * MIN,   // …a "seeder" IS connected but sends nothing (it can come back to life, so it gets longer)
  // ---- the people connected do not have the pieces we still need ----
  unavailDeadMs: 6 * MIN,   // no complete copy among them (aria2.getPeers bitfields) for this long while nothing arrives
  // ---- slow but alive ----
  slowBps: 48 * KIB,        // under this (smoothed) is "slow" — a 1 GB episode at 48 KiB/s takes 6 h
  slowMs: 5 * MIN,          // …for this long, after the grace below
  slowGraceMs: 3 * MIN,     // nothing is called slow in its first minutes
  // ---- recovering ----
  recoverBytes: 2 * MIB,    // a stalled attempt is healthy again after this many new bytes…
  recoverBps: 96 * KIB,     // …or at this speed (smoothed)
};

// config.json "downloadHealth": { "metaDeadMs": 600000, … } overrides one
// number; anything that is not a non-negative number is ignored.
const resolveConfig = (raw) => {
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULTS)) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) cfg[k] = v;
    }
  }
  return cfg;
};

const fmtMin = (ms) => {
  const m = Math.round(ms / MIN);
  if (m < 1) return "under a minute";
  if (m < 90) return `${m} min`;
  return `${(ms / 3600e3).toFixed(1)} h`;
};

// One attempt as plain data (media/downloads.js newAttempt):
//   startedAt   when the engine was asked for it
//   metaAt      when its details (the file list) arrived — 0: not yet
//   connectedAt first moment anyone was connected or a byte arrived — 0: never
//   lastProgressAt  the last time its file's bytes grew (or the first sample)
//   completed   bytes of the wanted file on disk
//   speed       the smoothed download speed (bytes/s) credited to this file
//   seeders, connections   what the engine says right now
//   avail       share of the still-missing pieces that someone connected has
//               (null: not measured)   availLowSince: since when avail < 1
//   hs          this function's memory: { state, since, stallBytes, slowSince }
// Returns { state, code, why, since, holdsSlot } and updates att.hs.
//
// `env.lineFree`: the line and the admin's cap have room (a slow attempt may
// stop counting). Default true.
const assess = (att, t, cfg = DEFAULTS, env = {}) => {
  const hs = att.hs || (att.hs = { state: "starting", since: t, stallBytes: 0, slowSince: 0 });
  const verdict = judge(att, t, cfg, env, hs);
  if (verdict.state !== hs.state) {
    // entering a stalled/dead stretch: remember how much was there, for the
    // hysteresis on the way out
    if ((verdict.state === "stalled" || verdict.state === "dead") && hs.state !== "stalled" && hs.state !== "dead") hs.stallBytes = att.completed || 0;
    hs.state = verdict.state;
    hs.since = t;
  }
  return { ...verdict, since: hs.since, holdsSlot: holdsSlot(verdict.state, env) };
};

const holdsSlot = (state, env) => {
  if (state === "stalled" || state === "dead") return false;
  if (state === "slow") return env.lineFree === false; // a slow one holds its slot only while the line is full
  return true;
};

const judge = (att, t, cfg, env, hs) => {
  const age = t - (att.startedAt || t);
  // 1. no details yet
  if (!att.metaAt) {
    if (age >= cfg.metaDeadMs) return { state: "dead", code: "no-meta", why: `no one has sent the torrent's details in ${fmtMin(age)}` };
    if (age >= cfg.metaStallMs) return { state: "stalled", code: "no-meta", why: `no one has sent the torrent's details yet (${fmtMin(age)})` };
    return { state: "starting", code: "finding", why: null };
  }
  const moved = (att.completed || 0) > 0;
  // 2. details in, never connected to anyone
  if (!att.connectedAt && !moved) {
    const since = t - att.metaAt;
    if (since >= cfg.peersDeadMs) return { state: "dead", code: "no-peers", why: `no one is sharing it — no one to connect to in ${fmtMin(since)}` };
    if (since >= cfg.peersStallMs) return { state: "stalled", code: "no-peers", why: "no one is sharing it right now" };
    return { state: "starting", code: "finding", why: null };
  }
  // 3. connected: are bytes arriving?
  const from = Math.max(att.lastProgressAt || 0, att.connectedAt || 0, att.metaAt || 0);
  const quiet = t - from;
  const wasDown = hs.state === "stalled" || hs.state === "dead";
  const regained = (att.completed || 0) - (hs.stallBytes || 0) >= cfg.recoverBytes || (att.speed || 0) >= cfg.recoverBps;
  const seeded = (att.seeders || 0) > 0;
  const anyone = seeded || (att.connections || 0) > 0;
  const unavailable = att.avail != null && att.avail < 1 && !seeded && att.availLowSince && t - att.availLowSince >= cfg.unavailDeadMs;
  if (quiet >= cfg.bytesStallMs || (wasDown && !regained)) {
    if (unavailable) return { state: "dead", code: "unavailable", why: "the people sharing it don't have the whole file" };
    if (!anyone && quiet >= cfg.peersDeadMs && !moved) return { state: "dead", code: "no-peers", why: `no one is sharing it — no one to connect to in ${fmtMin(quiet)}` };
    if (!seeded && quiet >= cfg.bytesDeadMs) return { state: "dead", code: "no-bytes", why: `nothing has arrived for ${fmtMin(quiet)} and no one with the whole file is connected` };
    if (seeded && quiet >= cfg.zombieDeadMs) return { state: "dead", code: "zombie", why: `connected to ${att.seeders} with the whole file, but nothing has arrived for ${fmtMin(quiet)}` };
    if (quiet >= cfg.bytesStallMs) return { state: "stalled", code: anyone ? "no-bytes" : "no-peers", why: anyone ? `nothing has arrived for ${fmtMin(quiet)}` : "no one is sharing it right now" };
    // quiet for less than the stall time but not recovered yet: stays down
    return { state: hs.state, code: "recovering", why: "picking up again" };
  }
  // 4. alive. Slow?
  if (age < cfg.slowGraceMs || !(att.speed >= 0)) { hs.slowSince = 0; return { state: hs.state === "starting" && !moved ? "starting" : "ok", code: "ok", why: null }; }
  if ((att.speed || 0) < cfg.slowBps) {
    if (!hs.slowSince) hs.slowSince = t;
    if (t - hs.slowSince >= cfg.slowMs) return { state: "slow", code: "slow", why: `slow — about ${Math.max(1, Math.round((att.speed || 0) / KIB))} KB/s` };
  } else {
    hs.slowSince = 0;
  }
  return { state: "ok", code: "ok", why: null };
};

// ---------- availability (is there a complete copy among the connected?) ----------
// aria2 says, per peer, which pieces it has (a hex bitfield, the high bit of
// the first byte is piece 0), and which we have. The wanted file covers a
// range of pieces; what matters is whether every piece of it that we still
// lack is held by at least one peer we are connected to. → a share 0..1, or
// null when it cannot be worked out.
const hasPiece = (hex, i) => {
  const nib = parseInt(hex[i >> 2], 16);
  if (!Number.isFinite(nib)) return false;
  return ((nib >> (3 - (i & 3))) & 1) === 1;
};
const pieceRange = (files, fileIndex, pieceLength) => {
  if (!(pieceLength > 0) || !Array.isArray(files)) return null;
  let off = 0;
  for (const f of files) {
    const len = Number(f.length) || 0;
    if (Number(f.index) === Number(fileIndex)) {
      if (!(len > 0)) return null;
      return { first: Math.floor(off / pieceLength), last: Math.floor((off + len - 1) / pieceLength) };
    }
    off += len;
  }
  return null;
};
const availability = ({ files, fileIndex, pieceLength, numPieces, bitfield, peers }) => {
  const r = pieceRange(files, fileIndex, Number(pieceLength));
  if (!r || typeof bitfield !== "string") return null;
  const last = Math.min(r.last, (Number(numPieces) || r.last + 1) - 1);
  const list = Array.isArray(peers) ? peers : [];
  if (list.some((p) => p && (p.seeder === true || p.seeder === "true"))) return 1;
  let missing = 0;
  let held = 0;
  for (let i = r.first; i <= last; i++) {
    if (hasPiece(bitfield, i)) continue;
    missing++;
    if (list.some((p) => p && typeof p.bitfield === "string" && hasPiece(p.bitfield, i))) held++;
  }
  if (!missing) return 1;
  return held / missing;
};

module.exports = { DEFAULTS, resolveConfig, assess, holdsSlot, availability, fmtMin, _internals: { hasPiece, pieceRange, judge } };
