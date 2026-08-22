// Browse catalog rules. These cover the two ways "New" went wrong in
// production: it shared a cache key with Trending, and it trusted the shelf a
// title came from instead of the title's own release year.
const test = require("node:test");
const assert = require("node:assert");

const { cacheKey, isNewRelease, isFullPage, PAGE_SIZE, NEW_SPAN } =
  require("../src/media/discover")._internals;

// ---------- cache keys ----------

test("New and Trending in the same genre do not share a cache key", () => {
  // The bug: "New + Western" used to rewrite itself onto the `top` catalog, so
  // it produced the identical key to plain Trending + Western while caching a
  // year-filtered list. Whichever page loaded first decided what the other saw
  // — Trending poisoned New with 1967 westerns, and New poisoned Trending down
  // to a single title. New no longer touches `top` at all.
  const trending = cacheKey("movie", "top", "Western", 0);
  const news = cacheKey("movie", "year", "2026", 0);
  assert.notStrictEqual(trending, news);
});

test("a cache key separates type, catalog, extra and skip", () => {
  const base = cacheKey("movie", "top", "Western", 0);
  assert.notStrictEqual(base, cacheKey("series", "top", "Western", 0));
  assert.notStrictEqual(base, cacheKey("movie", "imdbRating", "Western", 0));
  assert.notStrictEqual(base, cacheKey("movie", "top", "Horror", 0));
  assert.notStrictEqual(base, cacheKey("movie", "top", "Western", 50));
});

test("no genre and an empty-string genre are the same request", () => {
  assert.strictEqual(cacheKey("movie", "top", null, 0), cacheKey("movie", "top", "", 0));
});

// ---------- what counts as "New" ----------

const meta = (year, genres = []) => ({ year, genres, imdbId: "tt1" });

test("a title older than the floor is not new, whatever shelf it came from", () => {
  // Real leak: Cinemeta's 2026 year catalog returns this on page 0.
  assert.strictEqual(isNewRelease(meta(1998, ["Comedy"]), 2025, null), false);
  assert.strictEqual(isNewRelease(meta(1967, ["Western"]), 2025, "Western"), false);
});

test("a title at or after the floor is new", () => {
  assert.strictEqual(isNewRelease(meta(2025), 2025, null), true);
  assert.strictEqual(isNewRelease(meta(2026), 2025, null), true);
});

test("a title with no release year is not new", () => {
  // Previously `!m.year ||` let these through, so undated entries counted as new.
  assert.strictEqual(isNewRelease(meta(null), 2025, null), false);
  assert.strictEqual(isNewRelease({ genres: [] }, 2025, null), false);
});

test("the genre must be on the title itself", () => {
  assert.strictEqual(isNewRelease(meta(2026, ["Drama", "Western"]), 2025, "Western"), true);
  assert.strictEqual(isNewRelease(meta(2026, ["Drama"]), 2025, "Western"), false);
  assert.strictEqual(isNewRelease(meta(2026, []), 2025, "Western"), false);
});

test("a missing genres array is treated as no genres, not a match", () => {
  assert.strictEqual(isNewRelease({ year: 2026 }, 2025, "Western"), false);
  assert.strictEqual(isNewRelease({ year: 2026 }, 2025, null), true);
});

test("the New window spans this year and last", () => {
  const thisYear = new Date().getFullYear();
  const floor = thisYear - (NEW_SPAN - 1);
  assert.strictEqual(isNewRelease(meta(thisYear), floor, null), true);
  assert.strictEqual(isNewRelease(meta(thisYear - 1), floor, null), true);
  assert.strictEqual(isNewRelease(meta(thisYear - 2), floor, null), false);
});

// ---------- end of catalog ----------

test("a short page means the catalog is exhausted", () => {
  assert.strictEqual(isFullPage(PAGE_SIZE), true);
  assert.strictEqual(isFullPage(46), true);   // Cinemeta trims a few per page
  assert.strictEqual(isFullPage(3), false);
  assert.strictEqual(isFullPage(0), false);
});
