// Usage stats from the app (public/js/usage.js): validated, appended to a
// monthly JSONL file under data/usage, and aggregated in memory for the
// admin's Analytics tab — routes with paint times, features, nav taps, play
// starts by path, client errors, active profiles per day. The summary also
// renders as plain text so it can be copied out of the admin panel in one
// press and pasted into a chat.
//
// Everything here is bounded: 50 events per batch, short whitelisted names,
// 30 MB per month file (then the month's tail is dropped), three months
// kept, reservoir samples for percentiles.
const fs = require("fs");
const path = require("path");
const config = require("../config");

const DIR = path.join(config.DATA_DIR, "usage");
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const KEEP_MONTHS = 3;
const SAMPLE = 400; // per-key reservoir for percentiles
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
const DEVICES = new Set(["phone", "tablet", "desktop", "tv"]);
const LOOKS = new Set(["glass", "legacy", "tv"]); // "tv": the Android TV app (it has one look of its own)
const NET_TIERS = new Set(["slow", "ok", "fast"]);
// The TV app's frame monitor (tv-native/src/perfTier.ts): a `perf` event per
// screen a few times a session, one `device` event, a `trim` event when the
// system warned about memory. Aggregated per screen × app version × which
// components are native (`impl`, "-" when none) so a before/after read is two
// rows of one table — the evidence base for the native-rendering work.
const PERF_SCREEN_RE = /^[a-z]{1,24}$/;
const PERF_V_RE = /^[A-Za-z0-9._-]{1,12}$/;
const PERF_IMPL_RE = /^[A-Za-z-]{1,8}$/;
const PERF_LOW_REASONS = ["no", "android", "mem", "heap", "frames", "trim"];
const PERF_MAX_SCREEN_KEYS = 500;
const PERF_MAX_DEVICES = 200;
const PERF_ROWS = 40;

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const fileFor = (month) => path.join(DIR, `events-${month}.jsonl`);

// ---------- aggregate ----------
const fresh = () => ({
  since: null,
  last: null,
  events: 0,
  batches: 0,
  devices: {}, // class -> events
  looks: {},
  routes: {}, // pattern -> { n, ms: [], byDevice: {} }
  features: {}, // name -> { n, byDevice: {} }
  nav: {}, // destination -> n
  plays: {}, // `${kind}/${path}` -> { n, ms: [], byDevice: {} }
  errors: {}, // message -> n
  net: { tiers: {}, byDevice: {}, sources: {}, kbps: [], rtt: [] }, // connection quality, per report
  perf: {
    screens: {}, // `${screen}|${v}|${impl}` -> { n, frames, p50: [], p90: [], jank: [], low, lite }
    devices: {}, // model -> { n, sdk: {}, mem_mb, heap_mb, gpu, lowram, low: { no, android, mem, heap, frames, trim } }
    trims: {}, // ComponentCallbacks2 level -> n
  },
  profilesByDay: {}, // day -> Set
  sessionsByDay: {}, // day -> Set
});
let agg = fresh();

const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
const sample = (arr, v) => {
  if (arr.length < SAMPLE) arr.push(v);
  else arr[Math.floor(Math.random() * arr.length)] = v; // reservoir-ish: bounded, unbiased enough
};
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const apply = (batch) => {
  const { profile, sid, device, look, events } = batch;
  agg.batches++;
  for (const ev of events) {
    agg.events++;
    if (!agg.since || ev.t < agg.since) agg.since = ev.t;
    if (!agg.last || ev.t > agg.last) agg.last = ev.t;
    bump(agg.devices, device);
    bump(agg.looks, look);
    const day = dayOf(ev.t);
    (agg.profilesByDay[day] = agg.profilesByDay[day] || new Set()).add(profile);
    (agg.sessionsByDay[day] = agg.sessionsByDay[day] || new Set()).add(sid);
    const p = ev.p || {};
    if (ev.n === "route" && typeof p.r === "string") {
      const r = (agg.routes[p.r] = agg.routes[p.r] || { n: 0, ms: [], byDevice: {} });
      r.n++;
      bump(r.byDevice, device);
      if (typeof p.ms === "number" && p.ms >= 0 && p.ms < 120000) sample(r.ms, p.ms);
    } else if (ev.n === "feat" && typeof p.f === "string") {
      const f = (agg.features[p.f] = agg.features[p.f] || { n: 0, byDevice: {} });
      f.n++;
      bump(f.byDevice, device);
    } else if (ev.n === "nav" && typeof p.to === "string") {
      bump(agg.nav, p.to);
    } else if (ev.n === "play") {
      const key = `${p.kind || "?"}/${p.path || "?"}`;
      const pl = (agg.plays[key] = agg.plays[key] || { n: 0, ms: [], byDevice: {} });
      pl.n++;
      bump(pl.byDevice, device);
      if (typeof p.ms === "number" && p.ms >= 0 && p.ms < 600000) sample(pl.ms, p.ms);
    } else if (ev.n === "error" && typeof p.m === "string") {
      if (p.m in agg.errors || Object.keys(agg.errors).length < 300) bump(agg.errors, p.m);
    } else if (ev.n === "net" && NET_TIERS.has(p.tier)) {
      bump(agg.net.tiers, p.tier);
      if (p.tier === "slow") bump(agg.net.byDevice, device);
      if (typeof p.src === "string") bump(agg.net.sources, p.src.slice(0, 24));
      if (typeof p.kbps === "number" && p.kbps > 0 && p.kbps < 1e7) sample(agg.net.kbps, p.kbps);
      if (typeof p.rtt === "number" && p.rtt > 0 && p.rtt < 60000) sample(agg.net.rtt, p.rtt);
    } else if (ev.n === "perf" && typeof p.screen === "string" && PERF_SCREEN_RE.test(p.screen)) {
      applyPerf(p);
    }
  }
};

const applyPerf = (p) => {
  const perf = agg.perf;
  if (p.screen === "device") {
    const model = typeof p.model === "string" && p.model.trim() ? p.model.trim().slice(0, 40) : "?";
    if (!perf.devices[model] && Object.keys(perf.devices).length >= PERF_MAX_DEVICES) return;
    const d = (perf.devices[model] = perf.devices[model] || {
      n: 0, sdk: {}, mem_mb: null, heap_mb: null, gpu: "", lowram: 0,
      low: Object.fromEntries(PERF_LOW_REASONS.map((r) => [r, 0])),
    });
    d.n++;
    if (Number.isInteger(p.sdk) && p.sdk > 0 && p.sdk < 100) bump(d.sdk, String(p.sdk));
    if (typeof p.mem_mb === "number" && p.mem_mb > 0 && p.mem_mb < 1e6) d.mem_mb = Math.round(p.mem_mb); // the latest wins
    if (typeof p.heap_mb === "number" && p.heap_mb > 0 && p.heap_mb < 1e6) d.heap_mb = Math.round(p.heap_mb);
    if (typeof p.gpu === "string" && p.gpu.trim()) d.gpu = p.gpu.trim().slice(0, 60);
    if (p.lowram === true) d.lowram++;
    if (typeof p.low === "string" && PERF_LOW_REASONS.includes(p.low)) d.low[p.low]++;
  } else if (p.screen === "trim") {
    if (Number.isInteger(p.level) && p.level >= 0 && p.level <= 100) bump(perf.trims, String(p.level));
  } else {
    // a screen's frames: `v` (versionCode) and `impl` arrive from newer builds; older ones get the defaults
    const v = typeof p.v === "number" && Number.isInteger(p.v) && p.v > 0 ? String(p.v) : typeof p.v === "string" && PERF_V_RE.test(p.v) ? p.v : "?";
    const impl = typeof p.impl === "string" && PERF_IMPL_RE.test(p.impl) ? p.impl : "-";
    const key = `${p.screen}|${v}|${impl}`;
    if (!perf.screens[key] && Object.keys(perf.screens).length >= PERF_MAX_SCREEN_KEYS) return;
    const s = (perf.screens[key] = perf.screens[key] || { screen: p.screen, v, impl, n: 0, frames: 0, p50: [], p90: [], jank: [], low: 0, lite: 0 });
    s.n++;
    if (typeof p.frames === "number" && p.frames > 0 && p.frames < 1e7) s.frames += Math.round(p.frames);
    if (typeof p.p50 === "number" && p.p50 > 0 && p.p50 < 1000) sample(s.p50, p.p50);
    if (typeof p.p90 === "number" && p.p90 > 0 && p.p90 < 1000) sample(s.p90, p.p90);
    if (typeof p.jank === "number" && p.jank >= 0 && p.jank <= 100) sample(s.jank, p.jank);
    if (p.low === true) s.low++;
    if (p.lite === true) s.lite++;
  }
};

// ---------- validation ----------
const cleanProps = (p) => {
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (!KEY_RE.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "boolean") out[k] = v;
    else continue;
    if (++n >= 10) break;
  }
  return out;
};

// A batch from the client → the clean version (or null when nothing usable).
const validate = (body, now = Date.now()) => {
  if (!body || typeof body !== "object") return null;
  const profile = String(body.profile || "").slice(0, 40);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(profile)) return null;
  const sid = String(body.sid || "").slice(0, 16).replace(/[^a-z0-9]/gi, "") || "none";
  const device = DEVICES.has(body.device) ? body.device : "desktop";
  const look = LOOKS.has(body.look) ? body.look : "glass";
  const raw = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  const events = [];
  for (const ev of raw) {
    if (!ev || typeof ev !== "object" || !NAME_RE.test(String(ev.n || ""))) continue;
    // client clocks drift: anything outside the last day or the next hour is re-stamped
    let t = Number(ev.t);
    if (!Number.isFinite(t) || t < now - 86400000 || t > now + 3600000) t = now;
    const p = cleanProps(ev.p);
    // an error's message is scrubbed like every other client string before it
    // is counted or written (lib/tel/scrub.js): no address, path, id or quoted name
    if (ev.n === "error" && typeof p.m === "string") p.m = require("./tel/scrub").normMessage(p.m);
    events.push({ n: ev.n, t, p });
  }
  if (!events.length) return null;
  return { profile, sid, device, look, events };
};

// ---------- persistence ----------
let pending = []; // lines waiting for the next append
let writeTimer = null;
let monthBytes = { month: null, bytes: 0 };

const sizeOf = (month) => {
  try {
    return fs.statSync(fileFor(month)).size;
  } catch {
    return 0;
  }
};

const writeNow = () => {
  writeTimer = null;
  if (!pending.length) return;
  const lines = pending;
  pending = [];
  const month = monthOf(Date.now());
  if (monthBytes.month !== month) monthBytes = { month, bytes: sizeOf(month) };
  const chunk = lines.join("");
  if (monthBytes.bytes + chunk.length > MAX_FILE_BYTES) return; // the month is full — aggregates still count
  monthBytes.bytes += chunk.length;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFile(fileFor(month), chunk, () => {});
  } catch {}
};

const prune = () => {
  try {
    const files = fs.readdirSync(DIR).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_MONTHS))) fs.unlinkSync(path.join(DIR, f));
  } catch {}
};

// Record one batch from the app. Returns how many events were kept.
// `persist: false` keeps it in memory only (tests).
const record = (body, { persist = true } = {}) => {
  const batch = validate(body);
  if (!batch) return 0;
  apply(batch);
  if (persist) {
    pending.push(JSON.stringify(batch) + "\n");
    if (!writeTimer) writeTimer = setTimeout(writeNow, 2000);
  }
  return batch.events.length;
};

// Rebuild the aggregate from this month's file (bounded by MAX_FILE_BYTES,
// so never more than a few seconds even on the biggest month).
const boot = () => {
  agg = fresh();
  prune();
  const file = fileFor(monthOf(Date.now()));
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const b = JSON.parse(line);
      if (b && Array.isArray(b.events)) apply(b);
    } catch {}
  }
};

// ---------- the summary ----------
const top = (obj, n, by = (v) => (typeof v === "number" ? v : v.n)) =>
  Object.entries(obj)
    .sort((a, b) => by(b[1]) - by(a[1]))
    .slice(0, n);

const summary = () => {
  const days = Object.keys(agg.profilesByDay).sort().slice(-14);
  return {
    since: agg.since,
    last: agg.last,
    events: agg.events,
    batches: agg.batches,
    devices: agg.devices,
    looks: agg.looks,
    routes: top(agg.routes, 20).map(([r, v]) => ({ route: r, n: v.n, p50: pct(v.ms, 50), p90: pct(v.ms, 90), byDevice: v.byDevice })),
    features: top(agg.features, 30).map(([f, v]) => ({ feature: f, n: v.n, byDevice: v.byDevice })),
    nav: top(agg.nav, 12).map(([to, n]) => ({ to, n })),
    plays: top(agg.plays, 12).map(([k, v]) => ({ path: k, n: v.n, p50: pct(v.ms, 50), p90: pct(v.ms, 90), byDevice: v.byDevice })),
    errors: top(agg.errors, 10).map(([m, n]) => ({ message: m, n })),
    // connection quality as the app measured it (js/net.js): how many reports
    // per tier, which devices the slow ones were, and the measured line
    net: {
      tiers: agg.net.tiers,
      slowByDevice: agg.net.byDevice,
      sources: agg.net.sources,
      kbpsP10: pct(agg.net.kbps, 10),
      kbpsP50: pct(agg.net.kbps, 50),
      rttP50: pct(agg.net.rtt, 50),
      rttP90: pct(agg.net.rtt, 90),
    },
    activeByDay: days.map((d) => ({ day: d, profiles: agg.profilesByDay[d].size, sessions: (agg.sessionsByDay[d] || new Set()).size })),
    // the TV app's frame timings: one row per screen × version × impl (p50 and
    // p90 are medians over the sessions' own p50/p90, p90hi the 90th of the
    // p90s, jank the median jank%; `low` and `lite` count the sessions that
    // reported under those economies), and the boxes that sent them
    perf: {
      screens: top(agg.perf.screens, PERF_ROWS, (s) => s.frames).map(([, s]) => ({
        screen: s.screen, v: s.v, impl: s.impl, n: s.n, frames: s.frames,
        p50: pct(s.p50, 50), p90: pct(s.p90, 50), p90hi: pct(s.p90, 90), jank: pct(s.jank, 50),
        low: s.low, lite: s.lite,
      })),
      devices: top(agg.perf.devices, PERF_ROWS).map(([model, d]) => ({
        model, n: d.n, sdk: d.sdk, mem_mb: d.mem_mb, heap_mb: d.heap_mb, gpu: d.gpu, lowram: d.lowram, low: { ...d.low },
      })),
      trims: { ...agg.perf.trims },
    },
  };
};

const fmtMs = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
const devs = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");

// The same numbers as text — for the admin's Copy button.
const text = () => {
  const s = summary();
  const lines = [];
  lines.push(`Aurora usage — ${s.events} events in ${s.batches} batches` + (s.since ? `, ${new Date(s.since).toISOString().slice(0, 10)} → ${new Date(s.last).toISOString().slice(0, 10)}` : ""));
  lines.push(`Devices: ${devs(s.devices) || "–"} · Looks: ${devs(s.looks) || "–"}`);
  lines.push("");
  lines.push("Screens (views · p50 / p90 to painted · by device)");
  for (const r of s.routes) lines.push(`  ${r.route}  ${r.n} · ${fmtMs(r.p50)} / ${fmtMs(r.p90)} · ${devs(r.byDevice)}`);
  lines.push("");
  lines.push("Features (uses · by device)");
  for (const f of s.features) lines.push(`  ${f.feature}  ${f.n} · ${devs(f.byDevice)}`);
  lines.push("");
  lines.push("Nav taps");
  for (const n of s.nav) lines.push(`  ${n.to}  ${n.n}`);
  lines.push("");
  lines.push("Play starts (kind/path · starts · p50 / p90 to first frame · by device)");
  for (const p of s.plays) lines.push(`  ${p.path}  ${p.n} · ${fmtMs(p.p50)} / ${fmtMs(p.p90)} · ${devs(p.byDevice)}`);
  if (s.errors.length) {
    lines.push("");
    lines.push("Client errors");
    for (const e of s.errors) lines.push(`  ${e.n}× ${e.message}`);
  }
  if (Object.keys(s.net.tiers).length) {
    const kb = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} Mbit/s` : `${Math.round(v)} kbit/s`);
    lines.push("");
    lines.push("Connections (reports per tier · slow ones by device · measured line)");
    lines.push(`  ${devs(s.net.tiers)}${Object.keys(s.net.slowByDevice).length ? ` · slow on: ${devs(s.net.slowByDevice)}` : ""}`);
    lines.push(`  speed p10 / p50: ${kb(s.net.kbpsP10)} / ${kb(s.net.kbpsP50)} · round trip p50 / p90: ${fmtMs(s.net.rttP50)} / ${fmtMs(s.net.rttP90)}`);
    if (Object.keys(s.net.sources).length) lines.push(`  decided by: ${devs(s.net.sources)}`);
  }
  if (s.perf.screens.length) {
    const n1 = (v) => (v == null ? "–" : `${Math.round(v)}`);
    const pc = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "–");
    lines.push("");
    lines.push("TV frames (screen · v · impl · sessions · frames · p50 / p90 ms, medians of sessions · p90 of p90s · jank% · low / lite sessions)");
    for (const r of s.perf.screens) {
      let line = `  ${r.screen}  v${r.v} ${r.impl}  ${r.n} sess · ${fmtCount(r.frames)} frames · ${n1(r.p50)} / ${n1(r.p90)} ms · p90s ${n1(r.p90hi)} ms · ${r.jank == null ? "–" : `${r.jank.toFixed(1)}%`}`;
      if (r.low) line += `   low ${pc(r.low, r.n)}`;
      if (r.lite) line += `  lite ${pc(r.lite, r.n)}`;
      lines.push(line);
    }
  }
  if (s.perf.devices.length || Object.keys(s.perf.trims).length) {
    lines.push("");
    lines.push("TV boxes (model · sessions · sdk · RAM · heap · GPU · low-RAM flag · why low)");
    for (const d of s.perf.devices) {
      const sdk = Object.keys(d.sdk).sort((a, b) => a - b).map((k) => `sdk${k}`).join("/") || "sdk?";
      lines.push(`  ${d.model}  ${d.n} sess · ${sdk}  ${d.mem_mb == null ? "?" : d.mem_mb}MB heap${d.heap_mb == null ? "?" : d.heap_mb}  ${d.gpu || "gpu ?"}  lowram ${d.lowram}  low: ${devs(d.low) || "–"}`);
    }
    if (Object.keys(s.perf.trims).length) lines.push(`  memory warnings (trim level · times): ${devs(s.perf.trims)}`);
  }
  lines.push("");
  lines.push("Active per day (profiles · tabs)");
  for (const d of s.activeByDay) lines.push(`  ${d.day}  ${d.profiles} · ${d.sessions}`);
  return lines.join("\n");
};

// Test hooks: a fresh aggregate, and where the files live.
const _reset = () => { agg = fresh(); pending = []; };

module.exports = { record, validate, boot, summary, text, prune, DIR, KEEP_MONTHS, _reset };
