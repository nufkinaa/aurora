// D1 — deleting one library video file. The dangerous parts live in
// src/lib/libfiles.js and are exercised here against REAL temp directories:
// containment refusal, sidecar subtitle collection, and the empty-dir sweep
// that must stop at (and never remove) a library root.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { deleteVideoFile, insideARoot } = require("../src/lib/libfiles");

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-libdel-"));
const write = (p, content = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

test("deletes the video and its sidecar subtitles, nothing else", () => {
  const root = mkTemp();
  const dir = path.join(root, "Show", "Season 2");
  const vid = path.join(dir, "Show.S02E03.mkv");
  write(vid, "0123456789");
  write(path.join(dir, "Show.S02E03.srt"), "sub");
  write(path.join(dir, "Show.S02E03.en.srt"), "sub-en");
  write(path.join(dir, "Show.S02E04.mkv"), "other-episode");
  write(path.join(dir, "Show.S02E04.srt"), "other-sub");

  const r = deleteVideoFile(vid, [root]);
  assert.deepEqual(r.deleted.sort(), ["Show.S02E03.en.srt", "Show.S02E03.mkv", "Show.S02E03.srt"]);
  assert.equal(r.freedBytes, 10 + 3 + 6);
  assert.ok(fs.existsSync(path.join(dir, "Show.S02E04.mkv")), "the other episode survives");
  assert.ok(fs.existsSync(path.join(dir, "Show.S02E04.srt")), "the other episode's sub survives");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a season folder emptied by the deletion is swept, the root never is", () => {
  const root = mkTemp();
  const dir = path.join(root, "Show", "Season 9");
  const vid = path.join(dir, "finale.mkv");
  write(vid);

  deleteVideoFile(vid, [root]);
  assert.ok(!fs.existsSync(dir), "empty season folder removed");
  assert.ok(!fs.existsSync(path.join(root, "Show")), "empty show folder removed");
  assert.ok(fs.existsSync(root), "the library root itself is never deleted");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the sweep stops at the first non-empty ancestor", () => {
  const root = mkTemp();
  write(path.join(root, "Show", "poster.jpg"));
  const vid = path.join(root, "Show", "Season 1", "e1.mkv");
  write(vid);

  deleteVideoFile(vid, [root]);
  assert.ok(!fs.existsSync(path.join(root, "Show", "Season 1")), "empty season removed");
  assert.ok(fs.existsSync(path.join(root, "Show", "poster.jpg")), "show folder kept — it still has the poster");
  fs.rmSync(root, { recursive: true, force: true });
});

test("refuses to delete anything outside the roots, before any I/O", () => {
  const root = mkTemp();
  const outside = mkTemp();
  const vid = path.join(outside, "movie.mkv");
  write(vid);

  assert.throws(() => deleteVideoFile(vid, [root]), /outside the library/);
  assert.ok(fs.existsSync(vid), "the file was not touched");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("a file directly under a root is deletable, and the root survives", () => {
  const root = mkTemp();
  const vid = path.join(root, "loose.mkv");
  write(vid);

  const r = deleteVideoFile(vid, [root]);
  assert.deepEqual(r.deleted, ["loose.mkv"]);
  assert.ok(fs.existsSync(root), "root untouched");
  fs.rmSync(root, { recursive: true, force: true });
});

test("similarly-named files are NOT mistaken for sidecars", () => {
  const root = mkTemp();
  const dir = path.join(root, "M");
  const vid = path.join(dir, "Alien.mkv");
  write(vid);
  write(path.join(dir, "Aliens.srt"), "different movie's sub");
  write(path.join(dir, "Alien.txt"), "notes"); // right basename, not a sub ext

  const r = deleteVideoFile(vid, [root]);
  assert.deepEqual(r.deleted, ["Alien.mkv"]);
  assert.ok(fs.existsSync(path.join(dir, "Aliens.srt")));
  assert.ok(fs.existsSync(path.join(dir, "Alien.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("insideARoot: strict descendants only", () => {
  const root = mkTemp();
  assert.equal(insideARoot(path.join(root, "a"), [root]), true);
  assert.equal(insideARoot(root, [root]), false, "the root itself is not 'inside'");
  assert.equal(insideARoot(path.join(root, ".."), [root]), false);
  fs.rmSync(root, { recursive: true, force: true });
});
