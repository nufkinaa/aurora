// lib/spawner.js `lower`: decoration (a title page's still frame, picture
// variants, blur-ups) starts below normal priority, so it does not take the
// CPU from the segment somebody is waiting to see. The child reads its own
// priority a moment after it starts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const spawner = require("../src/lib/spawner");

const own = ["-e", "setTimeout(() => console.log(require('os').getPriority()), 400)"];

test("a helper started with lower: true runs below normal priority", async () => {
  const r = await spawner.run(process.execPath, own, { timeoutMs: 10000, lower: true, name: "test" });
  assert.equal(r.code, 0);
  assert.equal(Number(String(r.stdout).trim()), os.constants.priority.PRIORITY_BELOW_NORMAL);
});

test("without it, at the server's own priority", async () => {
  const r = await spawner.run(process.execPath, own, { timeoutMs: 10000, name: "test" });
  assert.equal(r.code, 0);
  assert.equal(Number(String(r.stdout).trim()), os.getPriority());
});
