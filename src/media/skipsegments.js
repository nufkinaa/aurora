// Intro / recap / credits / preview timestamps from the two public,
// crowd-sourced databases — SkipDB (api.skipdb.tv) and TheIntroDB
// (api.theintrodb.org). Both are keyed by IMDb id + season + episode, both
// take the stream's duration so a cut with an extra logo up front can be told
// apart, and neither needs a key to read.
//
// Where this sits: Aurora's own detector (introdetect.js — chapter markers,
// then the audio every episode of a season shares) is measured on the very
// file being played, so it stays the first answer for a library episode.
// This module fills what that cannot reach:
//   * STREAMED episodes — there is no local file to fingerprint, so until now
//     a stream never had Skip intro or a credits-timed Up next at all;
//   * a season of ONE episode (nothing to compare it with);
//   * episodes where the audio pass found nothing (a cold open that differs,
//     an intro shorter than its floor);
//   * RECAPS and "next time" previews, which repeat in no other episode and
//     so can never be found by comparison.
//
// Trust: a segment is used when the database says its duration match is
// exact or shifted, or when the two databases agree with each other; a lone
// uncertain answer ("out-of-range", or a low-confidence guess with no
// duration to compare) is dropped rather than shown as a button that skips
// to the wrong place. Everything is sanity-bounded against the runtime.
//
// Kept current: an answer is fresh for a day. After that it is still served
// at once (a stale Skip intro beats a two-second wait) while it is re-asked
// in the background, and the daily round (lib/daily.js → refreshRecent)
// re-asks every streamed episode someone played in the last month, so an
// intro submitted for last night's episode shows up by tomorrow. A re-ask
// that fails, or that one database didn't answer, never erases what was
// already known.
//
// Polite by construction: one request at a time per host with a gap between
// them, answers cached on disk, failures remembered for an hour. Only a
// show's IMDb id, season, episode and runtime ever leave the server.
// `"skipDatabases": false` in config.json turns the whole thing off.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const SKIPDB = "https://api.skipdb.tv/api/segments";
const TIDB = "https://api.theintrodb.org/v3/media";
const FRESH_MS = 20 * 3600 * 1000; // under a day, so the daily round always finds yesterday's answers due
const RECENT_MS = 30 * 24 * 3600 * 1000; // a streamed episode played this recently is kept current
const FAIL_TTL = 60 * 60 * 1000;
const GAP_MS = 700; // per host: well under SkipDB's 120/min
const TIMEOUT_MS = 7000;
const MAX_ENTRIES = 6000;

const store = new JsonStore(path.join(config.CACHE_DIR, "skip-segments.json"), {});
const failures = new Map(); // key -> at
const inflight = new Map(); // key -> promise

const enabled = () => config.SKIP_DATABASES !== false;

// ---------- one polite queue per host ----------
const queues = new Map(); // host -> promise chain
const politely = (host, fn) => {
  const prev = queues.get(host) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  // the NEXT caller waits for this one plus the gap; this caller gets its
  // answer the moment it arrives
  queues.set(host, run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP_MS))));
  return run;
};

const getJson = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Aurora (personal media server)", Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

// ---------- normalizing the two shapes ----------
const sec = (ms) => (Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
const range = (o) => {
  if (!o) return null;
  const start = sec(o.start_ms);
  const end = sec(o.end_ms);
  if (start == null && end == null) return null;
  return { start: start == null ? 0 : start, end };
};

// SkipDB: one best object per type, with how well the duration matched.
const fromSkipDb = (j) => {
  if (!j || !j.segments) return {};
  const out = {};
  for (const [theirs, ours] of [["intro", "intro"], ["recap", "recap"], ["outro", "credits"], ["preview", "preview"]]) {
    const s = j.segments[theirs];
    const r = range(s);
    if (!r) continue;
    out[ours] = { ...r, match: s.match || "agnostic", confidence: Number.isFinite(s.confidence) ? s.confidence : null };
  }
  return out;
};

// TheIntroDB: arrays per type (usually one entry), no match quality.
const fromTidb = (j) => {
  if (!j) return {};
  const out = {};
  for (const type of ["intro", "recap", "credits", "preview"]) {
    const first = Array.isArray(j[type]) ? j[type][0] : null;
    const r = range(first);
    if (r) out[type] = r;
  }
  return out;
};

// Does a segment make sense for this kind and this runtime?
const plausible = (type, seg, duration) => {
  if (!seg || !Number.isFinite(seg.start) || seg.start < 0) return false;
  const end = Number.isFinite(seg.end) ? seg.end : null;
  if (end != null && end <= seg.start) return false;
  const len = end != null ? end - seg.start : null;
  const d = duration > 0 ? duration : null;
  if (type === "intro") {
    if (len == null || len < 5 || len > 300) return false;
    return !d || seg.start < d * 0.5;
  }
  if (type === "recap") {
    if (len == null || len < 5 || len > 420) return false;
    return !d || seg.start < d * 0.3;
  }
  // credits / preview live at the end
  if (d && seg.start < d * 0.6) return false;
  if (d && seg.start > d - 3) return false;
  return true;
};

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// Merge what the two databases said into one answer, segment by segment.
// Exported for tests: this is the judgement the whole module exists for.
const merge = (skipdb, tidb, duration) => {
  const out = { intro: null, recap: null, credits: null, preview: null, source: null };
  const used = new Set();
  for (const type of ["intro", "recap", "credits", "preview"]) {
    const a = skipdb && skipdb[type];
    const b = tidb && tidb[type];
    const aOk = a && plausible(type, a, duration);
    const bOk = b && plausible(type, b, duration);
    const agree = aOk && bOk && near(a.start, b.start, 5);
    let pick = null;
    if (agree) {
      // two independent submissions within 5s: take SkipDB's (it carries an
      // end for credits more often) unless it is the unmatched one
      pick = a.match === "out-of-range" ? b : a;
      used.add("skipdb").add("theintrodb");
    } else if (aOk && (a.match === "exact" || a.match === "shifted")) {
      pick = a;
      used.add("skipdb");
    } else if (bOk && (!aOk || a.match === "out-of-range")) {
      // TheIntroDB alone — it was asked with the duration, and it is curated
      pick = b;
      used.add("theintrodb");
    } else if (aOk && a.match === "agnostic" && (a.confidence == null || a.confidence >= 0.7)) {
      pick = a; // no duration to compare, but a confident entry
      used.add("skipdb");
    }
    if (pick) out[type] = { start: pick.start, end: Number.isFinite(pick.end) ? pick.end : null };
  }
  out.source = used.size ? [...used].join("+") : null;
  return out;
};

const keyFor = (imdbId, season, episode, duration) =>
  `${imdbId}:${season || 0}:${episode || 0}:${duration > 0 ? Math.round(duration / 20) : 0}`;

const isEmpty = (r) => !r || !(r.intro || r.recap || r.credits || r.preview);

const TYPES = ["intro", "recap", "credits", "preview"];

// A re-ask where a database didn't answer must not forget what it said last
// time: each segment the new answer lacks is kept from the old one. (When
// both answered, the new answer stands as-is — a segment they withdrew is
// gone for a reason.)
const keepKnown = (fresh, old) => {
  if (!old) return fresh;
  const out = { ...fresh };
  const used = new Set(String(fresh.source || "").split("+").filter(Boolean));
  for (const t of TYPES) {
    if (!out[t] && old[t]) {
      out[t] = old[t];
      for (const s of String(old.source || "").split("+").filter(Boolean)) used.add(s);
    }
  }
  out.source = used.size ? [...used].join("+") : null;
  return out;
};

const prune = () => {
  const keys = Object.keys(store.data);
  if (keys.length <= MAX_ENTRIES) return;
  const last = (k) => Math.max(store.data[k].at || 0, store.data[k].used || 0);
  keys.sort((x, y) => last(x) - last(y));
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES + 200)) delete store.data[k];
};

// What's cached for this episode, fresh or not, without touching the network.
const cached = ({ imdbId, season, episode, duration }) => {
  const hit = store.data[keyFor(imdbId, season, episode, Math.max(0, Math.round(Number(duration) || 0)))];
  return hit ? hit.res : undefined;
};

// Ask both databases now. Resolves to the merged answer, or null when
// neither could be reached (the caller keeps whatever it had).
const ask = (key, { imdbId, season, episode, duration }) => {
  if (inflight.has(key)) return inflight.get(key);
  const qs = (extra) => {
    const p = new URLSearchParams({ imdb_id: imdbId });
    if (season && episode) { p.set("season", String(season)); p.set("episode", String(episode)); }
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, String(v));
    return p.toString();
  };
  const p = (async () => {
    const [a, b] = await Promise.allSettled([
      politely("skipdb", () => getJson(`${SKIPDB}?${qs({ duration })}`)),
      politely("tidb", () => getJson(`${TIDB}?${qs({ duration_ms: duration ? duration * 1000 : 0 })}`)),
    ]);
    if (a.status === "rejected" && b.status === "rejected") {
      failures.set(key, Date.now());
      return null;
    }
    let res = merge(
      a.status === "fulfilled" ? fromSkipDb(a.value) : {},
      b.status === "fulfilled" ? fromTidb(b.value) : {},
      duration,
    );
    const prev = store.data[key];
    if (a.status === "rejected" || b.status === "rejected") res = keepKnown(res, prev && prev.res);
    store.data[key] = { ...(prev || {}), at: Date.now(), res };
    prune();
    store.save();
    return res;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

// The answer for one episode (or film, with no season/episode). Never throws;
// nothing found is an answer too.
//   * fresh cache (under a day) → served as-is;
//   * stale cache → served at once, re-asked in the background;
//   * nothing cached → asked now.
// `force` (the refresh rounds) always asks, and waits for the answer.
// `failed: true` on the result means nobody could be reached and nothing was
// known — callers holding an older answer should keep it.
const lookup = async ({ imdbId, season = null, episode = null, duration = 0 }, { force = false, played = false } = {}) => {
  const empty = { intro: null, recap: null, credits: null, preview: null, source: null };
  if (!enabled() || !/^tt\d{4,12}$/.test(String(imdbId || ""))) return empty;
  duration = Math.max(0, Math.round(Number(duration) || 0));
  const q = { imdbId, season, episode, duration };
  const key = keyFor(imdbId, season, episode, duration);
  const hit = store.data[key];
  if (hit && played) { hit.used = Date.now(); store.save(); }
  const recentlyFailed = Date.now() - (failures.get(key) || 0) < FAIL_TTL;
  if (hit && !force) {
    if (Date.now() - hit.at >= FRESH_MS && !recentlyFailed) ask(key, q).catch(() => {});
    return hit.res;
  }
  if (recentlyFailed && !force) return { ...empty, failed: true };
  const res = await ask(key, q).catch(() => null);
  if (res && played && store.data[key] && !store.data[key].used) store.data[key].used = Date.now();
  if (res) return res;
  return { ...(hit ? hit.res : empty), failed: true };
};

// The daily round for STREAMED episodes: every cached answer someone played
// in the last month and that is over a day old is asked again. (Library
// episodes are refreshed by introdetect, which owns their records.) Empty
// answers go first — they are the ones most likely to have changed.
const refreshRecent = async ({ limit = 600 } = {}) => {
  if (!enabled()) return { asked: 0, changed: 0 };
  const now = Date.now();
  const due = Object.entries(store.data)
    .filter(([, v]) => v.used && now - v.used < RECENT_MS && now - (v.at || 0) >= FRESH_MS)
    .sort(([, x], [, y]) => (isEmpty(y.res) - isEmpty(x.res)) || (x.at || 0) - (y.at || 0))
    .slice(0, limit);
  let asked = 0;
  let changed = 0;
  for (const [key, v] of due) {
    const [imdbId, s, e, bucket] = key.split(":");
    // the key keeps the runtime only to the nearest 20s — close enough for
    // the databases' own duration matching
    const q = { imdbId, season: Number(s) || null, episode: Number(e) || null, duration: Number(bucket) * 20 };
    const before = JSON.stringify(v.res);
    const res = await ask(key, q).catch(() => null);
    asked++;
    if (res && JSON.stringify(res) !== before) changed++;
  }
  return { asked, changed };
};

module.exports = { lookup, cached, enabled, refreshRecent, _internals: { merge, plausible, fromSkipDb, fromTidb, keyFor, keepKnown, FRESH_MS } };
