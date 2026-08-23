// Library API: browse, item details, search, and the composed home screen.
const path = require("path");
const express = require("express");
const config = require("../config");
const scanner = require("../media/scanner");
const profiles = require("../profiles");
const discover = require("../media/discover");
const hero = require("../media/hero");
const availability = require("../media/availability");
const newEpisodes = require("../media/newEpisodes");
const { JsonStore } = require("../lib/jsonstore");

const router = express.Router();

// ---------- skip intro ----------
// One intro range per SHOW, marked once by anyone in the household from the
// player (same trust model as watch progress). Every episode of the show then
// offers "Skip intro" inside that range. Keys: "show:<libraryShowId>" for
// library shows, "imdb:<ttId>" for streamed ones.
const intros = new JsonStore(path.join(config.DATA_DIR, "intros.json"), {});
const INTRO_KEY = /^(show|imdb):[\w.-]{1,40}$/;

router.get("/api/intro/:key", (req, res) => {
  res.json(intros.data[req.params.key] || {});
});

router.post("/api/intro/:key", (req, res) => {
  const key = req.params.key;
  if (!INTRO_KEY.test(key)) return res.status(400).json({ error: "bad key" });
  const start = Number(req.body && req.body.start);
  const end = Number(req.body && req.body.end);
  // Sanity bounds: a real intro starts inside the first act and runs seconds
  // to a few minutes — anything else is a mis-press, refuse it.
  if (
    !isFinite(start) || !isFinite(end) ||
    start < 0 || end <= start || end - start > 600 || start > 3600
  ) {
    return res.status(400).json({ error: "bad range" });
  }
  intros.data[key] = { start: Math.floor(start), end: Math.floor(end) };
  intros.save();
  res.json({ ok: true, ...intros.data[key] });
});

router.delete("/api/intro/:key", (req, res) => {
  delete intros.data[req.params.key];
  intros.save();
  res.json({ ok: true });
});

// Drop the episode tree from a LIST entry.
//
// `seasons` is 75% of /api/library and 74% of /api/home — 762 KB of the home
// payload, because a show that lands in three rows was sent with its whole tree
// three times over (651 of 951 item objects in one response were duplicates).
// Nothing that renders a list touches it: every consumer (the detail page's
// mergeSeasons, the player's Up Next) reads seasons off /api/item/:id, which is
// untouched. `episodeCount` is a scalar the scanner already stores separately,
// so "93 episodes" still renders.
const listEntry = (i) => {
  if (!i || !i.seasons) return i;
  const { seasons, ...rest } = i;
  return rest;
};

// Non-secret display config the client needs before a profile is picked.
router.get("/api/server-info", (req, res) => {
  res.json({ adminName: require("../config").ADMIN_NAME });
});

router.get("/api/library", (req, res) => {
  res.json({
    movies: scanner.index.movies,
    shows: scanner.index.shows.map(listEntry),
    scannedAt: scanner.index.scannedAt,
    enriched: scanner.index.enriched,
  });
});

router.get("/api/item/:id", (req, res) => {
  const id = req.params.id;

  // Torrent items are handed to the player directly by the Discover page. On a
  // page refresh the client's in-memory item is gone — rebuild it from the
  // profile's stored play-item (keeps transcode URLs, title, poster, season/
  // episode, resume). Falls back to the bare stub below if nothing is stored.
  if (id.startsWith("torrent|")) {
    const stored = req.query.profile ? profiles.getStreamItem(req.query.profile, id) : null;
    if (stored) return res.json({ ...stored, subtitles: stored.subtitles || [] });
    const [, infoHash, fileIdx] = id.split("|");
    const idx = parseInt(fileIdx, 10) || 0;
    return res.json({
      id,
      type: "movie",
      title: "Streaming…",
      videoUrl: `/stream/torrent/${infoHash}/${idx}`,
      downloadUrl: `/stream/torrent/${infoHash}/${idx}`,
      // Transcode base so a refreshed page can still fall back to server
      // transcode (and seek) for codecs the browser can't decode.
      transcodeBase: `/stream/torrent/hls/${infoHash}/${idx}`,
      transcodeV: "h264",
      subtitles: [],
      infoHash,
      _isTorrent: true,
    });
  }

  const item = scanner.findById(id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

router.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const score = (title) => {
    const t = title.toLowerCase();
    if (t === q) return 3;
    if (t.startsWith(q)) return 2;
    if (t.includes(q)) return 1;
    // every word of the query appears somewhere
    const words = q.split(/\s+/);
    return words.length > 1 && words.every((w) => t.includes(w)) ? 0.5 : 0;
  };

  const results = [];
  for (const m of scanner.index.movies) {
    const s = score(m.title);
    if (s > 0) results.push({ score: s, item: m });
  }
  for (const show of scanner.index.shows) {
    const s = score(show.title);
    if (s > 0) results.push({ score: s, item: show });
    else {
      // Surface episode-title matches under their show
      for (const season of show.seasons) {
        for (const ep of season.episodes) {
          if (ep.title && score(ep.title) > 0) {
            results.push({ score: 0.4, item: show });
            break;
          }
        }
        if (results.length && results[results.length - 1].item === show) break;
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  res.json({ results: results.slice(0, 40).map((r) => r.item) });
});

// The order home reads in, top to bottom.
//
// Declared here rather than being whatever order the code below happens to push
// in: the rows are built in the order their DATA is convenient to assemble, which
// is not the order anyone wants to read them. Anything not named keeps its
// relative position below all of these — the "Top Rated by You" and "More
// <genre>" shelves, the genre rows and All Movies, which belong at the foot of the
// page.
const ROW_ORDER = [
  "continue",
  "new-episodes",
  "recommended",
  "new-movies",
  "trending-stream",
  "upcoming",
  "next-watch",
  "recent-movies",
  "mylist",
];

// Sorted by rank, then by where it already was — so the unnamed rows keep their
// existing sequence instead of being shuffled by an unstable comparison.
const orderRows = (rows) =>
  rows
    .map((row, at) => ({ row, at, rank: ROW_ORDER.indexOf(row.id) }))
    .sort((a, b) => {
      const ra = a.rank === -1 ? ROW_ORDER.length : a.rank;
      const rb = b.rank === -1 ? ROW_ORDER.length : b.rank;
      return ra - rb || a.at - b.at;
    })
    .map((entry) => entry.row);

// Tiny seeded PRNG (mulberry32) + a (profile, day) seed for the home page's
// sampled rows — see the `random:` note at the hero.select call.
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const dailyRandom = (profileId) => {
  let h = Math.floor(Date.now() / 86400000);
  for (const c of String(profileId || "")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return mulberry32(h);
};

// Composed home screen for a profile: hero + rows. Blends your downloaded
// library with streamable (Discover) titles and personalises by star ratings,
// liked genres, and watch history. Stays fast: streamable data comes from the
// in-memory cache (a background refresh keeps it warm), never a blocking fetch.
router.get("/api/home", (req, res) => {
  const reqProfile = req.query.profile || null;
  // Honour the profile lock: a password-protected profile's personalized rows
  // (Continue Watching, My List, ratings, liked genres) require a valid unlock
  // token. Admin-locked profiles never personalize. Otherwise serve the
  // generic (non-personalized) home instead.
  const profileId =
    reqProfile &&
    !profiles.isLocked(reqProfile) &&
    (!profiles.isProtected(reqProfile) || profiles.tokenValid(reqProfile, req.get("X-Profile-Token")))
      ? reqProfile
      : null;
  const { movies, shows } = scanner.index;
  const local = [...movies, ...shows];

  const byAddedDesc = (arr) => [...arr].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const dedupeByTitle = (arr, cap) => {
    const seen = new Set();
    const out = [];
    for (const i of arr) {
      const k = (i.title || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(i);
      if (cap && out.length >= cap) break;
    }
    return out;
  };

  // Streamable titles from the cache (null until first Discover fetch). Warm it
  // in the background so it's ready next time, without blocking this response.
  const cached = discover.trendingCached();
  discover.trending().catch(() => {});
  const asStream = (m) => ({ ...m, cover: m.poster || m.cover || null, source: "stream" });
  const streamMovies = cached ? cached.movies.filter((m) => !m.inLibrary).map(asStream) : [];
  const streamShows = cached ? cached.shows.filter((m) => !m.inLibrary).map(asStream) : [];
  const streamAll = [...streamMovies, ...streamShows];

  // Category shelves should lead with what can be STREAMED. The library is tiny
  // next to the catalogue (32 titles vs ~380), so a library-only shelf looks
  // thin and repeats the same few covers on every row. Two streams per
  // downloaded title keeps each row mostly streamable while still surfacing
  // what's already on disk.
  const blendStreamFirst = (streamItems, localItems, cap = 24) => {
    const out = [];
    let s = 0;
    let l = 0;
    while (s < streamItems.length || l < localItems.length) {
      for (let k = 0; k < 2 && s < streamItems.length; k++) out.push(streamItems[s++]);
      if (l < localItems.length) out.push(localItems[l++]);
      if (out.length >= cap * 2) break; // dedupe below trims to cap
    }
    return dedupeByTitle(out, cap);
  };
  const byRating = (arr) => [...arr].sort((a, b) => (b.rating || 0) - (a.rating || 0));

  const ratings = profileId ? profiles.getRatings(profileId) : {};
  const likedGenres = profileId ? profiles.getLikedGenres(profileId) : [];
  const progress = profileId ? profiles.getProgress(profileId) : {};
  const userRating = (i) => ratings[i.id] || ratings[i.imdbId] || 0;

  // Every known title, indexed by both kinds of key a profile can store against
  // it — library ids in the watchlist, IMDb ids in ratings and stream refs.
  const catalogue = new Map();
  for (const item of [...hero.poolCached(), ...streamAll, ...local]) {
    if (item.id) catalogue.set(item.id, item);
    if (item.imdbId) catalogue.set(item.imdbId, item);
  }

  // Hero: see src/media/hero.js. Same contract as the streamable rows — it reads
  // its own pool from memory and never blocks, and the warm below fills it for
  // next time. Chosen before the rows because Recommended needs to know what the
  // billboard is already showing.
  hero.warm().catch(() => {});
  const heroItems = hero.select({
    local,
    streamAll,
    ratings,
    likedGenres,
    progress,
    streamItems: profileId ? profiles.getStreamItems(profileId) : {},
    // Seeded per (profile, day): the billboard sampling stays varied but is
    // byte-stable within a day — a Math.random draw made every /api/home
    // response unique, so Express's ETag never matched and the full body
    // re-downloaded on every single visit (measured: zero 304s, ever).
    random: dailyRandom(profileId),
  });

  const rows = [];

  if (profileId) {
    const cw = profiles.continueWatching(profileId);
    if (cw.length > 0) rows.push({ id: "continue", title: "Continue Watching", items: cw });

    // New Episodes — shows you follow that have aired something you haven't seen.
    // Same cache-only contract as everything else here.
    const followArgs = {
      watchlist: profiles.getWatchlist(profileId),
      ratings,
      catalogue,
    };
    newEpisodes.warm(followArgs).catch(() => {});
    const fresh = newEpisodes.select({
      ...followArgs,
      progress,
      streamItems: profiles.getStreamItems(profileId),
    });
    if (fresh.length > 0) rows.push({ id: "new-episodes", title: "New Episodes", items: fresh });

    // Recommended for You — discovery, ranked by the same taste model as the
    // billboard (see hero.recommend for why the old version recommended things
    // you had already watched, downloaded or listed).
    const rec = hero.recommend({
      local,
      streamAll,
      ratings,
      likedGenres,
      progress,
      streamItems: profiles.getStreamItems(profileId),
      watchlist: profiles.getWatchlist(profileId),
      exclude: heroItems,
    });
    if (rec.length >= 4) rows.push({ id: "recommended", title: "Recommended for You", items: rec });

    const list = profiles.watchlistItems(profileId);
    if (list.length > 0) rows.push({ id: "mylist", title: "My List", items: list });

    // Your Next Watch — same-genre picks off your most recent watch. The
    // generator only knows the library (it lives in profiles.js), so the
    // streamable half is matched here off the source title's genres.
    //
    // It skips anything with watch progress, which is not the same as anything you
    // have watched: a series finished before Aurora existed has no progress rows at
    // all, so Breaking Bad and Chernobyl were both being offered as what to watch
    // next. A star rating is the profile saying it has already been seen.
    const nx = profiles.recommendations(profileId);
    if (nx) {
      const wanted = new Set(nx.genres || []);
      const unseen = (arr) => arr.filter((i) => !userRating(i));
      const nxStreams = wanted.size
        ? byRating(unseen(streamAll.filter((i) => (i.genres || []).some((g) => wanted.has(g)))))
        : [];
      const items = blendStreamFirst(nxStreams, unseen(nx.items));
      if (items.length >= 3) rows.push({ id: "next-watch", title: "Your Next Watch", items });
    }
  }

  // Trending to Stream — bring streamable content onto Home
  if (streamAll.length >= 4) {
    rows.push({ id: "trending-stream", title: "Trending to Stream", items: dedupeByTitle(streamAll, 24) });
  }

  if (profileId) {
    const topRated = local.filter((i) => userRating(i) >= 4).sort((a, b) => userRating(b) - userRating(a));
    if (topRated.length >= 2) rows.push({ id: "top-rated", title: "Top Rated by You", items: topRated });

    for (const genre of likedGenres.slice(0, 4)) {
      const items = [...local, ...streamAll]
        .filter((i) => (i.genres || []).includes(genre))
        .sort((a, b) => (userRating(b) - userRating(a)) || ((b.rating || 0) - (a.rating || 0)));
      if (items.length >= 3) rows.push({ id: `liked-${genre}`, title: `More ${genre}`, items: dedupeByTitle(items, 24) });
    }
  }

  // New Movies / Upcoming.
  //
  // This row used to be `byAddedDesc(movies)` under the name "New Movies", which
  // answered a different question: what arrived on the SERVER most recently. That
  // list still exists, now called Recently Added, which is what it always was.
  //
  // The trap in doing it properly is that Cinemeta's release date is the
  // THEATRICAL one, so a film that opened in cinemas last week reads as released
  // while nobody can watch it at home yet — and an announced film with no release
  // at all reads the same as one that is out. src/media/availability.js asks TMDB
  // the question that actually matters, and the two rows split on its answer.
  const thisYear = new Date().getFullYear();
  const verdict = (i) => availability.cached(i.imdbId) || {};
  // When it became gettable. For a film with a digital date that is the date; for
  // one that has no digital date but does have sources (see availability.js), the
  // theatrical date is the best proxy we have for how long it has been around.
  const availableAt = (i) => {
    const v = verdict(i);
    const at = Number.isFinite(v.homeAt) ? v.homeAt : v.streamed ? v.theatricalAt : null;
    return Number.isFinite(at) ? at : null;
  };
  const expectedAt = (i) => {
    const v = verdict(i);
    return [v.homeAt, v.theatricalAt].find((x) => Number.isFinite(x)) ?? Infinity;
  };
  const recentReleases = dedupeByTitle(
    [...hero.poolCached(), ...streamMovies].filter(
      (i) => i.type === "movie" && i.year && i.year >= thisYear - 1,
    ),
    120,
  );
  // Out now: most recently available first, so the row leads with this week's.
  const newMovies = recentReleases
    .filter((i) => availability.isReleased(i))
    .sort((a, b) => (availableAt(b) || 0) - (availableAt(a) || 0) || (b.year || 0) - (a.year || 0))
    .slice(0, 20);
  if (newMovies.length >= 4) rows.push({ id: "new-movies", title: "New Movies", items: newMovies });

  // Still to come: soonest first, because that is the only useful order for a
  // row of things you cannot watch yet.
  const upcoming = recentReleases
    .filter((i) => availability.isUpcoming(i))
    .sort((a, b) => expectedAt(a) - expectedAt(b))
    .slice(0, 20);
  if (upcoming.length >= 4) rows.push({ id: "upcoming", title: "Upcoming", items: upcoming });

  const recentlyAdded = byAddedDesc(movies).slice(0, 20);
  if (recentlyAdded.length) rows.push({ id: "recent-movies", title: "Recently Added", items: recentlyAdded });

  // Genre shelves, built from BOTH sources and mostly streams. Grouping only
  // the library gave 5-9 thin rows of the same titles seen elsewhere on the page.
  const byGenre = {};
  const groupByGenre = (arr, side) => {
    for (const item of arr) {
      for (const g of item.genres || []) {
        (byGenre[g] = byGenre[g] || { stream: [], local: [] })[side].push(item);
      }
    }
  };
  groupByGenre(local, "local");
  groupByGenre(streamAll, "stream");
  const genreSize = (g) => g.stream.length + g.local.length;
  const genreRows = Object.entries(byGenre)
    .filter(([, g]) => genreSize(g) >= 3)
    .sort((a, b) => genreSize(b[1]) - genreSize(a[1]))
    .slice(0, 6);
  for (const [genre, g] of genreRows) {
    rows.push({
      id: `genre-${genre}`,
      title: genre,
      items: blendStreamFirst(byRating(g.stream), byRating(g.local)),
    });
  }

  if (movies.length) rows.push({ id: "movies", title: "All Movies", items: movies });

  // `?slim=1` is the TV app's stronger diet: it also drops the per-file subtitle,
  // audio and video detail, because it fetches /api/item wherever it needs any
  // of that.
  //
  // The browser gets the episode trees dropped too (see listEntry) — that alone
  // took this response from 1,060,613 B to ~270 KB. It was only ever left in out
  // of caution about changing the live app underneath the household; the
  // consumers turned out to all read seasons from /api/item/:id.
  const strip =
    req.query.slim === "1"
      ? (i) => {
          const { seasons, subtitles, audio, video, extras, ...rest } = i;
          return rest;
        }
      : cardStrip;
  res.json({
    hero: heroItems.map((i) => strip(i, { synopsis: true })),
    rows: orderRows(rows).map((r) => ({ ...r, items: r.items.map((i) => strip(i)) })),
  });
});

// Card-sized entries for the web's home rows. Measured 2026-08-23: the
// default response was 367.5 KB raw, of which 140 KB was `subtitles` arrays,
// 78 KB full synopses and ~90 KB player-only URLs — none of it rendered by a
// card (the detail page and the player both fetch /api/item themselves).
// Torrent resume entries are the exception and pass through WHOLE: their
// stored play-meta is the only copy the player can resume a stream from.
// The hero keeps its synopsis — it's the one place home prints one.
// (tv-native's ?slim=1 shape above is untouched.)
const cardStrip = (i, { synopsis = false } = {}) => {
  if (!i) return i;
  if (typeof i.id === "string" && i.id.startsWith("torrent|")) return i;
  const {
    seasons, subtitles, audio, video, extras, files,
    url, videoUrl, downloadUrl, hlsUrl, transcodeBase, transcodeV,
    synopsis: syn,
    ...rest
  } = i;
  if (synopsis && syn) rest.synopsis = syn;
  return rest;
};

module.exports = router;
