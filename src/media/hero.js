// What the home screen puts on its billboard.
//
// This used to live inline in /api/home and had three problems worth naming,
// because the fixes below only make sense against them:
//
//   1. It never excluded what you had watched. The filter was
//      `progress[item.id].finished`, but a streamable title has no library `id`
//      — so the lookup was `progress[undefined]` for every trending candidate
//      and the check silently did nothing. Watch history is keyed by things like
//      `stream|tt0903747|1|1`, so the ids have to be resolved, not indexed.
//
//   2. The candidate pool was one fixed catalogue page, ranked, and sampled with
//      `Math.random() ** 2` — a hard front bias over a static list, which is a
//      recipe for showing the same handful of titles forever.
//
//   3. Taste was a Set of genres: one 4-star rating made a genre "liked" as
//      strongly as ten, and a profile with a single liked category got a hero
//      made entirely of that category.
//
// The pool rotates on BREADTH, not depth. Paging deeper is the tempting way to
// rotate and it quietly rots: measured against Cinemeta on 2026-07-28, the
// popularity catalogue averages year 2019 on page 0, 2009 by page 2 and 2008 by
// page 6, while the average rating stays flat around 7.4. So depth does not buy
// worse titles, it buys OLDER ones, and a monotonically advancing offset ends up
// parked in the back catalogue a few months from now. Instead: 19 movie genres +
// 22 series genres x 3 catalogues is 123 source combinations, nearly all of them
// a fresh page 0, and the depth we do use is capped and wraps.
const discover = require("./discover");
const scanner = require("./scanner");
const availability = require("./availability");
const { watchedIndex, makeIsSeen } = require("./watched");

const DAY_MS = 24 * 3600 * 1000;
const dayIndex = (now) => Math.floor(now / DAY_MS);

// ---------- the candidate pool ----------

// Never page deeper than this. Page 2 is already averaging 2009 (see above), so
// this is the point where "more variety" turns into "a wall of old films".
const MAX_PAGE = 2;
const PER_TYPE_DRAWS = 4;
const CATALOG_IDS = ["trending", "top", "new"];
const DRAW_BATCH = 4;
const POOL_TTL = 6 * 3600 * 1000;

// Always drawn, every day. These are the self-refreshing part of the pool: the
// `new` catalogue's page 0 changes on its own as films come out, and popularity
// page 0 shifts week to week behind a 24h cache. That is what keeps the pool
// current months from now WITHOUT moving any offset — the rotation below only
// has to supply variety, not freshness.
const ANCHORS = [
  { type: "movie", category: "new", genre: null, page: 0 },
  { type: "series", category: "new", genre: null, page: 0 },
  { type: "movie", category: "trending", genre: null, page: 0 },
  { type: "series", category: "trending", genre: null, page: 0 },
];

// A contiguous window of the genre list, rotated by the day.
//
// Contiguous matters. The obvious `(day * n + i) % len` with a stride only
// reaches indices that share a factor with the length: 4 draws stepping through
// 22 series genres by 4 a day never lands on 11 of them. Consecutive windows are
// adjacent, so they tile the whole ring whatever the two numbers are.
const genreWindow = (list, day, count) => {
  if (!list || !list.length) return [];
  const take = Math.min(count, list.length);
  return Array.from({ length: take }, (_, k) => list[(day * take + k) % list.length]);
};

const sourcePlan = (now, movieGenres, seriesGenres) => {
  const day = dayIndex(now);
  const draws = [...ANCHORS];
  const sides = [
    { type: "movie", genres: genreWindow(movieGenres, day, PER_TYPE_DRAWS) },
    { type: "series", genres: genreWindow(seriesGenres, day, PER_TYPE_DRAWS) },
  ];
  for (const side of sides) {
    side.genres.forEach((genre, i) => {
      draws.push({
        type: side.type,
        category: CATALOG_IDS[(day + i) % CATALOG_IDS.length],
        genre,
        // Wraps rather than advancing, so the offset cycles inside a bounded
        // window instead of marching into the tail forever.
        page: (day + i) % (MAX_PAGE + 1),
      });
    });
  }
  return draws;
};

let pool = { at: 0, day: -1, items: [] };
let warming = null;

// Whatever pool is already in memory. Home is a cache-only read path, so this is
// what select() actually gets; an empty pool just means it falls back to the
// trending cache for this one response.
const poolCached = () => pool.items;

// Fill the pool for today. Fire-and-forget from the request path.
const warm = async (now = Date.now()) => {
  if (warming) return warming;
  const day = dayIndex(now);
  if (pool.items.length && pool.day === day && now - pool.at < POOL_TTL) return pool.items;

  warming = (async () => {
    try {
      const [movieGenres, seriesGenres] = await Promise.all([
        discover.genres("movie").catch(() => []),
        discover.genres("series").catch(() => []),
      ]);
      const plan = sourcePlan(now, movieGenres, seriesGenres);
      const items = [];
      const seen = new Set();
      for (let i = 0; i < plan.length; i += DRAW_BATCH) {
        const pages = await Promise.all(
          plan
            .slice(i, i + DRAW_BATCH)
            .map((draw) => discover.catalog(draw).catch(() => ({ items: [] }))),
        );
        for (const page of pages) {
          for (const m of page.items || []) {
            // `inLibrary` titles arrive through the library half already.
            if (!m.imdbId || !m.poster || m.inLibrary || seen.has(m.imdbId)) continue;
            seen.add(m.imdbId);
            items.push({ ...m, cover: m.poster, source: "stream" });
          }
        }
      }
      if (items.length) {
        await availability.warm(items, now).catch(() => {});
        pool = { at: now, day, items };
      }
    } catch {
      // Keep the previous pool; a failed warm must not empty the hero.
    } finally {
      warming = null;
    }
    return pool.items;
  })();
  return warming;
};

const titleKey = (item) => (item.title || "").trim().toLowerCase();

// ---------- taste ----------

// 3 stars is "it was fine", so it moves nothing. Below pushes a genre away.
const RATING_PIVOT = 3;
// Divides by count + this, so a genre resting on one rating is pulled toward
// neutral while one backed by eight keeps most of its mean. Without it a single
// 5-star obscurity outranks a genre you have liked repeatedly.
const SHRINK = 1;
// Finishing something says less than deliberately rating it.
const IMPLICIT_WEIGHT = 0.35;
// Liked categories are a nudge, not a gate. This is deliberately about the size
// of one 4-star rating: it tilts the ranking without letting a profile that
// picked a single category get a hero made of nothing else.
const LIKED_PRIOR = 0.4;

// genre -> signed affinity. Positive means "more of this", negative means "less".
//
// The mean, not the sum. On the current test profile the sum reads Drama 9 /
// Comedy 5, which looks like a clear preference but is really just Drama turning
// up in 8 of 15 rated titles; per rating it is Comedy 1.25 / Drama 1.0. Summing
// hands the whole hero to whichever genre is most common in the catalogue.
const affinityMap = ({ ratings = {}, likedGenres = [], catalogue, watchedGenres = [] }) => {
  const sum = new Map();
  const count = new Map();
  const add = (genres, weight) => {
    for (const g of genres || []) {
      sum.set(g, (sum.get(g) || 0) + weight);
      count.set(g, (count.get(g) || 0) + 1);
    }
  };

  for (const [key, stars] of Object.entries(ratings)) {
    const item = catalogue.get(key);
    if (item) add(item.genres, Number(stars) - RATING_PIVOT);
  }
  for (const genres of watchedGenres) add(genres, IMPLICIT_WEIGHT);

  const out = new Map();
  for (const [g, total] of sum) out.set(g, total / (count.get(g) + SHRINK));
  for (const g of likedGenres) out.set(g, (out.get(g) || 0) + LIKED_PRIOR);
  return out;
};

// ---------- scoring ----------

const W_TASTE = 3;
const W_RATING = 1;
const W_RECENCY = 1.5;
const W_STREAM = 0.3;
// Years at which the recency term has halved. Short enough that this year's
// titles clearly lead, long enough that a 2019 favourite is still in the running.
const RECENCY_HALF_LIFE = 4;
// Public ratings cluster in a narrow band, so centre them: 6.5 is the middle of
// what the catalogues actually return, and the /2 keeps this from swamping taste.
const RATING_PIVOT_PUBLIC = 6.5;

// Mean over the title's genres, so a title tagged with six genres is not
// automatically a better fit than one tagged with two.
const tasteTerm = (item, affinity) => {
  const genres = item.genres || [];
  if (!genres.length || !affinity.size) return 0;
  let total = 0;
  for (const g of genres) total += affinity.get(g) || 0;
  return total / genres.length;
};

const ratingTerm = (item) =>
  item.rating ? (item.rating - RATING_PIVOT_PUBLIC) / 2 : 0;

const recencyTerm = (item, now) => {
  if (!item.year) return 0;
  const age = Math.max(0, new Date(now).getFullYear() - item.year);
  return 1 / (1 + age / RECENCY_HALF_LIFE);
};

// Everything except taste. This is both the ranking for a profile with no signal
// yet AND the pool the affinity-blind hero slots are drawn from, which is why
// recency lives here rather than being bolted onto the taste path alone: without
// it an all-time classic outranks anything from this year on every path.
const blindScore = (item, now) =>
  ratingTerm(item) * W_RATING +
  recencyTerm(item, now) * W_RECENCY +
  (item.source === "stream" ? W_STREAM : 0);

const tasteScore = (item, affinity, now) =>
  tasteTerm(item, affinity) * W_TASTE + blindScore(item, now);

// ---------- sampling ----------

const POOL_CAP = 60;
// Slots drawn with taste ignored entirely, so the billboard always carries
// something that was not chosen to agree with you.
const BLIND_SLOTS = 2;
// Caps how many picks may share a primary genre. Two lets a genuine preference
// show without the whole billboard becoming one shelf.
const MAX_PER_GENRE = 2;
// Sampling curve. `random() ** 2` (the old value) is a hard front bias, which
// over a static ranked list is why the same titles kept coming back; ~1 is
// uniform. This keeps a slight lean toward the better fits and nothing more.
const FRONT_BIAS = 1.15;

// Draw `n` items across two rankings, honouring the genre cap.
const sample = (tasteRanked, blindRanked, n, random) => {
  const tastePool = [...tasteRanked];
  const blindPool = [...blindRanked];
  const out = [];
  const used = new Set();
  const perGenre = new Map();
  const overflow = [];
  const dominant = (item) => (item.genres || [])[0] || null;

  const draw = (candidates) => {
    while (candidates.length) {
      const idx = Math.min(
        candidates.length - 1,
        Math.floor(random() ** FRONT_BIAS * candidates.length),
      );
      const [item] = candidates.splice(idx, 1);
      const key = titleKey(item);
      if (!key || used.has(key)) continue;
      const genre = dominant(item);
      if (genre && (perGenre.get(genre) || 0) >= MAX_PER_GENRE) {
        overflow.push(item);
        continue;
      }
      used.add(key);
      if (genre) perGenre.set(genre, (perGenre.get(genre) || 0) + 1);
      return item;
    }
    return null;
  };

  const tasteSlots = Math.max(0, n - BLIND_SLOTS);
  for (let i = 0; i < tasteSlots; i++) {
    const item = draw(tastePool);
    if (!item) break;
    out.push(item);
  }
  while (out.length < n) {
    const item = draw(blindPool) || draw(tastePool);
    if (!item) break;
    out.push(item);
  }
  // Short because the genre cap bit harder than the pool could absorb — a thin
  // library with everything tagged Drama. Better a repeated genre than a hero
  // with three slots.
  for (const item of overflow) {
    if (out.length >= n) break;
    const key = titleKey(item);
    if (used.has(key)) continue;
    used.add(key);
    out.push(item);
  }
  return out;
};

// ---------- selection ----------

// Everything the billboard could show, from all three sources, deduped by title.
const candidates = ({ local = [], streamAll = [] }) => {
  const out = [];
  const seen = new Set();
  for (const item of [...poolCached(), ...streamAll, ...local]) {
    const key = titleKey(item);
    if (!key || seen.has(key) || !item.cover) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

// Rating keys are library ids for local titles and IMDb ids for streamed ones,
// so anything resolving a profile key has to look up either.
const catalogueOf = (items) => {
  const map = new Map();
  for (const item of items) {
    if (item.id) map.set(item.id, item);
    if (item.imdbId) map.set(item.imdbId, item);
  }
  return map;
};

// Genres of everything the profile has finished, as an implicit taste signal.
const watchedGenresFrom = (watched, catalogue) => {
  const out = [];
  for (const key of [...watched.movies, ...watched.episodes.keys()]) {
    const item = catalogue.get(key) || scanner.findById(key);
    if (item && (item.genres || []).length) out.push(item.genres);
  }
  return out;
};

// Everything shared by the billboard and the Recommended row: who you are, and
// what is worth offering you.
const taste = ({ local, streamAll, ratings, likedGenres, progress, streamItems }) => {
  const watched = watchedIndex({ progress, streamItems });
  const all = candidates({ local, streamAll });
  const catalogue = catalogueOf(all);
  return {
    all,
    catalogue,
    isSeen: makeIsSeen(watched),
    affinity: affinityMap({
      ratings,
      likedGenres,
      catalogue,
      watchedGenres: watchedGenresFrom(watched, catalogue),
    }),
  };
};

// Having rated something means having seen it.
//
// This is not the same check as the watch history, and it catches what that one
// cannot: makeIsSeen has to fail open when it does not know how many episodes a
// show has, so a series finished long ago — before its meta was ever cached —
// reads as unwatched. A star rating is the profile saying outright that it has
// been watched, whatever the number is.
const ratedBy = (ratings) => (item) => !!(ratings[item.id] || ratings[item.imdbId]);

// A film still only in cinemas is a poster you cannot act on.
const playable = (item, now) =>
  item.type === "show" ||
  item.inLibrary ||
  item.source !== "stream" ||
  availability.isReleased(item, now);

// Pick the hero titles. Synchronous and cache-only: nothing here fetches.
const select = ({
  local = [],
  streamAll = [],
  ratings = {},
  likedGenres = [],
  progress = {},
  streamItems = {},
  count = 8,
  now = Date.now(),
  random = Math.random,
} = {}) => {
  const { all, isSeen, affinity } = taste({
    local,
    streamAll,
    ratings,
    likedGenres,
    progress,
    streamItems,
  });

  // A film still only in cinemas has no business being the thing the home screen
  // leads with, and neither has one you have already sat through and rated.
  const rated = ratedBy(ratings);
  const eligible = all.filter((item) => !isSeen(item) && !rated(item) && playable(item, now));

  const tasteRanked = [...eligible]
    .sort((a, b) => tasteScore(b, affinity, now) - tasteScore(a, affinity, now))
    .slice(0, POOL_CAP);
  const blindRanked = [...eligible]
    .sort((a, b) => blindScore(b, now) - blindScore(a, now))
    .slice(0, POOL_CAP);

  return sample(tasteRanked, blindRanked, count, random);
};

// ---------- the Recommended row ----------

// A recommendation is something you have NOT already got, seen, or decided on.
//
// The old row failed that on every count, for reasons worth writing down because
// they are easy to reintroduce:
//
//   - it filtered with `!progress[item.id]`, and a streamable title has no
//     library id, so the watched check was `progress[undefined]` and never fired
//   - it then SORTED BY `userRating`, actively promoting the titles you had
//     rated — which are, almost by definition, the ones you have already seen
//   - it interleaved the library 50/50, so half the row was films sitting in
//     Recently Added and All Movies two rows down
//   - watchlist titles came through untouched, duplicating My List
//
// So this is discovery only: streamable, not downloaded, not seen, not rated, not
// listed. The library still feeds the affinity map — what you have watched is how
// we know what to suggest — it just does not supply the answers.
const recommend = ({
  local = [],
  streamAll = [],
  ratings = {},
  likedGenres = [],
  progress = {},
  streamItems = {},
  watchlist = [],
  exclude = [],
  count = 18,
  now = Date.now(),
} = {}) => {
  const { all, isSeen, affinity } = taste({
    local,
    streamAll,
    ratings,
    likedGenres,
    progress,
    streamItems,
  });

  const listed = new Set();
  for (const entry of watchlist) {
    const key = typeof entry === "string" ? entry : entry && (entry.imdbId || entry.id);
    if (key) listed.add(key);
  }
  // The billboard is showing these right now, a few hundred pixels up.
  const onScreen = new Set(exclude.map(titleKey));
  const rated = ratedBy(ratings);

  return all
    .filter(
      (item) =>
        item.source === "stream" &&
        !item.inLibrary &&
        !isSeen(item) &&
        !rated(item) &&
        !listed.has(item.id) &&
        !listed.has(item.imdbId) &&
        !onScreen.has(titleKey(item)) &&
        playable(item, now),
    )
    .sort((a, b) => tasteScore(b, affinity, now) - tasteScore(a, affinity, now))
    .slice(0, count);
};

module.exports = {
  select,
  recommend,
  warm,
  poolCached,
  _internals: {
    sourcePlan,
    genreWindow,
    affinityMap,
    tasteScore,
    blindScore,
    sample,
    dayIndex,
    POOL_CAP,
    MAX_PAGE,
    BLIND_SLOTS,
    MAX_PER_GENRE,
  },
};
