// The scanner's per-file bookkeeping (media/scanner.js): one collator for
// every name comparison, and ids remembered between scans. Both must answer
// exactly what they answered when they were worked out afresh each time.
const { test } = require("node:test");
const assert = require("node:assert");

const scanner = require("../src/media/scanner");

test("naturalCompare orders exactly as localeCompare(numeric, base) did", () => {
  const { naturalCompare } = scanner._internals;
  const old = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const names = ["Episode 10", "Episode 2", "episode 2", "Épisode 3", "Alien", "alien", "Aliens", "Alien 3", "Alien³", "2001", "10 Things", "9", "",
    "Über", "uber", "Zoë", "Zoe", "מבצע סבתא", "千と千尋", "A.I.", "AI", "S01E02", "S01E10", "S1E2", "the Office", "The Office (US)", "The  Office", "ß", "ss"];
  for (const a of names) for (const b of names) assert.equal(Math.sign(naturalCompare(a, b)), Math.sign(old(a, b)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert.deepEqual([...names].sort(naturalCompare), [...names].sort(old));
});

test("makeId: the same id for the same (kind, path), whenever it is asked", () => {
  const crypto = require("crypto");
  const old = (kind, rel) => crypto.createHash("md5").update(`${kind}|${rel}`).digest("hex").slice(0, 12);
  for (const [kind, rel] of [["video", "Alpha (2001)/Alpha (2001).mkv"], ["show", "Gamma"], ["image", "Alpha (2001)\cover.jpg"], ["subtitle", "x.srt"], ["video", ""], ["video", "Ünïcödé 日本/ep 1.mkv"]]) {
    assert.equal(scanner.makeId(kind, rel), old(kind, rel));
    assert.equal(scanner.makeId(kind, rel), old(kind, rel), "and again, from memory");
  }
  assert.notEqual(scanner.makeId("video", "a.mkv"), scanner.makeId("image", "a.mkv"), "the kind is part of the id");
});
