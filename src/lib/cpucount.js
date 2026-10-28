// How many CPUs this process may really use — not how many the machine has.
//
// os.cpus() lists every CPU of the box. A server started with an affinity
// mask (start /affinity, taskset), in a container with a cpuset, or under a
// CPU quota (a container's or a VPS's cgroup limit) may use fewer — and sized
// from the box it admitted far more encodes than it could run (a 2-CPU slice
// of a 16-thread PC: 5 transcodes of 8 x264 threads each).
//   1. os.availableParallelism() — honours the affinity mask / cpuset on
//      Windows and Linux (Node 18.14+, so on every Node this runs on);
//   2. on Linux, the cgroup CPU quota as well: v2 /sys/fs/cgroup/cpu.max
//      ("200000 100000" = 2 CPUs; "max" = none), v1 cpu.cfs_quota_us /
//      cpu.cfs_period_us (-1 = none). A quota of 1.5 CPUs counts as 1.
// The smaller wins; never under 1. Looked up once a minute.
"use strict";
const fs = require("fs");
const os = require("os");

const deps = {
  platform: () => process.platform,
  available: () => (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length),
  all: () => os.cpus().length,
  read: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  now: () => Date.now(),
};

// CPUs a cgroup quota allows, or null when there is none (or it cannot be read)
const quota = () => {
  if (deps.platform() !== "linux") return null;
  const v2 = deps.read("/sys/fs/cgroup/cpu.max");
  if (v2 != null) {
    const [q, p] = String(v2).trim().split(/\s+/);
    const qn = Number(q);
    const pn = Number(p) || 100000;
    return q !== "max" && qn > 0 ? qn / pn : null;
  }
  const q1 = Number(String(deps.read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") || deps.read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us") || "").trim());
  const p1 = Number(String(deps.read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") || deps.read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us") || "").trim()) || 100000;
  return q1 > 0 ? q1 / p1 : null;
};

let cached = null;
const detail = () => {
  const now = deps.now();
  if (cached && now - cached.at < 60000) return cached;
  const machine = Math.max(1, deps.all());
  const available = Math.max(1, deps.available() || machine);
  const q = quota();
  let n = available;
  let why = available < machine ? `${available} of the machine's ${machine} (an affinity mask or cpuset)` : `all ${machine}`;
  if (q != null && Math.floor(q) < n) {
    n = Math.max(1, Math.floor(q));
    why = `${n} (a CPU quota of ${Math.round(q * 100) / 100}; the machine has ${machine})`;
  }
  cached = { at: now, count: n, machine, available, quota: q, why };
  return cached;
};
const count = () => detail().count;
// libx264 threads for a single-rendition encode (the TV's offset job, a
// torrent's transcode): the machine less two for the server — but never ONE.
// One thread on a 2-CPU box made a 1080p encode 1.84x real time on this PC's
// cores (two threads: 3.06x, 2026-10-27, Knives Out) — on a VPS's slower,
// shared vCPUs that is about the film's own speed, and the TV stopped to
// load. Small boxes give the encode every CPU; the OS shares them with the
// server, which mostly waits.
const encodeThreads = (n = count()) => (n <= 2 ? 2 : n <= 4 ? n : n - 2);
// Fewer than the machine has? → the number, else 0 (the callers' "not restricted").
const restricted = () => { const d = detail(); return d.count < d.machine ? d.count : 0; };

module.exports = { count, restricted, detail, encodeThreads, _internals: { deps, quota, reset: () => { cached = null; } } };
