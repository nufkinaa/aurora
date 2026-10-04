// Play-ready copies: made only where they will be used, never by default.
const test = require("node:test");
const assert = require("node:assert");
const { _internals: p } = require("../src/media/preconvert");

const base = { enabled: true, ffmpeg: true, video: { codec: "hevc", bitDepth: 10 }, liveEncodes: 3, folderBytes: 1e9, capBytes: 8e9 };

test("made when the file needs it AND this household's devices have needed live encodes", () => {
  assert.equal(p.decide(base).make, true);
});

test("plain 8-bit H.264 never gets a copy; 10-bit H.264 can", () => {
  assert.equal(p.decide({ ...base, video: { codec: "h264", bitDepth: 8 } }).make, false);
  assert.equal(p.decide({ ...base, video: { codec: "h264" } }).make, false);
  assert.equal(p.decide({ ...base, video: { codec: "h264", bitDepth: 10 } }).make, true);
});

test("no evidence of live encodes here → nothing is made, whatever the codec", () => {
  assert.equal(p.decide({ ...base, liveEncodes: 0 }).make, false);
});

test("a nearly full copies folder, no ffmpeg, or the switch off: nothing is made", () => {
  assert.equal(p.decide({ ...base, folderBytes: 7e9 }).make, false);
  assert.equal(p.decide({ ...base, ffmpeg: false }).make, false);
  assert.equal(p.decide({ ...base, enabled: false }).make, false);
});

test("a file that hasn't been probed yet is asked about again, not skipped", () => {
  const d = p.decide({ ...base, video: null });
  assert.equal(d.make, false);
  assert.equal(d.retry, true);
});
