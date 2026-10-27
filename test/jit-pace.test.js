// A viewer's encoder keeps normal priority while its reader is right behind
// it, yields once it is YIELD_LEAD segments ahead, and — where a priority can
// be raised again (lib/prio.js) — comes back to normal when the reader closes
// in (media/jit.js paceEncoder). It used to yield for good the moment its
// first segment was out: below normal against other viewers' copies at
// normal, a rung near its reader made a quarter of real time (stall rig).
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const jit = require("../src/media/jit");
const prio = require("../src/lib/prio");
const J = jit._internals;
const { PRIORITY_NORMAL } = os.constants.priority;

const realSet = os.setPriority;
const realDeps = { ...prio._deps };
afterEach(() => { os.setPriority = realSet; Object.assign(prio._deps, realDeps); });

const fake = (readerSeg, nextSeg) => {
  const job = { enc: true, readers: [{ seg: readerSeg, at: Date.now() }], table: new Array(100).fill({ start: 0, dur: 6 }) };
  const run = { fromSeg: 0, nextSeg, proc: { pid: 777 }, yielding: false, warm: null, stopped: false };
  return { job, run };
};

test("right behind its reader: stays at normal; two ahead: yields; the reader closes in: back to normal", () => {
  prio._deps.platform = () => "win32";
  const calls = [];
  os.setPriority = (pid, p) => calls.push([pid, p]);
  const { job, run } = fake(5, 6); // made up to seg 5, the reader is at 5
  J.paceEncoder(job, run, Date.now());
  assert.equal(run.yielding, false);
  assert.deepEqual(calls, []);
  run.nextSeg = 8; // two ahead
  J.paceEncoder(job, run, Date.now());
  assert.equal(run.yielding, true);
  assert.deepEqual(calls.at(-1), [777, prio.viewer()]);
  job.readers[0].seg = 7; // the reader caught up
  J.paceEncoder(job, run, Date.now());
  assert.equal(run.yielding, false);
  assert.deepEqual(calls.at(-1), [777, PRIORITY_NORMAL]);
});

test("where a priority cannot be raised again it is never lowered for a viewer in the first place (Linux, not root)", () => {
  prio._deps.platform = () => "linux";
  prio._deps.uid = () => 1000;
  const calls = [];
  os.setPriority = (pid, p) => calls.push([pid, p]);
  const { job, run } = fake(0, 9);
  J.paceEncoder(job, run, Date.now());
  assert.deepEqual(calls, [[777, PRIORITY_NORMAL]]);
});

test("a warm-up yields from the start whatever its lead", () => {
  prio._deps.platform = () => "win32";
  const calls = [];
  os.setPriority = (pid, p) => calls.push([pid, p]);
  const { job, run } = fake(0, 1);
  run.warm = 3;
  J.paceEncoder(job, run, Date.now());
  assert.equal(run.yielding, true);
});
