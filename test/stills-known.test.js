// media/stills.js hasStill: "is this film's still made?" without making it
// (what the blur-up placeholders ask before they fetch /img/still/).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const config = require("../src/config");
const stills = require("../src/media/stills");

test("hasStill: false until the still file exists, then true (and remembered)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-stills-"));
  try {
    const video = path.join(dir, "Film.mkv");
    fs.writeFileSync(video, "x");
    const mtime = Math.floor(fs.statSync(video).mtimeMs);
    const name = crypto.createHash("md5").update(`${video}|${mtime}`).digest("hex") + ".jpg";
    const stillDir = path.join(config.CACHE_DIR, "stills");
    const file = path.join(stillDir, name);
    const t0 = 1e12;
    assert.equal(stills.hasStill(video, t0), false);
    fs.mkdirSync(stillDir, { recursive: true });
    fs.writeFileSync(file, "jpeg");
    try {
      // "not yet" is remembered for a minute…
      assert.equal(stills.hasStill(video, t0 + 1000), false);
      // …then asked again
      assert.equal(stills.hasStill(video, t0 + 61 * 1000), true);
      fs.rmSync(file);
      assert.equal(stills.hasStill(video, t0 + 62 * 1000), true, "made is remembered while the video is unchanged");
    } finally {
      fs.rmSync(file, { force: true });
    }
    assert.equal(stills.hasStill(path.join(dir, "missing.mkv")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    stills._internals.made.clear();
    stills._internals.notYet.clear();
  }
});
