// The start hint (X-Aurora-Start): a player says where it is about to begin
// and on what line, and the server starts making that first segment while
// the playlists are still travelling (routes/stream.js warmStart). Here: the
// header's grammar, the rung the server picks — the SAME one the website
// will ask for — and which segment holds a second of the film.
const { test } = require("node:test");
const assert = require("node:assert");

const ladder = require("../src/media/ladder");
const jit = require("../src/media/jit");

test("parseStartHint: where, and what is known of the line or the rendition", () => {
  assert.deepEqual(ladder.parseStartHint("at=0"), { at: 0, kbps: 0, v: null });
  assert.deepEqual(ladder.parseStartHint("at=1436; kbps=3000"), { at: 1436, kbps: 3000, v: null });
  assert.deepEqual(ladder.parseStartHint("at=12.5;kbps=48000;v=h264-480"), { at: 12.5, kbps: 48000, v: "h264-480" });
  assert.deepEqual(ladder.parseStartHint(" v=h264 ; at=7 "), { at: 7, kbps: 0, v: "h264" });
});

test("parseStartHint: no header, no position, or nonsense is no hint", () => {
  for (const h of [undefined, null, "", "kbps=3000", "at=", "at=-5", "at=abc", "at=1e9", "at=99999999", "hello", "at=5x"]) {
    assert.equal(ladder.parseStartHint(h), null, String(h));
  }
  // a rendition that does not exist is ignored, the rest of the hint stands
  assert.deepEqual(ladder.parseStartHint("at=5; v=../../etc"), { at: 5, kbps: 0, v: null });
  assert.deepEqual(ladder.parseStartHint("at=5; v=h264-9000; kbps=x"), { at: 5, kbps: 0, v: null });
  // a header of any length is cut, never trusted
  assert.equal(ladder.parseStartHint("x".repeat(5000) + ";at=5"), null);
});

test("startRung: the server picks the rung the website will ask for — the two rules are one rule", async () => {
  const web = await import("../public/js/playstart.js");
  assert.equal(ladder._internals.START_HEADROOM, web.START_HEADROOM);
  const ladders = [
    [{ bandwidth: 9460800 }, { bandwidth: 3551147 }, { bandwidth: 1658027 }],
    [{ bandwidth: 3300000 }, { bandwidth: 1658027 }],
    [{ bandwidth: 12000000 }],
    [{ bandwidth: 0 }, { bandwidth: 1658027 }],
    [],
  ];
  for (const rungs of ladders) {
    for (const kbps of [0, NaN, 300, 800, 1500, 2072, 2073, 2500, 3000, 4400, 4439, 4500, 5000, 11825, 11826, 20000, 100000]) {
      assert.equal(ladder.startRung(rungs, kbps), web.startRung(rungs, kbps), `${JSON.stringify(rungs)} at ${kbps}`);
    }
  }
  // …and the numbers themselves, once
  const three = ladders[0];
  assert.equal(ladder.startRung(three, 0), 0, "nothing known: the top");
  assert.equal(ladder.startRung(three, 3000), 2, "3 Mbit/s: 480p");
  assert.equal(ladder.startRung(three, 5000), 1, "5 Mbit/s: 720p");
  assert.equal(ladder.startRung(three, 50000), 0);
  assert.equal(ladder.startRung(three, 300), 2, "thinner than anything: the lowest, never nothing");
  assert.equal(ladder.startRung([], 3000), -1);
  assert.equal(ladder.startRung(null, 3000), -1);
});

test("segmentAt: the segment of a table that holds a second of the film", () => {
  const table = [{ start: 0, dur: 10.01 }, { start: 10.01, dur: 10.01 }, { start: 20.02, dur: 6.5 }, { start: 26.52, dur: 10.01 }];
  assert.equal(jit.segmentAt(table, 0), 0);
  assert.equal(jit.segmentAt(table, 10), 0);
  assert.equal(jit.segmentAt(table, 10.01), 1);
  assert.equal(jit.segmentAt(table, 20.03), 2);
  assert.equal(jit.segmentAt(table, 26.52), 3);
  assert.equal(jit.segmentAt(table, 99999), 3, "past the end: the last one");
  assert.equal(jit.segmentAt(table, -3), 0);
  assert.equal(jit.segmentAt([], 5), -1);
  assert.equal(jit.segmentAt(null, 5), -1);
  // a long film: every boundary lands where it should
  const long = Array.from({ length: 721 }, (_, i) => ({ start: i * 10.01, dur: 10.01 }));
  for (const k of [0, 1, 143, 359, 360, 719, 720]) {
    assert.equal(jit.segmentAt(long, k * 10.01 + 0.001), k);
    if (k) assert.equal(jit.segmentAt(long, k * 10.01 - 0.001), k - 1);
  }
});

test("segmentAt agrees with what the player reads off the playlist the same table makes", async () => {
  const web = await import("../public/js/playstart.js");
  const table = Array.from({ length: 40 }, (_, i) => ({ start: i * 7.25, dur: 7.25 }));
  const text = jit.playlistText({ table }, "?v=copy", null);
  for (const sec of [0, 3, 7.24, 7.26, 100, 150.5, 289.9]) {
    const k = jit.segmentAt(table, sec);
    assert.equal(web.segmentAt(text, sec), `seg${String(k).padStart(5, "0")}.ts?v=copy`, `second ${sec}`);
  }
});
