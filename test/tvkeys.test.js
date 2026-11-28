// The keyframes of a library file, for the TV (src/lib/tvkeys.js, GET
// /api/tv/keyframes/:id): real files made by ffmpeg, keyframes every 2 s.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("../src/config");
const tvkeys = require("../src/lib/tvkeys");

const make = (dir, name) => {
  const out = path.join(dir, name);
  execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=9",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", out]);
  return out;
};

test("the keyframe times of an MKV and an MP4, from their own index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-tvkeys-"));
  try {
    for (const name of ["k.mkv", "k.mp4"]) {
      const f = make(dir, name);
      const keys = await tvkeys.keyframesOf(f);
      assert.ok(Array.isArray(keys), `${name}: a list`);
      assert.deepEqual(keys.map((k) => Math.round(k)), [0, 2, 4, 6, 8], `${name}: every 2 s`);
      for (let i = 1; i < keys.length; i++) assert.ok(keys[i] > keys[i - 1], "ascending");
      assert.equal(await tvkeys.keyframesOf(f), keys, `${name}: read once, then kept`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an item: a library video by id; anything else answers no list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-tvkeys-"));
  try {
    const f = make(dir, "i.mkv");
    const lib = { a1: { kind: "video", path: f }, s1: { kind: "subtitle", path: f } };
    const resolve = (id) => lib[id] || null;
    const a = await tvkeys.forItem("a1", resolve);
    assert.equal(a.v, 1);
    assert.equal(a.keys.length, 5);
    assert.deepEqual(await tvkeys.forItem("s1", resolve), { v: 1, keys: null }, "not a video");
    assert.deepEqual(await tvkeys.forItem("nope", resolve), { v: 1, keys: null }, "no such item");
    assert.deepEqual(await tvkeys.forItem("torrent|abc|0", resolve), { v: 1, keys: null }, "a stream has no file here");
    const junk = path.join(dir, "junk.mkv");
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    assert.equal(await tvkeys.keyframesOf(junk), null, "a file the readers do not take");
    assert.equal(await tvkeys.keyframesOf(path.join(dir, "gone.mkv")), null, "a file that is not there");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
