// lib/memnudge.js: a full collection when garbage Buffers pile up — at most
// once per gap, never below the limit.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const nudge = require("../src/lib/memnudge");

test("collects above the limit, at most once per gap; nothing below it", () => {
  const t = 1e12;
  assert.equal(nudge.check(t, 1e9), false, "far below the limit: nothing");
  assert.equal(nudge.check(t, 0), true, "above it: one full collection");
  assert.equal(nudge.check(t + 1000, 0), false, "not again within the gap");
  assert.equal(nudge.check(t + 6000, 0), true);
  assert.equal(nudge.stats().available, true);
  assert.ok(nudge.stats().runs >= 2);
});
