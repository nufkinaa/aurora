// lib/procpause.js: on Windows every pause/resume is a short-lived PowerShell
// (~350 ms) — so the calls are bounded: at most WIN_AT_ONCE at once, at most
// WIN_SUSPENDS_PER_MIN suspends a minute, suspending switched off for a while
// after WIN_FAILS_OFF failures in a row, and a resume never refused. And
// remux's pace() never asks again on every segment after a refusal.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pp = require("../src/lib/procpause");
const D = pp._internals.deps;
const real = { ...D };
let clock = 1e9;
const win = (impl) => {
  pp._internals._reset();
  D.platform = () => "win32";
  D.now = () => clock;
  D.powershell = impl;
};
test.afterEach(() => { Object.assign(D, real); pp._internals._reset(); });

test("Windows: no more than WIN_AT_ONCE PowerShells at once", async () => {
  let live = 0, most = 0;
  win(async () => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 15)); live--; return true; });
  const all = [];
  for (let i = 0; i < 8; i++) all.push(i % 2 ? pp.resume(100 + i) : pp.suspend(100 + i));
  const got = await Promise.all(all);
  assert.ok(got.every(Boolean));
  assert.equal(most, pp.WIN_AT_ONCE);
  assert.equal(pp.status().spawned, 8);
});

test("Windows: suspends capped per minute; resumes never refused", async () => {
  let spawned = 0;
  win(async () => { spawned++; return true; });
  for (let i = 0; i < pp.WIN_SUSPENDS_PER_MIN; i++) assert.equal(await pp.suspend(10 + i), true);
  assert.equal(await pp.suspend(99), false, "over the cap: runs on");
  assert.equal(pp.status().refusedRate, 1);
  assert.equal(await pp.resume(10), true, "a resume is always tried");
  clock += 61000;
  assert.equal(await pp.suspend(99), true, "a minute later: allowed again");
  assert.equal(spawned, pp.WIN_SUSPENDS_PER_MIN + 2);
});

test("Windows: suspending switched off after failures in a row — no PowerShell every few seconds", async () => {
  let spawned = 0;
  win(async () => { spawned++; return false; });
  for (let i = 0; i < pp.WIN_FAILS_OFF; i++) assert.equal(await pp.suspend(5), false);
  assert.equal(spawned, pp.WIN_FAILS_OFF);
  for (let i = 0; i < 20; i++) assert.equal(await pp.suspend(5), false);
  assert.equal(spawned, pp.WIN_FAILS_OFF, "off: nothing spawned");
  assert.equal(pp.status().refusedOff, 20);
  clock += 31 * 60 * 1000;
  await pp.suspend(5);
  assert.equal(spawned, pp.WIN_FAILS_OFF + 1, "tried again after the off time");
});

test("Linux: signals, no PowerShell", async () => {
  pp._internals._reset();
  const sent = [];
  D.platform = () => "linux";
  D.kill = (pid, sig) => sent.push([pid, sig]);
  D.powershell = async () => { throw new Error("never"); };
  assert.equal(await pp.suspend(7), true);
  assert.equal(await pp.resume(7), true);
  assert.deepEqual(sent, [[7, "SIGSTOP"], [7, "SIGCONT"]]);
});

test("remux pace: a refused pause is not asked again for a minute; a failed resume is retried, not on every segment", async () => {
  const remux = require("../src/media/remux");
  const realS = pp.suspend, realR = pp.resume;
  const calls = [];
  let suspendOk = false, resumeOk = false;
  pp.suspend = async (pid) => { calls.push("suspend"); return suspendOk; };
  pp.resume = async (pid) => { calls.push("resume"); return resumeOk; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-pp-"));
  try {
    const write = (n) => fs.writeFileSync(path.join(tmp, "index.m3u8"), "#EXTM3U\n" + Array.from({ length: n }, (_, i) => `#EXTINF:6.0,\nseg${i}.ts\n`).join(""));
    const job = { proc: { pid: 4242 }, done: false, dir: tmp, readSeg: 0, paused: false };
    write(remux.AHEAD_MAX + 5);
    for (let i = 0; i < 10; i++) await remux.pace(job);
    assert.deepEqual(calls, ["suspend"], "one refused suspend, then quiet");
    assert.equal(job.paused, false);
    // a pause that worked, then the reader catches up and the resume fails
    job.pauseRetryAt = 0; suspendOk = true; calls.length = 0;
    await remux.pace(job);
    assert.equal(job.paused, true);
    job.readSeg = remux.AHEAD_MAX + 5 - 2;
    for (let i = 0; i < 10; i++) await remux.pace(job);
    assert.deepEqual(calls, ["suspend", "resume"], "one resume asked, not ten");
    assert.equal(job.paused, true, "still paused: it will be tried again");
    job.resumeRetryAt = 0; resumeOk = true;
    await remux.pace(job);
    assert.equal(job.paused, false);
  } finally {
    pp.suspend = realS; pp.resume = realR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
