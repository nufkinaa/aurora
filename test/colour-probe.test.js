// One colour probe for the server (server round, 2026-10-18): the quality
// ladder and the tone mapping ask ffprobe about a source once between them.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("../src/config");
const tonemap = require("../src/media/tonemap");

test("probeJson: a second caller for the same source shares the first one's answer", { skip: !config.FFMPEG || !config.FFPROBE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-colour-"));
  try {
    const clip = path.join(dir, "c.mkv");
    execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
    const a = tonemap.probeJson(clip);
    const b = tonemap.probeJson(clip);
    assert.equal(a, b, "one request in flight");
    const j = await a;
    assert.equal(j.streams[0].codec_name, "h264");
    assert.ok("profile" in j.streams[0] && "color_space" in j.streams[0] || j.streams[0].profile, "the ladder's and the tone mapping's fields in one answer");
    assert.equal(tonemap.probeJson(clip), a, "and shared for a while after");
    const facts = await tonemap.probeVideo(clip);
    assert.equal(facts.codec, "h264");
    // a source that cannot be read: null, and not kept
    const bad = await tonemap.probeJson(path.join(dir, "missing.mkv"));
    assert.equal(bad, null);
    assert.notEqual(tonemap.probeJson(path.join(dir, "missing.mkv")), tonemap.probeJson(path.join(dir, "other.mkv")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
