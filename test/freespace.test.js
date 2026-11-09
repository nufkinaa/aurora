// "Free up space" (src/media/freespace.js): what is SAFE to remove — finished
// by every profile that started it, on nobody's My List, old enough — and the
// extra copies of a title held twice. Pure halves, plain rows.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { safeTitles, spareCopies, names, cleanDays } = require("../src/media/freespace");

const GB = 1024 ** 3;
const DAY = 86400e3;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (d) => NOW - d * DAY;
const done = (d = 30) => ({ finished: true, position: 5000, duration: 5100, updatedAt: ago(d) });
const mid = (pos = 900) => ({ finished: false, position: pos, duration: 5100, updatedAt: ago(1) });
const person = (id, name, progress = {}, list = []) => ({ id, name, progress, list: new Set(list) });

const film = (id, title, o = {}) => ({ id, title, year: 2001, cover: null, addedAt: ago(94), sizeBytes: 8 * GB, streaming: false, ...o });
const ep = (id, season, episode, o = {}) => ({ id, season, episode, title: `Ep ${episode}`, addedAt: ago(120), sizeBytes: 1 * GB, streaming: false, ...o });

test("a film everyone who started it finished, on nobody's My List, 94 days old: safe — with why", () => {
  const people = [
    person("a", "jn", { f1: done(10) }),
    person("b", "Dor", { f1: done(20) }),
    person("c", "Kid"), // never started it: does not matter
  ];
  const rows = safeTitles({ movies: [film("f1", "Old Film")], people, now: NOW, days: 60 });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.key, "m:f1");
  assert.equal(r.kind, "movie");
  assert.equal(r.name, "Old Film (2001)");
  assert.deepEqual(r.ids, ["f1"]);
  assert.equal(r.sizeBytes, 8 * GB);
  assert.deepEqual(r.watchedBy, ["Dor", "jn"]);
  assert.equal(r.ageDays, 94);
  assert.equal(r.why, "watched by Dor and jn, nobody's My List, 94 days old");
});

test("never safe: someone part-way, nobody finished, on someone's My List, too new, no size", () => {
  const people = [
    person("a", "Ann", { f1: done(), f2: done(), f3: done(), f5: done(), f6: done() }, ["f3"]),
    person("b", "Ben", { f1: mid(900), f2: mid(30) }),
  ];
  const movies = [
    film("f1", "Someone Midway"), // Ben is 15 min in
    film("f2", "Only Opened"), // Ben opened it for 30 s: not "started" (the admin's 60 s rule)
    film("f3", "On A List"),
    film("f4", "Nobody Watched"),
    film("f5", "Too New", { addedAt: ago(10) }),
    film("f6", "No Size", { sizeBytes: 0 }),
  ];
  const rows = safeTitles({ movies, people, now: NOW, days: 60 });
  assert.deepEqual(rows.map((r) => r.key), ["m:f2"]);
  // N is adjustable: 0 days lets the new one in
  const all = safeTitles({ movies, people, now: NOW, days: 0 });
  assert.deepEqual(all.map((r) => r.key).sort(), ["m:f2", "m:f5"]);
  // a file whose date is unknown is never taken as old
  assert.deepEqual(safeTitles({ movies: [film("f2", "x", { addedAt: 0 })], people, now: NOW, days: 0 }), []);
});

test("a show: its safe episodes in one row, each checked on its own; a show on someone's My List never", () => {
  const show = {
    id: "s1", title: "The Show", year: 2020, cover: null,
    seasons: [
      { episodes: [ep("e1", 1, 1), ep("e2", 1, 2), ep("e3", 1, 3), ep("e4", 1, 4, { addedAt: ago(5) })] },
      { episodes: [ep("e5", 2, 1, { streaming: true })] },
    ],
  };
  const people = [
    person("a", "Ann", { e1: done(), e2: done(), e3: done(), e4: done(), e5: done() }),
    person("b", "Ben", { e1: done(), e3: mid() }),
  ];
  const rows = safeTitles({ shows: [show], people, now: NOW, days: 60 });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.key, "s:s1");
  assert.equal(r.kind, "show");
  assert.deepEqual(r.episodes.map((e) => e.id), ["e1", "e2", "e5"], "e3: Ben part-way; e4: too new");
  assert.deepEqual(r.ids, ["e1", "e2"], "the one being played is listed, not removed");
  assert.equal(r.sizeBytes, 2 * GB, "and not counted");
  assert.equal(r.fileBytes, 3 * GB);
  assert.deepEqual(r.watchedBy, ["Ann", "Ben"]);
  assert.equal(r.why, "3 episodes (S01E01–S02E01) watched by Ann and Ben, nobody's My List, 120+ days old");
  assert.equal(r.inUse, false);
  // on Ben's My List: the whole show stays
  const listed = [person("a", "Ann", people[0].progress), person("b", "Ben", people[1].progress, ["s1"])];
  assert.deepEqual(safeTitles({ shows: [show], people: listed, now: NOW, days: 60 }), []);
});

test("one being played right now is listed, marked, and counts for nothing", () => {
  const rows = safeTitles({ movies: [film("f1", "Playing", { streaming: true }), film("f2", "Small", { sizeBytes: GB })], people: [person("a", "Ann", { f1: done(), f2: done() })], now: NOW });
  assert.deepEqual(rows.map((r) => [r.key, r.inUse, r.sizeBytes]), [["m:f2", false, GB], ["m:f1", true, 0]], "biggest freeable first");
});

test("extra copies: every copy but the one that stays, why it is safe; a title already offered whole is left out", () => {
  const groups = [
    { key: "tt1", kind: "movie", title: "Twice Film", year: 2010, copies: [
      { ref: "movies:0:Twice Film/a.mkv", libraryId: "m1", indexed: true, quality: "1080p", sizeBytes: 8 * GB, fileName: "a.mkv", streaming: false },
      { ref: "movies:0:Twice Film/b.mkv", libraryId: null, indexed: false, quality: "720p", sizeBytes: 3 * GB, fileName: "b.mkv", streaming: false },
    ] },
    { key: "tt2:1:3", kind: "episode", title: "Some Show", season: 1, episode: 3, copies: [
      { ref: "shows:0:x.mkv", libraryId: "e9", indexed: true, quality: "1080p", sizeBytes: 2 * GB, fileName: "x.mkv" },
      { ref: "shows:0:y.mkv", libraryId: "e10", indexed: true, quality: "1080p", sizeBytes: 2 * GB, fileName: "y.mkv", streaming: true },
    ] },
    { key: "tt3", kind: "movie", title: "Already Offered", copies: [
      { ref: "movies:0:A/1.mkv", libraryId: "m3", indexed: true, sizeBytes: GB },
      { ref: "movies:0:A/2.mkv", libraryId: null, sizeBytes: GB },
    ] },
    { key: "tt4", kind: "movie", title: "One File, Two Jobs", copies: [{ ref: "movies:0:B/1.mkv", libraryId: "m4", sizeBytes: GB }] },
  ];
  const rows = spareCopies(groups, new Set(["m3"]));
  assert.deepEqual(rows.map((r) => r.key), ["c:movies:0:Twice Film/b.mkv", "c:shows:0:y.mkv"]);
  assert.equal(rows[0].name, "Twice Film (2010)");
  assert.equal(rows[0].why, "an extra 720p copy — the 1080p copy (8.0 GB) stays and is the one the app plays");
  assert.equal(rows[0].sizeBytes, 3 * GB);
  assert.equal(rows[1].name, "Some Show S01E03");
  assert.equal(rows[1].inUse, true);
  assert.equal(rows[1].sizeBytes, 0);
  // an extra copy sharper than the one that stays says so
  const sharper = spareCopies([{ kind: "movie", title: "Soft", copies: [
    { ref: "movies:0:S/a.mkv", libraryId: "m7", indexed: true, quality: "480p", sizeBytes: GB },
    { ref: "movies:0:S/b.mkv", quality: "1080p", sizeBytes: 4 * GB },
  ] }]);
  assert.match(sharper[0].why, /\(this one is the sharper copy: to keep it instead, use More than one copy\)$/);
});

test("the small words: names and days", () => {
  assert.equal(names(["Dor"]), "Dor");
  assert.equal(names(["Dor", "jn"]), "Dor and jn");
  assert.equal(names(["A", "B", "C"]), "A, B and C");
  assert.equal(names(["A", "B", "C", "D", "E", "F"]), "A, B, C and 3 others");
  assert.equal(cleanDays("30"), 30);
  assert.equal(cleanDays("0"), 0);
  assert.equal(cleanDays("-4"), 60);
  assert.equal(cleanDays("abc"), 60);
  assert.equal(cleanDays(undefined), 60);
  assert.equal(cleanDays(null), 60);
  assert.equal(cleanDays(""), 60);
  assert.equal(cleanDays(99999), 60);
});
