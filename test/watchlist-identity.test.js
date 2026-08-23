// The My List identity landmine, unit-tested (prompt-05's three required
// behaviors). Everything runs on the PURE halves with injected fakes —
// profiles.json (live household data) is never touched.
const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const { entryKey, sameIdentity, materializeWatchlist } = profiles._internals;

// A fake library: one downloaded movie the household also listed as a stream.
const LIB_ARRIVAL = {
  id: "lib123",
  type: "movie",
  title: "Arrival",
  year: 2016,
  cover: "/img/abc",
  genres: ["Sci-Fi"],
};
const STREAM_ARRIVAL = {
  stream: true,
  imdbId: "tt2543164",
  type: "movie",
  title: "Arrival",
  year: 2016,
  poster: "https://cdn.example/arrival.jpg",
};
const STREAM_DUNE = {
  stream: true,
  imdbId: "tt1160419",
  type: "movie",
  title: "Dune",
  year: 2021,
  poster: "https://cdn.example/dune.jpg",
};

const deps = {
  findById: (id) => (id === "lib123" ? LIB_ARRIVAL : null),
  findLibrary: (ref) => (ref && ref.imdbId === "tt2543164" ? LIB_ARRIVAL : null),
  imdbIdFor: (item) => (item.id === "lib123" ? "tt2543164" : null),
};

test("a stream ref of an OWNED title materializes as ONE library card with both keys", () => {
  const items = materializeWatchlist([STREAM_ARRIVAL], deps);
  assert.equal(items.length, 1);
  const card = items[0];
  assert.equal(card.id, "lib123", "library id wins");
  assert.equal(card.cover, "/img/abc", "library cover wins — one title, one cover");
  assert.equal(card.imdbId, "tt2543164", "stream key still carried");
  assert.equal(card.listKey, "disc:tt2543164", "original stored key preserved for removal");
  assert.ok(!card.source, "NO source:stream — this is what routes it to the library page");
});

test("both forms stored → exactly one card (elia's item 11 verbatim)", () => {
  const items = materializeWatchlist(["lib123", STREAM_ARRIVAL], deps);
  assert.equal(items.length, 1);
});

test("an unowned stream ref stays a stream card, keys intact", () => {
  const items = materializeWatchlist([STREAM_DUNE], deps);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "stream");
  assert.equal(items[0].id, "disc:tt1160419");
  assert.equal(items[0].listKey, "disc:tt1160419");
});

test("landmine (a): removal reaches the stored entry whatever form the card took", () => {
  // The deduped card shows as the library item; the user un-lists it from the
  // LIBRARY detail page, which sends the library id. sameIdentity must match
  // that id against the stored stream ref.
  const stored = [STREAM_ARRIVAL];
  const removed = stored.filter((e) => !sameIdentity(e, "lib123", deps));
  assert.equal(removed.length, 0, "the stream ref is removed by the library id");
});

test("removal takes BOTH twins in one action", () => {
  const stored = ["lib123", STREAM_ARRIVAL, STREAM_DUNE];
  const removed = stored.filter((e) => !sameIdentity(e, "lib123", deps));
  assert.deepEqual(removed, [STREAM_DUNE], "both Arrival forms gone, Dune untouched");
});

test("membership check sees the library entry as the stream form's twin", () => {
  // The UI's "in my list?" check is identity-aware (button state), while the
  // ADD path dedupes on exact entryKey only — both forms may be stored, each
  // carrying keys the other lacks; the materializer collapses them to one.
  const stored = ["lib123"];
  const has = stored.some((e) => sameIdentity(e, STREAM_ARRIVAL, deps));
  assert.ok(has, "membership check sees the library entry as the same title");
});

test("an IMDb cache collision between two LIBRARY items hides neither", () => {
  // Pathological but possible: cachedIdFor resolves two different library
  // titles to the same imdbId. Library-stored cards must dedupe by id only.
  const LIB_OTHER = { id: "lib999", type: "movie", title: "Arrival Two", year: 2020, cover: "/img/xyz" };
  const collide = {
    findById: (id) => (id === "lib123" ? LIB_ARRIVAL : id === "lib999" ? LIB_OTHER : null),
    findLibrary: () => null,
    imdbIdFor: () => "tt2543164", // both resolve to the same id
  };
  const items = materializeWatchlist(["lib123", "lib999"], collide);
  assert.equal(items.length, 2, "both library titles stay visible");
});

test("a library item with NO cover borrows the stream ref's poster", () => {
  const bare = { ...LIB_ARRIVAL, cover: null };
  const d = { ...deps, findLibrary: () => bare, findById: () => bare };
  const items = materializeWatchlist([STREAM_ARRIVAL], d);
  assert.equal(items[0].cover, "https://cdn.example/arrival.jpg");
});

test("identity never bleeds across different titles", () => {
  assert.ok(!sameIdentity(STREAM_DUNE, "lib123", deps));
  assert.ok(!sameIdentity(STREAM_DUNE, STREAM_ARRIVAL, deps));
});

test("entryKey stays byte-compatible with stored data", () => {
  assert.equal(entryKey("lib123"), "lib123");
  assert.equal(entryKey(STREAM_ARRIVAL), "disc:tt2543164");
});

test("a dangling library id (file deleted) drops out without crashing", () => {
  const items = materializeWatchlist(["gone999"], deps);
  assert.equal(items.length, 0);
});
