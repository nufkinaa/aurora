// Found in production logs (2026-10-11): two things that only showed on a
// real server.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("fMP4 jobs name their init file barely: ffmpeg joins it to the playlist's folder itself", () => {
  for (const rel of ["src/media/remux.js", "src/media/torrent-transcode.js"]) {
    const src = read(rel);
    assert.match(src, /"-hls_fmp4_init_filename", "init.mp4"/, rel);
    assert.doesNotMatch(src, /"-hls_fmp4_init_filename", path.join/, rel);
    assert.match(src, /fmt === "fmp4" \? playlist\.replace\(/, rel);
  }
});

test("ffmpeg really writes init.mp4 beside the playlist with those arguments", (t) => {
  const config = require("../src/config");
  if (!config.FFMPEG) return t.skip("no ffmpeg here");
  const probe = spawnSync(config.FFMPEG, ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip("no ffmpeg here");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "aurora-fmp4-"));
  try {
    const r = spawnSync(config.FFMPEG, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=160x120:r=24", "-f", "lavfi", "-i", "sine=d=3",
      "-c:v", "libx264", "-g", "48", "-c:a", "aac", "-f", "hls", "-hls_time", "2",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", path.join(dir, "seg%05d.m4s"), path.join(dir, "index.m3u8").replace(/\\/g, "/"),
    ], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "init.mp4")), "init.mp4 is beside the playlist");
    assert.match(fs.readFileSync(path.join(dir, "index.m3u8"), "utf8"), /#EXT-X-MAP:URI="init.mp4"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared torrent promise's own cleanup cannot become an unhandled rejection", () => {
  const src = read("src/media/torrent.js");
  const at = src.indexOf("const readyTorrent = ");
  const body = src.slice(at, at + 900);
  assert.match(body, /p\.finally\([\s\S]*?\}\)\.catch\(/, "finally(...) is followed by .catch");
});
