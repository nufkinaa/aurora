// Packs are ranked like any other source (elia 2026-10-18: "we are penalizing
// good pack sources when we shouldn't … just remove the penalty for packs").
const test = require("node:test");
const assert = require("node:assert");
const torrent = require("../src/media/torrent");

const { valueScore } = torrent._internals;
const GB = 1024 ** 3;
const src = (over) => ({ quality: "1080p", seeders: 100, sizeBytes: 2 * GB, cam: false, dubbed: false, pack: false, ...over });

test("a pack scores exactly what the same single release scores", () => {
  assert.equal(valueScore(src({ pack: true })), valueScore(src({ pack: false })));
});

test("a well-seeded pack beats a weakly seeded single release of the same quality", () => {
  assert.ok(valueScore(src({ pack: true, seeders: 2000 })) > valueScore(src({ seeders: 20 })));
});

test("a CAM still sinks, pack or not", () => {
  assert.ok(valueScore(src({ cam: true, pack: true })) < valueScore(src({ quality: "480p", seeders: 1 })));
});
