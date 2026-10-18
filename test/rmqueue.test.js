// A job folder is removed off the event loop (lib/rmqueue.js): its name is
// free at once, the files go in the background, leftovers are recognised.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rmq = require("../src/lib/rmqueue");

test("the folder's name is free at once; the files go in the background", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-rmq-"));
  const dir = path.join(root, "job");
  fs.mkdirSync(dir);
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `seg${String(i).padStart(5, "0")}.ts`), Buffer.alloc(2048));
  const t0 = process.hrtime.bigint();
  rmq.removeDir(dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(fs.existsSync(dir), false, "renamed away at once");
  fs.mkdirSync(dir); // a new job can start there straight away
  assert.ok(ms < 200, `the call itself took ${ms} ms`);
  await rmq.drain();
  assert.deepEqual(fs.readdirSync(root), ["job"], "the renamed folder is gone");
  rmq.removeDir(path.join(root, "missing")); // nothing there: nothing happens
  await rmq.drain();
  fs.rmSync(root, { recursive: true, force: true });
});

test("leftovers of an unfinished removal are recognised by name", () => {
  assert.equal(rmq.isLeftover("abc-123.del-lz0k1a"), true);
  assert.equal(rmq.isLeftover("abc-123-h264-0"), false);
  assert.equal(rmq.isLeftover("abc.del-"), false);
});
