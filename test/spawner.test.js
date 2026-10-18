// lib/spawner.js: helper processes started from a worker thread, so the
// blocking process start does not hold the event loop (server round,
// 2026-10-18) — same answers as starting them here.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const spawner = require("../src/lib/spawner");
const children = require("../src/lib/children");

test("run: exit code, stdout, stdin, stderr's end, a time limit — from the worker", async () => {
  const node = process.execPath;
  const ok = await spawner.run(node, ["-e", "process.stdout.write('hello')"], { name: "test" });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.toString(), "hello");
  const echo = await spawner.run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: Buffer.from("piped through") });
  assert.equal(echo.stdout.toString(), "piped through");
  const bad = await spawner.run(node, ["-e", "console.error('it went wrong'); process.exit(3)"]);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /it went wrong/);
  const slow = await spawner.run(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.code, 0);
  const missing = await spawner.run("Z:/no/such/program.exe", []);
  assert.notEqual(missing.code, 0);
  const s = spawner.stats();
  assert.ok(s.inWorker >= 5, JSON.stringify(s));
  assert.equal(s.waiting, 0);
  assert.equal(children.list().filter((c) => c.name === "test").length, 0, "a finished helper is no longer tracked");
});

test("while a helper runs it is tracked by pid (so a stopping server ends it)", async () => {
  const p = spawner.run(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { name: "tracked-test", timeoutMs: 5000 });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    seen = children.list().some((c) => c.name === "tracked-test" && c.pid > 0);
    if (!seen) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(seen, "the helper's pid is in lib/children.js");
  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(children.list().some((c) => c.name === "tracked-test"), false);
});

test("the event loop keeps turning while helpers start", async () => {
  let ticks = 0;
  const t = setInterval(() => ticks++, 1);
  await Promise.all(Array.from({ length: 6 }, () => spawner.run(process.execPath, ["-e", "0"])));
  clearInterval(t);
  assert.ok(ticks > 0);
});
