// Watch party sync math — the TV's copy of public/js/partySync.js (keep the
// two in step; both are unit-tested against the same cases:
// test/party-sync.test.js and __tests__/logic/partySync.test.ts).
//
// A party's transport state is (playing, position, at) with `at` in SERVER
// time, so every member works out where the film is right now from the
// server's clock (see clockFrom). An `at` in the future is a start together:
// wait at `position` until the server's clock reaches it, then play.
//
// Calm by design (elia, 2026-10-27): "sync once on join, then send each
// action (stop / play / skip); fix alignment only when someone stops, or
// once every 20 minutes" — and the film's speed is never touched (a few
// percent faster or slower is heard with the sound on). So a member:
//   lands where the party is when it joins (landOver)
//   follows every play / pause / jump; a pause is the same frame
//   every 20 minutes looks once: more than alignOver apart -> one seek
//   far off (stuck, back from a dropped line): moved at once, at most
//   every farEveryMs
export const SYNC = {
  tickMs: 1000, // how often a member looks (it acts only as below)
  landOver: 0.3, // s: joining lands closer than this (direct file)
  landOverHeavy: 3, // s: … on a transcode / torrent (lands on a chunk)
  alignEveryMs: 1200000, // the quiet look: every 20 minutes
  alignOver: 1, // s: a bigger gap at the look is one seek
  alignOverHeavy: 3,
  farOver: 10, // s: further than this is moved at once…
  farOverHeavy: 15,
  farEveryMs: 30000, // …at most this often
  seekLead: 0.2, // s: a direct file lands a hair ahead (the seek itself takes a moment)
  stallTicks: 2, // looks without progress while it should play = buffering
  readyAhead: 2, // s buffered ahead before a waiting member says "ready"
  readyAheadHeavy: 4,
  readyWaitMs: 8000, // …or this long with something to play (a stream that buffers in big steps)
};

// Where the party's film is at server time `now` (ms).
export type SyncState = {playing?: boolean; position?: number; at?: number} | null | undefined;
export const targetOf = (st: SyncState, now: number): number =>
  (st && st.position ? st.position : 0) + (st && st.playing && st.at ? Math.max(0, now - st.at) / 1000 : 0);

// A start together: how long (ms) until the party's film starts moving.
export const startsIn = (st: SyncState, now: number): number => (st && st.playing && st.at ? Math.max(0, st.at - now) : 0);

// What to do about a gap (`drift` = mine − the party's, in seconds) at a
// look. `due`: the 20-minute look is now. -> { act: 'seek' | 'none' }
export type SyncAct = {act: 'seek' | 'none'};
export const decide = (
  drift: number,
  {heavy = false, sinceFixMs = Infinity, due = false}: {heavy?: boolean; sinceFixMs?: number; due?: boolean} = {},
): SyncAct => {
  const abs = Math.abs(drift);
  if (abs > (heavy ? SYNC.farOverHeavy : SYNC.farOver) && sinceFixMs >= SYNC.farEveryMs) return {act: 'seek'};
  if (due && abs > (heavy ? SYNC.alignOverHeavy : SYNC.alignOver)) return {act: 'seek'};
  return {act: 'none'};
};
// Joining (or back from a dropped line): land unless already this close.
export const landTolerance = (heavy = false): number => (heavy ? SYNC.landOverHeavy : SYNC.landOver);

// One ping: sent at t0, answered with the server's `now`, back at t1 (ms).
//   -> { rtt, offset } (offset = server clock − ours)
export type ClockSample = {rtt: number; offset: number};
export const clockFrom = (t0: number, t1: number, now: number): ClockSample => ({ rtt: t1 - t0, offset: now - (t0 + t1) / 2 });
// Of a few samples, the shortest round trip is the most honest.
export const bestClock = (samples: (ClockSample | null | undefined)[]): ClockSample | null =>
  (samples.filter(s => !!s && s.rtt >= 0) as ClockSample[]).reduce<ClockSample | null>((a, s) => (!a || s.rtt < a.rtt ? s : a), null);

// Seconds buffered ahead of `t` in a TimeRanges-like list of [start, end].
export const aheadOf = (ranges: [number, number][], t: number): number => {
  for (const [s, e] of ranges) if (t >= s - 0.25 && t <= e) return Math.max(0, e - t);
  return 0;
};

// A member that said "buffering" says "ready" when it has enough ahead.
export const readyToGo = ({readyState = 0, ahead = 0, heavy = false, ended = false, waitedMs = 0}: {readyState?: number; ahead?: number; heavy?: boolean; ended?: boolean; waitedMs?: number}): boolean =>
  ended ||
  (readyState >= 3 && ahead >= (heavy ? SYNC.readyAheadHeavy : SYNC.readyAhead)) ||
  (readyState >= 3 && waitedMs >= SYNC.readyWaitMs);

// "Waiting for Dana…", "Waiting for Dana and Kim…", "Waiting for 3 people…"
export const waitingWords = (names: (string | null | undefined)[] = []): string => {
  const n = names.filter(Boolean);
  if (!n.length) return "";
  if (n.length === 1) return `Waiting for ${n[0]}…`;
  if (n.length === 2) return `Waiting for ${n[0]} and ${n[1]}…`;
  return `Waiting for ${n.length} people…`;
};
