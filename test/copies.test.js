// More than one copy of a title (media/copies.js): how copies and download
// jobs are grouped, which copy may be deleted, and how a page-given ref is
// turned back into a path — never one outside a library folder. Plus the two
// helpers it leans on: lib/inuse.js ("someone is playing this") and the
// sidecar rule in lib/libfiles.js when two copies share a folder.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const copies = require("../src/media/copies");
const inuse = require("../src/lib/inuse");
const { deleteVideoFile } = require("../src/lib/libfiles");

const VIDEO = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];
const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-copies-"));
const write = (p, content = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

// ---------- group() ----------
const file = (over) => ({
  key: "tt1", kind: "movie", title: "Film", year: 2020, abs: path.resolve("/lib/Film (2020)/Film (2020).mkv"),
  ref: "movies:0:Film (2020)/Film (2020).mkv", fileName: "Film (2020).mkv", sizeBytes: 4e9, indexed: true,
  libraryId: "aaaaaaaaaaaa", streaming: false, midway: 0, watched: 0, ...over,
});
const job = (over) => ({ key: null, id: "j1", status: "done", destPath: null, type: "movie", title: "Film", by: "Anna", ...over });

test("one copy and one download of a title is not a duplicate", () => {
  const f = file();
  assert.deepEqual(copies.group([f], [job({ destPath: f.abs })]), []);
  assert.deepEqual(copies.group([f], []), []);
});

test("two files of one film (a 720p beside a 1080p) are one group of two copies, the indexed one first", () => {
  const a = file({ fileName: "Film.720p.mkv", abs: path.resolve("/lib/Film/Film.720p.mkv"), sizeBytes: 1e9, indexed: false, libraryId: null });
  const b = file({ fileName: "Film.1080p.mkv", abs: path.resolve("/lib/Film/Film.1080p.mkv"), sizeBytes: 4e9 });
  const other = file({ key: "tt2", title: "Other", abs: path.resolve("/lib/Other/o.mkv") });
  const groups = copies.group([a, b, other], [job({ destPath: b.abs })]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.key, "tt1");
  assert.equal(g.files, 2);
  assert.equal(g.jobs, 1);
  assert.deepEqual(g.copies.map((c) => c.fileName), ["Film.1080p.mkv", "Film.720p.mkv"]);
  assert.equal(g.copies[0].jobs[0].by, "Anna", "the job that wrote a file rides on that file");
  assert.equal(g.copies[1].jobs.length, 0);
  assert.equal(g.sizeBytes, 5e9);
  assert.equal(g.spareBytes, 1e9, "everything but the biggest copy");
});

test("an episode on disk twice (same show, season and episode) is a group; another episode is not in it", () => {
  const ep = (n, name, over) => file({ key: `tt9:1:${n}`, kind: "episode", title: `Ep ${n}`, showTitle: "Show", season: 1, episode: n, fileName: name, abs: path.resolve(`/lib/Show/Season 01/${name}`), ...over });
  const groups = copies.group([ep(3, "Show S01E03.mkv"), ep(3, "Show.S01E03.1080p.mp4"), ep(4, "Show S01E04.mkv")], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "episode");
  assert.equal(groups[0].title, "Show", "an episode group is named after its show");
  assert.equal(groups[0].season, 1);
  assert.equal(groups[0].episode, 3);
  assert.equal(groups[0].files, 2);
});

test("a second download of something already on disk makes a group: one copy, one download in flight", () => {
  const f = file();
  const groups = copies.group([f], [job({ id: "j2", status: "downloading", key: "tt1", progress: 0.4 }), job({ id: "j3", status: "error", key: "tt1" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files, 1);
  assert.equal(groups[0].jobs, 1, "a failed job is not a copy");
  assert.deepEqual(groups[0].downloads.map((j) => j.id), ["j2"]);
});

test("two finished jobs that wrote the same file are a group of one file and two downloads", () => {
  const f = file();
  const groups = copies.group([f], [job({ id: "j1", destPath: f.abs }), job({ id: "j2", destPath: f.abs.toUpperCase() === f.abs ? f.abs : f.abs })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files, 1);
  assert.equal(groups[0].copies[0].jobs.length, 2);
});

test("two downloads of a title not on disk yet are a group with no files", () => {
  const groups = copies.group([], [job({ id: "a", status: "downloading", key: "tt5", title: "New" }), job({ id: "b", status: "pending", key: "tt5", title: "New" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files, 0);
  assert.equal(groups[0].title, "New");
  assert.equal(groups[0].downloads.length, 2);
});

test("a finished job whose file is gone is not counted anywhere", () => {
  assert.deepEqual(copies.group([file()], [job({ destPath: path.resolve("/lib/gone.mkv") }), job({ id: "j2", destPath: path.resolve("/lib/gone2.mkv") })]), []);
});

// ---------- deletable() ----------
test("the rules: a copy being played is never deleted; the last copy only with the stronger confirm", () => {
  const two = { files: 2 };
  const one = { files: 1 };
  assert.deepEqual(copies.deletable(two, { streaming: false }), { ok: true });
  assert.equal(copies.deletable(two, { streaming: true }).code, "streaming");
  assert.equal(copies.deletable(two, { streaming: true }, { confirmLast: true }).code, "streaming", "confirming does not override a viewer");
  assert.equal(copies.deletable(one, { streaming: false }).code, "last-copy");
  assert.deepEqual(copies.deletable(one, { streaming: false }, { confirmLast: true }), { ok: true });
});

// ---------- resolveRef() ----------
test("a ref resolves to a video strictly inside its library folder", () => {
  const root = mkTemp();
  const vid = path.join(root, "Film (2020)", "Film.1080p.mkv");
  write(vid);
  const libs = { movies: [root], shows: [] };
  const r = copies.resolveRef("movies:0:Film (2020)/Film.1080p.mkv", libs, VIDEO);
  assert.equal(r.error, undefined);
  assert.equal(r.abs, vid);
  assert.equal(copies.refOf("movies", 0, root, vid), "movies:0:Film (2020)/Film.1080p.mkv");
  assert.equal(copies.resolveRef("movies:0:Film (2020)/missing.mkv", libs, VIDEO).notFound, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("traversal and everything that is not a library video is refused before any file is touched", () => {
  const top = mkTemp();
  const root = path.join(top, "movies");
  write(path.join(root, "Film", "Film.mkv"));
  write(path.join(top, "secret.mkv"));
  write(path.join(root, "Film", "notes.txt"));
  const libs = { movies: [root], shows: [] };
  const bad = [
    "movies:0:../secret.mkv",
    "movies:0:Film/../../secret.mkv",
    "movies:0:Film\\..\\..\\secret.mkv",
    `movies:0:${path.join(top, "secret.mkv")}`,
    "movies:0:/etc/passwd.mkv",
    "movies:0:C:/Windows/x.mkv",
    "movies:0:Film/./Film.mkv",
    "movies:0:Film//Film.mkv",
    "movies:0:Film/Film.mkv\0.txt",
    "movies:0:Film/notes.txt",
    "movies:0:",
    "movies:1:Film/Film.mkv",
    "shows:0:Film/Film.mkv",
    "other:0:Film/Film.mkv",
    "",
    null,
    { ref: "x" },
  ];
  for (const ref of bad) {
    const r = copies.resolveRef(ref, libs, VIDEO);
    assert.ok(r.error, `${JSON.stringify(ref)} was accepted: ${JSON.stringify(r)}`);
    assert.ok(!r.abs);
  }
  assert.ok(fs.existsSync(path.join(top, "secret.mkv")));
  fs.rmSync(top, { recursive: true, force: true });
});

test("a link inside the library that points outside it is refused", (t) => {
  const top = mkTemp();
  const root = path.join(top, "movies");
  const outside = path.join(top, "elsewhere");
  write(path.join(outside, "Film.mkv"));
  fs.mkdirSync(root, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, "Linked"), "junction");
  } catch (e) {
    fs.rmSync(top, { recursive: true, force: true });
    return t.skip(`cannot make a link here: ${e.code}`);
  }
  const r = copies.resolveRef("movies:0:Linked/Film.mkv", { movies: [root], shows: [] }, VIDEO);
  assert.match(r.error || "", /outside the library/);
  fs.rmSync(top, { recursive: true, force: true });
});

test("quality comes from the probed height, else the file name, else the download", () => {
  assert.equal(copies.qualityOf(1080, "x"), "1080p");
  assert.equal(copies.qualityOf(800, "x"), "720p");
  assert.equal(copies.qualityOf(2160, "x"), "2160p");
  assert.equal(copies.qualityOf(0, "Film.2020.720p.WEB.mkv"), "720p");
  assert.equal(copies.qualityOf(0, "Film.4K.mkv"), "2160p");
  assert.equal(copies.qualityOf(0, "Film.mkv", "1080p"), "1080p");
  assert.equal(copies.qualityOf(0, "Film.mkv"), null);
});

// ---------- lib/inuse.js ----------
test("a file asked for in the last five minutes is being played; older, or never, is not", () => {
  const t0 = 1_000_000_000;
  inuse.touch("abc123abc123", t0);
  assert.equal(inuse.streamingNow("abc123abc123", t0 + 1000), true);
  assert.equal(inuse.streamingNow("abc123abc123", t0 + inuse.WINDOW_MS - 1), true);
  assert.equal(inuse.streamingNow("abc123abc123", t0 + inuse.WINDOW_MS + 1), false);
  assert.equal(inuse.streamingNow("never0000000", t0), false);
  assert.equal(inuse.lastAt("abc123abc123"), t0);
});

// ---------- two copies in one folder: whose subtitles are whose ----------
test("deleting one copy leaves the other copy's subtitles (longer name), and the shared ones of a same-named copy", () => {
  const root = mkTemp();
  const dir = path.join(root, "Film (2020)");
  write(path.join(dir, "Film.mkv"), "aaaa");
  write(path.join(dir, "Film.en.srt"), "s");
  write(path.join(dir, "Film.1080p.mkv"), "bbbbbbbb");
  write(path.join(dir, "Film.1080p.en.srt"), "t");
  const r = deleteVideoFile(path.join(dir, "Film.mkv"), [root]);
  assert.deepEqual(r.deleted.sort(), ["Film.en.srt", "Film.mkv"]);
  assert.ok(fs.existsSync(path.join(dir, "Film.1080p.en.srt")), "the 1080p copy keeps its subtitles");

  // same basename, two containers: the subtitles stay for the one left
  write(path.join(dir, "Film.1080p.mp4"), "cc");
  const r2 = deleteVideoFile(path.join(dir, "Film.1080p.mkv"), [root]);
  assert.deepEqual(r2.deleted, ["Film.1080p.mkv"]);
  assert.ok(fs.existsSync(path.join(dir, "Film.1080p.en.srt")));
  assert.ok(fs.existsSync(path.join(dir, "Film.1080p.mp4")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an episode's name is shown only when its copies agree on it", () => {
  const ep = (name, title) => file({ key: "tt9:1:2", kind: "episode", title, showTitle: "Show", season: 1, episode: 2, fileName: name, abs: path.resolve(`/lib/Show/${name}`) });
  assert.equal(copies.group([ep("a.mkv", "Pilot"), ep("b.mkv", "Pilot")], [])[0].episodeTitle, "Pilot");
  assert.equal(copies.group([ep("a.mkv", "Pilot"), ep("b.mkv", "Show 1080p WEB")], [])[0].episodeTitle, null);
});
