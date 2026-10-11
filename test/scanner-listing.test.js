// A library scan reads each folder ONCE (media/scanner.js, scanListings).
//
// Before: a film's folder was listed three times (videos, cover, subtitles)
// and a season's folder once per episode, plus the show's folder once per
// episode. The answer must not change: the same titles, ids, covers and
// subtitle tracks, and a second scan must see what changed on disk since the
// first (nothing is remembered between scans).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const scanner = require("../src/media/scanner");

let root, movies, shows, savedLibraries;
const touch = (...p) => {
  const f = path.join(...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x");
  return f;
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-scanlist-"));
  movies = path.join(root, "movies");
  shows = path.join(root, "shows");
  // two films: one with a cover and two sidecars, one bare
  touch(movies, "Alpha (2001)", "Alpha (2001).mkv");
  touch(movies, "Alpha (2001)", "cover.jpg");
  touch(movies, "Alpha (2001)", "Alpha (2001).English.srt");
  touch(movies, "Alpha (2001)", "Alpha (2001).Hebrew.srt");
  touch(movies, "Beta (2002)", "Beta (2002).mp4");
  // a show: two seasons, sidecars beside the episodes and one in the show's own folder
  for (const [season, eps] of [[1, [1, 2, 3]], [2, [1, 2]]]) {
    for (const e of eps) {
      const base = `Gamma S0${season}E0${e}`;
      touch(shows, "Gamma", `Season ${season}`, `${base}.mkv`);
      if (e !== 2) touch(shows, "Gamma", `Season ${season}`, `${base}.English.srt`);
    }
  }
  touch(shows, "Gamma", "Gamma S01E02.Hebrew.srt");
  touch(shows, "Gamma", "poster.png");
  savedLibraries = { movies: config.LIBRARIES.movies, shows: config.LIBRARIES.shows };
  config.LIBRARIES.movies = [movies];
  config.LIBRARIES.shows = [shows];
});

after(() => {
  config.LIBRARIES.movies = savedLibraries.movies;
  config.LIBRARIES.shows = savedLibraries.shows;
  scanner.scan();
  fs.rmSync(root, { recursive: true, force: true });
});

// every readdirSync the scan makes, by folder
const countingScan = () => {
  const real = fs.readdirSync;
  const reads = new Map();
  fs.readdirSync = function (dir, ...rest) {
    reads.set(String(dir), (reads.get(String(dir)) || 0) + 1);
    return real.call(this, dir, ...rest);
  };
  try { scanner.scan(); } finally { fs.readdirSync = real; }
  return reads;
};

test("a scan lists every folder exactly once", () => {
  const reads = countingScan();
  const expected = [
    movies, path.join(movies, "Alpha (2001)"), path.join(movies, "Beta (2002)"),
    shows, path.join(shows, "Gamma"), path.join(shows, "Gamma", "Season 1"), path.join(shows, "Gamma", "Season 2"),
  ];
  assert.deepEqual([...reads.keys()].sort(), expected.slice().sort(), "exactly the folders that exist");
  for (const [dir, n] of reads) assert.equal(n, 1, `${dir} was listed ${n} times`);
});

test("what the scan finds is what it always found", () => {
  scanner.scan();
  const { movies: m, shows: s } = scanner.index;
  assert.deepEqual(m.map((x) => [x.title, x.year, x.container]), [["Alpha", 2001, "mkv"], ["Beta", 2002, "mp4"]]);
  const alpha = m[0];
  assert.match(alpha.cover, /^\/img\/[a-f0-9]{12}$/);
  assert.equal(m[1].cover, null, "no picture in the folder, no online match: no cover");
  assert.deepEqual(alpha.subtitles.map((t) => t.label), ["English", "Hebrew"]);
  assert.ok(alpha.subtitles.every((t) => /^\/stream\/subtitle\/[a-f0-9]{12}$/.test(t.url) && t.downloadUrl.startsWith(`/stream/download/${alpha.id}/sub/`)));
  assert.deepEqual(m[1].subtitles, []);

  assert.equal(s.length, 1);
  const gamma = s[0];
  assert.equal(gamma.title, "Gamma");
  assert.equal(gamma.episodeCount, 5);
  assert.match(gamma.cover, /^\/img\/[a-f0-9]{12}$/, "the show folder's own picture");
  assert.deepEqual(gamma.seasons.map((se) => [se.number, se.episodes.map((e) => e.episode)]), [[1, [1, 2, 3]], [2, [1, 2]]]);
  const labels = (se, ep) => gamma.seasons[se - 1].episodes[ep - 1].subtitles.map((t) => t.label);
  assert.deepEqual(labels(1, 1), ["English"], "its own sidecar, beside it");
  assert.deepEqual(labels(1, 2), ["Hebrew"], "a sidecar kept in the show's folder, matched by name");
  assert.deepEqual(labels(1, 3), ["English"]);
  assert.deepEqual(labels(2, 1), ["English"]);
  assert.deepEqual(labels(2, 2), [], "another episode's subtitle is never borrowed");
  // ids come from the path alone: the same files give the same ids on every scan
  const ids = () => [...scanner.index.movies.map((x) => x.id), ...scanner.index.shows.flatMap((x) => x.seasons.flatMap((se) => se.episodes.map((e) => e.id)))];
  const first = ids();
  scanner.scan();
  assert.deepEqual(ids(), first);
  for (const id of first) assert.ok(scanner.resolve(id), "every id resolves to its file");
});

test("nothing is remembered between scans: the next one sees the disk as it is", () => {
  scanner.scan();
  assert.equal(scanner.index.movies.length, 2);
  const added = touch(movies, "Delta (2003)", "Delta (2003).mkv");
  const sub = touch(movies, "Beta (2002)", "Beta (2002).English.srt");
  const ep = touch(shows, "Gamma", "Season 2", "Gamma S02E03.mkv");
  try {
    scanner.scan();
    assert.deepEqual(scanner.index.movies.map((x) => x.title), ["Alpha", "Beta", "Delta"]);
    assert.deepEqual(scanner.index.movies[1].subtitles.map((t) => t.label), ["English"]);
    assert.equal(scanner.index.shows[0].episodeCount, 6);
  } finally {
    fs.rmSync(path.dirname(added), { recursive: true, force: true });
    fs.rmSync(sub, { force: true });
    fs.rmSync(ep, { force: true });
  }
  scanner.scan();
  assert.deepEqual(scanner.index.movies.map((x) => x.title), ["Alpha", "Beta"]);
  assert.equal(scanner.index.shows[0].episodeCount, 5);
});

test("a folder that cannot be read is an empty folder, as before, and the scan goes on", () => {
  const real = fs.readdirSync;
  fs.readdirSync = function (dir, ...rest) {
    if (String(dir) === path.join(movies, "Beta (2002)")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return real.call(this, dir, ...rest);
  };
  try { scanner.scan(); } finally { fs.readdirSync = real; }
  assert.deepEqual(scanner.index.movies.map((x) => x.title), ["Alpha"]);
  assert.equal(scanner.index.shows.length, 1);
});
