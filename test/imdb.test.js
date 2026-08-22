// Matching a library title to an IMDb id. Getting this wrong is quietly
// expensive: a false match pulls the wrong show's episode list and the wrong
// subtitles onto a page, and a missed match silently costs a title its sources.
const { test } = require("node:test");
const assert = require("node:assert");

const imdb = require("../src/media/imdb");
const { norm } = imdb._internals;

test("titles normalise past punctuation and spacing", () => {
  assert.equal(norm("Avatar: The Last Airbender"), norm("Avatar The Last Airbender"));
  assert.equal(norm("  How  I  Met   Your Mother "), "how i met your mother");
  assert.equal(norm("Marvel's Daredevil"), "marvel s daredevil");
  assert.equal(norm(null), "");
});

// The ranking rules, as applied by resolve() — pinned here as pure logic so the
// behaviour is checked without hitting the network.
const pick = (pool, title, year) => {
  const want = norm(title);
  const exact = pool.filter((m) => norm(m.title) === want);
  const loose = pool.filter(
    (m) => norm(m.title).startsWith(want) ||
      (year && m.year && Math.abs(m.year - year) <= 1 && want.startsWith(norm(m.title)))
  );
  const ranked = (exact.length ? exact : loose).sort((a, b) => {
    if (!year) return 0;
    return Math.abs((a.year || 0) - year) - Math.abs((b.year || 0) - year);
  });
  const best = ranked[0];
  if (best && (!year || !best.year || Math.abs(best.year - year) <= 1)) return best.imdbId;
  return null;
};

test("an exact title wins", () => {
  const pool = [
    { title: "Avatar", year: 2009, imdbId: "tt0499549" },
    { title: "Avatar: The Last Airbender", year: 2024, imdbId: "tt9018736" },
  ];
  assert.equal(pick(pool, "Avatar", 2009), "tt0499549");
  assert.equal(pick(pool, "Avatar: The Last Airbender", 2024), "tt9018736");
});

test("the year separates remakes with the same title", () => {
  const pool = [
    { title: "The Office", year: 2005, imdbId: "tt0386676" },
    { title: "The Office", year: 2001, imdbId: "tt0290978" },
  ];
  assert.equal(pick(pool, "The Office", 2005), "tt0386676");
  assert.equal(pick(pool, "The Office", 2001), "tt0290978");
});

test("a folder name with extra words still matches, when the year agrees", () => {
  // "Avatar Movie (2009)" is a real folder name in a hand-built library.
  const pool = [{ title: "Avatar", year: 2009, imdbId: "tt0499549" }];
  assert.equal(pick(pool, "Avatar Movie", 2009), "tt0499549");
});

test("extra words do NOT match when the year disagrees", () => {
  const pool = [{ title: "Alien", year: 1979, imdbId: "tt0078748" }];
  assert.equal(pick(pool, "Alien Romulus", 2024), null, "a different film entirely");
});

test("a candidate whose year is far off is refused", () => {
  const pool = [{ title: "Dune", year: 1984, imdbId: "tt0087182" }];
  assert.equal(pick(pool, "Dune", 2021), null);
});

test("a year within one is accepted (release-date drift)", () => {
  const pool = [{ title: "Some Film", year: 2019, imdbId: "tt1" }];
  assert.equal(pick(pool, "Some Film", 2020), "tt1");
});

test("no match returns null rather than a guess", () => {
  const pool = [{ title: "Something Else", year: 2000, imdbId: "tt9" }];
  assert.equal(pick(pool, "Disclosure Day", 2021), null);
});

test("resolve rejects an empty title without calling anything", async () => {
  assert.equal(await imdb.resolve("", "movie", 2000), null);
  assert.equal(await imdb.resolve(null, "show", null), null);
});
