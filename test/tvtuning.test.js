// The TV player's start-up tuning (src/lib/tvtuning.js): what config.json's
// "tvPlayer" may say, and what the app is told.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitize, RANGES } = require("../src/lib/tvtuning");

test("nothing set: nothing told — the app keeps the values it was built with", () => {
  for (const raw of [undefined, null, {}, [], "fast", 7, true]) assert.deepEqual(sanitize(raw), {}, JSON.stringify(raw));
});

test("the numbers, inside their ranges, as whole milliseconds", () => {
  assert.deepEqual(sanitize({ startBufferMs: 1000, rebufferMs: 5000 }), { startBufferMs: 1000, rebufferMs: 5000 });
  assert.deepEqual(sanitize({ startBufferMs: 750.4 }), { startBufferMs: 750 });
  assert.deepEqual(sanitize({ startBufferMs: RANGES.startBufferMs[0], rebufferMs: RANGES.rebufferMs[1] }), { startBufferMs: 250, rebufferMs: 20000 });
});

test("a value out of range, or not a number, is dropped — not pushed to an edge nobody chose", () => {
  assert.deepEqual(sanitize({ startBufferMs: 0 }), {});
  assert.deepEqual(sanitize({ startBufferMs: 100 }), {});
  assert.deepEqual(sanitize({ startBufferMs: 60000 }), {});
  assert.deepEqual(sanitize({ startBufferMs: "1000" }), {});
  assert.deepEqual(sanitize({ startBufferMs: NaN, rebufferMs: Infinity }), {});
  assert.deepEqual(sanitize({ rebufferMs: 500 }), {});
});

test("playback never resumes on less than it starts on", () => {
  assert.deepEqual(sanitize({ startBufferMs: 3000, rebufferMs: 2000 }), { startBufferMs: 3000 });
  assert.deepEqual(sanitize({ startBufferMs: 2000, rebufferMs: 2000 }), { startBufferMs: 2000, rebufferMs: 2000 });
});

test("switches are true or false, nothing else; unknown keys never reach the app", () => {
  assert.deepEqual(sanitize({ resumeAtSource: true }), { resumeAtSource: true });
  assert.deepEqual(sanitize({ resumeAtSource: false }), { resumeAtSource: false });
  assert.deepEqual(sanitize({ resumeAtSource: "yes" }), {});
  assert.deepEqual(sanitize({ resumeAtSource: 1 }), {});
  assert.deepEqual(sanitize({ adminPassword: "x", somethingElse: 5, startBufferMs: 800 }), { startBufferMs: 800 });
  assert.deepEqual(sanitize(Object.create({ startBufferMs: 1000, resumeAtSource: true })), {}, "only the object's own keys");
});
