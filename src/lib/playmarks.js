// Playback marks, kept as numbers.
//
// The web player and the TV app post a mark at every step of a play — mount,
// which path was taken, the first frame, a stall, the end of a stall, an
// error (routes/api.js /api/play-mark/:id, which also writes the "[play] …"
// log line, unchanged). Here the same marks are folded into ONE small record
// per play, in a bounded list, so the healer can answer with statistics —
// how long films take to start by path, how often a start fails, stalls per
// hour watched, which title is behind most failures — without re-reading the
// text log. Memory only: a day's worth at most; the healer keeps the daily
// totals it compares against (healer-checks/stats.js).
"use strict";

const MAX_PLAYS = 1500;
const KEEP_MS = 26 * 3600 * 1000;
const SAME_PLAY_MS = 6 * 3600 * 1000; // marks this long after a mount still belong to it
const START_GRACE_MS = 60 * 1000; // a mount with no first frame after this long failed to start

const plays = []; // oldest first
const latest = new Map(); // `${ip}|${id}` -> play

const deviceOf = (ua, app) => {
  const s = String(ua || "");
  if (app === "tv" || /Android TV|AFT[A-Z]|BRAVIA|SmartTV|Smart-TV|Tizen|Web0S|GoogleTV|okhttp/i.test(s)) return "tv";
  if (/Mobi|iPhone|iPad|iPod|Android/i.test(s)) return "phone";
  return "desktop";
};

const prune = (now) => {
  let drop = 0;
  while (drop < plays.length && (plays.length - drop > MAX_PLAYS || now - plays[drop].at > KEEP_MS)) drop++;
  if (!drop) return;
  for (const p of plays.splice(0, drop)) if (latest.get(p.key) === p) latest.delete(p.key);
};

// One mark from a client. `extra` is the rest of the posted body.
const record = ({ id, name, ms = 0, extra = {}, ip = "", ua = "", now = Date.now() }) => {
  if (!id || !name) return null;
  const key = `${ip}|${id}`;
  let p = latest.get(key);
  if (name === "mount" || !p || now - p.at > SAME_PLAY_MS) {
    p = {
      key, id: String(id), ip, at: now - (name === "mount" ? 0 : ms || 0), mounted: name === "mount",
      app: extra.app === "tv" ? "tv" : "web", device: deviceOf(ua, extra.app), path: extra.app === "tv" ? "tv" : null,
      ffMs: null, stalls: 0, stallOpenAt: 0, errors: 0, errMsg: null, lastAt: now, lastName: name,
    };
    plays.push(p);
    latest.set(key, p);
    prune(now);
    if (name === "mount") return p;
  }
  p.lastAt = now;
  p.lastName = name;
  if (extra.app === "tv") { p.app = "tv"; p.device = "tv"; p.path = "tv"; }
  if (name === "path" && typeof extra.path === "string" && p.app !== "tv") p.path = extra.path.slice(0, 12);
  else if (name === "first-frame") {
    if (p.ffMs == null) p.ffMs = Math.max(0, Number(ms) || 0);
    if (!p.path) p.path = String(extra.jit) === "true" ? "jit" : String(extra.transcode) === "true" ? "transcode" : "direct";
    else if (p.app !== "tv" && p.path === "direct" && String(extra.transcode) === "true") p.path = "transcode";
    p.stallOpenAt = 0;
  } else if (name === "stall") {
    // the web player reports the stages of ONE stall (nudge → rebuild → card);
    // only the first is a new stall, and "card" means it gave up
    const stage = extra.stage ? String(extra.stage) : "";
    if (!stage || stage === "nudge") { p.stalls++; p.stallOpenAt = now; }
    if (stage === "card") { p.errors++; p.errMsg = "playback stopped after a stall"; p.stallOpenAt = now; }
  } else if (name === "stall-end") p.stallOpenAt = 0;
  else if (name === "error") { p.errors++; p.errMsg = String(extra.m || "error").slice(0, 60); p.stallOpenAt = p.stallOpenAt || now; }
  return p;
};

// Was this address in trouble moments ago — a stall that never ended, or an
// error — when its session closed? (telemetry asks, to mark an abnormal end.)
const troubledJustNow = (ip, now = Date.now(), withinMs = 120000) => {
  for (let i = plays.length - 1; i >= 0 && now - plays[i].lastAt <= SAME_PLAY_MS; i--) {
    const p = plays[i];
    if (p.ip !== ip) continue;
    if (now - p.lastAt > withinMs) return false;
    return !!p.stallOpenAt || p.lastName === "error";
  }
  return false;
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// PURE: a list of play records -> the numbers. `sinceMs` is the window.
const summarize = (list, now = Date.now(), sinceMs = 24 * 3600 * 1000) => {
  const inWin = list.filter((p) => now - p.at <= sinceMs);
  const out = {
    plays: 0, started: 0, startFailures: 0, stalls: 0, errors: 0,
    byPath: {}, // path -> { n, p50, p90 }
    byDevice: {}, // tv|phone|desktop -> { plays, startFailures, stalls, errors }
    failuresByTitle: {}, // id -> failures (start failures + errors)
    ttff: { p50: null, p90: null },
  };
  const ms = {};
  const all = [];
  for (const p of inWin) {
    const dev = (out.byDevice[p.device] = out.byDevice[p.device] || { plays: 0, startFailures: 0, stalls: 0, errors: 0 });
    out.stalls += p.stalls;
    out.errors += p.errors;
    dev.stalls += p.stalls;
    dev.errors += p.errors;
    let failed = p.errors;
    if (p.mounted) {
      out.plays++;
      dev.plays++;
      if (p.ffMs != null) {
        out.started++;
        const k = p.path || "direct";
        (ms[k] = ms[k] || []).push(p.ffMs);
        all.push(p.ffMs);
      } else if (now - p.at > START_GRACE_MS) {
        out.startFailures++;
        dev.startFailures++;
        failed++;
      }
    }
    if (failed) out.failuresByTitle[p.id] = (out.failuresByTitle[p.id] || 0) + failed;
  }
  for (const [k, arr] of Object.entries(ms)) out.byPath[k] = { n: arr.length, p50: pct(arr, 50), p90: pct(arr, 90) };
  out.ttff = { p50: pct(all, 50), p90: pct(all, 90) };
  return out;
};

const list = () => plays;
const _reset = () => { plays.length = 0; latest.clear(); };

module.exports = { record, summarize, troubledJustNow, list, deviceOf, START_GRACE_MS, _reset };
