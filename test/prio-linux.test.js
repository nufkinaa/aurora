// Viewer streams on a server that cannot raise a priority back (Linux or
// macOS, not root — nufurora.com's VPS): they stay at NORMAL instead of the
// below-normal they could never leave again, where a TV's encode and every
// jit encode after its first segment starved behind any other work
// (lib/prio.js). Windows (and root) keep the old behaviour. And the
// single-rendition encoders never get ONE thread (lib/cpucount.js).
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const prio = require("../src/lib/prio");
const cpuwork = require("../src/media/cpuwork");
const cpucount = require("../src/lib/cpucount");

const real = { ...prio._deps };
afterEach(() => Object.assign(prio._deps, real));
const as = (platform, uid) => { prio._deps.platform = () => platform; prio._deps.uid = () => uid; };
const { PRIORITY_NORMAL, PRIORITY_BELOW_NORMAL, PRIORITY_LOW } = os.constants.priority;

test("Linux, not root: viewer work stays at normal; the background stays lowest", () => {
  as("linux", 1000);
  assert.equal(prio.canRaise(), false);
  assert.equal(prio.viewer(), PRIORITY_NORMAL);
  assert.equal(cpuwork.PRIORITY.viewer, PRIORITY_NORMAL);
  assert.equal(cpuwork.PRIORITY.background, PRIORITY_LOW);
});

test("Windows, and root anywhere: below normal, as before (it can be raised again)", () => {
  as("win32", -1);
  assert.equal(prio.viewer(), PRIORITY_BELOW_NORMAL);
  assert.equal(cpuwork.PRIORITY.viewer, PRIORITY_BELOW_NORMAL);
  as("linux", 0);
  assert.equal(prio.viewer(), PRIORITY_BELOW_NORMAL);
});

test("a jit encoder that has made its first segment yields to the viewers' priority — normal on Linux", () => {
  const jit = require("../src/media/jit");
  const seen = [];
  const realSet = os.setPriority;
  os.setPriority = (pid, p) => seen.push([pid, p]);
  try {
    as("linux", 1000);
    jit._internals.yieldCpu({ yielding: false }, { pid: 4242 });
    as("win32", -1);
    jit._internals.yieldCpu({ yielding: false }, { pid: 4343 });
  } finally { os.setPriority = realSet; }
  assert.deepEqual(seen, [[4242, PRIORITY_NORMAL], [4343, PRIORITY_BELOW_NORMAL]]);
});

test("encoder threads: never one; every CPU of a small box; two kept for the server on a big one", () => {
  assert.equal(cpucount.encodeThreads(1), 2);
  assert.equal(cpucount.encodeThreads(2), 2);
  assert.equal(cpucount.encodeThreads(4), 4);
  assert.equal(cpucount.encodeThreads(6), 4);
  assert.equal(cpucount.encodeThreads(16), 14);
});
