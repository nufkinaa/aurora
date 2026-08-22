// Folding duplicate show folders into one library entry. The downloader names
// folders "<Title> (<Year>)" and hand-made libraries usually don't, so the same
// series can sit in two folders; this must join them WITHOUT moving files or
// changing episode ids (ids come from the path — changing one loses its watch
// progress).
const { test } = require("node:test");
const assert = require("node:assert");

const scanner = require("../src/media/scanner");
const { mergeDuplicateShows } = scanner._internals;

const ep = (id, season, episode) => ({
  id,
  season,
  episode,
  title: `Episode ${episode}`,
  addedAt: 1,
});

const show = (id, title, year, seasons, extra = {}) => ({
  id,
  type: "show",
  title,
  year,
  seasons: seasons.map(([number, eps]) => ({ number, episodes: eps })),
  episodeCount: seasons.reduce((n, [, eps]) => n + eps.length, 0),
  extras: [],
  genres: [],
  addedAt: 1,
  cover: null,
  backdrop: null,
  synopsis: "",
  rating: null,
  certificate: null,
  ...extra,
});

test("a hand-made folder and a downloaded (Year) folder become one entry", () => {
  const merged = mergeDuplicateShows([
    show("A", "How I Met Your Mother", 2005, [
      [1, [ep("e1", 1, 1), ep("e2", 1, 2)]],
      [2, [ep("e3", 2, 1)]],
    ]),
    show("B", "How I Met Your Mother", 2005, [[6, [ep("e4", 6, 2)]]]),
  ]);
  assert.equal(merged.length, 1, "one series, one entry");
  assert.equal(
    merged[0].id,
    "A",
    "the bigger folder keeps its id, so existing links still work",
  );
  assert.deepEqual(
    merged[0].seasons.map((s) => s.number),
    [1, 2, 6],
  );
  assert.equal(merged[0].episodeCount, 4);
});

test("merging preserves every episode id", () => {
  const merged = mergeDuplicateShows([
    show("A", "Gate", 2015, [[1, [ep("keep1", 1, 1)]]]),
    show("B", "Gate", 2015, [[1, [ep("keep2", 1, 2)]]]),
  ]);
  const ids = merged[0].seasons.flatMap((s) => s.episodes.map((e) => e.id));
  assert.deepEqual(
    ids.sort(),
    ["keep1", "keep2"],
    "no episode is dropped and no id is rewritten",
  );
});

test("episodes of a shared season are merged in episode order", () => {
  const merged = mergeDuplicateShows([
    show("A", "Ted", 2024, [[1, [ep("a", 1, 1), ep("c", 1, 5)]]]),
    show("B", "Ted", 2024, [[1, [ep("b", 1, 3)]]]),
  ]);
  assert.deepEqual(
    merged[0].seasons[0].episodes.map((e) => e.episode),
    [1, 3, 5],
  );
});

test("different shows are never merged", () => {
  const merged = mergeDuplicateShows([
    show("A", "Avatar", 2009, [[1, [ep("a", 1, 1)]]]),
    show("B", "Avatar The Last Airbender", 2024, [[1, [ep("b", 1, 1)]]]),
  ]);
  assert.equal(merged.length, 2);
});

test("the same title from different years stays separate", () => {
  const merged = mergeDuplicateShows([
    show("A", "The Office", 2005, [[1, [ep("a", 1, 1)]]]),
    show("B", "The Office", 2001, [[1, [ep("b", 1, 1)]]]),
  ]);
  assert.equal(merged.length, 2, "a remake is not the same series");
});

test("the merged entry inherits artwork the bigger folder lacks", () => {
  const merged = mergeDuplicateShows([
    show("A", "Silo", 2023, [[1, [ep("a", 1, 1), ep("a2", 1, 2)]]], {
      cover: null,
      synopsis: "",
    }),
    show("B", "Silo", 2023, [[2, [ep("b", 2, 1)]]], {
      cover: "/img/xyz",
      synopsis: "In a ruined world.",
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cover, "/img/xyz");
  assert.equal(merged[0].synopsis, "In a ruined world.");
});

test("a library with no duplicates is returned unchanged", () => {
  const input = [
    show("A", "Gate", 2015, [[1, [ep("a", 1, 1)]]]),
    show("B", "Ted", 2024, [[1, [ep("b", 1, 1)]]]),
  ];
  const merged = mergeDuplicateShows(input);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((s) => s.id).sort(), ["A", "B"]);
});

// ---------- subtitle label collisions ----------
//
// A sidecar named "English" and an embedded English stream are two different
// tracks with one name. Both must survive, but a menu with two identical
// entries makes choosing a coin toss.
const { uniqueLabels } = scanner._internals;

test("a sidecar and an embedded track sharing a name are told apart", () => {
  const tracks = uniqueLabels([
    { label: "English", url: "/a" },
    { label: "Hebrew", url: "/b" },
    { label: "English", url: "/c", embedded: true },
  ]);
  assert.deepEqual(
    tracks.map((t) => t.label),
    ["English", "Hebrew", "English 2"],
  );
  assert.equal(tracks.length, 3, "no track is dropped");
});

test("numbering skips names already in use", () => {
  const tracks = uniqueLabels([
    { label: "English" },
    { label: "English 2" },
    { label: "English 3" },
    { label: "English" }, // the collision
  ]);
  assert.deepEqual(
    tracks.map((t) => t.label),
    ["English", "English 2", "English 3", "English 4"],
  );
});

test("labels that don't collide are left exactly as they were", () => {
  const tracks = uniqueLabels([
    { label: "Hebrew" },
    { label: "Hebrew 2" },
    { label: "English - SDH" },
  ]);
  assert.deepEqual(
    tracks.map((t) => t.label),
    ["Hebrew", "Hebrew 2", "English - SDH"],
  );
});
