// A remux job that dies on its own (ffmpeg exits with an error) at one place
// is started again by the player's next playlist poll — on a file damaged a
// few seconds past the offset that was a new encoder every few seconds, 36 and
// 47 of them in 150 s (tools/stream-net-rig, 2026-11-28). A poll never starts
// a job that failed there; a viewer's seek may try once more; after two
// failures in a row everything is refused for a while, without starting
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
  const seek = true;
  assert.equal(failedHere(d, { now: t0 }), false, "never failed: a poll may start it");
  noteFailed(d, t0);
  assert.equal(failedHere(d, { seek, now: t0 + 1 }), false, "once: a seek may try again");
  assert.equal(failedHere(d, { now: t0 + 1 }), true, "once: a poll may not");
  noteFailed(d, t0 + 5000);
  assert.equal(failedHere(d, { seek, now: t0 + 6000 }), true, "twice in a row: not a seek either");
  assert.equal(failedHere(d, { seek, now: t0 + 5000 + FAIL_MS }), false, "the window has passed");
  assert.equal(failedHere(d, { now: t0 + 5000 + FAIL_MS }), false, "…for a poll too");
  noteFailed(d, t0 + 5000 + FAIL_MS + 1);
  assert.equal(failedHere(d, { seek, now: t0 + 5000 + FAIL_MS + 2 }), false, "a failure after the window counts from one");
  failed.delete(d);
});

test("a file ffmpeg cannot read: two tries, then refused with no ffmpeg started", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-remuxfail-"));
  const film = path.join(tmp, "broken.mkv");
  fs.writeFileSync(film, Buffer.alloc(64 * 1024, 7)); // not a film at all
  const id = `failtwice${process.pid}`;
  spawned = 0;
  try {
    const refused = (e) => /failed here/.test(e.message) && e.status === 404;
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6, seek: true }), /Remux failed|did not start/, "the first try fails");
    assert.equal(spawned, 1, "it started ffmpeg");
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6 }), refused, "a playlist poll after it: refused as a 404 (the player does not ask again)");
    assert.equal(spawned, 1, "the poll started nothing");
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6, seek: true }), /Remux failed|did not start/, "a seek tries once more, and fails");
    assert.equal(spawned, 2);
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6, seek: true }), refused, "twice: a seek is refused too");
    await assert.rejects(remux.ensure(film, id, { vcodec: "h264", ss: 6 }), refused);
    assert.equal(spawned, FAIL_LIMIT, "nothing more was started");
  } finally {
    for (const k of [...failed.keys()]) if (k.includes(id)) failed.delete(k);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
