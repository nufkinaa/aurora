// Capped encodes for slow connections: the ?v= names the routes accept, and
// that a capped job never shares a directory with the full one.
const test = require("node:test");
const assert = require("node:assert");
const remux = require("../src/media/remux");
const { capOf, isHeavy } = remux._internals;

test("?v= accepts copy, the capped names, and falls back to the full encode", () => {
  assert.equal(remux.vcodecFromQuery("copy"), "copy");
  assert.equal(remux.vcodecFromQuery("h264-720"), "h264-720");
  assert.equal(remux.vcodecFromQuery("h264-480"), "h264-480");
  assert.equal(remux.vcodecFromQuery("h264-9999"), "h264");
  assert.equal(remux.vcodecFromQuery(undefined), "h264");
  assert.equal(remux.vcodecFromQuery("../../etc"), "h264");
});

test("a capped job is an encode, under its own bitrate ceiling, in its own directory", () => {
  assert.equal(isHeavy("h264-480"), true);
  assert.equal(isHeavy("copy"), false);
  assert.equal(capOf("h264"), null);
  assert.equal(capOf("h264-480").h, 480);
  assert.ok(parseInt(capOf("h264-480").maxrate, 10) < parseInt(capOf("h264-720").maxrate, 10));
  const dirs = new Set(["h264", "h264-720", "h264-480", "copy"].map((v) => remux.dirName("abc", 1000, v, 30)));
  assert.equal(dirs.size, 4);
});

test("every job dir the transcoder can name is one the segment route will serve", () => {
  const { validDir } = remux._internals;
  for (const v of ["copy", "h264", "h264-720", "h264-480"]) {
    for (const ss of [0, 30, 5400]) {
      for (const fmt of [null, "fmp4"]) {
        for (const audio of [0, 2]) {
          const d = remux.dirName("61ace07e4fa6", 1728000000000.5, v, ss, fmt, audio);
          assert.ok(validDir(d), `${d} must be servable`);
        }
      }
    }
  }
  assert.equal(validDir("../../etc"), false);
  assert.equal(validDir("abc-1-h264-999-0"), false);
});
