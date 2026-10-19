// lib/children.js killNow: a helper the server lowered (cpuwork's viewer and
// background classes, jit's yield, remux, torrent transcodes) is given the
// normal priority back right before it is killed. On a busy Windows box a
// killed below-normal / idle process only dies when it next gets the CPU —
// measured 5-93 s, holding its files, RAM and encoder slot (2026-10-20).
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { spawn } = require("child_process");
const children = require("../src/lib/children");

test("killNow raises the priority, then kills", () => {
  const calls = [];
  const realSet = os.setPriority;
  os.setPriority = (pid, prio) => calls.push(["prio", pid, prio]);
  try {
    const fake = { pid: 4242, exitCode: null, signalCode: null, kill: (sig) => calls.push(["kill", sig]) };
    assert.equal(children.killNow(fake), true);
    assert.deepEqual(calls, [["prio", 4242, os.constants.priority.PRIORITY_NORMAL], ["kill", "SIGKILL"]]);
    // one that has already exited: no priority call, the kill is still harmless
    calls.length = 0;
    children.killNow({ pid: 4243, exitCode: 0, signalCode: null, kill: () => calls.push(["kill"]) });
    assert.deepEqual(calls, [["kill"]]);
    // nothing, or a kill that throws: never throws itself
    assert.equal(children.killNow(null), false);
    assert.equal(children.killNow({ pid: 1, exitCode: null, signalCode: null, kill: () => { throw new Error("gone"); } }), false);
  } finally {
    os.setPriority = realSet;
  }
});

test("a real child at idle priority is gone promptly after killNow", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  const exited = new Promise((r) => child.once("exit", r));
  const t0 = Date.now();
  assert.equal(children.killNow(child), true);
  await exited;
  assert.ok(Date.now() - t0 < 10000, `exited after ${Date.now() - t0} ms`);
});
