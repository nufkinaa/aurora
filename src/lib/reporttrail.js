// What a problem report carries besides the words (docs/report-trail.md):
// the viewer's last steps (`trail`), facts about the device and app (`env`),
// the player's state (`player`) and the last request timings (`reqs`) — as the
// client sent them, cleaned here — and what only the server knows (`srv`),
// read from what it already keeps.
//
// Every client field is validated as if it came from someone hostile: known
// entry kinds only, short flat values (no objects inside), every string one
// line, no markup brackets, capped in count, length and total size. A client
// from before this (no trail) is a report like any other; a field this server
// does not know is dropped. Other profiles' names are taken out of the trail
// here too, whatever the client did.
"use strict";

const KINDS = new Set(["nav", "tap", "key", "sheet", "toast", "err", "req", "search", "play", "net", "app", "feat"]);
const LIMITS = {
  ENTRIES: 80, // the clients send 60 at most
  ENTRY_KEYS: 12,
  STR: 160,
  TRAIL_BYTES: 14000,
  ENV_KEYS: 48,
  ENV_STR: 120,
  PLAYER_KEYS: 32,
  REQS: 10,
  T_MAX: 24 * 3600 * 1000, // a step's `t` (ms before sending) — ten minutes is what is sent
};
const KEY = /^[A-Za-z][A-Za-z0-9]{0,11}$/;

const str = (v, n) =>
  String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const scalar = (v, n) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(-1e12, Math.min(1e12, Math.round(v * 10) / 10)) : undefined;
  if (typeof v === "string") return str(v, n) || undefined;
  return undefined;
};
// A flat object of short values, or null.
const flat = (o, maxKeys, n, skip = []) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const out = {};
  let count = 0;
  for (const k of Object.keys(o).slice(0, 200)) {
    if (count >= maxKeys) break;
    if (!KEY.test(k) || skip.includes(k)) continue;
    const v = scalar(o[k], n);
    if (v === undefined) continue;
    out[k] = v;
    count++;
  }
  return count ? out : null;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scrubber = (names) => {
  const list = (names || []).map((x) => String(x || "").trim()).filter((x) => x.length >= 2);
  if (!list.length) return (s) => s;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(?:${list.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  return (s) => (typeof s === "string" ? s.replace(re, "$1someone") : s);
};

const ms = (v) => Math.max(0, Math.min(LIMITS.T_MAX, Math.round(Number(v) || 0)));

// [{t, k, …}] newest last, cleaned and capped; [] for anything else.
const cleanTrail = (arr, { names = [] } = {}) => {
  if (!Array.isArray(arr)) return [];
  const scrub = scrubber(names);
  const out = [];
  for (const e of arr.slice(-LIMITS.ENTRIES)) {
    if (!e || typeof e !== "object" || !KINDS.has(e.k)) continue;
    const o = { t: ms(e.t), k: e.k };
    const rest = flat(e, LIMITS.ENTRY_KEYS, LIMITS.STR, ["t", "k"]) || {};
    for (const [k, v] of Object.entries(rest)) o[k] = scrub(v);
    if (o.n != null && !(Number.isInteger(o.n) && o.n > 0)) delete o.n;
    out.push(o);
  }
  out.sort((a, b) => b.t - a.t); // oldest first
  let size = JSON.stringify(out).length;
  while (out.length && size > LIMITS.TRAIL_BYTES) size -= JSON.stringify(out.shift()).length + 1;
  return out;
};
const cleanEnv = (o) => flat(o, LIMITS.ENV_KEYS, LIMITS.ENV_STR);
const cleanPlayer = (o) => flat(o, LIMITS.PLAYER_KEYS, LIMITS.ENV_STR);
const cleanReqs = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-LIMITS.REQS).map((r) => {
    const o = flat(r, 6, 120);
    if (!o || typeof o.p !== "string") return null;
    return { t: ms(o.t), m: typeof o.m === "string" ? o.m.slice(0, 8) : "GET", p: o.p, s: typeof o.s === "number" ? o.s : 0, ms: typeof o.ms === "number" ? Math.max(0, o.ms) : null };
  }).filter(Boolean);
};

// ---------- what only the server knows ----------
// Read-only, from the stores the server already keeps; each part on its own
// (a part that fails is left out). Nothing here touches the playback pipeline.
const safe = (fn) => { try { const v = fn(); return v == null || (Array.isArray(v) && !v.length) ? undefined : v; } catch { return undefined; } };
const devLine = (d) => (d && typeof d === "object" ? [d.device, d.browser, d.os].filter(Boolean).join(" · ") : d ? String(d) : "");
const INACTIVE = new Set(["done", "canceled", "cancelled", "declined", "dismissed"]);
const serverFacts = ({ profileId = null, clientId = null, app = null, now = Date.now() } = {}) => {
  const pkg = safe(() => require("../../package.json"));
  const out = {
    v: pkg && pkg.version,
    up: Math.round(process.uptime()),
    mode: safe(() => require("./authmode").get()),
  };
  if (profileId) {
    const tele = safe(() => require("../telemetry"));
    out.plays = safe(() => tele.sessions.data.filter((s) => s.profileId === profileId).slice(0, 5).map((s) => ({
      what: str(s.content || "", 120), started: s.startedAt, ended: s.endedAt || null, watchedSec: s.watchedSec || 0,
      pos: s.position, dur: s.duration, state: s.state || null, live: !!s.live, device: devLine(s.device),
    })));
    const rt = safe(() => require("../realtime"));
    out.screens = safe(() => [...rt.clients.values()].filter((c) => c.profileId === profileId && !(c.ws && c.ws.isAdmin)).slice(0, 8).map((c) => {
      const p = rt.publicClient(c);
      return { app: p.app || null, device: devLine(p.device), doing: p.activity || null, what: p.details ? str(p.details, 120) : null, presence: p.presence || null, pos: typeof p.position === "number" ? Math.round(p.position) : null, me: clientId ? c.id === clientId : undefined };
    }));
    out.downloads = safe(() => require("../media/downloads").rawJobs().filter((j) => j.profile === profileId && !INACTIVE.has(j.status)).slice(0, 8).map((j) => ({
      title: str(j.label || j.title || "?", 120), status: j.status, progress: Math.round((j.progress || 0) * 100), why: j.error || j.holdReason || j.note ? str(j.error || j.holdReason || j.note, 120) : null,
    })));
  }
  if (clientId) {
    out.session = safe(() => {
      const s = require("../telemetry").liveSessionOf(String(clientId));
      return s ? { id: s.id, what: str(s.content || "", 120), state: s.state || null, pos: s.position, started: s.startedAt } : null;
    });
  }
  // the kinds of error this kind of app reported in the last quarter of an hour (lib/tel —
  // counted by kind, never by person: these may be anyone's on the same app)
  out.appErrors = safe(() => {
    const rows = require("./tel/errors").summary({ app: app || undefined }, now).top || [];
    return rows.filter((r) => now - r.last <= 15 * 60 * 1000).slice(0, 6).map((r) => ({ kind: r.kind, level: r.level, m: str(r.message, 160), n: r.n, devices: r.devices, ago: Math.round((now - r.last) / 1000) }));
  });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
};

module.exports = { cleanTrail, cleanEnv, cleanPlayer, cleanReqs, serverFacts, scrubber, LIMITS, KINDS };
