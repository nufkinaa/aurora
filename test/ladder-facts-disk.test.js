// The ladder's one ffprobe per source (media/ladder.js probe) is kept on disk
// too: after a restart the master playlist does not wait on it again.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../src/config");

const realCache = config.CACHE_DIR;
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ladderfacts-"));
  config.CACHE_DIR = tmp;
});
after(() => { config.CACHE_DIR = realCache; fs.rmSync(tmp, { recursive: true, force: true }); });

test("a probe is asked once; after a restart it is read back, not asked again", async () => {
  const tonemap = require("../src/media/tonemap");
  const ladder = require("../src/media/ladder");
  const real = tonemap.probeJson;
  let asked = 0;
  tonemap.probeJson = async () => {
    asked++;
    return { streams: [{ codec_type: "video", codec_name: "hevc", width: 1920, height: 800, pix_fmt: "yuv420p10le", r_frame_rate: "24000/1001", avg_frame_rate: "24000/1001", profile: "Main 10", level: 120 }] };
  };
  try {
    const a = await ladder.probe("film|123", "x.mkv");
    assert.ok(a && a.width === 1920, JSON.stringify(a));
    assert.equal(asked, 1);
    assert.equal(await ladder.probe("film|123", "x.mkv"), a, "kept in memory");
    assert.equal(asked, 1);
    ladder._internals.forgetMemory(); // a restart
    const b = await ladder.probe("film|123", "x.mkv");
    assert.equal(asked, 1, "not asked again after the restart");
    assert.deepEqual(b, a);
    assert.ok(ladder._internals.factsOnDisk()["film|123"]);
  } finally {
    tonemap.probeJson = real;
  }
});
