// How long the moments people feel take — as bounded histograms.
//
// One histogram per  metric × app × version × device class × network tier ×
// dimension  (the dimension is the metric's own split: a play's path, a
// screen's pattern). A value lands in one of 140 buckets, each 15 % wider
// than the last (1 ms … about three days), so a histogram is at most 140
// small numbers however many values it has seen, and a percentile read from
// it is within ±7 % of the true one. That is the whole store: no samples, no
// per-event rows.
//
// The clients send their measurements with their usage stats (same names on
// the site and on the TV — docs/analytics.md has the definitions); the
// server adds its own: how long the heavy endpoints took to answer
// (`middleware`), and how long a download spent waiting, starting and
// arriving (`downloadStarted` / `downloadDone`, called from media/downloads.js).
//
// Bounded: 3000 histograms; the four newest versions per app; a histogram
// nobody added to for 45 days is dropped.
"use strict";
const fs = require("fs");
const path = require("path");
const { TIMINGS, DIM_RE, DEVICES, NET_TIERS } = require("./vocab");

const RATIO = 1.15;
const BUCKETS = 140;
const LOG_RATIO = Math.log(RATIO);
const MAX_KEYS = 3000;
const KEEP_VERSIONS = 4;
const KEEP_MS = 45 * 24 * 3600 * 1000;
const MAX_PER_BATCH = 60;
const SAVE_EVERY_MS = 60 * 1000;

const bucketOf = (ms) => (ms <= 1 ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms) / LOG_RATIO)));
// the middle of a bucket (geometric): what a percentile reports
const valueOf = (b) => (b <= 0 ? 1 : Math.round(Math.pow(RATIO, b - 0.5) * 10) / 10);

let hists = {}; // key -> { n, sum, min, max, at, b: { bucket: count } }
let file = null;
let saveTimer = null;
let dirty = false;

const keyOf = (metric, app, v, device, net, dim) => `${metric}|${app}|${v}|${device}|${net}|${dim}`;
const parseKey = (k) => { const [metric, app, v, device, net, ...rest] = k.split("|"); return { metric, app, v, device, net, dim: rest.join("|") }; };

const cmpVer = (a, b) => {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

const add = (key, ms, now) => {
  let h = hists[key];
  if (!h) {
    if (Object.keys(hists).length >= MAX_KEYS) prune(now, true);
    if (Object.keys(hists).length >= MAX_KEYS) return false;
    h = hists[key] = { n: 0, sum: 0, min: ms, max: ms, at: now, b: {} };
  }
  h.n++;
  h.sum += ms;
  if (ms < h.min) h.min = ms;
  if (ms > h.max) h.max = ms;
  h.at = now;
  const b = bucketOf(ms);
  h.b[b] = (h.b[b] || 0) + 1;
  dirty = true;
  return true;
};

// One measurement. `who`: { app, v, device, net }. Anything not in the
// vocabulary, out of the metric's range, or with a dimension that is not one
// of the metric's own is dropped.
const observe = (metric, ms, dim, who, now = Date.now()) => {
  const def = TIMINGS[metric];
  if (!def) return false;
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms < 0 || ms > def.max) return false;
  let d = "-";
  if (def.dims) {
    d = typeof dim === "string" && (def.dims === "screen" ? DIM_RE.test(dim) : def.dims.includes(dim)) ? dim : def.dims === "screen" ? "?" : "other";
  }
  const app = who.app === "tv" || who.app === "server" ? who.app : "web";
  const device = DEVICES.has(who.device) ? who.device : "-";
  const net = NET_TIERS.has(who.net) ? who.net : "-";
  const v = /^[A-Za-z0-9._-]{1,16}$/.test(String(who.v || "")) ? String(who.v) : "?";
  const ok = add(keyOf(metric, app, v, device, net, d), Math.round(ms), now);
  if (ok) schedule();
  return ok;
};

// A batch's timings from a client: [[name, ms, dim?], …].
const record = (list, who, now = Date.now()) => {
  if (!Array.isArray(list)) return 0;
  let kept = 0;
  for (const t of list.slice(0, MAX_PER_BATCH)) {
    if (!Array.isArray(t) || typeof t[0] !== "string") continue;
    const def = TIMINGS[t[0]];
    if (!def || def.from === "server") continue; // a client cannot write the server's own metrics
    if (observe(t[0], t[1], t[2], who, now)) kept++;
  }
  return kept;
};

// ---------- reading ----------
const merge = (list) => {
  const out = { n: 0, sum: 0, min: Infinity, max: 0, b: {} };
  for (const h of list) {
    out.n += h.n; out.sum += h.sum;
    if (h.min < out.min) out.min = h.min;
    if (h.max > out.max) out.max = h.max;
    for (const [b, c] of Object.entries(h.b)) out.b[b] = (out.b[b] || 0) + c;
  }
  return out;
};
const pct = (h, p) => {
  if (!h || !h.n) return null;
  const want = Math.max(1, Math.ceil((p / 100) * h.n));
  let seen = 0;
  for (const b of Object.keys(h.b).map(Number).sort((a, c) => a - c)) {
    seen += h.b[b];
    if (seen >= want) return Math.min(h.max, Math.max(h.min, valueOf(b)));
  }
  return h.max;
};
const stats = (h) => (h && h.n ? { n: h.n, p50: pct(h, 50), p90: pct(h, 90), p99: pct(h, 99), mean: Math.round(h.sum / h.n) } : null);

// The admin's Timings view: a row per metric × app × dimension with the
// newest version's p50 / p90 / p99 and the change against the version before
// it. `q`: { device, net } narrow what is merged.
const summary = (q = {}) => {
  const groups = new Map(); // metric|app|dim -> { v -> [hist] }
  for (const [k, h] of Object.entries(hists)) {
    const p = parseKey(k);
    if (q.device && p.device !== q.device) continue;
    if (q.net && p.net !== q.net) continue;
    const gk = `${p.metric}|${p.app}|${p.dim}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { metric: p.metric, app: p.app, dim: p.dim, versions: {}, byDevice: {}, byNet: {} }));
    (g.versions[p.v] = g.versions[p.v] || []).push(h);
    g.all = g.all || [];
    g.all.push([p, h]);
  }
  const rows = [];
  for (const g of groups.values()) {
    const vs = Object.keys(g.versions).sort((a, b) => cmpVer(b, a));
    const cur = stats(merge(g.versions[vs[0]]));
    const prev = vs[1] ? stats(merge(g.versions[vs[1]])) : null;
    const change = (k) => (cur && prev && prev[k] > 0 && prev.n >= 5 && cur.n >= 5 ? Math.round(((cur[k] - prev[k]) / prev[k]) * 100) : null);
    const split = (field) => {
      const o = {};
      for (const [p, h] of g.all) if (p.v === vs[0] && p[field] !== "-") (o[p[field]] = o[p[field]] || []).push(h);
      return Object.fromEntries(Object.entries(o).map(([name, list]) => [name, stats(merge(list))]));
    };
    const def = TIMINGS[g.metric] || {};
    rows.push({
      metric: g.metric, label: def.label || g.metric, app: g.app, dim: g.dim, version: vs[0], ...cur,
      prevVersion: vs[1] || null, prev, changeP50: change("p50"), changeP90: change("p90"),
      byDevice: split("device"), byNet: split("net"),
      versions: vs.slice(0, KEEP_VERSIONS).map((v) => ({ v, ...stats(merge(g.versions[v])) })),
    });
  }
  const order = Object.keys(TIMINGS);
  rows.sort((a, b) => order.indexOf(a.metric) - order.indexOf(b.metric) || a.app.localeCompare(b.app) || (b.n || 0) - (a.n || 0));
  return { rows, histograms: Object.keys(hists).length };
};

const fmt = (v) => (v == null ? "–" : v >= 3600000 ? `${(v / 3600000).toFixed(1)}h` : v >= 60000 ? `${(v / 60000).toFixed(1)}min` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const text = () => {
  const s = summary();
  const lines = ["Timings (metric · app · split · version · count · p50 / p90 / p99 · change in p50 against the version before)"];
  for (const r of s.rows) {
    lines.push(`  ${r.metric}  ${r.app}${r.dim !== "-" ? ` ${r.dim}` : ""}  v${r.version}  ${r.n} · ${fmt(r.p50)} / ${fmt(r.p90)} / ${fmt(r.p99)}` +
      (r.changeP50 != null ? ` · ${r.changeP50 > 0 ? "+" : ""}${r.changeP50}% vs v${r.prevVersion} (${fmt(r.prev.p50)})` : ""));
  }
  if (!s.rows.length) lines.push("  nothing measured yet");
  return lines.join("\n");
};

// ---------- the server's own clock ----------
let serverVersion = "?";
try { serverVersion = require("../../../package.json").version; } catch {}
const SERVER = { app: "server", v: serverVersion, device: "-", net: "-" };

// [metric, test(path), dim(req)]
const WATCHED = [
  ["srv_home", (p) => p === "/api/home"],
  ["srv_search", (p) => p === "/api/search"],
  ["srv_suggest", (p) => p === "/api/search/suggest"],
  ["srv_item", (p) => p.startsWith("/api/item/")],
  ["srv_library", (p) => p === "/api/library"],
  ["srv_catalog", (p) => p === "/api/catalog"],
  ["srv_discover", (p) => p.startsWith("/api/discover/meta/")],
  ["srv_img", (p) => p.startsWith("/img/"), (req) => (req.query && req.query.w ? "variant" : "original")],
];
// Tiny on purpose: two string tests for an unwatched request, one listener
// and one bucket increment for a watched one.
const middleware = (req, res, next) => {
  const p = req.path;
  if (p.charCodeAt(1) !== 97 /* a */ && p.charCodeAt(1) !== 105 /* i */) return next();
  for (const [metric, test, dim] of WATCHED) {
    if (!test(p)) continue;
    const t0 = process.hrtime.bigint();
    res.once("finish", () => {
      if (res.statusCode >= 400) return; // a refusal is quick; it would flatter the numbers
      observe(metric, Number(process.hrtime.bigint() - t0) / 1e6, dim ? dim(req) : undefined, SERVER);
    });
    break;
  }
  next();
};

// Downloads: asked → approved (the wait for a yes), approved → started (the
// wait for a slot), started → in the library. From the job's own timestamps;
// the start is remembered here (memory only) so the job record is untouched.
const dlStarts = new Map();
const downloadStarted = (job, now = Date.now()) => {
  try {
    if (!job || !job.id) return;
    if (dlStarts.size > 500) dlStarts.clear();
    if (!dlStarts.has(job.id)) dlStarts.set(job.id, now);
    const asked = Date.parse(job.at || job.createdAt || "");
    const approved = Date.parse(job.approvedAt || "");
    if (asked && approved && approved >= asked) observe("dl_wait_approval", approved - asked, job.autoApproved ? "auto" : "asked", SERVER, now);
    if (approved && now >= approved) observe("dl_wait_slot", now - approved, undefined, SERVER, now);
  } catch {}
};
const downloadDone = (job, now = Date.now()) => {
  try {
    if (!job || !job.id) return;
    const started = dlStarts.get(job.id);
    dlStarts.delete(job.id);
    if (started) observe("dl_transfer", now - started, undefined, SERVER, now);
    const asked = Date.parse(job.at || job.createdAt || "");
    if (asked && now >= asked) observe("dl_total", now - asked, undefined, SERVER, now);
  } catch {}
};

// ---------- housekeeping ----------
const prune = (now = Date.now(), hard = false) => {
  const byApp = {};
  for (const k of Object.keys(hists)) {
    const p = parseKey(k);
    if (now - hists[k].at > KEEP_MS) { delete hists[k]; dirty = true; continue; }
    (byApp[p.app] = byApp[p.app] || new Set()).add(p.v);
  }
  for (const [app, set] of Object.entries(byApp)) {
    const keep = new Set([...set].sort((a, b) => cmpVer(b, a)).slice(0, KEEP_VERSIONS));
    for (const k of Object.keys(hists)) { const p = parseKey(k); if (p.app === app && !keep.has(p.v)) { delete hists[k]; dirty = true; } }
  }
  if (hard && Object.keys(hists).length >= MAX_KEYS) {
    // still full: the thinnest histograms make room
    const keys = Object.keys(hists).sort((a, b) => hists[a].n - hists[b].n || hists[a].at - hists[b].at);
    for (const k of keys.slice(0, Math.ceil(MAX_KEYS / 10))) delete hists[k];
    dirty = true;
  }
};

const schedule = () => {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_EVERY_MS);
  saveTimer.unref?.();
};
const saveNow = () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!file || !dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, hists }));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[telemetry] could not save the timings:", e && e.message);
  }
};
const boot = (filePath, now = Date.now()) => {
  file = filePath || null;
  hists = {};
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.v === 1 && raw.hists && typeof raw.hists === "object") hists = raw.hists;
  } catch {}
  prune(now);
};
const _reset = () => { hists = {}; file = null; dirty = false; dlStarts.clear(); if (saveTimer) clearTimeout(saveTimer); saveTimer = null; };

module.exports = {
  observe, record, summary, text, middleware, downloadStarted, downloadDone, prune, boot, saveNow, _reset,
  LIMITS: { RATIO, BUCKETS, MAX_KEYS, KEEP_VERSIONS, KEEP_MS, MAX_PER_BATCH },
  _internals: { bucketOf, valueOf, pct, merge, keyOf, get hists() { return hists; }, SERVER },
};
