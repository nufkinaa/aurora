// Home screen hero selection.
//
// Three things here are easy to get wrong in ways nobody notices for months, so
// they are what these cover:
//   - the watched filter, which was silently a no-op because it indexed watch
//     history by a field streamable titles do not have
//   - the taste model, where summing per-genre scores hands the billboard to
//     whichever genre is merely most COMMON
//   - the rotation, where the tempting fix (page deeper each day) drifts the pool
//     into the back catalogue, and where a stride can skip half the genre list
const test = require("node:test");
const assert = require("node:assert");

const hero = require("../src/media/hero");
const { watchedIndex, makeIsSeen } = require("../src/media/watched");
const {
  sourcePlan,
  genreWindow,
  affinityMap,
  tasteScore,
  blindScore,
  sample,
  MAX_PAGE,
  MAX_PER_GENRE,
  BLIND_SLOTS,
} = hero._internals;

const YEAR = new Date().getFullYear();

// Deterministic RNG so the sampler's behaviour is assertable rather than flaky.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const movie = (over = {}) => ({
  type: "movie",
  title: "Untitled",
  cover: "poster.jpg",
  year: YEAR - 5,
  rating: 7,
  genres: ["Drama"],
  ...over,
});

const done = (extra = {}) => ({ finished: true, position: 100, duration: 100, updatedAt: 1, ...extra });

// ---------- resolving watch history back to titles ----------

test("a streamed film marked watched is found by its IMDb id", () => {
  // The bug this replaces: the old filter read progress[item.id], and a
  // streamable title has no library id, so it looked up progress[undefined].
  const watched = watchedIndex({ progress: { "stream|tt2194499": done() } });
  assert.ok(watched.movies.has("tt2194499"));
});

test("a torrent key is resolved through its stored play-item", () => {
  // `torrent|<hash>|<idx>` names a torrent, not a title. streamItems is the only
  // thing that knows which title was playing.
  const watched = watchedIndex({
    progress: { "torrent|abc123|0": done() },
    streamItems: { "torrent|abc123|0": { imdbId: "tt0111161", title: "The Shawshank Redemption" } },
  });
  assert.ok(watched.movies.has("tt0111161"));
});

test("a torrent key with no stored meta is ignored, not guessed at", () => {
  const watched = watchedIndex({ progress: { "torrent|abc123|0": done() } });
  assert.strictEqual(watched.movies.size, 0);
});

test("started but unfinished counts as nothing watched", () => {
  const watched = watchedIndex({
    progress: { "stream|tt2194499": { finished: false, position: 60, duration: 6000 } },
  });
  assert.strictEqual(watched.movies.size, 0);
});

test("episode keys are collected per show, not as films", () => {
  const watched = watchedIndex({
    progress: {
      "stream|tt0903747|1|1": done(),
      "stream|tt0903747|1|2": done(),
    },
  });
  assert.strictEqual(watched.movies.size, 0);
  assert.strictEqual(watched.episodes.get("tt0903747").size, 2);
});

test("one episode watched from two different sources is one episode", () => {
  // Otherwise a show rewatched off a second torrent reads as twice as complete as
  // it is, and a 10-episode show gets excluded after five.
  const watched = watchedIndex({
    progress: {
      "torrent|hashA|0": done(),
      "torrent|hashB|0": done(),
      "stream|tt0903747|1|1": done(),
    },
    streamItems: {
      "torrent|hashA|0": { imdbId: "tt0903747", season: 1, episode: 1 },
      "torrent|hashB|0": { imdbId: "tt0903747", season: 1, episode: 1 },
    },
  });
  assert.strictEqual(watched.episodes.get("tt0903747").size, 1);
});

// ---------- what counts as "finished with it" ----------

test("a finished film is excluded", () => {
  const isSeen = makeIsSeen(watchedIndex({ progress: { "stream|tt2194499": done() } }));
  assert.strictEqual(isSeen(movie({ imdbId: "tt2194499" })), true);
});

test("a show is only excluded once every episode is watched", () => {
  const progress = {};
  for (let e = 1; e <= 10; e++) progress[`stream|tt1|1|${e}`] = done();
  const isSeen = makeIsSeen(watchedIndex({ progress }));

  const show = (episodeCount) => ({ type: "show", imdbId: "tt1", title: "Show", episodeCount });
  assert.strictEqual(isSeen(show(10)), true, "all 10 of 10 watched");
  assert.strictEqual(isSeen(show(20)), false, "10 of 20 is halfway through");
});

test("an unknown episode total leaves the show in", () => {
  // Fails open deliberately. Streamable shows only have an episode count once
  // someone has opened their detail page, and hiding a show you are midway
  // through is far worse than offering one you finished.
  const isSeen = makeIsSeen(watchedIndex({ progress: { "stream|tt1|1|1": done() } }));
  assert.strictEqual(isSeen({ type: "show", imdbId: "tt1", title: "Show" }), false);
});

test("a show nobody has touched is never excluded", () => {
  const isSeen = makeIsSeen(watchedIndex({ progress: {} }));
  assert.strictEqual(isSeen({ type: "show", imdbId: "tt1", title: "Show", episodeCount: 3 }), false);
});

// ---------- taste ----------

test("affinity is a mean, so a common genre does not win by volume", () => {
  // Straight from the real profile: Drama sums to +9 because it appears in eight
  // rated titles, Comedy to +5 across three. Summed, Drama looks like a strong
  // preference; per rating, Comedy is the stronger one — which is the truth.
  const catalogue = new Map();
  const dramaStars = [5, 5, 3, 4, 5, 4, 4, 3];
  dramaStars.forEach((stars, i) => catalogue.set(`d${i}`, { genres: ["Drama"] }));
  const comedyStars = [5, 5, 4];
  comedyStars.forEach((stars, i) => catalogue.set(`c${i}`, { genres: ["Comedy"] }));

  const ratings = {};
  dramaStars.forEach((stars, i) => (ratings[`d${i}`] = stars));
  comedyStars.forEach((stars, i) => (ratings[`c${i}`] = stars));

  const aff = affinityMap({ ratings, catalogue });
  assert.ok(aff.get("Comedy") > aff.get("Drama"), "Comedy rates higher per title");
  assert.ok(aff.get("Drama") > 0, "Drama is still liked, just less strongly");
});

test("one rating carries less weight than several", () => {
  // Shrinkage: without it a single 5-star obscurity outranks a genre backed by
  // eight ratings, and one lucky pick redefines your taste.
  const catalogue = new Map([
    ["a", { genres: ["Western"] }],
    ["b", { genres: ["Horror"] }],
    ["c", { genres: ["Horror"] }],
    ["d", { genres: ["Horror"] }],
  ]);
  const aff = affinityMap({ ratings: { a: 5, b: 5, c: 5, d: 5 }, catalogue });
  assert.ok(aff.get("Horror") > aff.get("Western"));
});

test("a low rating pushes its genres away", () => {
  const catalogue = new Map([["a", { genres: ["Horror"] }]]);
  const aff = affinityMap({ ratings: { a: 1 }, catalogue });
  assert.ok(aff.get("Horror") < 0);
});

test("liked categories tilt the ranking without deciding it", () => {
  // The complaint this answers: a profile with ONE liked category used to get a
  // hero made entirely of that category. The prior is about the size of a single
  // 4-star rating, so real evidence still beats a checkbox.
  const catalogue = new Map([["a", { genres: ["Horror"] }], ["b", { genres: ["Horror"] }]]);
  const aff = affinityMap({
    ratings: { a: 5, b: 5 },
    likedGenres: ["Western"],
    catalogue,
  });
  assert.ok(aff.get("Western") > 0, "the checkbox counts for something");
  assert.ok(aff.get("Horror") > aff.get("Western"), "but two 5-star ratings count for more");
});

test("liked categories alone still produce a signal", () => {
  const aff = affinityMap({ likedGenres: ["Sci-Fi"], catalogue: new Map() });
  assert.ok(aff.get("Sci-Fi") > 0);
});

test("a six-genre title is not a better fit than a two-genre one by default", () => {
  const aff = new Map([["Drama", 1]]);
  const narrow = movie({ genres: ["Drama", "Crime"] });
  const wide = movie({ genres: ["Drama", "Crime", "War", "History", "Sport", "Music"] });
  assert.ok(tasteScore(narrow, aff, Date.now()) > tasteScore(wide, aff, Date.now()));
});

// ---------- recency ----------

test("a recent title outranks an older, better-rated one", () => {
  const now = Date.now();
  const fresh = movie({ title: "Fresh", year: YEAR, rating: 7 });
  const classic = movie({ title: "Classic", year: YEAR - 20, rating: 8 });
  // On public rating alone the classic wins, which is how the hero ended up full
  // of all-time greats. The recency term is what turns that around.
  assert.ok(classic.rating > fresh.rating);
  assert.ok(blindScore(fresh, now) > blindScore(classic, now), "no-taste path");
  const aff = new Map([["Drama", 1]]);
  assert.ok(tasteScore(fresh, aff, now) > tasteScore(classic, aff, now), "taste path");
});

test("a title with no year is not treated as brand new", () => {
  const now = Date.now();
  const undated = movie({ title: "Undated", year: null, rating: 7 });
  const thisYear = movie({ title: "Now", year: YEAR, rating: 7 });
  assert.ok(blindScore(thisYear, now) > blindScore(undated, now));
});

// ---------- sampling and diversity ----------

test("no more than two picks share a primary genre", () => {
  const ranked = [
    ...Array.from({ length: 6 }, (_, i) => movie({ title: `Drama ${i}`, genres: ["Drama"] })),
    movie({ title: "Comedy", genres: ["Comedy"] }),
    movie({ title: "Horror", genres: ["Horror"] }),
    movie({ title: "Western", genres: ["Western"] }),
  ];
  const out = sample(ranked, ranked, 5, mulberry32(7));
  const dramas = out.filter((i) => i.genres[0] === "Drama").length;
  assert.ok(dramas <= MAX_PER_GENRE, `${dramas} dramas in 5 slots`);
  assert.strictEqual(out.length, 5);
});

test("the genre cap bends rather than returning a short hero", () => {
  // A thin library where everything is tagged the same genre must still fill the
  // billboard — a repeated genre beats three slots and a gap.
  const ranked = Array.from({ length: 8 }, (_, i) => movie({ title: `Drama ${i}` }));
  const out = sample(ranked, ranked, 6, mulberry32(3));
  assert.strictEqual(out.length, 6);
});

test("two slots are reserved for picks taste had no say in", () => {
  // random() === 0 always takes the front of whichever list it is handed, so the
  // last BLIND_SLOTS picks must come from the blind ranking.
  const tasteRanked = Array.from({ length: 10 }, (_, i) =>
    movie({ title: `Taste ${i}`, genres: [`G${i}`] }),
  );
  const blindRanked = Array.from({ length: 10 }, (_, i) =>
    movie({ title: `Blind ${i}`, genres: [`B${i}`] }),
  );
  const out = sample(tasteRanked, blindRanked, 6, () => 0);
  const blind = out.filter((i) => i.title.startsWith("Blind"));
  assert.strictEqual(blind.length, BLIND_SLOTS);
});

test("the same titles do not come back on every load", () => {
  // The old sampler was random() ** 2 over a static ranked list: a hard front
  // bias that kept handing back the same few titles. Over a 60-title pool this
  // should rotate broadly.
  const ranked = Array.from({ length: 60 }, (_, i) =>
    movie({ title: `Title ${i}`, genres: [`G${i % 12}`] }),
  );
  const random = mulberry32(42);
  const counts = new Map();
  const loads = 40;
  for (let i = 0; i < loads; i++) {
    for (const item of sample(ranked, ranked, 8, random)) {
      counts.set(item.title, (counts.get(item.title) || 0) + 1);
    }
  }
  assert.ok(counts.size >= 30, `only ${counts.size} distinct titles over ${loads} loads`);
  const worst = Math.max(...counts.values());
  assert.ok(worst < loads, "no title appeared on every single load");
});

test("a title is never picked twice in one hero", () => {
  const ranked = Array.from({ length: 20 }, (_, i) => movie({ title: `Title ${i}`, genres: [`G${i}`] }));
  const out = sample(ranked, ranked, 8, mulberry32(11));
  assert.strictEqual(new Set(out.map((i) => i.title)).size, out.length);
});

// ---------- rotation ----------

test("every genre gets its turn as the days pass", () => {
  // The trap: `(day * n + i) % len` with a stride only reaches indices sharing a
  // factor with the length — 4 draws a day through 22 series genres never lands
  // on 11 of them. Contiguous windows tile the whole ring instead.
  for (const len of [19, 22, 8, 12]) {
    const list = Array.from({ length: len }, (_, i) => `G${i}`);
    const reached = new Set();
    for (let day = 0; day < len * 4; day++) {
      for (const g of genreWindow(list, day, 4)) reached.add(g);
    }
    assert.strictEqual(reached.size, len, `length ${len} left genres unreached`);
  }
});

test("a short genre list is not padded with duplicates", () => {
  const out = genreWindow(["A", "B"], 0, 4);
  assert.deepStrictEqual(out, ["A", "B"]);
});

test("the pool never pages deeper than the cap", () => {
  // This is the whole defence against the pool aging: page 2 of the popularity
  // catalogue already averages year 2009, so depth is bounded and wraps rather
  // than advancing forever.
  const movieGenres = Array.from({ length: 19 }, (_, i) => `M${i}`);
  const seriesGenres = Array.from({ length: 22 }, (_, i) => `S${i}`);
  for (let day = 0; day < 500; day++) {
    for (const draw of sourcePlan(day * 86400000, movieGenres, seriesGenres)) {
      assert.ok(draw.page <= MAX_PAGE, `day ${day} asked for page ${draw.page}`);
      assert.ok(draw.page >= 0);
    }
  }
});

test("the self-refreshing sources are drawn every single day", () => {
  // These are what keep the pool current months from now without moving any
  // offset: the `new` catalogue's page 0 changes as films come out.
  for (let day = 0; day < 100; day++) {
    const plan = sourcePlan(day * 86400000, ["M0"], ["S0"]);
    for (const type of ["movie", "series"]) {
      assert.ok(
        plan.some((d) => d.type === type && d.category === "new" && !d.genre && d.page === 0),
        `day ${day} dropped the ${type} new anchor`,
      );
    }
  }
});

test("the source mix changes from one day to the next", () => {
  const movieGenres = Array.from({ length: 19 }, (_, i) => `M${i}`);
  const seriesGenres = Array.from({ length: 22 }, (_, i) => `S${i}`);
  const fingerprint = (day) =>
    JSON.stringify(
      sourcePlan(day * 86400000, movieGenres, seriesGenres).map(
        (d) => `${d.type}/${d.category}/${d.genre}/${d.page}`,
      ),
    );
  const seen = new Set();
  for (let day = 0; day < 120; day++) seen.add(fingerprint(day));
  assert.strictEqual(seen.size, 120, "some days shared an identical source plan");
});

// ---------- end to end ----------

test("select leaves out what you have finished and keeps what you have not", () => {
  const local = [
    movie({ id: "lib1", title: "Finished Film", imdbId: "tt100" }),
    movie({ id: "lib2", title: "Unwatched Film", imdbId: "tt200" }),
    { type: "show", id: "lib3", title: "Finished Show", imdbId: "tt300", cover: "c.jpg", episodeCount: 2, genres: ["Crime"], year: YEAR - 2 },
    { type: "show", id: "lib4", title: "Halfway Show", imdbId: "tt400", cover: "c.jpg", episodeCount: 10, genres: ["Mystery"], year: YEAR - 1 },
  ];
  const progress = {
    "stream|tt100": done(),
    "stream|tt300|1|1": done(),
    "stream|tt300|1|2": done(),
    "stream|tt400|1|1": done(),
  };

  const titles = hero
    .select({ local, progress, count: 8, random: mulberry32(5) })
    .map((i) => i.title);

  assert.ok(!titles.includes("Finished Film"), "a film watched to the end");
  assert.ok(!titles.includes("Finished Show"), "a show with every episode watched");
  assert.ok(titles.includes("Unwatched Film"));
  assert.ok(titles.includes("Halfway Show"), "one of ten episodes is not finished");
});

test("select leaves out anything you have rated, however you rated it", () => {
  // The gap this closes: makeIsSeen has to fail open when it cannot tell how many
  // episodes a show has, so a series finished years ago — before its meta was ever
  // cached — reads as unwatched and can lead the billboard. A star rating is the
  // profile saying outright that it has been watched.
  const local = [
    { type: "show", id: "lib1", title: "Rated Five", imdbId: "tt1", cover: "c.jpg", genres: ["Drama"], year: YEAR - 1 },
    { type: "show", id: "lib2", title: "Rated One", imdbId: "tt2", cover: "c.jpg", genres: ["Crime"], year: YEAR - 1 },
    movie({ id: "lib3", title: "Unrated", imdbId: "tt3" }),
  ];
  const titles = hero
    .select({ local, ratings: { tt1: 5, tt2: 1 }, count: 8, random: mulberry32(3) })
    .map((i) => i.title);
  assert.deepStrictEqual(titles, ["Unrated"]);
});

test("select ignores titles with no artwork", () => {
  const local = [movie({ id: "a", title: "No Art", cover: null }), movie({ id: "b", title: "Has Art" })];
  const titles = hero.select({ local, count: 8, random: mulberry32(1) }).map((i) => i.title);
  assert.deepStrictEqual(titles, ["Has Art"]);
});

test("a brand-new profile still gets a hero", () => {
  const local = Array.from({ length: 12 }, (_, i) =>
    movie({ id: `x${i}`, title: `Film ${i}`, genres: [`G${i}`] }),
  );
  const out = hero.select({ local, count: 8, random: mulberry32(9) });
  assert.strictEqual(out.length, 8);
});

// ---------- the Recommended row ----------

const streamable = (over = {}) => ({ ...movie(over), source: "stream" });

test("recommend offers only things you have not seen, got, rated or listed", () => {
  // Every one of these was in the row before: the watched check indexed history by
  // a field streamable titles do not have, the sort actively promoted titles you
  // had RATED, the library was interleaved 50/50 with the catalogue, and watchlist
  // entries came through untouched to duplicate My List one row below.
  const streamAll = [
    streamable({ imdbId: "tt1", title: "Watched" }),
    streamable({ imdbId: "tt2", title: "Rated" }),
    streamable({ imdbId: "tt3", title: "Listed" }),
    streamable({ imdbId: "tt4", title: "Downloaded", inLibrary: "lib9" }),
    streamable({ imdbId: "tt5", title: "Fresh" }),
  ];
  const local = [movie({ id: "lib1", title: "On Disk", imdbId: "tt6" })];

  const titles = hero
    .recommend({
      local,
      streamAll,
      ratings: { tt2: 4 },
      watchlist: [{ imdbId: "tt3" }],
      progress: { "stream|tt1": done() },
    })
    .map((i) => i.title);

  assert.deepStrictEqual(titles, ["Fresh"]);
});

test("recommend does not repeat what the billboard is already showing", () => {
  const streamAll = [
    streamable({ imdbId: "tt1", title: "On The Billboard" }),
    streamable({ imdbId: "tt2", title: "Not On It" }),
  ];
  const titles = hero
    .recommend({ streamAll, exclude: [{ title: "On The Billboard" }] })
    .map((i) => i.title);
  assert.deepStrictEqual(titles, ["Not On It"]);
});

test("recommend ranks by taste without ever filtering on it", () => {
  const streamAll = [
    streamable({ imdbId: "tt1", title: "Off Taste", genres: ["Western"] }),
    streamable({ imdbId: "tt2", title: "On Taste", genres: ["Horror"] }),
  ];
  const local = [movie({ id: "lib1", title: "Rated Horror", genres: ["Horror"] })];
  const out = hero.recommend({ local, streamAll, ratings: { lib1: 5 } });
  assert.deepStrictEqual(out.map((i) => i.title), ["On Taste", "Off Taste"]);
});

test("select never repeats a title within one hero", () => {
  // Both rankings hold the same objects, so the dedupe has to be by title rather
  // than by identity or the blind slots would duplicate the taste ones.
  const local = Array.from({ length: 30 }, (_, i) =>
    movie({ id: `x${i}`, title: `Film ${i}`, genres: [`G${i % 5}`] }),
  );
  for (let seed = 0; seed < 20; seed++) {
    const out = hero.select({ local, count: 8, random: mulberry32(seed) });
    assert.strictEqual(new Set(out.map((i) => i.title)).size, out.length, `seed ${seed}`);
  }
});
