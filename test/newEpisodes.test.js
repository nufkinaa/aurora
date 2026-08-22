// The New Episodes row, and the release-availability check the New Movies and
// Upcoming rows split on.
//
// Both exist because the obvious signal is the wrong one. "New episodes" is
// tempting to read off download times, which makes a season that landed in one
// go last night look like nine new episodes. "New movies" is tempting to read off
// the release date, which is THEATRICAL — so a film still only in cinemas reads
// as out.
const test = require("node:test");
const assert = require("node:assert");

const discover = require("../src/media/discover");
const scanner = require("../src/media/scanner");
const availability = require("../src/media/availability");
const newEpisodes = require("../src/media/newEpisodes");
const { RECENT_DAYS, notSeries } = newEpisodes._internals;

const DAY = 86400000;
const NOW = Date.parse("2026-07-28T12:00:00Z");
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);
const YEAR = new Date(NOW).getFullYear();

// metaCached() is the cache-only read the row depends on. Swapping it is how the
// episode lists get into these tests without a network or a warmed cache.
const withMeta = (byImdbId, run) => {
  const original = discover.metaCached;
  discover.metaCached = (_type, id) => byImdbId[id] || null;
  try {
    return run();
  } finally {
    discover.metaCached = original;
  }
};

// The downloaded side. Both reads are needed: allItems() to match a show by
// title, findById() to turn a played episode id back into a season and number.
const withLibrary = (items, run) => {
  const { allItems, findById } = scanner;
  scanner.allItems = () => items;
  scanner.findById = (id) => items.find((i) => i.id === id) || null;
  try {
    return run();
  } finally {
    scanner.allItems = allItems;
    scanner.findById = findById;
  }
};

const show = (over = {}) => ({
  type: "show",
  id: "lib1",
  imdbId: "tt1",
  title: "A Show",
  cover: "poster.jpg",
  ...over,
});

const seasons = (...episodes) => ({
  seasons: [{ number: 1, episodes: episodes.map((e, i) => ({ episode: i + 1, ...e })) }],
});

const catalogueOf = (...items) => {
  const map = new Map();
  for (const item of items) {
    if (item.id) map.set(item.id, item);
    if (item.imdbId) map.set(item.imdbId, item);
  }
  return map;
};

// ---------- who counts as followed ----------

test("My List and 4-5 stars count as following; 3 stars and below do not", () => {
  // The strict definition, on purpose. Anything looser (every show you ever
  // pressed play on) turns this row into a second Continue Watching and fills it
  // with shows you bounced off.
  const listed = show({ id: "a", imdbId: "tt-a", title: "Listed" });
  const loved = show({ id: "b", imdbId: "tt-b", title: "Five Stars" });
  const liked = show({ id: "c", imdbId: "tt-c", title: "Four Stars" });
  const meh = show({ id: "d", imdbId: "tt-d", title: "Three Stars" });
  const ignored = show({ id: "e", imdbId: "tt-e", title: "Unrated" });
  const catalogue = catalogueOf(listed, loved, liked, meh, ignored);

  const followed = newEpisodes.followedShows({
    watchlist: ["a"],
    ratings: { "tt-b": 5, "tt-c": 4, "tt-d": 3, "tt-e": 0 },
    catalogue,
  });
  assert.deepStrictEqual(
    followed.map((s) => s.title).sort(),
    ["Five Stars", "Four Stars", "Listed"],
  );
});

test("a stream ref in My List is followed just like a library id", () => {
  const streamed = show({ id: null, imdbId: "tt-x", title: "Streamed" });
  const followed = newEpisodes.followedShows({
    watchlist: [{ stream: true, imdbId: "tt-x" }],
    catalogue: catalogueOf(streamed),
  });
  assert.deepStrictEqual(followed.map((s) => s.title), ["Streamed"]);
});

test("films are never in this row, however much you liked them", () => {
  const film = { type: "movie", id: "m1", imdbId: "tt-m", title: "A Film" };
  const followed = newEpisodes.followedShows({
    ratings: { "tt-m": 5 },
    catalogue: catalogueOf(film),
  });
  assert.deepStrictEqual(followed, []);
});

test("a show rated twice over (listed AND rated) appears once", () => {
  const both = show({ id: "a", imdbId: "tt-a", title: "Both" });
  const followed = newEpisodes.followedShows({
    watchlist: ["a"],
    ratings: { "tt-a": 5 },
    catalogue: catalogueOf(both),
  });
  assert.strictEqual(followed.length, 1);
});

test("a downloaded show is followed on its rating alone, with no catalogue entry", () => {
  // The show most likely to be followed is the one least likely to be in the
  // catalogue: anything already downloaded is filtered OUT of the streamable
  // lists on purpose, and a scanner item carries no IMDb id to be found under.
  // Resolving through the cached meta instead is what lets this row show the
  // downloaded shows people actually follow.
  const local = { id: "lib9", type: "show", title: "Silo", episodeCount: 4 };
  withLibrary([local], () =>
    withMeta({ tt9: { title: "Silo", imdbId: "tt9", ...seasons({ released: iso(-3) }) } }, () => {
      const followed = newEpisodes.followedShows({ ratings: { tt9: 5 }, catalogue: new Map() });
      // The card is the local copy, so it opens the downloaded episodes — but it
      // carries the IMDb id the scanner could not know.
      assert.deepStrictEqual(
        followed.map((s) => ({ id: s.id, imdbId: s.imdbId })),
        [{ id: "lib9", imdbId: "tt9" }],
      );
    }),
  );
});

test("a rated film is asked about once, not on every home load", async () => {
  // A rating is id -> stars with no type beside it, so the only way to know a
  // 5-star id is a film is to ask for its series meta and be refused. Repeating
  // that per rated film per request would be a steady drip of doomed fetches.
  notSeries.clear();
  const { meta, metaCached } = discover;
  let calls = 0;
  discover.metaCached = () => null;
  discover.meta = async () => {
    calls += 1;
    throw new Error("not a series");
  };
  try {
    const args = { ratings: { tt1234567: 5 }, catalogue: new Map(), now: NOW };
    await newEpisodes.warm(args);
    await newEpisodes.warm(args);
    assert.strictEqual(calls, 1);
  } finally {
    discover.meta = meta;
    discover.metaCached = metaCached;
    notSeries.clear();
  }
});

// ---------- what counts as new ----------

test("a recently aired, unwatched episode puts the show in the row", () => {
  const s = show();
  withMeta({ tt1: seasons({ released: iso(-3) }) }, () => {
    const out = newEpisodes.select({
      watchlist: ["lib1"],
      catalogue: catalogueOf(s),
      now: NOW,
    });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(
      { season: out[0].newEpisode.season, episode: out[0].newEpisode.episode },
      { season: 1, episode: 1 },
    );
  });
});

test("an episode already watched is not new", () => {
  const s = show();
  withMeta({ tt1: seasons({ released: iso(-3) }) }, () => {
    const out = newEpisodes.select({
      watchlist: ["lib1"],
      catalogue: catalogueOf(s),
      progress: { "stream|tt1|1|1": { finished: true, updatedAt: 1 } },
      now: NOW,
    });
    assert.deepStrictEqual(out, []);
  });
});

test("an episode watched from the downloaded copy is not new either", () => {
  // Playing it locally records progress against the library EPISODE id, with no
  // IMDb id anywhere near it. Without joining the two sides by title the row
  // would keep offering the episode you watched last night.
  const local = { id: "lib9", type: "show", title: "Silo" };
  const played = { id: "ep2", showId: "lib9", season: 1, episode: 2 };
  withLibrary([local, played], () =>
    withMeta(
      { tt9: { title: "Silo", imdbId: "tt9", ...seasons({ released: iso(-9) }, { released: iso(-2) }) } },
      () => {
        const out = newEpisodes.select({
          ratings: { tt9: 5 },
          catalogue: new Map(),
          progress: { ep2: { finished: true, updatedAt: 1 } },
          now: NOW,
        });
        assert.strictEqual(out[0].newEpisodeCount, 1, "only the unwatched one is new");
        assert.strictEqual(out[0].newEpisode.episode, 1);
      },
    ),
  );
});

test("an episode that hasn't aired yet is not new", () => {
  // It belongs on the detail page. A row that promises something to watch
  // tonight must not offer next month's episode.
  const s = show();
  withMeta({ tt1: seasons({ released: iso(7) }) }, () => {
    assert.deepStrictEqual(
      newEpisodes.select({ watchlist: ["lib1"], catalogue: catalogueOf(s), now: NOW }),
      [],
    );
  });
});

test("an episode from long ago is not new", () => {
  const s = show();
  withMeta({ tt1: seasons({ released: iso(-(RECENT_DAYS + 5)) }) }, () => {
    assert.deepStrictEqual(
      newEpisodes.select({ watchlist: ["lib1"], catalogue: catalogueOf(s), now: NOW }),
      [],
    );
  });
});

test("the row counts how far behind you are and leads with the latest", () => {
  const s = show();
  withMeta(
    { tt1: seasons({ released: iso(-20) }, { released: iso(-13) }, { released: iso(-6) }) },
    () => {
      const out = newEpisodes.select({
        watchlist: ["lib1"],
        catalogue: catalogueOf(s),
        progress: { "stream|tt1|1|1": { finished: true, updatedAt: 1 } },
        now: NOW,
      });
      assert.strictEqual(out[0].newEpisodeCount, 2, "two unwatched of the three aired");
      assert.strictEqual(out[0].newEpisode.episode, 3, "the newest one is named");
    },
  );
});

test("shows are ordered by which aired most recently", () => {
  const older = show({ id: "a", imdbId: "tt-a", title: "Older" });
  const newer = show({ id: "b", imdbId: "tt-b", title: "Newer" });
  withMeta(
    { "tt-a": seasons({ released: iso(-20) }), "tt-b": seasons({ released: iso(-2) }) },
    () => {
      const out = newEpisodes.select({
        watchlist: ["a", "b"],
        catalogue: catalogueOf(older, newer),
        now: NOW,
      });
      assert.deepStrictEqual(out.map((s) => s.title), ["Newer", "Older"]);
    },
  );
});

test("a followed show whose meta isn't cached yet is simply skipped", () => {
  // Home is a cache-only read path. A cold meta contributes nothing this time
  // round rather than making the response wait on a fetch.
  const s = show();
  withMeta({}, () => {
    assert.deepStrictEqual(
      newEpisodes.select({ watchlist: ["lib1"], catalogue: catalogueOf(s), now: NOW }),
      [],
    );
  });
});

test("a show you don't follow is not in the row even with new episodes", () => {
  const s = show();
  withMeta({ tt1: seasons({ released: iso(-3) }) }, () => {
    assert.deepStrictEqual(
      newEpisodes.select({ catalogue: catalogueOf(s), now: NOW }),
      [],
    );
  });
});

// ---------- is a film actually watchable at home ----------

test("only this year and last are ambiguous enough to ask TMDB about", () => {
  // Everything older is out on something by now, and two requests to be told
  // what the year already said is two requests wasted.
  const film = (year) => ({ type: "movie", imdbId: "tt1", year });
  assert.strictEqual(availability.isAmbiguous(film(YEAR), NOW), true);
  assert.strictEqual(availability.isAmbiguous(film(YEAR - 1), NOW), true);
  assert.strictEqual(availability.isAmbiguous(film(YEAR - 2), NOW), false);
  assert.strictEqual(availability.isAmbiguous(film(2011), NOW), false);
});

test("shows and titles with no year or id are never asked about", () => {
  assert.strictEqual(
    availability.isAmbiguous({ type: "show", imdbId: "tt1", year: YEAR }, NOW),
    false,
  );
  assert.strictEqual(availability.isAmbiguous({ type: "movie", year: YEAR }, NOW), false);
  assert.strictEqual(
    availability.isAmbiguous({ type: "movie", imdbId: "tt1", year: null }, NOW),
    false,
  );
});

test("an older film needs no verdict to count as released", () => {
  assert.strictEqual(
    availability.isReleased({ type: "movie", imdbId: "tt1", year: 2011 }, NOW),
    true,
  );
});

test("'upcoming' needs evidence, so an unknown title claims neither row", () => {
  // The asymmetry is the point. isReleased is generous (showing a film a week
  // early beats hiding it on a failed lookup) but isUpcoming is not, or every
  // title TMDB has never heard of would pile into a row of things you cannot
  // watch.
  const unknown = { type: "movie", imdbId: "tt-never-looked-up", year: YEAR };
  assert.strictEqual(availability.isReleased(unknown, NOW), true);
  assert.strictEqual(availability.isUpcoming(unknown, NOW), false);
});

test("the earliest release of the wanted type wins", () => {
  const { earliest, HOME_TYPES, THEATRICAL_TYPES } = availability._internals;
  const results = [
    {
      iso_3166_1: "US",
      release_dates: [
        { type: 3, release_date: "2026-05-14T00:00:00.000Z" },
        { type: 4, release_date: "2026-07-21T00:00:00.000Z" },
      ],
    },
    {
      iso_3166_1: "DE",
      release_dates: [
        { type: 3, release_date: "2026-05-20T00:00:00.000Z" },
        { type: 5, release_date: "2026-08-01T00:00:00.000Z" },
      ],
    },
  ];
  assert.strictEqual(earliest(results, HOME_TYPES), Date.parse("2026-07-21T00:00:00.000Z"));
  assert.strictEqual(
    earliest(results, THEATRICAL_TYPES),
    Date.parse("2026-05-14T00:00:00.000Z"),
  );
});

test("a film with sources counts as out even when the digital date is next week", () => {
  // The Death of Robin Hood, on the day this was written: left cinemas on 19 June
  // with a digital date of 4 August, and sat in Upcoming with a page of 1080p
  // sources behind it. "Upcoming" is the wrong word for a film you can press play
  // on, so a verdict of "not out yet" is overridden by the sources actually
  // existing.
  const { isAvailable } = availability._internals;
  const theatricalOnly = { home: false, homeAt: null, theatricalAt: NOW - 40 * DAY };
  assert.strictEqual(isAvailable(theatricalOnly), false);
  assert.strictEqual(isAvailable({ ...theatricalOnly, streamed: true }), true);
  // And a digital release still stands on its own, probe or no probe.
  assert.strictEqual(isAvailable({ home: true, streamed: false }), true);
});

test("a film with only theatrical dates has no home release", () => {
  const { earliest, HOME_TYPES } = availability._internals;
  const results = [
    { iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2026-06-09T00:00:00.000Z" }] },
  ];
  assert.strictEqual(earliest(results, HOME_TYPES), null);
});

test("unparseable and empty release data is survived", () => {
  const { earliest, HOME_TYPES } = availability._internals;
  assert.strictEqual(earliest(null, HOME_TYPES), null);
  assert.strictEqual(earliest([], HOME_TYPES), null);
  assert.strictEqual(
    earliest([{ iso_3166_1: "US", release_dates: [{ type: 4, release_date: "" }] }], HOME_TYPES),
    null,
  );
});
