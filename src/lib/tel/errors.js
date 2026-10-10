// Error and warning reports from people's devices, kept as numbers.
//
// The site and the TV app each keep a small book of what went wrong in a
// session — an uncaught error, a refused request, forty pictures that would
// not load — and send it with their usage stats (only when the profile has
// those on). Here every report is scrubbed again, reduced to a FINGERPRINT
// (lib/tel/scrub.js) and counted: how often, on how many devices, since
// when, in which app versions, on which boxes, on which screen, under which
// sign-in mode. Nothing a person typed, watched or is called is kept — see
// docs/analytics.md.
//
// Bounded: 300 fingerprints (the stalest goes first), 30 days of per-day
// counts, 48 hours of per-hour counts, 40 device ids a day per fingerprint,
// a dozen versions / models / screens each. One JSON file, rewritten at most
// twice a minute.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const scrub = require("./scrub");
const { ERROR_KINDS, BENIGN, CTX_KEYS, SCREEN_RE } = require("./vocab");

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MAX_FPS = 300;
const KEEP_DAYS = 30;
const KEEP_HOURS = 48;
const MAX_IDS_PER_DAY = 40;
const MAX_FACETS = 12;
const MAX_PER_BATCH = 20;
const MAX_COUNT_PER_REPORT = 500; // one report may stand for this many occurrences, no more
const SAVE_EVERY_MS = 30 * 1000;
const RECENT_KEEP_MS = 2 * HOUR; // memory only: who reported what, for the alert's "within M minutes"
const RECENT_MAX = 60;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const hourOf = (t) => new Date(t).toISOString().slice(0, 13);

const fresh = () => ({ v: 1, salt: crypto.randomBytes(8).toString("hex"), fps: {}, known: {}, alerts: { lastAt: 0, day: "", sentToday: 0, pending: [] } });
let state = fresh();
let file = null; // null: memory only (tests)
let saveTimer = null;
let dirty = false;
const recent = new Map(); // fp key -> [{ t, n, id }]

const bumpFacet = (obj, key, n = 1) => {
  if (!key) return;
  if (!(key in obj) && Object.keys(obj).length >= MAX_FACETS) key = "other";
  obj[key] = (obj[key] || 0) + n;
};

// The install id never reaches the disk as it was sent: it is hashed with a
// salt this server made up, and only six characters are kept — enough to
// count "three different devices", useless for anything else.
const anon = (iid) => crypto.createHash("sha256").update(`${state.salt}|${iid}`).digest("hex").slice(0, 6);

// One report from a client → the clean record, or null. `env` is the batch's
// (already validated) envelope: { app, v, model, os, device, net, auth, flags }.
const clean = (r, env, now = Date.now()) => {
  if (!r || typeof r !== "object") return null;
  const kind = ERROR_KINDS.has(r.k) ? r.k : null;
  if (!kind) return null;
  const level = r.l === "warn" ? "warn" : "error";
  // A refused request or a picture that would not load is said by its SHAPE,
  // and the sentence is built here: "GET /img/:id?w=256 → 401". The address
  // goes through urlPattern (dictionary words, ":id" and sizes only), the
  // method and the status are checked — nothing of the client's own wording
  // is kept for these two kinds.
  let msg;
  const status = r.c && Number.isInteger(r.c.status) && r.c.status >= 0 && r.c.status < 1000 ? r.c.status : null;
  if (kind === "http" || kind === "img") {
    const m = /^\s*(?:(GET|POST|PUT|DELETE|PATCH|HEAD)\s+)?(\S+)/i.exec(String(r.m || ""));
    if (!m) return null;
    const what = status == null ? "failed" : status === 0 ? "no answer" : String(status);
    msg = `${kind === "img" ? "image" : (m[1] || "GET").toUpperCase()} ${scrub.urlPattern(m[2])} → ${what}`;
  } else msg = scrub.normMessage(r.m);
  msg = scrub.safe(msg);
  if (!msg) return null;
  const loc = scrub.safe(scrub.normLocation(r.s));
  const screen = typeof r.r === "string" && SCREEN_RE.test(r.r) ? r.r : "";
  let n = Math.floor(Number(r.n));
  if (!Number.isFinite(n) || n < 1) n = 1;
  n = Math.min(n, MAX_COUNT_PER_REPORT);
  const stamp = (v) => { const t = Number(v); return Number.isFinite(t) && t > now - DAY && t < now + HOUR ? t : now; };
  const ctx = {};
  if (r.c && typeof r.c === "object" && !Array.isArray(r.c)) {
    for (const k of CTX_KEYS) {
      const v = r.c[k];
      if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9) ctx[k] = Math.round(v);
    }
  }
  return { fp: scrub.fingerprint(env.app, kind, msg, loc), kind, level, msg, loc, screen, n, t0: stamp(r.t0), t1: stamp(r.t1), ctx };
};

const benignWhy = (rec) => {
  for (const [re, why] of BENIGN) if (re.test(rec.msg)) return why;
  return null;
};

const evict = () => {
  const keys = Object.keys(state.fps);
  if (keys.length <= MAX_FPS) return;
  // ignored ones first, then the ones longest unseen
  keys.sort((a, b) => {
    const ia = stateOf(a) === "ignored" ? 0 : 1;
    const ib = stateOf(b) === "ignored" ? 0 : 1;
    return ia - ib || state.fps[a].last - state.fps[b].last;
  });
  for (const k of keys.slice(0, keys.length - MAX_FPS)) { delete state.fps[k]; recent.delete(k); }
};

const trim = (f, now) => {
  const minDay = dayOf(now - KEEP_DAYS * DAY);
  for (const d of Object.keys(f.days)) if (d < minDay) delete f.days[d];
  const minHour = hourOf(now - KEEP_HOURS * HOUR);
  for (const h of Object.keys(f.hours)) if (h < minHour) delete f.hours[h];
};

// Count one batch's reports. Returns how many were kept.
const record = (list, env, iid, now = Date.now()) => {
  if (!Array.isArray(list) || !list.length) return 0;
  const id = anon(iid || "none");
  let kept = 0;
  for (const raw of list.slice(0, MAX_PER_BATCH)) {
    const r = clean(raw, env, now);
    if (!r) continue;
    let f = state.fps[r.fp];
    if (!f) {
      f = state.fps[r.fp] = {
        fp: r.fp, app: env.app, kind: r.kind, level: r.level, msg: r.msg, loc: r.loc,
        first: Math.min(r.t0, now), last: 0, firstV: env.v || "?", n: 0,
        versions: {}, models: {}, screens: {}, auth: {}, net: {}, os: {}, flags: {}, ctx: {},
        days: {}, hours: {}, alerted: {},
      };
      const why = benignWhy(r);
      if (why && !state.known[r.fp]) state.known[r.fp] = { state: "ignored", at: now, note: why, seeded: true };
    }
    if (r.level === "error") f.level = "error"; // the worse of what was reported
    f.n += r.n;
    f.last = Math.max(f.last, r.t1, now - 1);
    bumpFacet(f.versions, env.v || "?", r.n);
    bumpFacet(f.models, env.model || env.device || "?", r.n);
    bumpFacet(f.screens, r.screen || "?", r.n);
    bumpFacet(f.auth, env.auth || "?", r.n);
    bumpFacet(f.net, env.net || "?", r.n);
    bumpFacet(f.os, env.os || "?", r.n);
    for (const fl of env.flags || []) bumpFacet(f.flags, fl, r.n);
    for (const [k, v] of Object.entries(r.ctx)) {
      const c = (f.ctx[k] = f.ctx[k] || {});
      bumpFacet(c, String(v), r.n);
    }
    const day = (f.days[dayOf(now)] = f.days[dayOf(now)] || { n: 0, ids: [] });
    day.n += r.n;
    if (!day.ids.includes(id) && day.ids.length < MAX_IDS_PER_DAY) day.ids.push(id);
    f.hours[hourOf(now)] = (f.hours[hourOf(now)] || 0) + r.n;
    trim(f, now);
    let ring = recent.get(r.fp);
    if (!ring) recent.set(r.fp, (ring = []));
    ring.push({ t: now, n: r.n, id });
    while (ring.length > RECENT_MAX || (ring.length && now - ring[0].t > RECENT_KEEP_MS)) ring.shift();
    kept++;
  }
  if (kept) { evict(); touch(); }
  return kept;
};

// ---------- reading ----------
const stateOf = (fp) => (state.known[fp] && state.known[fp].state) || "open";

const devicesOf = (f, sinceDay = "") => {
  const ids = new Set();
  for (const [d, v] of Object.entries(f.days)) if (d >= sinceDay) for (const id of v.ids) ids.add(id);
  return ids.size;
};
const countSince = (f, sinceDay) => Object.entries(f.days).reduce((s, [d, v]) => s + (d >= sinceDay ? v.n : 0), 0);

// The last hour against the fingerprint's own usual hour: the mean of the
// hours before it in what is kept (48 h), with the days' counts standing in
// once those have rolled off. Null when it is too young to have a usual.
const spikeOf = (f, now = Date.now()) => {
  const cur = (f.hours[hourOf(now)] || 0) + (f.hours[hourOf(now - HOUR)] || 0) * ((HOUR - (now % HOUR)) / HOUR);
  const ageH = Math.min(7 * 24, (now - f.first) / HOUR);
  if (ageH < 24) return { cur: Math.round(cur), base: null, factor: null };
  const week = countSince(f, dayOf(now - 7 * DAY));
  const lastTwo = (f.hours[hourOf(now)] || 0) + (f.hours[hourOf(now - HOUR)] || 0);
  const base = Math.max(0, week - lastTwo) / Math.max(1, ageH - 2);
  return { cur: Math.round(cur), base: Math.round(base * 100) / 100, factor: base > 0 ? Math.round((cur / base) * 10) / 10 : cur > 0 ? Infinity : 0 };
};

// What happened lately, for the alert rule: occurrences and distinct devices
// in the last `windowMs` (memory only — it starts again after a restart).
const recentOf = (fp, windowMs, now = Date.now()) => {
  const ids = new Set();
  let n = 0;
  for (const e of recent.get(fp) || []) if (now - e.t <= windowMs) { n += e.n; ids.add(e.id); }
  return { n, devices: ids.size };
};

const cmpVer = (a, b) => {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};
// The newest version each app has reported from (errors only know the
// versions that had errors; `extra` lets the caller add what usage knows).
const latestVersions = (extra = {}) => {
  const out = { ...(state.latest || {}), ...extra };
  for (const f of Object.values(state.fps)) for (const v of Object.keys(f.versions)) {
    if (v === "?" || v === "other") continue;
    if (!out[f.app] || cmpVer(v, out[f.app]) > 0) out[f.app] = v;
  }
  return out;
};

const view = (f, now, latest) => {
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = dayOf(now - i * DAY); days.push({ day: d, n: (f.days[d] && f.days[d].n) || 0, devices: (f.days[d] && f.days[d].ids.length) || 0 }); }
  const sp = spikeOf(f, now);
  const k = state.known[f.fp] || null;
  return {
    fp: f.fp, app: f.app, kind: f.kind, level: f.level, message: f.msg, where: f.loc,
    n: f.n, n24: Math.round(sumHours(f, now, 24)), devices: devicesOf(f), devices24: devicesOf(f, dayOf(now - DAY)),
    first: f.first, last: f.last, firstVersion: f.firstV,
    isNew: now - f.first < DAY || (!!latest[f.app] && f.firstV === latest[f.app] && Object.keys(f.versions).every((v) => v === f.firstV)),
    newInLatest: !!latest[f.app] && f.firstV === latest[f.app],
    spike: sp,
    versions: f.versions, models: f.models, screens: f.screens, auth: f.auth, net: f.net, os: f.os, flags: f.flags, ctx: f.ctx,
    days, state: k ? k.state : "open", note: k ? k.note || "" : "",
  };
};
const sumHours = (f, now, hours) => {
  let s = 0;
  for (let i = 0; i < hours; i++) s += f.hours[hourOf(now - i * HOUR)] || 0;
  return s;
};

// Everything the admin's Errors view needs. `q`: { app, version, model, level }.
const summary = (q = {}, now = Date.now(), opts = {}) => {
  const latest = latestVersions(opts.latest);
  let rows = Object.values(state.fps).map((f) => view(f, now, latest));
  if (q.app) rows = rows.filter((r) => r.app === q.app);
  if (q.level) rows = rows.filter((r) => r.level === q.level);
  if (q.version) rows = rows.filter((r) => r.versions[q.version]);
  if (q.model) rows = rows.filter((r) => r.models[q.model]);
  const open = rows.filter((r) => r.state !== "ignored");
  const spikeMin = opts.spikeMin || 20;
  const spikeFactor = opts.spikeFactor || 5;
  const facet = (name) => {
    const all = {};
    for (const f of Object.values(state.fps)) for (const [k, v] of Object.entries(f[name])) all[k] = (all[k] || 0) + v;
    return Object.entries(all).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 30);
  };
  return {
    total: rows.length,
    latest,
    fresh: open.filter((r) => r.isNew && r.state === "open").sort((a, b) => b.devices - a.devices || b.n - a.n).slice(0, 50),
    spiking: open.filter((r) => r.spike.base != null && r.spike.cur >= spikeMin && (r.spike.factor === Infinity || r.spike.factor >= spikeFactor)).sort((a, b) => b.spike.cur - a.spike.cur).slice(0, 50),
    top: open.slice().sort((a, b) => b.devices - a.devices || b.n - a.n).slice(0, 100),
    ignored: rows.filter((r) => r.state === "ignored").sort((a, b) => b.n - a.n).slice(0, 100),
    filters: { apps: [...new Set(Object.values(state.fps).map((f) => f.app))].sort(), versions: facet("versions").sort((a, b) => cmpVer(b, a)), models: facet("models"), levels: ["error", "warn"] },
  };
};

const fmtAgo = (t, now) => {
  const m = Math.round((now - t) / 60000);
  if (m < 60) return `${Math.max(0, m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
const facetLine = (o, n = 4) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
const line = (r, now) =>
  `  ${r.level === "warn" ? "warn " : "ERROR"} ${r.app} ${r.kind}  ${r.n}× on ${r.devices} device${r.devices === 1 ? "" : "s"} · ${r.message}` +
  `${r.where ? `  @ ${r.where}` : ""}\n        first ${fmtAgo(r.first, now)} in ${r.firstVersion} · last ${fmtAgo(r.last, now)} · versions: ${facetLine(r.versions)} · on: ${facetLine(r.models)} · screens: ${facetLine(r.screens)}` +
  `${Object.keys(r.auth).some((k) => k !== "?") ? ` · sign-in: ${facetLine(r.auth)}` : ""}${r.ctx.status ? ` · status: ${facetLine(r.ctx.status)}` : ""}`;

// The same as text, for the Copy button.
const text = (now = Date.now(), opts = {}) => {
  const s = summary({}, now, opts);
  const lines = [`Errors and warnings from devices — ${s.total} kinds known` + (Object.keys(s.latest).length ? ` · newest versions: ${Object.entries(s.latest).map(([a, v]) => `${a} ${v}`).join(", ")}` : "")];
  const block = (title, rows, max) => {
    if (!rows.length) return;
    lines.push("", title);
    for (const r of rows.slice(0, max)) lines.push(line(r, now));
  };
  block("New (first seen in the last day, or only ever in the newest version)", s.fresh, 15);
  block("Spiking (this hour against its own usual hour)", s.spiking, 10);
  block("Top by devices affected", s.top, 20);
  if (s.ignored.length) lines.push("", `Ignored: ${s.ignored.length} kinds (${s.ignored.slice(0, 5).map((r) => r.message.slice(0, 40)).join(" | ")})`);
  if (!s.total) lines.push("  nothing reported");
  return lines.join("\n");
};

// ---------- the known / ignored list ----------
const setState = (fp, st, note = "", now = Date.now()) => {
  if (!/^[0-9a-f]{10}$/.test(String(fp))) return false;
  if (st === "open") delete state.known[fp];
  else if (st === "known" || st === "ignored") state.known[fp] = { state: st, at: now, note: scrub.label(note, 80, /[^\x20-\x7e]/g) };
  else return false;
  // the list outlives the fingerprints it names, but not for ever
  const keys = Object.keys(state.known);
  if (keys.length > 600) for (const k of keys.sort((a, b) => state.known[a].at - state.known[b].at).slice(0, keys.length - 600)) if (!state.fps[k]) delete state.known[k];
  touch(true);
  return true;
};

// ---------- persistence ----------
const touch = (soon = false) => {
  dirty = true;
  if (!file || saveTimer) return;
  saveTimer = setTimeout(saveNow, soon ? 1000 : SAVE_EVERY_MS);
  saveTimer.unref?.();
};
const saveNow = () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!file || !dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[telemetry] could not save the error book:", e && e.message);
  }
};
const boot = (filePath, now = Date.now()) => {
  file = filePath || null;
  state = fresh();
  recent.clear();
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.v === 1 && raw.fps && typeof raw.fps === "object") {
      state = { ...fresh(), ...raw, alerts: { ...fresh().alerts, ...(raw.alerts || {}) } };
      const minLast = now - KEEP_DAYS * DAY;
      for (const [k, f] of Object.entries(state.fps)) {
        if (!f || !f.days || f.last < minLast) { delete state.fps[k]; continue; }
        trim(f, now);
      }
    }
  } catch {}
};

// Every batch says which version it came from, errors or not — so "new in the
// newest version" knows the newest version even when it has no errors yet.
const noteVersion = (app, v) => {
  if (!v || v === "?") return;
  state.latest = state.latest || {};
  if (!state.latest[app] || cmpVer(v, state.latest[app]) > 0) { state.latest[app] = v; touch(); }
};
const list = () => Object.values(state.fps);
const alertState = () => state.alerts;
const markAlerted = (fp, what, now = Date.now()) => { if (state.fps[fp]) { state.fps[fp].alerted[what] = now; touch(); } };
const _reset = () => { state = fresh(); recent.clear(); dirty = false; file = null; if (saveTimer) clearTimeout(saveTimer); saveTimer = null; };

module.exports = {
  record, clean, summary, text, setState, stateOf, boot, saveNow, list, recentOf, spikeOf, devicesOf, latestVersions, cmpVer,
  alertState, markAlerted, noteVersion, touch, _reset,
  LIMITS: { MAX_FPS, KEEP_DAYS, KEEP_HOURS, MAX_IDS_PER_DAY, MAX_FACETS, MAX_PER_BATCH, MAX_COUNT_PER_REPORT },
  _internals: { get state() { return state; }, anon, dayOf, hourOf },
};
