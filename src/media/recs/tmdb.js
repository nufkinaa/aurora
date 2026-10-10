// The recommender's one door to TMDB: paced, retried once, counted.
//
// Everything the title index learns from outside comes through here, so the
// request cost of "wider knowledge" is a number that can be read (stats())
// and bounded (the callers pass budgets), not a guess. Pacing is global: at
// most one request every GAP_MS however many callers are waiting — a first
// index build is a couple of thousand calls and must not look like a burst.
const config = require("../../config");

const TMDB = "https://api.themoviedb.org/3";
const GAP_MS = 110; // ~9 requests a second, well under TMDB's limit
let nextAt = 0;
const counters = { calls: 0, ok: 0, failed: 0, since: Date.now(), byDay: {} };

const hasKey = () => !!config.TMDB_KEY;

const slot = async () => {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
};

// `fetchImpl` is injectable so tests never touch the network.
let fetchImpl = (...a) => fetch(...a);
const setFetch = (fn) => { fetchImpl = fn || ((...a) => fetch(...a)); };

const get = async (pathname, params = "", attempt = 0) => {
  if (!config.TMDB_KEY) throw new Error("tmdb: no key");
  await slot();
  const day = new Date().toISOString().slice(0, 10);
  counters.calls++;
  counters.byDay[day] = (counters.byDay[day] || 0) + 1;
  let res;
  try {
    res = await fetchImpl(`${TMDB}/${pathname}?api_key=${config.TMDB_KEY}${params}`, {
      signal: AbortSignal.timeout(9000),
    });
  } catch (err) {
    if (attempt < 1) return get(pathname, params, attempt + 1);
    counters.failed++;
    throw err;
  }
  try { require("../../lib/signals").provider(TMDB, res.status); } catch {}
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await new Promise((r) => setTimeout(r, 600));
    return get(pathname, params, attempt + 1);
  }
  if (!res.ok) {
    counters.failed++;
    const err = new Error(`tmdb ${res.status}`);
    err.status = res.status;
    throw err;
  }
  counters.ok++;
  return res.json();
};

const stats = () => {
  const days = Object.keys(counters.byDay).sort();
  for (const d of days.slice(0, -7)) delete counters.byDay[d];
  return { ...counters, byDay: { ...counters.byDay } };
};

module.exports = { get, hasKey, stats, setFetch, GAP_MS };
