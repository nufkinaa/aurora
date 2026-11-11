// Continue Watching rules (media/continuerow.js), elia 2026-11-11: only the
// latest episode of a series, and nothing the person has finished — over a
// fake library and history, no stores.
const test = require("node:test");
const assert = require("node:assert");

const cr = require("../src/media/continuerow");
const profiles = require("../src/profiles");

const ep = (show, season, episode, extra = {}) => ({
  id: `${show}-s${season}e${episode}`,
  type: "episode",
  showId: show,
  showTitle: show === "silo" ? "Silo" : "Ted",
  season,
  episode,
  title: `Episode ${episode}`,
  ...extra,
});
const SILO = {
  id: "silo",
  type: "show",
  title: "Silo",
  imdbId: "tt14688458",
  cover: "/c/silo.jpg",
  seasons: [
    { number: 1, episodes: [1, 2, 3, 4, 5, 6].map((n) => ep("silo", 1, n)) },
    { number: 2, episodes: [1, 2, 3].map((n) => ep("silo", 2, n)) },
  ],
};
const TED = {
  id: "ted",
  type: "show",
  title: "Ted",
  imdbId: null,
  cover: "/c/ted.jpg",
  seasons: [{ number: 1, episodes: [1, 2, 3].map((n) => ep("ted", 1, n)) }],
};
const FILM = { id: "arrival", type: "movie", title: "Arrival", imdbId: "tt2543164", duration: 6982 };
const LIB = new Map();
for (const s of [SILO, TED]) {
  LIB.set(s.id, s);
  for (const se of s.seasons) for (const e of se.episodes) LIB.set(e.id, e);
}
LIB.set(FILM.id, FILM);

// A row: position / duration in seconds, `at` the updatedAt stamp.
const row = (position, duration, at, finished = position / duration > 0.95) => ({ position, duration, finished, updatedAt: at });

const deps = (view, { streamItems = {}, credits = {}, streamCredits = {}, upNextDismissed = {}, hidden = {}, owned = () => null } = {}) => ({
  streamMeta: (id) => streamItems[id] || null,
  ownedPlayable: owned,
  libraryItem: (id) => LIB.get(id) || null,
  show: (id) => LIB.get(id) || null,
  showImdb: (show) => show.imdbId || null,
  libraryShowFor: ({ imdbId, title }) =>
    [SILO, TED].find((s) => (imdbId && s.imdbId === imdbId) || cr.norm(s.title) === cr.norm(title)) || null,
  progressOf: (id) => view[id] || null,
  creditsLibrary: (id) => (id in credits ? credits[id] : null),
  creditsStream: (meta) => streamCredits[`${meta.imdbId}:${meta.season}:${meta.episode}`] ?? null,
  upNextDismissed,
  hidden,
});
const run = (view, opts) => cr.pick(Object.entries(view), deps(view, opts));
const ids = (items) => items.map((i) => i.id);

const streamEp = (hash, season, episode, extra = {}) => ({
  id: `torrent|${hash}|0`,
  type: "movie",
  title: `Silo · S${season} E${episode}`,
  imdbId: "tt14688458",
  season,
  episode,
  ...extra,
});

test("(a) S1E4 half-watched from disk, then S2E2 streamed: one card, S2E2", () => {
  const s = streamEp("aa", 2, 2);
  const view = { "silo-s1e4": row(1200, 3000, 100), [s.id]: row(900, 3000, 200) };
  const items = run(view, { streamItems: { [s.id]: s } });
  assert.deepEqual(ids(items), [s.id]);
  assert.equal(items[0].season, 2);
  assert.equal(items[0].episode, 2);
});

test("a show streamed on Monday and played from disk on Tuesday is one card — the disk one, newest", () => {
  const s = streamEp("bb", 1, 2);
  const view = { [s.id]: row(900, 3000, 100), "silo-s1e3": row(600, 3000, 200) };
  assert.deepEqual(ids(run(view, { streamItems: { [s.id]: s } })), ["silo-s1e3"]);
});

test("a streamed show with no IMDb id is one card, not one per episode", () => {
  const a = { id: "torrent|c1|0", type: "movie", title: "Severance · S1 E2", season: 1, episode: 2 };
  const b = { id: "torrent|c2|0", type: "movie", title: "Severance · S1 E3", season: 1, episode: 3 };
  const view = { [a.id]: row(500, 3000, 100), [b.id]: row(700, 3000, 200) };
  assert.deepEqual(ids(run(view, { streamItems: { [a.id]: a, [b.id]: b } })), [b.id]);
});

test("a library show with no IMDb id and a stream of it with one name: one card", () => {
  const s = { id: "torrent|t1|0", type: "movie", title: "Ted · S1 E3", season: 1, episode: 3 };
  const view = { "ted-s1e2": row(500, 1300, 100), [s.id]: row(300, 1300, 200) };
  assert.deepEqual(ids(run(view, { streamItems: { [s.id]: s } })), [s.id]);
});

test("two shows that share a name but have different IMDb ids stay two cards", () => {
  const a = { id: "torrent|o1|0", title: "The Office · S1 E1", imdbId: "tt0386676", season: 1, episode: 1 };
  const b = { id: "torrent|o2|0", title: "The Office · S1 E1", imdbId: "tt0290978", season: 1, episode: 1 };
  const view = { [a.id]: row(500, 1300, 100), [b.id]: row(300, 1300, 200) };
  assert.deepEqual(ids(run(view, { streamItems: { [a.id]: a, [b.id]: b } })), [b.id, a.id]);
});

test("(b) E5 finished, then E4 rewatched to the end: no up next for the finished E5 — E6 instead", () => {
  const view = { "silo-s1e5": row(3000, 3000, 100), "silo-s1e4": row(2990, 3000, 200) };
  const items = run(view);
  assert.deepEqual(ids(items), ["silo-s1e6"]);
  assert.equal(items[0].upNext, true);
  assert.equal(items[0].progress, null);
  assert.equal(items[0].showTitle, "Silo");
});

test("(b) …and when every later episode on disk is finished, the series leaves the row", () => {
  const view = {
    "silo-s1e5": row(3000, 3000, 100),
    "silo-s1e6": row(3000, 3000, 110),
    "silo-s2e1": row(3000, 3000, 120),
    "silo-s2e2": row(3000, 3000, 130),
    "silo-s2e3": row(3000, 3000, 140),
    "silo-s1e4": row(2990, 3000, 200),
    "silo-s1e2": row(1000, 3000, 50), // an older half-watched one does not come back
  };
  assert.deepEqual(ids(run(view)), []);
});

test("up next skips an episode marked watched (a mark is finished with an old stamp)", () => {
  const view = { "silo-s1e2": { ...row(3000, 3000, 0), marked: true }, "silo-s1e1": row(3000, 3000, 100) };
  assert.deepEqual(ids(run(view)), ["silo-s1e3"]);
});

test("up next skips an episode stopped in its credits", () => {
  const view = { "silo-s1e2": row(2850, 3000, 50), "silo-s1e1": row(3000, 3000, 100) };
  assert.deepEqual(ids(run(view, { credits: { "silo-s1e2": 2800 } })), ["silo-s1e3"]);
});

test("a finished streamed episode counts: up next is the next one on disk", () => {
  const s = streamEp("dd", 1, 5);
  const view = { [s.id]: row(3000, 3000, 200), "silo-s1e2": row(800, 3000, 100) };
  const items = run(view, { streamItems: { [s.id]: s } });
  assert.deepEqual(ids(items), ["silo-s1e6"]);
  assert.equal(items[0].upNext, true);
});

test("a finished last episode with nothing after it on disk: the series is gone, older episodes too", () => {
  const view = { "silo-s2e3": row(3000, 3000, 200), "silo-s1e2": row(800, 3000, 100) };
  assert.deepEqual(ids(run(view)), []);
});

test("a film stopped in the credits is gone; one stopped before them stays", () => {
  const arrival = row(6500, 6982, 100); // 93 %
  assert.deepEqual(ids(run({ arrival })), [], "93 % with no credits time known: in the credits");
  assert.deepEqual(ids(run({ arrival: row(6000, 6982, 100) })), ["arrival"], "86 %: still watching");
});

test("an episode in its credits (known credits start) is finished and moves to up next", () => {
  const view = { "silo-s1e2": row(2840, 3000, 100) };
  assert.deepEqual(ids(run(view)), ["silo-s1e2"], "no credits time: 94.7 % is not finished");
  const items = run(view, { credits: { "silo-s1e2": 2800 } });
  assert.deepEqual(ids(items), ["silo-s1e3"]);
  assert.equal(items[0].upNext, true);
});

test("a streamed episode in its credits (the skip databases' time) is finished", () => {
  const s = streamEp("ee", 2, 1);
  const view = { [s.id]: row(2700, 3000, 100) };
  assert.deepEqual(ids(run(view, { streamItems: { [s.id]: s } })), [s.id]);
  const items = run(view, { streamItems: { [s.id]: s }, streamCredits: { "tt14688458:2:1": 2650 } });
  assert.deepEqual(ids(items), ["silo-s2e2"]);
});

test("an implausible credits time (mid-programme) is not believed", () => {
  const view = { "silo-s1e2": row(1600, 3000, 100) };
  assert.deepEqual(ids(run(view, { credits: { "silo-s1e2": 1500 } })), ["silo-s1e2"]);
});

test("finished rules: thresholds", () => {
  const { isDone } = cr;
  assert.equal(isDone(row(2851, 3000, 0)), true, "a film at 95 %");
  assert.equal(isDone({ position: 6430, duration: 6982 }), true, "a film at 92.1 %");
  assert.equal(isDone({ position: 6400, duration: 6982 }), false, "a film at 91.7 %");
  assert.equal(isDone({ position: 1100, duration: 1200 }), true, "a short film with 100 s left");
  assert.equal(isDone({ position: 2700, duration: 3000 }, { episode: true }), false, "an episode at 90 %");
  assert.equal(isDone({ position: 1250, duration: 1300 }, { episode: true }), true, "an episode with 50 s left");
  assert.equal(isDone({ position: 1200, duration: 1300 }, { episode: true }), false, "an episode with 100 s left");
  assert.equal(isDone({ position: 2600, duration: 3000 }, { episode: true, creditsAt: 2590 }), true, "in the credits");
  assert.equal(isDone({ position: 30, duration: 60 }), false, "a one-minute clip half-watched (tail rules start at 80 %)");
  assert.equal(isDone({ position: 30, duration: 45 }, { episode: true }), false, "a 45-second episode at 30 s");
  assert.equal(isDone({ position: 0, duration: 0 }), false);
  assert.equal(isDone({ position: 10, duration: 3000, finished: true }), true, "marked watched");
});

test("finished films and episodes never show; half-watched ones do, newest first", () => {
  const s = streamEp("ff", 1, 1);
  const view = {
    arrival: row(6982, 6982, 300),
    "ted-s1e1": row(600, 1300, 200),
    [s.id]: row(1200, 3000, 100),
  };
  assert.deepEqual(ids(run(view, { streamItems: { [s.id]: s } })), ["ted-s1e1", s.id]);
});

test("barely started (10 s or less) neither makes a card nor claims the series", () => {
  const view = { "silo-s1e3": row(5, 3000, 200), "silo-s1e2": row(800, 3000, 100) };
  assert.deepEqual(ids(run(view)), ["silo-s1e2"]);
});

test("a streamed episode whose title is now on disk gives way to the library row", () => {
  const s = streamEp("gg", 1, 2);
  const view = { [s.id]: row(800, 3000, 100), "silo-s1e2": row(800, 3000, 100) };
  const owned = (meta) => (meta.season === 1 && meta.episode === 2 ? LIB.get("silo-s1e2") : null);
  assert.deepEqual(ids(run(view, { streamItems: { [s.id]: s }, owned })), ["silo-s1e2"]);
});

test("the up-next ✕ still hides that one next episode, and the series with it", () => {
  const view = { "silo-s1e1": row(3000, 3000, 200), "silo-s2e1": row(500, 3000, 100) };
  assert.deepEqual(ids(run(view, { upNextDismissed: { silo: "silo-s1e2" } })), []);
  // watch further: the candidate changes and the card comes back
  view["silo-s1e2"] = row(3000, 3000, 300);
  assert.deepEqual(ids(run(view, { upNextDismissed: { silo: "silo-s1e2" } })), ["silo-s1e3"]);
});

test("the ✕ on an episode card hides its series until something of it is watched again", () => {
  // the newest (S1E4) was cleared; S1E2 is older than the ✕
  const view = { "silo-s1e2": row(800, 3000, 100) };
  assert.deepEqual(ids(run(view, { hidden: { tt14688458: 150 } })), []);
  view["silo-s1e5"] = row(400, 3000, 200);
  assert.deepEqual(ids(run(view, { hidden: { tt14688458: 150 } })), ["silo-s1e5"]);
  // a show with no IMDb id is hidden by its name
  const t = { "ted-s1e1": row(800, 1300, 100) };
  assert.deepEqual(ids(run(t, { hidden: { "t:ted": 150 } })), []);
});

test("no more than 12 cards", () => {
  const view = {};
  for (let i = 0; i < 20; i++) {
    const id = `film${i}`;
    LIB.set(id, { id, type: "movie", title: `Film ${i}`, imdbId: `tt10000${i}` });
    view[id] = row(600, 6000, i);
  }
  assert.equal(run(view).length, 12);
});

test("series names from stream titles", () => {
  assert.equal(cr.seriesTitleOf({ title: "Silo · S2 E3" }), "Silo");
  assert.equal(cr.seriesTitleOf({ title: "Mr. Robot S01E02" }), "Mr. Robot");
  assert.equal(cr.seriesTitleOf({ title: "x", showTitle: "Ted" }), "Ted");
});

test("profiles: the ✕ stamps the series of a streamed episode (before its play-item is cleared)", () => {
  const { hideSeries } = profiles._internals;
  const state = { progress: {}, streamItems: { "torrent|h|0": streamEp("h", 1, 2) }, titles: {} };
  hideSeries(state, "torrent|h|0", 5000);
  assert.deepEqual(state.cwHidden, { tt14688458: 5000 });
  const noId = { progress: {}, streamItems: { "torrent|n|0": { title: "Severance · S1 E1", season: 1, episode: 1 } }, titles: {} };
  hideSeries(noId, "torrent|n|0", 6000);
  assert.deepEqual(noId.cwHidden, { "t:severance": 6000 });
  const film = { progress: {}, streamItems: { "torrent|f|0": { title: "Arrival", imdbId: "tt2543164" } }, titles: {} };
  hideSeries(film, "torrent|f|0", 7000);
  assert.equal(film.cwHidden, undefined, "a film needs no stamp: its whole history goes");
});
