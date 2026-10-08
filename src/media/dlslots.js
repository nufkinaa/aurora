// "Downloads at once": how many downloads the queue may run side by side, and
// the one rule that overrides it. Pure — media/downloads.js does the I/O.
//
//   * The admin picks 1–6 (default 4) on the Downloads tab; it is stored in
//     lib/settings.js beside the speed caps and takes effect without a restart.
//   * HOLD WHILE PEOPLE WATCH: while anyone is watching, no more than
//     WATCH_HOLD downloads are STARTED. Running ones are never stopped — the
//     queue just waits, and pumps again when viewing stops.
//
// The engine has to be told too: aria2's own concurrency limit must leave room
// for the setting plus a second-source race (media/dlrace.js) plus the short
// "[METADATA]" downloads a magnet starts with, and the peers allowed per
// torrent shrink as more torrents run so the total stays sane.
const MIN_ACTIVE = 1;
const MAX_ACTIVE = 6;
const DEFAULT_ACTIVE = 4;
const WATCH_HOLD = 2;

// Connections the whole queue may hold open, split across the torrents that
// can run at once: 100 per torrent up to three, 90 at four, 72 at five, 60 at
// six. (It was a flat 100 when two ran at once.)
const PEER_BUDGET = 360;
const PEERS_MAX = 100;
const PEERS_MIN = 55;
// aria2 counts a magnet's metadata fetch as a download of its own for a few
// seconds; without headroom a fresh add would sit "waiting" behind real ones.
const METADATA_HEADROOM = 2;

// What an admin typed → a whole number in range, or null (refused).
const parseMaxActive = (v) => {
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) v = Number(v);
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v >= MIN_ACTIVE && v <= MAX_ACTIVE ? v : null;
};

// What is stored → what is used. Anything unreadable is the default: a
// settings file from before this existed has no such key.
const effectiveMaxActive = (saved) => parseMaxActive(saved) ?? DEFAULT_ACTIVE;

// How many downloads may be running after the next start.
//   cap      the number pump() compares against
//   holding  true when viewing (not the setting) is what limits it
const startCap = ({ maxActive, watching }) => {
  const max = effectiveMaxActive(maxActive);
  if (watching > 0 && max > WATCH_HOLD) return { cap: WATCH_HOLD, holding: true };
  return { cap: max, holding: false };
};

// What aria2 is told for a given setting.
const enginePlan = (maxActive, maxRaces = 1) => {
  const max = effectiveMaxActive(maxActive);
  const races = Math.max(0, Math.min(4, Math.floor(Number(maxRaces) || 0)));
  return {
    maxConcurrent: max + races + METADATA_HEADROOM,
    btMaxPeers: Math.max(PEERS_MIN, Math.min(PEERS_MAX, Math.floor(PEER_BUDGET / max))),
  };
};

module.exports = {
  MIN_ACTIVE, MAX_ACTIVE, DEFAULT_ACTIVE, WATCH_HOLD,
  parseMaxActive, effectiveMaxActive, startCap, enginePlan,
};
