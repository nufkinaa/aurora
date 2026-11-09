// The title the drive mover is working on is busy for the admin's delete
// suggestions and the deletes behind them (lib/busyfiles.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const busyfiles = require("../src/lib/busyfiles");
const makeMover = require("../src/lib/drives/mover");

test("a move in progress makes its original, its temp copy and its target busy; nothing else", () => {
  const root = path.join(os.tmpdir(), "aurora-mover-busy");
  const src = path.join(root, "fast", "Aurora", "Movies", "Old Film (1990)");
  const temp = path.join(root, "slow", "Aurora", ".aurora-moving-abc");
  const dst = path.join(root, "slow", "Aurora", "Movies", "Old Film (1990)");
  const state = { moves: { current: { src, temp, dst, phase: "copying" } } };
  makeMover({ deps: { now: () => 0 }, rules: {}, limits: { mover: {} }, data: () => state, live: { drives: [] }, stateOf: () => ({}) });
  assert.equal(busyfiles.busyWhy(path.join(src, "Old Film (1990).mkv")), "being moved to another drive");
  assert.equal(busyfiles.busyWhy(path.join(temp, "Old Film (1990).mkv")), "being moved to another drive");
  assert.equal(busyfiles.busyWhy(dst), "being moved to another drive");
  assert.equal(busyfiles.busyWhy(path.join(root, "fast", "Aurora", "Movies", "Another (2001)", "a.mkv")), null);
  state.moves.current = null;
  assert.equal(busyfiles.busyWhy(path.join(src, "Old Film (1990).mkv")), null, "free again when the move ends");
});
