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
// WHAT A MEASUREMENT IS (2026-10-26: "the site almost always says I have a
// slow connection when I get in"). Timed one response at a time, a page that
// is loading measured itself: thirty posters and modules arriving at once
// each get a thirtieth of the line, and each one read as a slow line — a
// 10 Mbit/s line 150 ms away measured ~1.6 Mbit/s, "slow", in the first
// seconds of every visit (real Chrome on emulated lines,
// test/ui/net-entry.test.js). So now:
//   - responses that arrive together are ONE reading: their bytes over the
//     time the line was busy with them (bursts), and a burst of less than
//     ~96 kB says more about the round trip than about the line — none;
//   - the round trip leaves out the server's own time (its Server-Timing);
//   - the probe waits until the page has stopped loading, and a slow first
//     reading is looked at again with a bigger download;
//   - a MEASURED slow line has to stay slow: at least 20 s and three fresh
//     readings before Aurora goes lighter by itself (Data Saver, 2G and the
//     person's own choice still count at once);
//   - and the viewer is told only when it changes what they watch — a film
//     started on a lighter stream — once a session, and not again for a day
//     after "OK" (slowNoteDue / slowNoteShown / slowNoteDismissed, below).
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
export const BURST_MIN_BYTES = 96 * 1024; // a burst smaller than this: the round trip, not the line
const BURST_IDLE_MS = 1200; // a burst is over once nothing has arrived for this long
const BURST_MAX_WAIT_MS = 8000; // …or this long after it began, whatever still arrives
const MIN_SAMPLES = 4;
const KEEP = 14;
export const SUSTAIN_MS = 20000; // a measured slow line stays slow this long…
export const SUSTAIN_READINGS = 3; // …over this many fresh readings, before Aurora acts on it

const PROBE_KB = 64;
const CONFIRM_KB = 192; // a second look, big enough that a new connection's slow start does not decide it
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

// A measured slow line has to last: (state, the classification, the tier we
// are on, now, what is new: "kbps" a throughput reading, "rtt" round trips,
// or nothing) → { apply, st }. PURE. A reading counts toward the verdict it
// is evidence for: a throughput one for "measured", round trips for "latency".
// Anything else — leaving slow, a preference, Data Saver, 2G — applies at once.
export const sustain = (st, next, current, now, fresh = "kbps") => {
  const measuredSlow = next.tier === "slow" && current !== "slow" && (next.source === "measured" || next.source === "latency");
  if (!measuredSlow) return { apply: true, st: { since: 0, seen: 0 } };
  const since = st && st.since ? st.since : now;
  const counts = fresh === "kbps" || (fresh === "rtt" && next.source === "latency");
  const seen = ((st && st.seen) || 0) + (counts ? 1 : 0);
  // (and the reading that settles it is a fresh one: readings from the first
  // seconds and then a quiet wait are not 20 s of a slow line)
  return { apply: counts && now - since >= SUSTAIN_MS && seen >= SUSTAIN_READINGS, st: { since, seen } };
};

let strong = false;
let held = { since: 0, seen: 0 }; // a slow reading waiting to be sustained
let heldCheck = null;
const decide = (fresh = null) => {
  let next = classify(hints(), measured(), dataMode(), tier);
  const gate = sustain(held, next, tier, Date.now(), fresh);
  held = gate.st;
  if (!gate.apply) {
    // not yet: another look (a probe is a fresh reading) half way, and once
    // the time is up — a line that really is slow is acted on ~20 s after it
    // first read slow, not whenever the page next happens to load something
    if (!heldCheck && typeof setTimeout === "function") {
      const at = held.since + (held.seen < SUSTAIN_READINGS - 1 ? SUSTAIN_MS / 2 : SUSTAIN_MS) + 500;
      heldCheck = setTimeout(() => {
        heldCheck = null;
        whenQuiet(() => { if (!behindFilm()) probe({ kb: CONFIRM_KB }); });
      }, Math.max(1000, at - Date.now()));
    }
    return;
  }
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
  // A <video> paces its own download to its buffer, not to the line: a
  // direct-played file "arrives" at about its own bitrate however fast the
  // connection is, and a low-bitrate episode would read as a slow line.
  if (e.initiatorType === "video" || e.initiatorType === "audio" || /\/(stream|offline)\//.test(e.name)) return null;
  const out = {};
  // transferSize 0 = served from a cache: says nothing about the line
  if (e.transferSize > MIN_BYTES && e.responseEnd > e.responseStart && e.responseStart > 0) {
    // A body that arrived in a millisecond or two is a LAN (the usual home
    // server): that is evidence of a fast line, not a missing measurement —
    // without it a wrong "3g" hint from the browser was never overruled.
    const ms = Math.max(1, e.responseEnd - e.responseStart);
    out.kbps = (e.transferSize * 8) / ms;
    // (this response alone; take() reads it together with the others that came with it)
    out.body = { start: e.responseStart, end: e.responseEnd, bytes: e.transferSize };
  }
  if (e.transferSize > 0 && e.requestStart > 0 && e.responseStart > e.requestStart) {
    // the server's own time (its Server-Timing "app", lib/servertiming.js) is
    // not the line: a poster fetched from far away, an answer worked out
    const app = (e.serverTiming || []).find((t) => t && t.name === "app");
    const think = app && app.duration > 0 ? app.duration : 0;
    out.rtt = Math.max(1, e.responseStart - e.requestStart - think);
  }
  return out.kbps || out.rtt ? out : null;
};

// Responses that arrived together are one reading: their bytes over the time
// the line was busy with them. PURE. [{ start, end, bytes }] → [{ kbps, bytes, ms, n }]
// — only the bursts big enough to say something about the line.
export const bursts = (bodies, minBytes = BURST_MIN_BYTES) => {
  const list = bodies.filter((b) => b && b.end > b.start && b.bytes > 0).sort((a, b) => a.start - b.start);
  const out = [];
  let cur = null;
  const close = () => {
    if (!cur || cur.bytes < minBytes) return;
    const ms = Math.max(1, cur.end - cur.start);
    out.push({ kbps: (cur.bytes * 8) / ms, bytes: cur.bytes, ms, n: cur.n });
  };
  for (const b of list) {
    if (cur && b.start <= cur.end) {
      cur.end = Math.max(cur.end, b.end);
      cur.bytes += b.bytes;
      cur.n++;
    } else {
      close();
      cur = { start: b.start, end: b.end, bytes: b.bytes, n: 1 };
    }
  }
  close();
  return out;
};

const pushKbps = (k) => {
  kbpsSamples.push(k);
  if (kbpsSamples.length > KEEP) kbpsSamples.shift();
};
let lastArrival = 0; // when the page last received anything (the probe waits for quiet)
let bodies = [];
let burstTimer = null;
let burstFirst = 0;
const flushBursts = () => {
  burstTimer = null;
  const list = bodies;
  bodies = [];
  let changed = false;
  for (const b of bursts(list)) {
    pushKbps(b.kbps);
    changed = true;
  }
  if (changed) decide("kbps");
};
const take = (entries) => {
  let changed = false;
  for (const e of entries) {
    let sameOrigin = false;
    try { sameOrigin = new URL(e.name).origin === location.origin; } catch {}
    if (!sameOrigin) continue;
    lastArrival = performance.now();
    if (e.name.includes("/api/netprobe")) continue; // the probe times itself
    const s = sampleFrom(e);
    if (!s) continue;
    if (s.body) {
      if (!bodies.length) burstFirst = performance.now();
      bodies.push(s.body);
    }
    if (s.rtt) { rttSamples.push(s.rtt); if (rttSamples.length > KEEP * 2) rttSamples.shift(); changed = true; }
  }
  if (bodies.length) {
    clearTimeout(burstTimer);
    burstTimer = setTimeout(flushBursts, performance.now() - burstFirst > BURST_MAX_WAIT_MS ? 0 : BURST_IDLE_MS);
  }
  if (changed) decide("rtt");
};

// A film on screen owns the line: a probe then measures the leftovers.
const behindFilm = () => typeof document !== "undefined" && !!document.querySelector(".player");

// fn once the page has stopped loading: nothing arrived for a second (and
// never sooner than 2.5 s into the page), or at the latest after 15 s.
const whenQuiet = (fn, { quietMs = 1000, maxMs = 15000 } = {}) => {
  const t0 = performance.now();
  const check = () => {
    const now = performance.now();
    const loaded = typeof document === "undefined" || document.readyState === "complete";
    if ((loaded && now >= 2500 && now - lastArrival >= quietMs) || now - t0 >= maxMs) return fn();
    setTimeout(check, 250);
  };
  check();
};

// Time one small download. The first chunk is left out of the sum: it was
// already on its way when the headers arrived, so counting it flatters a
// slow line. Resolves with the measurement (or null), and feeds the tier.
let probing = false;
let confirming = false; // a slow reading is waiting for its second opinion
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
export const probe = async ({ kb = PROBE_KB } = {}) => {
  if (probing || typeof fetch === "undefined" || !navigator.onLine || dataMode() === "full") return null;
  probing = true;
  try {
    const t0 = performance.now();
    const res = await fetch(`/api/netprobe?kb=${kb}&t=${Date.now()}`, { cache: "no-store", priority: "low" });
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
    // One slow reading is not a slow line. A probe that lands while the page
    // is pulling a screenful of posters shares the connection with them and
    // can read low on a perfectly good line — and "slow" costs that person
    // picture quality and a capped stream. So a first slow reading on a line
    // not already known to be slow is only a reason to look again in a few
    // seconds; it counts when the second look agrees. (The caller still gets
    // the reading: the player asks during a real stall and judges for itself.)
    // (the second look waits for a quiet page, and downloads more)
    if (m.kbps < SLOW_KBPS && tier !== "slow" && !confirming) {
      confirming = true;
      setTimeout(() => whenQuiet(() => {
        if (behindFilm()) { confirming = false; return; }
        probe({ kb: CONFIRM_KB }).finally(() => { confirming = false; });
      }), 4000);
      return m;
    }
    probed = m.kbps;
    pushKbps(m.kbps);
    rttSamples.push(m.rtt);
    if (rttSamples.length > KEEP * 2) rttSamples.shift();
    decide("kbps");
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

// Which capped stream fits a line: the 720p one runs at up to ~2.4 Mbit/s all
// in, the 480p one at ~1.1 — so 720p only for a line with room for it. With
// nothing measured (Data saver on an unmeasured line), 720p.
export const capFor = (kbps, type = null) =>
  type === "slow-2g" || type === "2g" || (kbps != null && kbps < 2800) ? 480 : 720;

// The height to cap a stream at, or 0 for the file as it is. Only when the
// evidence is strong (see classify); a very thin line gets 480p.
export const playCap = () => {
  if (tier !== "slow" || !strong) return 0;
  const m = measured();
  const h = hints();
  return capFor(m.kbps, h.type);
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

// ---------- telling the viewer ----------
// Only when it changes what they watch (the player starting a film on a
// lighter stream because of the line), at most once a session, and not again
// for a day after they pressed OK on it.
const TOLD_KEY = "aurora-net-told"; // sessionStorage: said in this session
const QUIET_KEY = "aurora-net-quiet-until"; // localStorage: OK pressed, quiet until then
export const SLOW_NOTE_QUIET_MS = 24 * 3600 * 1000;
// PURE: (said this session?, quiet until, now) → may it be said?
export const slowNoteAllowed = (toldThisSession, quietUntil, now) => !toldThisSession && !(quietUntil > now);
const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
};
export const slowNoteDue = () => slowNoteAllowed(session.get(TOLD_KEY) === "1", Number(read(QUIET_KEY)) || 0, Date.now());
export const slowNoteShown = () => session.set(TOLD_KEY, "1");
export const slowNoteDismissed = () => write(QUIET_KEY, String(Date.now() + SLOW_NOTE_QUIET_MS));

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
  // (a line already known to be slow keeps its first seconds for the page)
  // (once the page has stopped loading: a probe that shares the line with
  // the first screenful of posters measures them, not the line)
  whenQuiet(() => probe());
  // Never behind a film: the video owns the line then, so a probe would
  // measure the leftovers and call a good connection slow. The player asks
  // for its own measurement when playback actually stalls.
  setInterval(() => { if (!document.hidden && !behindFilm()) probe(); }, PROBE_EVERY_MS);
}
