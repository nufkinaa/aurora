// The part of the drives feature that touches a drive — run as its OWN
// process (lib/drives/run.js), never inside the server.
//
// Why a process: a network drive mounted "hard" (NFS's default) that stops
// answering makes every file call on it wait for ever. Inside the server
// such a call sits in libuv's thread pool (a handful of threads shared by
// ALL file I/O, DNS and compression), or on the event loop itself for a
// synchronous call — a few of them and nobody in the house can watch
// anything. Out here it only holds this process, which the server stops
// waiting for after its timeout (and kills).
//
//   node probe-child.js '<json>'   { op, ...args }  →  stdout: one JSON line
//
//   statfs   { path }                  { total, free, used }
//   check    { path, roots: [dir] }    statfs + each folder readable
//   usage    { paths: [dir], budgetMs } bytes under them (hard links once)
//   writable { dir }                   create, write, fsync, rename, delete a test file
//   prepare  { dirs: [dir], test }     mkdir -p each, then `writable` in test
//   speed    { dir, sizeMB, budgetMs } sequential write + read, random 4K reads
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const statfs = (p) => {
  const s = fs.statfsSync(p);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return { total, free, used: Math.max(0, total - s.bfree * s.bsize) };
};

const readable = (dir) => {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const d = fs.opendirSync(dir);
    try { d.readSync(); } finally { d.closeSync(); }
    return true;
  } catch { return false; }
};

const usage = ({ paths = [], budgetMs = 60000 }) => {
  const until = Date.now() + budgetMs;
  const seen = new Set();
  let bytes = 0;
  let files = 0;
  let partial = false;
  const stack = [...paths];
  while (stack.length) {
    if (Date.now() > until) { partial = true; break; }
    const dir = stack.pop();
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(abs, { bigint: false });
        // a hard-linked file (a download landed from staging on the same
        // volume) is counted once
        if (st.nlink > 1) {
          const k = `${st.dev}:${st.ino}`;
          if (seen.has(k)) continue;
          seen.add(k);
        }
        bytes += st.size;
        files++;
      } catch {}
    }
  }
  return { bytes, files, partial };
};

const testName = (dir, what) => path.join(dir, `.aurora-${what}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);

// Every step a library needs of a drive: a new file, bytes in it, those
// bytes on the disk (fsync), a rename (how a download is put in place), a delete.
const writable = ({ dir }) => {
  const a = testName(dir, "check");
  const b = `${a}.renamed`;
  let step = "create";
  try {
    const fd = fs.openSync(a, "wx");
    try {
      step = "write";
      fs.writeSync(fd, Buffer.from("aurora drive check\n"));
      step = "fsync";
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    step = "rename";
    fs.renameSync(a, b);
    step = "read";
    if (fs.readFileSync(b, "utf8") !== "aurora drive check\n") throw new Error("read back different bytes");
    step = "delete";
    fs.unlinkSync(b);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(a); } catch {}
    try { fs.unlinkSync(b); } catch {}
    return { ok: false, step, error: `${e.code || ""} ${e.message || e}`.trim() };
  }
};

const prepare = ({ dirs = [], test }) => {
  const created = [];
  const existed = [];
  for (const d of dirs) {
    if (fs.existsSync(d)) { existed.push(d); continue; }
    fs.mkdirSync(d, { recursive: true });
    created.push(d);
  }
  return { created, existed, check: writable({ dir: test || dirs[0] }) };
};

// ---- speed ----
const MB = 1024 * 1024;
const hasDd = () => {
  if (process.platform !== "linux") return false;
  try { execFileSync("dd", ["--version"], { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
};
// GNU dd's "nocache": posix_fadvise(DONTNEED) on the whole file — its pages
// leave the page cache, so the next read comes from the drive.
const dropCache = (file) => {
  try { execFileSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"], { stdio: "ignore", timeout: 10000 }); return true; } catch { return false; }
};
// "268435456 bytes (268 MB, 256 MiB) copied, 0.121 s, 2.2 GB/s"
const ddSeconds = (stderr) => {
  const m = /copied,\s*([\d.,]+)\s*s/.exec(String(stderr || ""));
  return m ? parseFloat(m[1].replace(",", ".")) : null;
};

const speed = ({ dir, sizeMB = 256, budgetMs = 18000 }) => {
  const file = testName(dir, "speedtest");
  const started = Date.now();
  const phaseBudget = Math.max(2000, Math.floor(budgetMs * 0.4));
  const out = { sizeMB, readMethod: null };
  const chunk = crypto.randomBytes(4 * MB); // random: a compressing file system cannot cheat
  const dd = hasDd();
  try {
    // 1. sequential write, fsync at the end (what landing a film costs)
    let written = 0;
    const t0 = process.hrtime.bigint();
    const fd = fs.openSync(file, "w");
    try {
      while (written < sizeMB * MB) {
        chunk.writeUInt32LE(written / MB, 0); // no two chunks alike (no dedupe)
        fs.writeSync(fd, chunk, 0, chunk.length);
        written += chunk.length;
        if (Date.now() - started > phaseBudget) break;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const wSec = Number(process.hrtime.bigint() - t0) / 1e9;
    out.writtenMB = Math.round(written / MB);
    out.writeMBps = wSec > 0 ? written / MB / wSec : null;

    // 2. sequential read — from the drive, not from memory where that can be arranged
    let rMBps = null;
    if (dd) {
      try {
        const r = require("child_process").spawnSync("dd", [`if=${file}`, "of=/dev/null", "bs=1M", "iflag=direct"], { encoding: "utf8", timeout: phaseBudget + 5000 });
        const s = r.status === 0 ? ddSeconds(r.stderr) : null;
        if (s && s > 0) { rMBps = written / MB / s; out.readMethod = "direct (O_DIRECT, page cache bypassed)"; }
      } catch {}
      if (rMBps == null && dropCache(file)) out.readMethod = "cache dropped first (fadvise)";
    }
    if (rMBps == null) {
      if (!out.readMethod) out.readMethod = process.platform === "win32"
        ? "Windows: read right after writing — partly from memory, so this figure can be high"
        : "read right after writing — partly from memory, so this figure can be high";
      const buf = Buffer.allocUnsafe(4 * MB);
      const t1 = process.hrtime.bigint();
      const rfd = fs.openSync(file, "r");
      let read = 0;
      try {
        for (;;) { const n = fs.readSync(rfd, buf, 0, buf.length, read); if (!n) break; read += n; }
      } finally { fs.closeSync(rfd); }
      const rSec = Number(process.hrtime.bigint() - t1) / 1e9;
      rMBps = rSec > 0 ? read / MB / rSec : null;
    }
    out.readMBps = rMBps;

    // 3. small random reads (4 KB at random places: seeking about in a film)
    if (dd) dropCache(file);
    const small = Buffer.allocUnsafe(4096);
    const blocks = Math.max(1, Math.floor(written / 4096));
    const lat = [];
    const rfd = fs.openSync(file, "r");
    const until = Date.now() + Math.min(4000, Math.max(1000, budgetMs - (Date.now() - started) - 1000));
    try {
      while (lat.length < 400 && Date.now() < until) {
        const at = Math.floor(Math.random() * blocks) * 4096;
        const t = process.hrtime.bigint();
        fs.readSync(rfd, small, 0, 4096, at);
        lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    } finally { fs.closeSync(rfd); }
    const total = lat.reduce((n, x) => n + x, 0);
    lat.sort((a, b) => a - b);
    out.randomReads = lat.length;
    out.iops = total > 0 ? lat.length / (total / 1000) : null;
    out.latencyMs = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    out.randomMethod = dd ? "cache dropped first" : "may be partly from memory";
    out.seconds = (Date.now() - started) / 1000;
    return out;
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
};

const OPS = {
  statfs: ({ path: p }) => statfs(p),
  check: ({ path: p, roots = [] }) => {
    const s = statfs(p);
    const r = {};
    for (const d of roots) r[d] = readable(d);
    return { ...s, roots: r };
  },
  usage,
  writable,
  prepare,
  speed,
};

if (require.main === module) {
  let args;
  try { args = JSON.parse(process.argv[2] || "{}"); } catch { args = {}; }
  // (test seam: a drive that never answers — the parent's timeout is what is tested)
  // (…and with AURORA_DRIVES_FAKE_HANG_SWITCH, only while that file exists: a private
  // test server's drive can stop answering, and answer again, while it runs)
  const hangOn = () => !process.env.AURORA_DRIVES_FAKE_HANG_SWITCH || fs.existsSync(process.env.AURORA_DRIVES_FAKE_HANG_SWITCH);
  if (process.env.AURORA_DRIVES_FAKE_HANG && String(args.path || args.dir || (args.paths || [])[0] || (args.dirs || [])[0] || "").startsWith(process.env.AURORA_DRIVES_FAKE_HANG) && hangOn()) {
    setInterval(() => {}, 1 << 30);
  } else {
    let res;
    try {
      const fn = OPS[args.op];
      if (!fn) throw new Error(`unknown op ${args.op}`);
      res = { ok: true, result: fn(args) };
    } catch (e) {
      res = { ok: false, error: `${(e && e.code) || ""} ${(e && e.message) || e}`.trim() };
    }
    process.stdout.write(JSON.stringify(res) + "\n");
  }
}

module.exports = { OPS, ddSeconds };
