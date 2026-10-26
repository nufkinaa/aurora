// "Downloads at once": how many downloads the queue may run side by side, and
// the one rule that overrides it. Pure — media/downloads.js does the I/O.
//
//   * The admin picks 1–6 (default 4) on the Downloads tab; it is stored in
//     lib/settings.js beside the speed caps and takes effect without a restart.
//   * HOLD WHILE PEOPLE WATCH: while anyone is watching, no more than
//     WATCH_HOLD downloads are STARTED. Running ones are never stopped — the
//     queue just waits, and pumps again when viewing stops.
//
//   * WHO GOES FIRST: a download a person asked for starts before the
//     automatic kinds (the next episode, a followed show's new episode), and
//     no account runs more than PER_OWNER at once. plan() below is that rule.
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

// ---------- who goes first ----------
//
// THE ORDER a waiting job is started in:
//   0  asked for by a person (Download / SAVE, "Try again")
//   1  the automatic kinds — the next episode (smartdl.js), a followed show's
//      new episode (follows.js)
// Inside a tier the queue's own order is kept (the newest request first, as
// it always was). (Until 2026-10-26 a third tier, My List downloads, came last
// and was put on hold for the others; that feature is gone — elia: "it's not
// used well at all".)
const TIER_PERSON = 0;
const TIER_AUTO = 1;
const tierOf = (job) => (job && job.smart ? TIER_AUTO : TIER_PERSON);

// AT MOST `perOwner` running downloads per account (elia 2026-10-18: "3
// concurrent downloads from the same account at the same time, so one user
// can't download 30 movies at the same time"). Every kind counts — a person's
// own request and smart downloads. A job over the limit simply waits its turn
// (it is never refused); the free slot goes to the next job that fits. A job
// without an owner (`owner` null — one no profile asked for) is not counted
// against anyone. perOwner 0 = no limit.
//
// One look at the queue → what to start now. Pure.
//   cap        from startCap()
//   running    [{ id, owner }] — the jobs holding a slot
//   waiting    [{ id, tier, owner }] in the queue's order
// → { start: [id…], overLimit: [id…] }
//   overLimit: waiting only because their account is at its limit.
const PER_OWNER = 3;
const plan = ({ cap, running = [], waiting = [], perOwner = PER_OWNER }) => {
  const start = [];
  let n = running.length;
  const owned = new Map();
  const own = (o) => { if (o) owned.set(o, (owned.get(o) || 0) + 1); };
  for (const r of running) own(r.owner);
  const fits = (w) => !w.owner || !(perOwner > 0) || (owned.get(w.owner) || 0) < perOwner;
  const queue = waiting.map((w, i) => ({ w, i })).sort((a, b) => (a.w.tier || 0) - (b.w.tier || 0) || a.i - b.i).map((x) => x.w);
  for (const w of queue) {
    if (n >= cap) break;
    if (!fits(w)) continue;
    start.push(w.id);
    n++;
    own(w.owner);
  }
  const overLimit = waiting.filter((w) => !start.includes(w.id) && !fits(w)).map((w) => w.id);
  return { start, overLimit };
};

module.exports = {
  MIN_ACTIVE, MAX_ACTIVE, DEFAULT_ACTIVE, WATCH_HOLD,
  parseMaxActive, effectiveMaxActive, startCap, enginePlan,
  TIER_PERSON, TIER_AUTO, tierOf, plan, PER_OWNER,
};
