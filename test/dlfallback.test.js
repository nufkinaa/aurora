// The next copy, the right file, a fake, an engine error
// (media/dlfallback.js). Pure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/media/dlfallback");

const H = (c) => String(c).repeat(40).slice(0, 40);
const src = (c, over = {}) => ({ infoHash: H(c), fileIdx: 0, quality: "1080p", sizeBytes: 1.2e9, seeders: 50, release: `Rel.${c}`, ...over });
const job = (over = {}) => ({ infoHash: H("a"), quality: "1080p", sizeBytes: 1.2e9, type: "movie", ...over });

test("the next copy: same resolution first, best seeded by order of magnitude, then the list's ranking", () => {
  const streams = [src("a"), src("b", { seeders: 9 }), src("c", { seeders: 90 }), src("d", { quality: "720p", seeders: 900 }), src("e", { seeders: 70 })];
  const p = F.chooseFallback({ job: job(), streams });
  assert.equal(p.source.infoHash, H("c"), "90 seeders beats 9; 90 and 70 tie and the list's order decides");
  assert.equal(p.step, "1080p");
});

test("the next copy: one step down when nothing at the same resolution is alive; up only when not much bigger", () => {
  const streams = [src("a"), src("b", { seeders: 0 }), src("c", { quality: "720p", seeders: 5, sizeBytes: 0.8e9 }), src("d", { quality: "2160p", sizeBytes: 9e9, seeders: 400 })];
  assert.equal(F.chooseFallback({ job: job(), streams }).source.infoHash, H("c"));
  const up = [src("a"), src("d", { quality: "2160p", sizeBytes: 1.6e9, seeders: 40 }), src("e", { quality: "2160p", sizeBytes: 9e9, seeders: 400 })];
  assert.equal(F.chooseFallback({ job: job(), streams: up }).source.infoHash, H("d"), "a 4K copy only when it is not much bigger than what was asked");
});

test("the next copy: never tried, reported, a cinema copy, a dub, burned-in, the replaced copy, the wrong size or busy", () => {
  const streams = [
    src("a"),
    src("b"),                                    // tried
    src("c", { badHere: { reason: "dead" } }),   // filed here
    src("d", { cam: true }),
    src("e", { dubbed: true }),
    src("f", { sizeBytes: 0.1e9 }),              // far too small for this title
    src("g"),                                    // the copy being replaced
    src("h"),                                    // another download is on it
    src("i", { hardsub: true }),
  ];
  const p = F.chooseFallback({
    job: job(), streams, tried: new Set([H("b")]), exclude: new Set([H("g")]),
    live: [{ infoHash: H("h"), fileIdx: 0 }],
  });
  assert.equal(p.source.infoHash, H("i"), "burned-in subtitles only when nothing clean is left");
  const none = F.chooseFallback({ job: job(), streams: streams.filter((s) => s.infoHash !== H("i")), tried: new Set([H("b")]), exclude: new Set([H("g")]), live: [{ infoHash: H("h"), fileIdx: 0 }] });
  assert.equal(none.source, null);
  assert.match(none.reason, /already tried/);
  assert.match(none.reason, /found bad here/);
});

test("the next copy: a season pack already downloading for a sibling goes first", () => {
  const streams = [src("a"), src("b", { seeders: 500 }), src("p", { seeders: 20, fileIdx: 3 })];
  const p = F.chooseFallback({ job: job({ type: "show" }), streams, live: [{ infoHash: H("p"), fileIdx: 1, running: true }] });
  assert.equal(p.source.infoHash, H("p"));
  assert.equal(p.warm, true);
});

test("the next copy: the language rule of a 'Wrong language' replacement is applied", () => {
  const streams = [src("a"), src("b", { release: "Film.HINDI.1080p" }), src("c", { seeders: 3 })];
  const p = F.chooseFallback({ job: job(), streams, accept: (s) => !/HINDI/.test(s.release) });
  assert.equal(p.source.infoHash, H("c"));
});

// ---------- the right file ----------
const files = (...list) => list.map(([p, length], i) => ({ index: i + 1, path: `/s/${p}`, length }));

test("files: the listed one is right → ok", () => {
  const v = F.checkFiles(files(["Film.2020.1080p.mkv", 2e9], ["Film.nfo", 1000]), { type: "movie", fileIndex: 1, sizeBytes: 2e9 });
  assert.equal(v.verdict, "ok");
});

test("files: the listed file is a sample → the feature instead", () => {
  const f = files(["Sample/film-sample.mkv", 40e6], ["Film.2020.1080p.mkv", 2e9]);
  const v = F.checkFiles(f, { type: "movie", fileIndex: 1, sizeBytes: 2e9 });
  assert.equal(v.verdict, "switch");
  assert.equal(v.fileIndex, 2);
  assert.match(v.why, /sample/);
});

test("files: a season pack — the episode by its SxxEyy, never the extras; double episodes count", () => {
  const f = files(["Show.S01E01.mkv", 1e9], ["Show.S01E02.mkv", 1e9], ["Show.S01E03-E04.mkv", 2e9], ["Extras/Featurette.mkv", 3e8]);
  assert.equal(F.checkFiles(f, { type: "show", season: 1, episode: 2, fileIndex: 2, sizeBytes: 4.3e9 }).verdict, "ok");
  const wrong = F.checkFiles(f, { type: "show", season: 1, episode: 2, fileIndex: 1, sizeBytes: 1e9 });
  assert.equal(wrong.verdict, "switch");
  assert.equal(wrong.fileIndex, 2);
  assert.equal(F.checkFiles(f, { type: "show", season: 1, episode: 4, fileIndex: 3, sizeBytes: 2e9 }).verdict, "ok", "E03-E04 holds episode 4");
  assert.equal(F.checkFiles(f, { type: "show", season: 1, episode: 9, fileIndex: 1, sizeBytes: 1e9 }).verdict, "fake", "the episode is not in it at all");
});

test("files: episode numbers are read exactly — the 1080 of '1080p' is not an episode range (found on the rig)", () => {
  const f = files(["Rig.Pack.S01E01.1080p.WEB.mkv", 50e6], ["Rig.Pack.S01E02.1080p.WEB.mkv", 50e6], ["Sample/rig.pack.s01e02.sample.mkv", 3e6]);
  const v = F.checkFiles(f, { type: "show", season: 1, episode: 2, fileIndex: 3, sizeBytes: 50e6 });
  assert.equal(v.verdict, "switch");
  assert.equal(v.fileIndex, 2, "episode 2, not episode 1");
  const E = F._internals.episodeMatch;
  assert.equal(E({ path: "Show.S01E02.1080p.mkv" }, 1, 5), false);
  assert.equal(E({ path: "Show.S01E03-04.720p.mkv" }, 1, 4), true);
  assert.equal(E({ path: "Show.S01E03E04.mkv" }, 1, 4), true);
  assert.equal(E({ path: "Show.1x05.HDTV.mkv" }, 1, 5), true);
});

test("files: a pack listed with the WHOLE pack's size is not called too small", () => {
  const f = files(["Show.S02E01.mkv", 1e9], ["Show.S02E02.mkv", 1e9], ["Show.S02E03.mkv", 1e9]);
  assert.equal(F.checkFiles(f, { type: "show", season: 2, episode: 2, fileIndex: 2, sizeBytes: 3e9 }).verdict, "ok");
});

test("files: fakes — a program, an archive, no video, a lone sample", () => {
  assert.equal(F.checkFiles(files(["Film.2020.1080p.exe", 1.5e9], ["readme.txt", 100]), { type: "movie", fileIndex: 1, sizeBytes: 1.5e9 }).verdict, "fake");
  assert.match(F.checkFiles(files(["Film.2020.rar", 1.5e9]), { type: "movie", fileIndex: 1, sizeBytes: 1.5e9 }).why, /archive/);
  assert.equal(F.checkFiles(files(["Film.txt", 1000]), { type: "movie", fileIndex: 1 }).verdict, "fake");
  assert.equal(F.checkFiles(files(["Film-sample.mkv", 30e6]), { type: "movie", fileIndex: 1, sizeBytes: 1.4e9 }).verdict, "fake");
  assert.equal(F.checkFiles(files(["Film.mkv", 20e6]), { type: "movie", fileIndex: 1, sizeBytes: 1.4e9 }).verdict, "fake", "listed at 1.4 GB, the file is 20 MB");
  assert.equal(F.checkFiles(files(["Film.mkv", 20e6]), { type: "movie", fileIndex: 1, sizeBytes: 0 }).verdict, "ok", "no listed size: a lone video is given the benefit of the doubt");
});

test("probe: no picture, damaged, or a short small sample is not the film; a timeout is not held against it", () => {
  assert.equal(F.checkProbe(null, { type: "movie" }), null);
  assert.match(F.checkProbe({ invalid: true }, { type: "movie" }), /damaged/);
  assert.match(F.checkProbe({ video: false, duration: 5000 }, { type: "movie" }), /no picture/);
  assert.match(F.checkProbe({ video: true, duration: 120 }, { type: "movie" }, 50e6), /sample/);
  assert.equal(F.checkProbe({ video: true, duration: 120 }, { type: "movie" }, 2e9), null, "short but big: let it be");
  assert.equal(F.checkProbe({ video: true, duration: 7 * 60 }, { type: "show" }, 80e6), null, "a 7-minute cartoon episode is real");
  assert.equal(F.checkProbe({ video: true, duration: 6000 }, { type: "movie" }, 2e9), null);
});

test("engine errors: disk waits, a duplicate joins, bad data is broken, the rest is the source's fault", () => {
  assert.equal(F.classifyError(9, "not enough disk space"), "disk");
  assert.equal(F.classifyError(null, "No space left on device"), "disk");
  assert.equal(F.classifyError(12, "InfoHash already registered"), "dup");
  assert.equal(F.classifyError(26, "torrent is corrupted"), "broken");
  assert.equal(F.classifyError(32, "checksum validation failed"), "broken");
  assert.equal(F.classifyError(1, "unknown"), "source");
  assert.equal(F.classifyError(null, "no peers"), "source");
});
