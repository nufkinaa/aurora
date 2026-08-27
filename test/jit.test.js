// S7 — the jit segment table and playlist. The one invariant everything
// rests on: the table is built with ffmpeg's own splitting rule over the
// same keyframe list ffmpeg will see, so the EXTINFs the playlist declares
// and the segments the producer emits agree BY CONSTRUCTION. These tests
// pin that rule and the playlist shapes (TS and fMP4).
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const jit = require("../src/media/jit");
const { buildTable, producedUpTo, TARGET_SEG_SEC } = jit._internals;

// A fixture index: keyframes every 10.417s (the burnt-timecode fixture's
// GOP), 180s film — same shape the real E2E rig plays.
const bigGops = () => ({
  durationSec: 180.001,
  cues: Array.from({ length: 18 }, (_, i) => ({ t: i * 10.417, offset: i * 1e6 })),
});

test("split rule: GOPs longer than the target give one segment per keyframe", () => {
  const table = buildTable(bigGops());
  assert.equal(table.length, 18);
  assert.ok(Math.abs(table[10].start - 104.17) < 0.01);
  // every segment is exactly one GOP except the last, which runs to EOF
  assert.ok(Math.abs(table[0].dur - 10.417) < 1e-9);
  assert.ok(Math.abs(table[17].dur - (180.001 - 17 * 10.417)) < 1e-9);
});

test("split rule: dense keyframes pack up to the first cue >= start+target", () => {
  // keyframes every 2s, target 6 → ffmpeg cuts at the first keyframe >= +6s,
  // i.e. every 3rd cue: segments of exactly 6s.
  const cues = Array.from({ length: 30 }, (_, i) => ({ t: i * 2, offset: i }));
  const table = buildTable({ durationSec: 60, cues });
  assert.ok(table.every((s, i) => i === table.length - 1 || Math.abs(s.dur - TARGET_SEG_SEC) < 1e-9));
  assert.equal(table[0].start, 0);
  assert.equal(table[1].start, 6);
});

test("EXTINF durations sum to the exact declared duration", () => {
  const table = buildTable(bigGops());
  const sum = table.reduce((n, s) => n + s.dur, 0);
  assert.ok(Math.abs(sum - 180.001) < 1e-6, `sum ${sum} != 180.001`);
});

test("a file whose first keyframe is late has NO usable table", () => {
  // cues[0] at 5s → segment 0 could not start at the top; the playlist
  // would lie about where the film begins. Must refuse (caller falls back).
  const cues = [{ t: 5, offset: 0 }, { t: 15, offset: 1 }, { t: 25, offset: 2 }];
  assert.equal(buildTable({ durationSec: 60, cues }), null);
});

test("cues at or past the declared duration are dropped, not segmented", () => {
  const cues = [
    { t: 0, offset: 0 }, { t: 10, offset: 1 },
    { t: 59.999, offset: 2 }, { t: 61, offset: 3 }, // 61 > duration: bogus
  ];
  const table = buildTable({ durationSec: 60, cues });
  const last = table[table.length - 1];
  assert.ok(Math.abs(last.start + last.dur - 60) < 1e-9, "table ends at the duration");
});

test("TS playlist: VOD, ENDLIST, exact EXTINFs, suffixed URIs", () => {
  const entry = { table: buildTable(bigGops()), durationSec: 180.001 };
  const text = jit.playlistText(entry, "?v=copy");
  assert.match(text, /#EXT-X-VERSION:3\n/);
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(text, /#EXT-X-TARGETDURATION:11\n/); // ceil(10.417)
  assert.match(text, /#EXTINF:10\.417000,\nseg00000\.ts\?v=copy\n/);
  assert.match(text, /seg00017\.ts\?v=copy\n#EXT-X-ENDLIST\n$/);
  assert.ok(!text.includes(".m4s"));
  assert.ok(!text.includes("EXT-X-MAP"));
});

test("fMP4 playlist: version 7, EXT-X-MAP init, .m4s segments", () => {
  const entry = { table: buildTable(bigGops()), durationSec: 180.001 };
  const text = jit.playlistText(entry, "?v=copy&seg=fmp4", "fmp4");
  assert.match(text, /#EXT-X-VERSION:7\n/);
  assert.match(text, /#EXT-X-MAP:URI="init\.mp4\?v=copy&seg=fmp4"\n/);
  assert.match(text, /#EXTINF:10\.417000,\nseg00000\.m4s\?v=copy&seg=fmp4\n/);
  assert.ok(!text.includes(".ts?"));
  assert.match(text, /#EXT-X-ENDLIST\n$/);
});

test("segPath picks the extension by format", () => {
  assert.equal(path.basename(jit.segPath("d", 7)), "seg00007.ts");
  assert.equal(path.basename(jit.segPath("d", 7, "fmp4")), "seg00007.m4s");
});

test("producedUpTo reads the producer's write head, per format", () => {
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jit-"));
  for (const f of ["seg00000.ts", "seg00003.ts", "seg00001.m4s", "producer.m3u8", "init.mp4"]) {
    fs.writeFileSync(path.join(dir, f), "x");
  }
  assert.equal(producedUpTo(dir, null), 3, "highest .ts");
  assert.equal(producedUpTo(dir, "fmp4"), 1, "highest .m4s");
  assert.equal(producedUpTo(path.join(dir, "missing"), null), -1, "missing dir is just -1");
  fs.rmSync(dir, { recursive: true, force: true });
});
