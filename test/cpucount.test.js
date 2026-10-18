// The CPUs this process may use (lib/cpucount.js): the affinity mask /
// cpuset, and on Linux a cgroup CPU quota (v2 cpu.max, v1 cfs_quota_us).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../src/lib/cpucount");

const { deps } = cc._internals;
const real = { ...deps };
beforeEach(() => { Object.assign(deps, real); cc._internals.reset(); });
const box = ({ platform = "linux", all = 16, available = 16, files = {} }) => {
  deps.platform = () => platform;
  deps.all = () => all;
  deps.available = () => available;
  deps.read = (p) => (p in files ? files[p] : null);
};

test("the whole machine when nothing restricts it", () => {
  box({ files: { "/sys/fs/cgroup/cpu.max": "max 100000\n" } });
  assert.equal(cc.count(), 16);
  assert.equal(cc.restricted(), 0);
});

test("an affinity mask / cpuset (availableParallelism)", () => {
  box({ platform: "win32", available: 2 });
  assert.equal(cc.count(), 2);
  assert.equal(cc.restricted(), 2);
  assert.match(cc.detail().why, /2 of the machine's 16/);
});

test("a cgroup v2 quota: 200000/100000 = 2 CPUs; 150000 = 1 (rounded down, never 0)", () => {
  box({ files: { "/sys/fs/cgroup/cpu.max": "200000 100000\n" } });
  assert.equal(cc.count(), 2);
  cc._internals.reset();
  box({ files: { "/sys/fs/cgroup/cpu.max": "150000 100000\n" } });
  assert.equal(cc.count(), 1);
  cc._internals.reset();
  box({ files: { "/sys/fs/cgroup/cpu.max": "20000 100000\n" } });
  assert.equal(cc.count(), 1);
  assert.match(cc.detail().why, /quota of 0.2/);
});

test("a cgroup v1 quota, and -1 meaning none", () => {
  box({ files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" } });
  assert.equal(cc.count(), 4);
  cc._internals.reset();
  box({ files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" } });
  assert.equal(cc.count(), 16);
});

test("the smaller of the mask and the quota; a quota is not read on Windows", () => {
  box({ available: 3, files: { "/sys/fs/cgroup/cpu.max": "800000 100000" } });
  assert.equal(cc.count(), 3);
  cc._internals.reset();
  box({ platform: "win32", files: { "/sys/fs/cgroup/cpu.max": "100000 100000" } });
  assert.equal(cc.count(), 16);
});

test("encbudget sizes the machine by it", () => {
  box({ platform: "win32", available: 2 });
  const budget = require("../src/media/encbudget");
  assert.equal(budget.explain().logical, 2);
});
