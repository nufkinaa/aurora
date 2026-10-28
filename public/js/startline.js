// A play's start-up, step by step, from the press on Play to the first frame
// — so "it took a minute and a half" comes with the step that took it (the
// play-mark "start-up", the admin's App health → Slow starts, and Report a
// problem). Pure: the player hands in what it noted, this turns it into one
// small record. The same steps and names on the TV (tv-native/src/startline.ts).
//
// STEPS, each a moment in ms after the press (missing ones are skipped):
//   open     the player's code began (the screen was changed, its module loaded)
//   item     what is being played is known (/api/item, or handed over)
//   history  the profile's progress is read (where to resume)
//   probe    a torrent's real codecs are known (or the wait for them gave up)
//   mount    the player is built
//   decide   the way it will play is chosen (file, stream, encode)
//   ask      the first request for the film itself went out
//   byte     its first byte arrived (on an iPhone's own player — native HLS —
//            the element's first `progress` event: its requests never reach
//            Resource Timing. The server's own side of the start is added to
//            the mark by the server: src/lib/starttrace.js)
//   frame    the first frame of the film is on the screen
// A step's own time is the gap since the step before it; the SLOW step is the
// longest of those gaps.
export const STEPS = ["open", "item", "history", "probe", "mount", "decide", "ask", "byte", "frame"];
export const SLOW_START_MS = 6000;

const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

// at: { step: performance.now()-style time }, press: the same clock's press
// time. srv: what the server said it spent ({ playlist, seg } ms, optional).
export const startupOf = ({ press, at = {}, path = null, srv = null } = {}) => {
  if (!Number.isFinite(press)) return null;
  const steps = [];
  let prev = 0;
  let slow = null;
  let slowMs = -1;
  for (const name of STEPS) {
    const t = at[name];
    if (!Number.isFinite(t)) continue;
    const ms = Math.max(prev, num(t - press));
    const gap = ms - prev;
    steps.push([name, ms]);
    if (gap > slowMs) { slowMs = gap; slow = name; }
    prev = ms;
  }
  if (!steps.length) return null;
  const total = steps[steps.length - 1][1];
  const out = { total, slow, slowMs: Math.max(0, slowMs), path: path || null, steps };
  if (srv) {
    const s = {};
    for (const k of ["playlist", "seg"]) if (Number.isFinite(srv[k])) s[k] = num(srv[k]);
    if (Object.keys(s).length) out.srv = s;
  }
  return out;
};

// "open:12,item:40,…" — the play mark's compact form (the server keeps it
// as one field; src/lib/playmarks.js parses it back).
export const stepsText = (s) => (s && s.steps ? s.steps.map(([n, ms]) => `${n}:${ms}`).join(",") : "");

// What the server said about the first playlist and the first piece of the
// film, read off the browser's resource timing (Server-Timing, same origin):
// `app` is the whole answer, `seg` the time the segment took to be made.
export const serverSide = (entries = [], isMedia = () => true) => {
  const out = {};
  for (const e of entries) {
    if (!e || !isMedia(e.name || "")) continue;
    const st = {};
    for (const x of e.serverTiming || []) st[x.name] = x.duration;
    if (/\.m3u8(\?|$)/.test(e.name || "")) { if (out.playlist == null && st.app != null) out.playlist = st.app; }
    else if (out.seg == null && (st.seg != null || st.app != null)) out.seg = st.seg != null ? st.seg : st.app;
  }
  return out;
};

// The first request for the film (a playlist, a segment, the file) and the
// first byte of the film itself (a segment or the file — not a playlist),
// from the same entries (startTime / responseStart are on the page's clock:
// performance.now()). Requests from before `since` (a warm-up the title page
// made) do not count.
export const firstMedia = (entries = [], isMedia = () => true, since = 0) => {
  let ask = null;
  let byte = null;
  for (const e of entries) {
    if (!e || !isMedia(e.name || "") || e.startTime < since) continue;
    if (ask == null || e.startTime < ask) ask = e.startTime;
    if (!/\.m3u8(\?|$)/.test(e.name || "") && e.responseStart > 0 && (byte == null || e.responseStart < byte)) byte = e.responseStart;
  }
  return ask == null ? null : { ask, byte };
};
