// lib/leadprio.js: a producer well ahead of its viewer steps down to the lowest
// CPU priority and back to what it had when the viewer comes near (Windows only).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const lp = require("../src/lib/leadprio");

const fake = (platform) => {
  const calls = [];
  const prio = { 42: os.constants.priority.PRIORITY_BELOW_NORMAL };
  Object.assign(lp._deps, { platform: () => platform, get: (pid) => prio[pid], set: (pid, p) => { calls.push([pid, p]); prio[pid] = p; } });
  return { calls, prio };
};
const real = { ...lp._deps };
test.afterEach(() => Object.assign(lp._deps, real));

test("down at LOW_AT ahead, back to the priority it had under BACK_AT, once each", () => {
  const { calls, prio } = fake("win32");
  const run = {};
  assert.strictEqual(lp.step(run, 42, lp.LOW_AT - 1), null);
  assert.strictEqual(lp.step(run, 42, lp.LOW_AT), "low");
  assert.strictEqual(prio[42], os.constants.priority.PRIORITY_LOW);
  assert.strictEqual(lp.step(run, 42, lp.LOW_AT + 10), null); // already down: nothing asked of the OS
  assert.strictEqual(lp.step(run, 42, lp.BACK_AT), null); // between the two: stays
  assert.strictEqual(lp.step(run, 42, lp.BACK_AT - 1), "back");
  assert.strictEqual(prio[42], os.constants.priority.PRIORITY_BELOW_NORMAL);
  assert.strictEqual(calls.length, 2);
});

test("not on Linux / macOS (a nice value cannot be raised back without privileges)", () => {
  for (const pl of ["linux", "darwin"]) {
    const { calls } = fake(pl);
    assert.strictEqual(lp.step({}, 42, 50), null);
    assert.strictEqual(calls.length, 0);
  }
});

test("an OS that refuses changes nothing and the state stays honest", () => {
  fake("win32");
  lp._deps.set = () => { throw new Error("denied"); };
  const run = {};
  assert.strictEqual(lp.step(run, 42, 20), null);
  assert.ok(!run.leadLow);
  assert.strictEqual(lp.step(run, null, 20), null);
  assert.strictEqual(lp.step(null, 42, 20), null);
});

