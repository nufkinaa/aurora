// How the recommender studies a person (src/media/recs/person.js): stored
// profile state -> per-title evidence -> the taste model. Synthetic histories,
// a pinned clock — no store, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const person = require("../src/media/recs/person");
const features = require("../src/media/recs/features");
const { fromTmdb } = require("../src/media/recs/titleindex")._internals;
const { rewatchCount, noteDismissed } = require("../src/profiles")._internals;
const { W } = person;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86400000;
const ago = (days) => NOW - days * DAY;
const film = (position, duration, at, extra = {}) => ({ position, duration, finished: duration > 0 && position / duration > 0.95, updatedAt: at, ...extra });
const ep = (at, done = true) => ({ position: done ? 2700 : 400, duration: 2700, finished: done, updatedAt: at });
const eventsOf = (state, opts = {}) => person.collectEvents(state, { now: NOW, ...opts });
const one = (state, id, opts) => eventsOf(state, opts).titles.get(id);

test("a finished film is a clear positive; most-watched is a weaker one", () => {
  const t = one({ titles: { tt0000001: film(6000, 6000, ago(2)), tt0000002: film(4500, 6000, ago(2)) } }, "tt0000001");
  assert.equal(t.w, W.finished);
  assert.ok(t.kinds.has("finished"));
  const most = one({ titles: { tt0000002: film(4500, 6000, ago(2)) } }, "tt0000002");
  assert.equal(most.w, W.mostly);
  assert.ok(W.finished > W.mostly);
});

test("giving up early is a NEGATIVE — but only once it has been left alone", () => {
  const justStarted = eventsOf({ titles: { tt0000001: film(600, 6000, ago(0.5)) } });
  assert.equal(justStarted.titles.get("tt0000001"), undefined, "ten minutes in, an hour ago: no verdict yet");
  assert.ok(justStarted.seen.has("tt0000001"), "…but it is in Continue Watching, so never recommended");
  const abandoned = one({ titles: { tt0000001: film(600, 6000, ago(10)) } }, "tt0000001");
  assert.equal(abandoned.w, W.abandoned);
  assert.ok(abandoned.w < 0);
  const sampled = eventsOf({ titles: { tt0000001: film(120, 6000, ago(10)) } });
  assert.equal(sampled.titles.get("tt0000001"), undefined, "two minutes is a peek, not a rejection");
});

test("half-way: still at it is mildly positive, left for weeks is mildly negative", () => {
  assert.equal(one({ titles: { tt0000001: film(2400, 6000, ago(3)) } }, "tt0000001").w, W.watching);
  assert.equal(one({ titles: { tt0000001: film(2400, 6000, ago(40)) } }, "tt0000001").w, W.stalled);
});

test("a series is judged by how far they went: devoted > regular > started; dropped after the pilot is negative", () => {
  const eps = (n, at) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tt0000009:1:${i + 1}`, ep(at - (n - i) * 3 * DAY)]));
  const total = () => 20;
  const devoted = one({ titles: eps(7, ago(5)) }, "tt0000009", { episodesOf: total });
  const regular = one({ titles: eps(4, ago(5)) }, "tt0000009", { episodesOf: total });
  const started = one({ titles: eps(1, ago(5)) }, "tt0000009", { episodesOf: total });
  const dropped = one({ titles: eps(1, ago(60)) }, "tt0000009", { episodesOf: total });
  assert.equal(devoted.w, W.showDevoted);
  assert.equal(regular.w, W.showRegular);
  assert.equal(started.w, W.showStarted);
  assert.equal(dropped.w, W.showDropped);
  assert.ok(dropped.w < 0 && dropped.kinds.has("dropped"));
  assert.equal(devoted.n, 7, "the episode count is kept for the explanation");
  // a short series watched nearly whole is devotion too
  const mini = one({ titles: eps(4, ago(5)) }, "tt0000009", { episodesOf: () => 5 });
  assert.equal(mini.w, W.showDevoted);
});

test("a binge (three episodes inside a day) adds to the series", () => {
  const titles = {};
  for (let i = 1; i <= 3; i++) titles[`tt0000009:1:${i}`] = ep(ago(2) + i * 3600 * 1000);
  const t = one({ titles }, "tt0000009", { episodesOf: () => 20 });
  assert.ok(t.kinds.has("binge"));
  assert.equal(t.w, W.showRegular + W.binge);
});

test("ratings, My List, follows, loved titles and marks each have their weight; several signals add up, clamped", () => {
  const ev = eventsOf({
    titles: { tt0000001: film(6000, 6000, ago(2)), tt0000005: { position: 1, duration: 1, finished: true, updatedAt: 0, marked: true, prior: null } },
    ratings: { tt0000001: 5, tt0000002: 1, tt0000006: 3 },
    watchlist: [{ stream: true, imdbId: "tt0000003", type: "movie", title: "Listed" }],
    likedTitles: [{ imdbId: "tt0000004", title: "Loved" }],
  }, { follows: [{ imdbId: "tt0000007", at: ago(1) }] });
  assert.equal(ev.titles.get("tt0000001").w, 4, "finished + 5★ = 4.6, clamped to 4");
  assert.equal(ev.titles.get("tt0000002").w, W.rate1);
  assert.equal(ev.titles.get("tt0000003").w, W.listed);
  assert.equal(ev.titles.get("tt0000004").w, W.loved);
  assert.equal(ev.titles.get("tt0000005").w, W.marked, "marked watched by hand: a weak positive");
  assert.equal(ev.titles.get("tt0000005").at, null, "…and not a watch that happened now");
  assert.equal(ev.titles.get("tt0000006").w, W.rate3);
  assert.equal(ev.titles.get("tt0000007").w, W.follow);
  for (const id of ["tt0000001", "tt0000002", "tt0000003", "tt0000005"]) assert.ok(ev.seen.has(id), `${id} is never recommended back`);
});

test("removed from Continue Watching is a negative — until they watch it again", () => {
  const gone = one({ titles: {}, dismissed: { tt0000001: ago(3) } }, "tt0000001");
  assert.equal(gone.w, W.dismissed);
  const back = one({ titles: { tt0000001: film(6000, 6000, ago(1)) }, dismissed: { tt0000001: ago(3) } }, "tt0000001");
  assert.equal(back.w, W.finished, "watched since: the removal no longer speaks");
});

test("profiles: removing an UNFINISHED title leaves the trace the recommender reads; a finished one leaves none", () => {
  const keyFor = (id) => id;
  const state = { progress: { tt0000001: film(900, 6000, ago(1)), tt0000002: film(6000, 6000, ago(1)), "tt0000003:1:2": ep(ago(1), false) }, titles: {}, streamItems: {} };
  noteDismissed(state, "tt0000001", keyFor, NOW);
  noteDismissed(state, "tt0000002", keyFor, NOW);
  noteDismissed(state, "tt0000003:1:2", keyFor, NOW);
  assert.deepEqual(state.dismissed, { tt0000001: NOW, tt0000003: NOW }, "the show, not the episode; nothing for the finished film");
});

test("profiles: a rewatch is counted when a watched-through title is started over, once per return", () => {
  const finished = film(6000, 6000, ago(30));
  assert.equal(rewatchCount(null, film(10, 6000, NOW)), 0);
  assert.equal(rewatchCount(finished, film(300, 6000, NOW)), 1, "finished a month ago, playing from the start");
  assert.equal(rewatchCount({ ...film(300, 6000, ago(0.01)), plays: 1 }, film(900, 6000, NOW)), 1, "the next heartbeat carries it, does not recount");
  assert.equal(rewatchCount(film(6000, 6000, NOW - 60000), film(5, 6000, NOW)), 0, "the credits rolling into a restart is not a rewatch");
  assert.equal(rewatchCount({ ...finished, marked: true }, film(300, 6000, NOW)), 0, "marked watched, now watching for the first time");
  const t = one({ titles: { tt0000001: { ...film(6000, 6000, ago(1)), plays: 1 } } }, "tt0000001");
  assert.equal(t.w, W.finished + W.rewatch);
});

test("time: yesterday counts in full, two months about half, a year a sixth; undated signals a steady 0.7", () => {
  const r = (days) => person.recency(ago(days), NOW).w;
  assert.ok(r(1) > 0.97);
  assert.ok(r(60) > 0.45 && r(60) < 0.6, `two months: ${r(60)}`);
  assert.ok(r(365) > 0.12 && r(365) < 0.2, `a year: ${r(365)}`);
  assert.ok(r(1) > r(14) && r(14) > r(60) && r(60) > r(365), "monotonic");
  assert.equal(person.recency(null, NOW).w, 0.7);
  // short-term and long-term are separate views of the same signal
  const k = person.recency(ago(7), NOW);
  assert.ok(k.short < k.long, "a week old: fading from 'right now', still fully part of long-term taste");
});

// ---------- the model ----------
let n = 100;
const rec = (genres, keywords, over = {}) => fromTmdb({
  id: n, title: over.title || `T${n}`, release_date: `${over.year || 2018}-01-01`, status: "Released",
  genres: genres.map((name, i) => ({ id: i, name })),
  keywords: { keywords: keywords.map((name, i) => ({ id: i, name })) },
  credits: { crew: (over.directors || []).map((d) => ({ id: d, name: `D${d}`, job: "Director" })), cast: [] },
  external_ids: { imdb_id: `tt${String(n++).padStart(7, "0")}` },
  vote_average: 7.4, vote_count: 2000, poster_path: "/p.jpg", overview: "",
}, "movie");
const HORROR = [0, 1, 2, 3].map(() => rec(["Horror"], ["haunted house", "ghost", "supernatural horror"]));
const HEIST = [0, 1, 2, 3].map(() => rec(["Crime", "Thriller"], ["heist", "bank robbery", "con artist"]));
const ROMCOM = [0, 1, 2, 3].map(() => rec(["Comedy", "Romance"], ["romcom", "wedding", "falling in love"]));
const ALL = [...HORROR, ...HEIST, ...ROMCOM];
const stats = features.buildStats(ALL);
const V = new Map(ALL.map((r) => [r.id, features.vectorOf(r, stats)]));
const model = (state, opts = {}) => person.buildModel(eventsOf(state, opts), { vectorFor: (id) => V.get(id) || null, titleFor: (id) => (ALL.find((r) => r.id === id) || {}).title, now: NOW });
const themeW = (m, slug) => m.taste.theme.get(features.intern(`theme|${slug}`)) || 0;
const genreW = (m, g) => m.taste.genre.get(features.intern(`genre|${g}`)) || 0;

test("the model learns themes, not just genres: a heist fan leans heist, and away from what they abandoned", () => {
  const m = model({ titles: {
    [HEIST[0].id]: film(6000, 6000, ago(3)),
    [HEIST[1].id]: film(6000, 6000, ago(9)),
    [HORROR[0].id]: film(700, 6000, ago(20)), // gave up
  } });
  assert.ok(themeW(m, "heist") > 0.5);
  assert.ok(themeW(m, "ghosts-hauntings") < 0, "the abandoned film's theme is a dislike");
  assert.ok(genreW(m, "Crime") > 0 && genreW(m, "Horror") < 0);
  assert.equal(m.pos.length, 2);
  assert.equal(m.neg.length, 1);
  assert.match(m.pos[0].why, /^you finished /);
});

test("recency: last week's taste outweighs last year's", () => {
  const m = model({ titles: {
    [HEIST[0].id]: film(6000, 6000, ago(4)),
    [ROMCOM[0].id]: film(6000, 6000, ago(400)),
  } });
  assert.ok(themeW(m, "heist") > themeW(m, "romcom") * 2);
  assert.equal(m.pos[0].id, HEIST[0].id, "the freshest evidence leads");
  assert.ok(m.recentShare > 0.6);
});

test("the Settings genre picks are a prior on genre, and on the calibration target", () => {
  const m = model({ titles: {}, likedGenres: ["Horror"] });
  assert.ok(genreW(m, "Horror") > 0);
  assert.ok(m.genreShare.Horror > 0.99);
  assert.equal(m.pos.length, 0);
  assert.equal(m.mass, 0, "picks alone are not history: the profile is still cold");
});

test("the calibration target mirrors the person's own mix", () => {
  const m = model({ titles: {
    [HEIST[0].id]: film(6000, 6000, ago(1)), [HEIST[1].id]: film(6000, 6000, ago(1)), [HEIST[2].id]: film(6000, 6000, ago(1)),
    [ROMCOM[0].id]: film(6000, 6000, ago(1)),
  } });
  const sum = Object.values(m.genreShare).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(m.genreShare.Crime + m.genreShare.Thriller - 0.75) < 0.01, "three of four titles are crime thrillers");
  assert.ok(Math.abs(m.genreShare.Comedy + m.genreShare.Romance - 0.25) < 0.01);
});

test("titles the index cannot describe are skipped, never guessed", () => {
  const m = model({ titles: { tt9999999: film(6000, 6000, ago(1)), [HEIST[0].id]: film(6000, 6000, ago(1)) } });
  assert.equal(m.known, 1);
  assert.equal(m.pos.length, 1);
  assert.ok(m.seen.has("tt9999999"), "…but still never recommended back");
});
