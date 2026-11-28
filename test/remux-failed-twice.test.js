// A remux job that dies on its own (ffmpeg exits with an error) at one place
// is started again by the player's next playlist poll — on a file damaged a
// few seconds past the offset that was a new encoder every few seconds, 36 and
// 47 of them in 150 s (tools/stream-net-rig, 2026-11-28). After two failures
// in a row at the same place the job is refused for a while, without starting
// ffmpeg; a job that finishes clears the count. Real ffmpeg.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const config = require("../src/config");
// (counted from before remux.js takes its own reference to spawn)
const realSpawn = cp.spawn;
let spawned = 0;
cp.spawn = function (file, ...rest) { if (file === config.FFMPEG) spawned++; return realSpawn.call(this, file, ...rest); };
const remux = require("../src/media/remux");
const { failed, failedHere, noteFailed, FAIL_LIMIT, FAIL_MS } = remux._internals;

test("the count: two failures in a row refuse; older than the window starts over", () => {
  const d = path.join(os.tmpdir(), `aurora-failcount-${process.pid}`);
  const t0 = 1_000_000;
  assert.equal(FAIL_LIMIT, 2);
  noteFailed(d, t0);
  assert.equal(failedHere(d, t0 + 1), false, "once is not enough");
  noteFailed(d, t0 + 5000);
  assert.equal(failedHere(d, t0 + 6000), true, "twice in a row");
  assert.equal(failedHere(d, t0 + 5000 + FAIL_MS), false, "the window has passed");
  noteFailed(d, t0 + 5000 + FAIL_MS + 1);
  assert.equal(failedHere(d, t0 + 5000 + FAIL_MS + 2), false, "a failure after the window counts from one");
  failed.delete(d);
});

test("a file ffmpeg cannot read: two tries, then refused with no ffmpeg started", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-remuxfail-"));
  const film = path.join(tmp, "broken.mkv");
  fs.writeFileSync(film, Buffer.alloc(64 * 1024, 7)); // not a film at all
  const id = `failtwice${process.pid}`;
  spawned = 0;
  try {
    for (let i = 1; i <= FAIL_LIMIT; i++) {
      await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6, seek: true }), /Remux failed|did not start/, `try ${i} fails`);
      assert.equal(spawned, i, `try ${i} started ffmpeg`);
    }
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6, seek: true }), /failed twice/);
    assert.equal(spawned, FAIL_LIMIT, "the third ask started nothing");
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6 }), /failed twice/, "a playlist poll the same");
    assert.equal(spawned, FAIL_LIMIT);
  } finally {
    for (const k of [...failed.keys()]) if (k.includes(id)) failed.delete(k);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
