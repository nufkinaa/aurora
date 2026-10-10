// "Downloads at once": how many downloads the queue may run side by side, and
// the one rule that overrides it. Pure — media/downloads.js does the I/O.
//
//   * The admin picks 1–6 (default 4) on the Downloads tab; it is stored in
//     lib/settings.js beside the speed caps and takes effect without a restart.
//   * HOLD WHILE PEOPLE WATCH: while anyone is watching, no more than
//     WATCH_HOLD downloads are STARTED. Running ones are never stopped — the
//     queue just waits, and pumps again when viewing stops.
//
//   * MY LIST DOWNLOADS COME LAST (the owner, 2026-10-10: "a list add
//     download should have lower priority than all other download types and
//     should be on hold if and when something else needs to be downloaded").
//     A download queued because a title was added to My List waits behind
//     every other kind, and one that is already running is put ON HOLD — its
//     bytes kept — the moment another download needs to run. plan() below is
//     that whole rule; media/downloads.js carries it out.
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

// ---------- who goes first, and who gives way ----------
//
// THE ORDER a waiting job is started in:
//   0  asked for by a person (Download / SAVE, "Try again"), or pushed to the
//      front by an admin ("Start now")
//   1  the other automatic kinds — the next episode (smartdl.js), a followed
//      show's new episode (follows.js)
//   2  My List downloads (mylistdl.js) — always last
// Inside a tier the queue's own order is kept (the newest request first, as
// it always was); among My List jobs one that was put on hold — it has bytes
// on disk already — goes before one that never started.
const TIER_PERSON = 0;
const TIER_AUTO = 1;
const TIER_MYLIST = 2;
// Does this job give way to the others? (An admin's "Start now" lifts it out.)
const yields = (job) => !!job && job.auto === "mylist" && !job.startNow;
const tierOf = (job) => (yields(job) ? TIER_MYLIST : job && job.smart && !job.startNow ? TIER_AUTO : TIER_PERSON);

// "On hold if and when something else needs to be downloaded" — the two
// readings, as the setting `myListYield` (data/settings.json):
//
//   "always"  (the default) A My List download runs only while NO other
//             download is waiting or running. Anything else in the queue —
//             moving or waiting its turn — and it is on hold: it never shares
//             the line with a download somebody asked for.
//   "slots"   It gives way only when the slots are contended: another
//             download is waiting and cannot start. While there is a free
//             slot for everything else, it runs beside them.
//
// In both, a My List job that is WAITING never takes a slot another waiting
// job could use.
const YIELD_MODES = ["always", "slots"];
const DEFAULT_YIELD = "always";
const yieldMode = (saved) => (YIELD_MODES.includes(saved) ? saved : DEFAULT_YIELD);

// After the others are done, this long with nothing else waiting or running
// before a My List download starts (or carries on): two episodes queued a few
// seconds apart must not stop and start it in between.
const RESUME_QUIET_MS = 60 * 1000;

// One look at the queue → what to do now. Pure.
//
//   cap, holding   from startCap()
//   mode           yieldMode()
//   running        [{ id, yields, locked, stalled, progress, startedAt }] — the jobs
//                  holding a slot. locked: it cannot be put on hold (its file
//                  is complete and being copied into the library). stalled: a
//                  download the healer restarted and that has not moved since
//                  — it holds its slot, but under "always" it is not
//                  "something that needs to be downloaded" (it would keep My
//                  List waiting for as long as a dead source stays dead).
//   waiting        [{ id, tier, yields, held, progress }] in the queue's order
//   quiet          has it been RESUME_QUIET_MS since the others last needed
//                  the queue? (false: My List jobs do not start this time)
//
// → { start: [id…], hold: [{ id, why: "downloads" | "watching" }…], blocked }
//   blocked: something else needs the queue right now (the quiet clock is
//   held at zero while this is true).
//
// The order things happen in: the others are started first; then, while one
// of them is still waiting, running My List jobs are put on hold one at a
// time (the one with the least of its file first) and each slot that frees
// goes to the next of the others; under "always" every running My List job is
// held while anything else is live; while people watch, My List jobs are held
// until no more than the viewing cap run — they are the only downloads the
// queue ever stops for viewers; and only when nothing else needs the queue
// does a My List job start.
const plan = ({ cap, holding = false, mode = DEFAULT_YIELD, running = [], waiting = [], quiet = true }) => {
  const start = [];
  const hold = [];
  let n = running.length;
  const others = waiting.filter((w) => !w.yields).map((w, i) => ({ w, i })).sort((a, b) => a.w.tier - b.w.tier || a.i - b.i).map((x) => x.w);
  const holdable = running.filter((r) => r.yields && !r.locked)
    .sort((a, b) => (a.progress || 0) - (b.progress || 0) || (b.startedAt || 0) - (a.startedAt || 0));
  let oi = 0;
  let hi = 0;
  while (oi < others.length && n < cap) { start.push(others[oi++].id); n++; }
  while (oi < others.length && hi < holdable.length) {
    hold.push({ id: holdable[hi++].id, why: "downloads" });
    n--;
    if (n < cap) { start.push(others[oi++].id); n++; }
  }
  const othersLive = others.length > 0 || running.some((r) => !r.yields && !r.stalled);
  if (yieldMode(mode) === "always" && othersLive) {
    while (hi < holdable.length) { hold.push({ id: holdable[hi++].id, why: "downloads" }); n--; }
  }
  if (holding) {
    while (n > cap && hi < holdable.length) { hold.push({ id: holdable[hi++].id, why: "watching" }); n--; }
  }
  const blocked = oi < others.length || (yieldMode(mode) === "always" && othersLive);
  if (!blocked && quiet && !hold.length) {
    const mine = waiting.filter((w) => w.yields).map((w, i) => ({ w, i }))
      .sort((a, b) => (b.w.held ? 1 : 0) - (a.w.held ? 1 : 0) || (a.w.held ? (b.w.progress || 0) - (a.w.progress || 0) : 0) || a.i - b.i);
    for (const { w } of mine) {
      if (n >= cap) break;
      start.push(w.id);
      n++;
    }
  }
  return { start, hold, blocked };
};

module.exports = {
  MIN_ACTIVE, MAX_ACTIVE, DEFAULT_ACTIVE, WATCH_HOLD,
  parseMaxActive, effectiveMaxActive, startCap, enginePlan,
  TIER_PERSON, TIER_AUTO, TIER_MYLIST, tierOf, yields,
  YIELD_MODES, DEFAULT_YIELD, yieldMode, RESUME_QUIET_MS, plan,
};
