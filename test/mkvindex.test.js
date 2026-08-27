// S7 — the MKV index reader. Two halves:
//  • paranoia: any structural surprise must return null (the caller falls
//    back to the legacy flow — failure can only mean "no better than before");
//  • truth: on a real MKV (generated with ffmpeg when available) the duration
//    and cue times must match what ffprobe says about the same file.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { parseMkvIndex } = require("../src/media/mkvindex");
const config = require("../src/config");

const bufferRange = (buf) => async (start, len) => buf.subarray(start, start + len);

test("garbage bytes → null, never a throw", async () => {
  const junk = Buffer.alloc(70000, 0xab);
  assert.equal(await parseMkvIndex(bufferRange(junk), junk.length), null);
});

test("empty file → null", async () => {
  const empty = Buffer.alloc(0);
  assert.equal(await parseMkvIndex(bufferRange(empty), 0), null);
});

test("an EBML header that is not matroska-shaped → null", async () => {
  // Valid EBML magic, then nothing useful behind it.
  const buf = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0, 0, 0, 0]), Buffer.alloc(1000)]);
  assert.equal(await parseMkvIndex(bufferRange(buf), buf.length), null);
});

test("a throwing readRange → null, never a throw", async () => {
  const boom = async () => { throw new Error("io failed"); };
  assert.equal(await parseMkvIndex(boom, 12345), null);
});

test("a real MKV parses to ffprobe's own truth", async (t) => {
  if (!config.ffmpegAvailable) return t.skip("no ffmpeg on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mkv-"));
  const file = path.join(dir, "t.mkv");
  try {
    // 12s of testsrc, keyframe every 2s → cues at 0/2/4/6/8/10.
    execFileSync(config.FFMPEG, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=12:size=128x72:rate=10",
      "-c:v", "libx264", "-g", "20", "-keyint_min", "20", "-sc_threshold", "0",
      "-pix_fmt", "yuv420p", file,
    ]);
    const fd = fs.openSync(file, "r");
    const size = fs.statSync(file).size;
    const readRange = async (start, len) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      return b;
    };
    const index = await parseMkvIndex(readRange, size);
    fs.closeSync(fd);
    assert.ok(index, "real MKV must parse");
    assert.ok(Math.abs(index.durationSec - 12) < 0.2, `duration ${index.durationSec} ≈ 12`);
    assert.ok(index.cues.length >= 5, `enough cues (${index.cues.length})`);
    assert.ok(index.cues[0].t <= 0.001, "first cue at the top");
    // cue spacing == the forced GOP (2s at 10fps)
    assert.ok(Math.abs(index.cues[1].t - index.cues[0].t - 2) < 0.11);
    // cues ascend and every offset is inside the file
    for (let i = 1; i < index.cues.length; i++) {
      assert.ok(index.cues[i].t > index.cues[i - 1].t);
      assert.ok(index.cues[i].offset > 0 && index.cues[i].offset < size);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
