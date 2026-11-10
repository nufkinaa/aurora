// lib/warmup.js (perf-server 2026-11-10): the modules the apps' first
// requests load are read ahead, one per step, in order, and every one of
// them resolves. (The timers are unref'd: a test keeps the loop alive.)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { warm, MODULES } = require("../src/lib/warmup");

test("every module on the list resolves", () => {
  for (const m of MODULES) assert.ok(require.resolve(path.join(__dirname, "..", "src", "lib", m)), m);
});

const alive = (p) => { const t = setInterval(() => {}, 1000); return p.finally(() => clearInterval(t)); };

test("one module per step, in order, after the delay", async () => {
  const seen = [];
  await alive(new Promise((resolve) => warm({ delayMs: 5, gapMs: 5, modules: ["a", "b", "c"], load: (m) => seen.push(m), onDone: resolve })));
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("a module that fails to load does not stop the rest", async () => {
  const seen = [];
  await alive(new Promise((resolve) => warm({ delayMs: 1, gapMs: 1, modules: ["a", "bad", "c"], load: (m) => { if (m === "bad") throw new Error("x"); seen.push(m); }, onDone: resolve })));
  assert.deepEqual(seen, ["a", "c"]);
});
