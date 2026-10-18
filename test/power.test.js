// lib/power.js: the low-power profile, chosen from the machine unless
// config.json says otherwise — and what it changes (server round, 2026-10-18).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const power = require("../src/lib/power");
const cpuwork = require("../src/media/cpuwork");

const GB = 1024 * 1024 * 1024;

test("auto: low on 4 CPU threads or fewer, or 6 GB or less; the setting wins either way", () => {
  assert.equal(power.decide("auto", { threads: 4, memory: 16 * GB }).profile, "low");
  assert.equal(power.decide("auto", { threads: 2, memory: 4 * GB }).profile, "low");
  assert.equal(power.decide("auto", { threads: 12, memory: 4 * GB }).profile, "low");
  assert.equal(power.decide("auto", { threads: 12, memory: 16 * GB }).profile, "normal");
  assert.equal(power.decide(undefined, { threads: 8, memory: 8 * GB }).profile, "normal");
  assert.equal(power.decide("low", { threads: 32, memory: 64 * GB }).profile, "low");
  assert.equal(power.decide("normal", { threads: 2, memory: 2 * GB }).profile, "normal");
  assert.equal(power.decide("NORMAL", { threads: 2, memory: 2 * GB }).profile, "normal");
  assert.match(power.decide("auto", { threads: 4, memory: 16 * GB }).why, /4 CPU threads/);
});

test("the background budget: one heavy decode at a time on a small machine or in low power, two on a big one", async () => {
  const C = cpuwork._internals;
  const saved = { cpus: C.deps.cpus, low: C.deps.low };
  try {
    C.deps.low = () => false;
    C.deps.cpus = () => 16;
    assert.equal(cpuwork.budget(), 2);
    C.deps.cpus = () => 8;
    assert.equal(cpuwork.budget(), 1, "eight threads: four cores — one at a time");
    C.deps.cpus = () => 4;
    assert.equal(cpuwork.budget(), 1);
    C.deps.cpus = () => 16;
    C.deps.low = () => true;
    assert.equal(cpuwork.budget(), 1, "the low-power profile");
    // and the gate keeps to it: with one unit in use nothing else of weight 1 starts
    C.deps.low = () => false;
    C.deps.cpus = () => 4;
    C._reset();
    const place = await cpuwork.background.gate("speech", { label: "a" });
    assert.equal(cpuwork.background.mayStart("intro"), false, "a second heavy decode waits");
    place.release();
    assert.equal(cpuwork.background.mayStart("intro"), cpuwork.viewer.quiet());
  } finally {
    Object.assign(C.deps, saved);
  }
});

test("status says the profile and why", () => {
  const s = power.status();
  assert.ok(s.profile === "low" || s.profile === "normal");
  assert.equal(typeof s.why, "string");
  assert.ok(s.threads >= 1);
});

test("a small JavaScript heap (a low --max-old-space-size) makes it low too, and says so", () => {
  const d = power.decide("auto", { threads: 16, memory: 32 * GB, heap: 512 * 1024 * 1024 });
  assert.equal(d.profile, "low");
  assert.match(d.why, /512 MB JavaScript heap/);
  assert.equal(power.decide("auto", { threads: 16, memory: 32 * GB, heap: 4 * GB }).profile, "normal");
  const m = power.machine();
  assert.ok(m.threads >= 1 && m.memory > 0 && m.heap > 0);
});
