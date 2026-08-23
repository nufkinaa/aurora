// The taste model's contracts (prompt 9): distinct people get distinct rows,
// a low rating suppresses, recency decays, diversity holds, and every pick
// can say why. Pure — only _internals, no store, no network.
const test = require("node:test");
const assert = require("node:assert");

const { buildVector, scoreItem, recommend, decay, W, COLD_START } =
  require("../src/media/taste")._internals;

const NOW = Date.parse("2026-08-24T12:00:00Z");
const daysAgo = (d) => NOW - d * 86400000;

const sig = (genres, weight, why, at = null, type = "movie", year = 2020) =>
  ({ genres, type, year, weight, why, at });

const CANDIDATES = [
  { imdbId: "tt-h1", title: "The Haunting", genres: ["Horror"], type: "movie", year: 2021, rating: 7.4 },
  { imdbId: "tt-h2", title: "Grave Signs", genres: ["Horror", "Thriller"], type: "movie", year: 2019, rating: 7.0 },
  { imdbId: "tt-h3", title: "Night Shift", genres: ["Horror"], type: "movie", year: 2023, rating: 6.8 },
  { imdbId: "tt-h4", title: "The Cellar", genres: ["Horror"], type: "movie", year: 2022, rating: 6.9 },
  { imdbId: "tt-c1", title: "Big Laughs", genres: ["Comedy"], type: "movie", year: 2020, rating: 7.2 },
  { imdbId: "tt-c2", title: "Office Chaos", genres: ["Comedy"], type: "show", year: 2018, rating: 8.1 },
  { imdbId: "tt-c3", title: "Punchline", genres: ["Comedy", "Romance"], type: "movie", year: 2024, rating: 7.0 },
  { imdbId: "tt-d1", title: "Slow River", genres: ["Drama"], type: "movie", year: 2015, rating: 7.9 },
];

test("a horror-lover and a comedy-lover get disjoint, sensible top rows", () => {
  const horror = buildVector([
    sig(["Horror"], W.rate5, "Because you rated The Ritual 5★", daysAgo(5)),
    sig(["Horror", "Thriller"], W.finished, "You finished Midsommar", daysAgo(10)),
  ], NOW);
  const comedy = buildVector([
    sig(["Comedy"], W.rate5, "Because you rated Superbad 5★", daysAgo(5)),
    sig(["Comedy"], W.loved, "Because you love The Office", daysAgo(2), "show"),
  ], NOW);
  const hTop = recommend(horror, CANDIDATES, { max: 3 }).map((i) => i.imdbId);
  const cTop = recommend(comedy, CANDIDATES, { max: 3 }).map((i) => i.imdbId);
  assert.ok(hTop.every((id) => id.startsWith("tt-h")), `horror got ${hTop}`);
  assert.ok(cTop.every((id) => id.startsWith("tt-c")), `comedy got ${cTop}`);
  assert.ok(!hTop.some((id) => cTop.includes(id)), "rows are disjoint");
});

test("a 2★ rating measurably suppresses similar titles", () => {
  const neutral = buildVector([sig(["Horror"], W.finished, "You finished it", daysAgo(3))], NOW);
  const burned = buildVector([
    sig(["Horror"], W.finished, "You finished it", daysAgo(3)),
    sig(["Horror"], W.rate2, "rated it 2★", daysAgo(1)),
  ], NOW);
  const h = CANDIDATES[0];
  assert.ok(scoreItem(burned, h).score < scoreItem(neutral, h).score,
    "the 2★ pulled the genre down");
});

test("recency decay: an old signal weighs less than a fresh one", () => {
  assert.ok(decay(daysAgo(1), NOW) > decay(daysAgo(180), NOW));
  assert.ok(Math.abs(decay(daysAgo(90), NOW) - 0.5) < 0.01, "half-life is 90 days");
  assert.equal(decay(null, NOW), 1, "undated signals (ratings) count in full");
});

test("seen titles are never recommended (novelty)", () => {
  const v = buildVector([sig(["Horror"], W.rate5, "5★", daysAgo(1))], NOW);
  const out = recommend(v, CANDIDATES, { seen: new Set(["tt-h1", "tt-h2"]) });
  assert.ok(!out.some((i) => i.imdbId === "tt-h1" || i.imdbId === "tt-h2"));
});

test("diversity cap: one genre can't own the whole row", () => {
  const v = buildVector([sig(["Horror"], W.rate5, "5★", daysAgo(1))], NOW);
  const out = recommend(v, CANDIDATES, { max: 10, maxPerGenre: 2 });
  const horrorPrimary = out.filter((i) => (i.genres || [])[0] === "Horror").length;
  assert.ok(horrorPrimary <= 2, `got ${horrorPrimary} horror-primary picks`);
});

test("every positive pick carries an honest why", () => {
  const v = buildVector([sig(["Horror"], W.rate5, "Because you rated The Ritual 5★", daysAgo(1))], NOW);
  const out = recommend(v, CANDIDATES, { max: 3 });
  assert.ok(out.length > 0);
  for (const i of out) assert.match(i.why, /Because you rated The Ritual 5★/);
});

test("negative-only taste recommends nothing rather than nonsense", () => {
  const v = buildVector([sig(["Horror"], W.rate1, "rated it 1★", daysAgo(1))], NOW);
  const out = recommend(v, CANDIDATES.filter((c) => c.genres.includes("Horror")));
  assert.equal(out.length, 0);
});

test("the cold-start threshold exists and one lone signal sits under it", () => {
  const v = buildVector([sig(["Drama"], W.listed, "on your list", daysAgo(1))], NOW);
  assert.ok(v.total < COLD_START, "a single watchlist add must not flip the model on");
});
