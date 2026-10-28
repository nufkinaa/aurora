// The SERVER'S side of a start, for the start-up line (2026-10-28).
//
// A start-up mark (public/js/startline.js) says, step by step from the press,
// when the page saw each step — and where the browser lets it, what the server
// said it spent (Server-Timing, read off Resource Timing). An iPhone's own
// player (native HLS) fetches the film outside the page: nothing of its
// requests reaches Resource Timing, and its "byte" step is the element's
// first `progress` event. elia's report from an iPhone ("start-up 7.6 s,
// mostly first frame") therefore could not say which side was slow. So the
// server keeps, per device address and title, what IT did for the start —
// on its own clock, from the first playlist request:
//   pl     ms the first playlist took to answer (the segment table)
//   init   ms from that request until the fMP4 init went out
//   k      the first media segment asked for, and `segAt` ms from the first
//          playlist request until it went out, `seg` ms it waited on the
//          server, `made` whether it had to be made then (not on disk)
//   top    the first media segment asked for was segment 0 of a film that
//          began elsewhere (a resume): the native player's detour
//   n      media segments served since; `slow` how many waited 1 s or more
// plus the last few segments (`recent`: [k, wait ms, made, s ago]) — what a
// "Loading too long" mid-play report wants to know.
// Memory only, bounded; nothing about who beyond the address the stream
// itself came from (the same address the play marks are kept by).
"use strict";

const MAX = 200;
const NEW_START_MS = 15000; // a playlist this long after a trace began is a new start
const KEEP_MS = 3 * 3600 * 1000;
const RECENT = 12;
const SLOW_MS = 1000;
const traces = new Map(); // `${ip}|${id}` -> trace

const keyOf = (ip, id) => `${ip || "?"}|${id}`;
const prune = (now) => {
  for (const [k, t] of traces) if (now - t.last > KEEP_MS) traces.delete(k);
  while (traces.size > MAX) traces.delete(traces.keys().next().value);
};

// A playlist was answered (`ms`: how long it took; `start`: where the player
// said it begins — EXT-X-START, the start hint — when it said so).
const playlist = ({ ip, id, ms = 0, start = null, now = Date.now() }) => {
  if (!id) return null;
  const k = keyOf(ip, id);
  let t = traces.get(k);
  if (!t || now - t.at > NEW_START_MS) {
    t = { at: now, last: now, pl: Math.max(0, Math.round(ms)), start: null, init: null, first: null, n: 0, slow: 0, recent: [] };
    traces.delete(k);
    traces.set(k, t);
    prune(now);
  }
  if (Number.isFinite(start) && start > 0 && t.start == null) t.start = start;
  t.last = now;
  return t;
};

// The init went out.
const init = ({ ip, id, now = Date.now() }) => {
  const t = traces.get(keyOf(ip, id));
  if (!t) return null;
  if (t.init == null) t.init = now - t.at;
  t.last = now;
  return t;
};

// A media segment went out: `k`, how long it waited here, whether it was made then.
const segment = ({ ip, id, k, waitMs = 0, made = false, table = null, now = Date.now() }) => {
  const t = traces.get(keyOf(ip, id));
  if (!t) return null;
  const wait = Math.max(0, Math.round(waitMs));
  if (!t.first) {
    t.first = { k, segAt: now - t.at, seg: wait, made: !!made };
    // the top of a film that was to begin further in: the detour
    if (k === 0 && t.start > 30 && table && table.length > 1 && table[1].start <= t.start) t.first.top = true;
  }
  t.n++;
  if (wait >= SLOW_MS) t.slow++;
  t.recent.push([k, wait, made ? 1 : 0, now]);
  if (t.recent.length > RECENT) t.recent.shift();
  t.last = now;
  return t;
};

// What the server knows of this address's latest start of this title — or
// null. `maxAgeMs`: only a trace that began this recently (a start-up mark
// arrives seconds after the first frame; a report may come minutes later).
const of = (ip, id, { maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) => {
  const t = traces.get(keyOf(ip, id));
  if (!t || now - t.at > maxAgeMs) return null;
  const out = { pl: t.pl, n: t.n, slow: t.slow };
  if (t.init != null) out.init = t.init;
  if (t.first) Object.assign(out, { k: t.first.k, segAt: t.first.segAt, seg: t.first.seg, made: t.first.made, ...(t.first.top ? { top: true } : {}) });
  out.recent = t.recent.map(([k, w, m, at]) => [k, w, m, Math.round((now - at) / 1000)]);
  return out;
};

// The compact form a start-up mark's log line and record carry:
// "pl:3,init:120,seg0:410@380,made,n:4,slow:0" (seg<k>:<sent after the
// first playlist>@<waited here>).
const text = (s) => {
  if (!s) return "";
  const parts = [`pl:${s.pl}`];
  if (s.init != null) parts.push(`init:${s.init}`);
  if (s.k != null) parts.push(`seg${s.k}:${s.segAt}@${s.seg}`, s.made ? "made" : "ready");
  if (s.top) parts.push("top-first");
  parts.push(`n:${s.n}`, `slow:${s.slow}`);
  return parts.join(",");
};

const _reset = () => traces.clear();
module.exports = { playlist, init, segment, of, text, _reset, NEW_START_MS };
