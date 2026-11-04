// Real watch time (2026-11-04, elia: "71 hours for one 40 min episode only 1
// person has seen"). docs/watch-time.md has the research and the whole story.
//
// What used to happen: every player reports "Watching <title>" every 5 s,
// PAUSED OR NOT, and a session's watch time was the wall clock from its first
// report to its last. A TV left paused on an episode for three days, a phone
// sitting on the end screen all night, a laptop tab with a paused film — each
// counted as watching, for as long as the screen stayed connected.
//
// What counts now — ONE rule, for every client, old and new: a report credits
// the time that media actually PLAYED since the report before it, and never
// more than the wall clock let pass.
//
//   new clients (web 1.15.11+, TV 5.8.4+, phone 1.0.4+) say it: `played`, the
//     seconds their own player advanced at normal play since their last report
//     (watchClock: only while playing — not paused, not buffering, not
//     seeking — and divided by the speed, so 2x for 10 min is 10 min of
//     someone's time, not 20)
//   old clients (TV 5.8.3, phone 1.0.3, a web tab opened before the update)
//     do not: their position is read instead. A position that moved forward
//     by about what the clock allows is play; standing still is a pause or the
//     end screen; going back or jumping ahead is a seek, and counts nothing.
//
// Whatever a report claims is then bounded by THE BANK: wall time accrues in
// it as the server's own clock runs (never the device's — clock skew does not
// matter), at most BANK_MAX_SEC of it, and every credit is taken out of it.
//   - a gap (a laptop asleep, a TV switched off, Wi-Fi gone for an hour) puts
//     at most BANK_MAX_SEC in the bank, and only media that really moved can
//     take it — the hour itself never counts
//   - reports that arrive bunched up (a socket that froze for 20 s and then
//     delivered six at once) still credit what was played, out of the bank
//   - the bank belongs to the PERSON AND TITLE, not to the socket: two tabs,
//     or a TV and a phone, playing the same episode for the same profile at
//     the same time share one bank, so the hour counts once
// and by BEAT_MAX_SEC per report, and per session by the media's duration
// (twice it, plus five minutes — rewatching a scene is real, three days is not).
//
// Pure: the caller passes the clock (tests use a fake one).
"use strict";

const BANK_MAX_SEC = 60; // wall time a person+title can have in hand (12 reports; a hidden tab Chrome holds to one timer a minute still counts)
const BEAT_MAX_SEC = 60; // the most one report can credit
const SLACK_SEC = 2; // timers and transport jitter
const MAX_RATE = 2.5; // old clients: a position ahead by more than this x the wall time is a seek
const SESSION_DUR_FACTOR = 2; // a session's credit ≤ duration × this + SESSION_DUR_EXTRA_SEC
const SESSION_DUR_EXTRA_SEC = 300;

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

// The bank of one person+title.
const newBank = (nowMs) => ({ at: nowMs, sec: 0 });
const accrue = (bank, nowMs) => {
  const wall = Math.max(0, (nowMs - bank.at) / 1000);
  bank.sec = Math.min(BANK_MAX_SEC, bank.sec + wall);
  bank.at = Math.max(bank.at, nowMs);
};

// What one report claims was played, before the bank. `st` is the session's
// own last look ({lastAt, lastPos}); `r` the report. Returns
// { claim, state, seek }. state: playing | paused | buffering | ended | null.
const claimOf = (st, r, nowMs) => {
  const pos = num(r.position);
  const dur = num(r.duration);
  const said = typeof r.state === "string" ? r.state : null;
  if (num(r.played) != null) {
    // a new client: its own measure, never negative
    const claim = Math.max(0, r.played);
    const state = said || (claim > 0 ? "playing" : "paused");
    return { claim, state, seek: false };
  }
  // an old client: the position, read against the wall clock
  if (pos == null || st.lastPos == null || st.lastAt == null) return { claim: 0, state: said, seek: false };
  const wall = Math.max(0, (nowMs - st.lastAt) / 1000);
  const moved = pos - st.lastPos;
  if (moved <= 0.5) {
    const ended = dur > 0 && pos >= dur - 2;
    return { claim: 0, state: moved < -SLACK_SEC ? "playing" : ended ? "ended" : "paused", seek: moved < -SLACK_SEC };
  }
  if (moved > wall * MAX_RATE + SLACK_SEC) return { claim: 0, state: "playing", seek: true };
  return { claim: moved, state: "playing", seek: false };
};

// One report. `st`: the session's accounting ({lastAt, lastPos, credited,
// duration}); `bank`: the person+title's bank. Mutates both; returns
// { credit, state, seek }.
const credit = (st, bank, r, nowMs) => {
  accrue(bank, nowMs);
  const { claim, state, seek } = claimOf(st, r, nowMs);
  let c = Math.min(claim, bank.sec, BEAT_MAX_SEC);
  const dur = num(r.duration) || st.duration || null;
  if (dur > 0) c = Math.min(c, Math.max(0, dur * SESSION_DUR_FACTOR + SESSION_DUR_EXTRA_SEC - (st.credited || 0)));
  c = Math.max(0, c);
  bank.sec -= c;
  st.credited = (st.credited || 0) + c;
  st.lastAt = nowMs;
  if (num(r.position) != null) st.lastPos = r.position;
  if (dur > 0) st.duration = dur;
  return { credit: c, state, seek };
};

// The cap a STORED session's watch time is held to by the one-off repair
// (scripts/fix-watch-time.js): the old accounting recorded wall time, so a
// session is held to what it could have played — its wall span, and the
// media's length (+10 %) when that is known, else FIX_NO_DUR_SEC.
const FIX_SESSION_FACTOR = 1.1;
const FIX_NO_DUR_SEC = 3 * 3600;
// and a person+title+day to 1.5 x the media's length (the same episode
// reopened again and again in one day, paused each time)
const FIX_DAY_FACTOR = 1.5;

module.exports = {
  credit,
  claimOf,
  newBank,
  accrue,
  BANK_MAX_SEC,
  BEAT_MAX_SEC,
  SLACK_SEC,
  MAX_RATE,
  SESSION_DUR_FACTOR,
  SESSION_DUR_EXTRA_SEC,
  FIX_SESSION_FACTOR,
  FIX_NO_DUR_SEC,
  FIX_DAY_FACTOR,
};
