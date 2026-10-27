// An encoder that is PAUSED far ahead of its reader (remux.js pace →
// procpause: the OS has suspended it) takes no CPU. It used to count against
// the machine's encode budget all the same — and on a small machine (one or
// two encoders: a 4-CPU VPS) the next viewer who needed an encode was told
// "Server is busy" on every rendition for as long as it slept: measured with
// tools/stall-rig, a ladder viewer frozen at 0 s for seven minutes beside one
// such sleeping encode.
//      node --test test/encoder-paused.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const remux = require("../src/media/remux");
const budget = require("../src/media/encbudget");
const cpuwork = require("../src/media/cpuwork");
const B = budget._internals;

const pinned = async (n, fn) => {
  const keep = { setting: B.deps.setting, started: B.state.started };
  B.deps.setting = () => n;
  B.state.started = true;
  B.state.overloadedUntil = 0;
  try { return await fn(); } finally {
    B.deps.setting = keep.setting;
    B.state.started = keep.started;
    B.state.overloadedUntil = 0;
  }
};
const fakeChild = (pid) => Object.assign(new EventEmitter(), { pid, kill() {} });
test.after(() => cpuwork._internals._reset());

test("the ladder's admission does not count a single-rendition encode that is asleep (budget pinned to one)", () => pinned(1, () => {
  cpuwork._internals._reset();
  let asleep = false;
  const child = fakeChild(31);
  cpuwork.viewer.track(child, { kind: "transcode", label: "sleeping offset job", cost: budget.unit(), idle: () => asleep });
  assert.strictEqual(jit.encodeRoom("another-title", true), false, "awake: the one slot is taken");
  asleep = true;
  assert.strictEqual(jit.encodeRoom("another-title", true), true, "asleep: the slot is free for the viewer who needs it");
  child.emit("exit");
}));

// The real job: remux.js registers its encode with that `idle` — true while
// the job is paused, false again once it runs.
const hasX264 = (() => { try { return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return false; } })();
test("remux registers its encode as idle while it is paused", { skip: !hasX264 && "no ffmpeg with libx264 here", timeout: 60000 }, async () => {
  cpuwork._internals._reset();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-encpaused-"));
  const film = path.join(tmp, "f.mkv");
  execFileSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=60", "-f", "lavfi", "-i", "sine=duration=60", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", film]);
  const id = "pausedtest01";
  const dir = await remux.ensure(film, id, { vcodec: "h264", ss: 0 });
  const job = remux._internals.jobs.get(dir);
  try {
    assert.ok(job && job.proc, "an encode is running");
    const unit = budget.unit();
    assert.ok(cpuwork.viewer.load() >= unit - 1e-9, "running: it counts");
    job.paused = true;
    assert.strictEqual(cpuwork.viewer.load(), 0, "paused: it does not");
    job.paused = false;
    assert.ok(cpuwork.viewer.load() >= unit - 1e-9, "running again: it counts again");
  } finally {
    if (job && job.proc) { require("../src/lib/children").killNow(job.proc); await new Promise((r) => (job.proc ? job.proc.once("close", r) : r())); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
