// Resolve a library title to its IMDb id.
//
// The scanner never records one — local metadata comes from TMDB and filenames —
// but everything on the streaming side (episode lists, torrent sources, subtitle
// providers) is keyed by IMDb id. Two callers need this: the detail page, so an
// owned title can still offer sources, and the subtitle backfill tool.
//
// Answers are cached on disk forever. They cannot change, and the detail page
// asks on every view.
const path = require("path");
const config = require("../config");
const discover = require("./discover");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "imdb-map.json"), {});
const NEGATIVE_TTL = 7 * 24 * 3600 * 1000; // retry "no match" after a week

const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// The IMDb id for a title, or null. `type` is "movie" or "show".
const resolve = async (title, type, year) => {
  const clean = String(title || "").trim();
  if (!clean) return null;
  const kind = type === "show" ? "show" : "movie";
  const key = `${kind}|${norm(clean)}|${year || ""}`;

  const hit = store.data[key];
  if (hit && (hit.imdbId || Date.now() - (hit.at || 0) < NEGATIVE_TTL)) {
    return hit.imdbId || null;
  }

  let imdbId = null;
  try {
    const results = await discover.search(clean);
    const pool = (kind === "show" ? results.shows : results.movies).filter((m) => m.imdbId);
    const want = norm(clean);
    const exact = pool.filter((m) => norm(m.title) === want);
    // Folder names carry extra words ("Avatar Movie" for Avatar), so also accept
    // a candidate whose title is a prefix of ours — but only with the year
    // agreeing, which is what keeps "Alien" off "Alien Romulus".
    const loose = pool.filter(
      (m) => norm(m.title).startsWith(want) ||
        (year && m.year && Math.abs(m.year - year) <= 1 && want.startsWith(norm(m.title)))
    );
    const ranked = (exact.length ? exact : loose).sort((a, b) => {
      if (!year) return 0;
      return Math.abs((a.year || 0) - year) - Math.abs((b.year || 0) - year);
    });
    const best = ranked[0];
    // A year that disagrees by more than a year is a different title.
    if (best && (!year || !best.year || Math.abs(best.year - year) <= 1)) imdbId = best.imdbId;
  } catch {
    // Provider down — don't cache that as "no match".
    return null;
  }

  store.data[key] = { imdbId, at: Date.now() };
  store.save();
  return imdbId;
};

module.exports = { resolve, _internals: { norm } };
