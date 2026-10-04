// Connection quality: how good is the line between this device and the
// server, and what Aurora should do about it.
//
// Two sources, because neither is enough alone:
//   hints     navigator.connection (Chrome / Android only): Data Saver, the
//             effective type (2g / 3g / 4g), its downlink and round-trip
//             guesses. Available before a single byte has moved.
//   measured  the browser's own Resource Timing for every same-origin
//             response this page receives (posters, API answers, video
//             segments): bytes over the time the body took gives a real
//             throughput, request-to-first-byte gives a real round trip.
//             Works everywhere, Safari included, and it measures the path
//             to THIS server — a phone on fast wifi talking to a home
//             server with a thin uplink is slow, whatever the hints say.
//
//   probed    one small download timed by the page itself (/api/netprobe,
//             48 kB of noise) shortly after start and every few minutes. The
//             offline service worker hides the sizes Resource Timing needs,
//             and on those devices the probe is the only real measurement.
//
// Out of those comes one of three tiers — "slow", "ok", "fast" — stamped on
// <html data-net> and read by the parts of the app that can be lighter:
// poster and backdrop sizes (ui.js), prefetching (prefetch.js), hero
// trailers and the animated sky, Home painting from its last answer, and
// the player's capped stream (see playCap). Preferences → Data use overrides
// the detection either way.
//
// No imports: everything else imports this.

const MODE_KEY = "aurora-data-mode"; // "auto" | "saver" | "full"
const LAST_KEY = "aurora-net-last"; // the last tier, so a reload starts on it
const LAST_TTL_MS = 30 * 60 * 1000;

// Thresholds, in kbit/s and ms. A 1080p file streams at 4–15 Mbit/s and a
// page of posters is ~1 MB: under ~1.5 Mbit/s both hurt, over ~6 nothing does.
export const SLOW_KBPS = 1500;
export const FAST_KBPS = 6000;
export const RECOVER_KBPS = 2800; // leaving "slow" takes more than entering it
export const SLOW_RTT_MS = 900;
const MIN_BYTES = 10 * 1024; // smaller transfers measure latency, not the line
const MIN_SAMPLES = 4;
const KEEP = 14;

const PROBE_KB = 48;
const PROBE_EVERY_MS = 5 * 60 * 1000;
let probed = null; // the last probe's kbit/s — a deliberate measurement, trusted alone
const kbpsSamples = []; // newest last
const rttSamples = [];
const listeners = new Set();
let tier = "ok";
let source = "default";

const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k, v) => {
  try { localStorage.setItem(k, v); } catch {}
};

export const dataMode = () => {
  const m = read(MODE_KEY);
  return m === "saver" || m === "full" ? m : "auto";
};

const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// What the browser itself says (null where it says nothing).
export const hints = () => {
  const c = typeof navigator !== "undefined" && navigator.connection;
  if (!c) return { saveData: false, type: null, downKbps: null, rtt: null };
  return {
    saveData: !!c.saveData,
    type: c.effectiveType || null,
    downKbps: typeof c.downlink === "number" && c.downlink > 0 ? Math.round(c.downlink * 1000) : null,
    rtt: typeof c.rtt === "number" && c.rtt > 0 ? c.rtt : null,
  };
};

// The measured line: median throughput, and the quick end of the round
// trips (the 25th percentile — the slow ones are the server thinking).
export const measured = () => ({
  kbps: kbpsSamples.length >= MIN_SAMPLES ? Math.round(median(kbpsSamples)) : probed != null ? Math.round(probed) : null,
  rtt: rttSamples.length >= MIN_SAMPLES ? Math.round(quantile(rttSamples, 0.25)) : null,
  samples: kbpsSamples.length,
});

// The decision, as a pure function so it can be tested: (hints, measured,
// mode, the tier we are on now) → { tier, source, strong }.
// `strong`: the evidence is good enough to change the STREAM, not only the
// pictures — Data Saver, a 2G line, or a real measurement.
export const classify = (h, m, mode = "auto", current = "ok") => {
  if (mode === "saver") return { tier: "slow", source: "preference", strong: true };
  if (mode === "full") return { tier: "fast", source: "preference", strong: false };
  if (h.saveData) return { tier: "slow", source: "data-saver", strong: true };
  if (h.type === "slow-2g" || h.type === "2g") return { tier: "slow", source: "2g", strong: true };
  if (m.kbps != null) {
    if (m.kbps < SLOW_KBPS) return { tier: "slow", source: "measured", strong: true };
    // hysteresis: a line that was slow has to prove itself before the heavy
    // pictures come back, or a line near the edge flips on every poster
    if (current === "slow" && m.kbps < RECOVER_KBPS) return { tier: "slow", source: "measured", strong: true };
    if (m.rtt != null && m.rtt > SLOW_RTT_MS) return { tier: "slow", source: "latency", strong: false };
    return { tier: m.kbps >= FAST_KBPS ? "fast" : "ok", source: "measured", strong: false };
  }
  if (m.rtt != null && m.rtt > SLOW_RTT_MS) return { tier: "slow", source: "latency", strong: false };
  // Nothing measured yet. The browser's milder guesses ("3g", a low downlink
  // figure) are NOT acted on: Chrome reports "3g" for a laptop talking to
  // localhost, and a wrong "slow" costs picture quality for nothing. The
  // probe answers within a couple of seconds, and the last tier is carried
  // across reloads, so a line that really is slow starts out slow anyway.
  return { tier: current, source: "default", strong: false };
};

let strong = false;
const decide = () => {
  const next = classify(hints(), measured(), dataMode(), tier);
  source = next.source;
  strong = next.strong;
  if (next.tier === tier) return;
  const prev = tier;
  tier = next.tier;
  if (typeof document !== "undefined") document.documentElement.dataset.net = tier;
  write(LAST_KEY, JSON.stringify({ tier, at: Date.now() }));
  for (const fn of listeners) {
    try { fn(tier, prev); } catch {}
  }
};

// One finished same-origin response → maybe a sample.
export const sampleFrom = (e) => {
  if (!e || !e.name || e.responseEnd <= 0) return null;
  const out = {};
  // transferSize 0 = served from a cache: says nothing about the line
  if (e.transferSize > MIN_BYTES && e.responseEnd > e.responseStart && e.responseStart > 0) {
    // A body that arrived in a millisecond or two is a LAN (the usual home
    // server): that is evidence of a fast line, not a missing measurement —
    // without it a wrong "3g" hint from the browser was never overruled.
    const ms = Math.max(1, e.responseEnd - e.responseStart);
    out.kbps = (e.transferSize * 8) / ms;
  }
  if (e.transferSize > 0 && e.requestStart > 0 && e.responseStart > e.requestStart) {
    out.rtt = e.responseStart - e.requestStart;
  }
  return out.kbps || out.rtt ? out : null;
};

const take = (entries) => {
  let changed = false;
  for (const e of entries) {
    let sameOrigin = false;
    try { sameOrigin = new URL(e.name).origin === location.origin; } catch {}
    if (!sameOrigin) continue;
    const s = sampleFrom(e);
    if (!s) continue;
    if (s.kbps) { kbpsSamples.push(s.kbps); if (kbpsSamples.length > KEEP) kbpsSamples.shift(); changed = true; }
    if (s.rtt) { rttSamples.push(s.rtt); if (rttSamples.length > KEEP * 2) rttSamples.shift(); changed = true; }
  }
  if (changed) decide();
};

// Time one small download. The first chunk is left out of the sum: it was
// already on its way when the headers arrived, so counting it flatters a
// slow line. Resolves with the measurement (or null), and feeds the tier.
let probing = false;
export const timeProbe = ({ t0, tHeaders, chunks }) => {
  // chunks: [{ t, bytes }] in arrival order
  if (!chunks || !chunks.length) return null;
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  const total = chunks.reduce((n, c) => n + c.bytes, 0);
  const rest = total - first.bytes;
  const ms = last.t - first.t;
  // everything in one chunk, or the rest within a millisecond: too fast to
  // time — a LAN. Say so with a number well over the "fast" line.
  const kbps = rest > 0 && ms >= 1 ? (rest * 8) / ms : (total * 8) / Math.max(1, last.t - tHeaders || 1);
  return { kbps, rtt: Math.max(1, tHeaders - t0) };
};
export const probe = async () => {
  if (probing || typeof fetch === "undefined" || !navigator.onLine || dataMode() === "full") return null;
  probing = true;
  try {
    const t0 = performance.now();
    const res = await fetch(`/api/netprobe?kb=${PROBE_KB}&t=${Date.now()}`, { cache: "no-store", priority: "low" });
    if (!res.ok || !res.body) return null;
    const tHeaders = performance.now();
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ t: performance.now(), bytes: value.byteLength });
    }
    const m = timeProbe({ t0, tHeaders, chunks });
    if (!m) return null;
    probed = m.kbps;
    kbpsSamples.push(m.kbps);
    if (kbpsSamples.length > KEEP) kbpsSamples.shift();
    rttSamples.push(m.rtt);
    if (rttSamples.length > KEEP * 2) rttSamples.shift();
    decide();
    return m;
  } catch {
    return null;
  } finally {
    probing = false;
  }
};

// ---------- the public face ----------
export const netTier = () => tier;
export const netSource = () => source;
// "be lighter": smaller pictures, no prefetch, no trailers
export const lite = () => tier === "slow";
export const fastNet = () => tier === "fast";

// The height to cap a stream at, or 0 for the file as it is. Only when the
// evidence is strong (see classify); a very thin line gets 480p.
export const playCap = () => {
  if (tier !== "slow" || !strong) return 0;
  const m = measured();
  const h = hints();
  // 480p only on real evidence of a very thin line (the browser's downlink
  // guess is not that); Data saver with nothing measured means 720p
  if (h.type === "slow-2g" || h.type === "2g" || (m.kbps != null && m.kbps < 900)) return 480;
  return 720;
};

export const setDataMode = (mode) => {
  write(MODE_KEY, mode === "saver" || mode === "full" ? mode : "auto");
  decide();
};

// fn(tier, previousTier) on every change; returns the unsubscribe.
export const onNet = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// A snapshot for the usage stats and the report sheet.
export const netInfo = () => {
  const m = measured();
  const h = hints();
  return { tier, source, mode: dataMode(), kbps: m.kbps, rtt: m.rtt, type: h.type, saveData: h.saveData };
};

// ---------- boot ----------
if (typeof window !== "undefined" && typeof document !== "undefined") {
  // start on the last known tier, so the first screenful of posters is
  // already the right size on a line that was slow a minute ago
  try {
    const last = JSON.parse(read(LAST_KEY) || "null");
    if (last && Date.now() - last.at < LAST_TTL_MS && ["slow", "ok", "fast"].includes(last.tier)) tier = last.tier;
  } catch {}
  document.documentElement.dataset.net = tier;
  decide();
  try {
    new PerformanceObserver((list) => take(list.getEntries())).observe({ type: "resource", buffered: true });
  } catch {}
  const c = navigator.connection;
  if (c && c.addEventListener) c.addEventListener("change", () => { decide(); probe(); });
  addEventListener("online", () => { decide(); probe(); });
  // the first probe once the first screen has had the line to itself, then
  // every few minutes while the tab is looked at (240 kB an hour)
  setTimeout(probe, 1200);
  setInterval(() => { if (!document.hidden) probe(); }, PROBE_EVERY_MS);
}
