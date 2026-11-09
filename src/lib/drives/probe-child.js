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
//   speed    { dir, sizeMB, budgetMs, network }  sequential write; reads: one
//            direct, one buffered, several at once; random 4K reads (progress
//            lines before the answer, so a check stopped on its deadline still counts)
//   sweep    { dirs, pids, maxAgeMs }  delete the test files a killed check left
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
// (the speed check reads with several readers at once: enough pool threads)
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "8";

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

// Aurora's share of a drive: the bytes its files take ON THE DISK (allocated
// blocks, as `df` counts them: a torrent left half-done in staging is
// mostly holes, and its full length is not on the disk). Each file is
// counted once however it is reached — a hard link between staging and
// the library, a folder inside another folder in `paths`, the same folder
// twice under two spellings — and the walk never leaves the file system its
// folder is on (a drive mounted inside a library folder is that drive's).
// Aurora's own test files (`.aurora-speedtest-*`, `.aurora-check-*`) are
// not Aurora's share.
const usage = ({ paths = [], budgetMs = 60000 }) => {
  const until = Date.now() + budgetMs;
  const seenFiles = new Set();
  const seenDirs = new Set();
  const key = (st) => (st.ino ? `${st.dev}:${st.ino}` : null);
  let bytes = 0;
  let apparent = 0;
  let files = 0;
  let partial = false;
  const stack = [];
  for (const p of paths) {
    try { const st = fs.statSync(p, { bigint: true }); if (st.isDirectory()) stack.push({ dir: p, dev: st.dev, st }); } catch {}
  }
  stack.reverse();
  while (stack.length) {
    if (Date.now() > until) { partial = true; break; }
    const { dir, dev, st: dst } = stack.pop();
    const dk = key(dst);
    if (dk) { if (seenDirs.has(dk)) continue; seenDirs.add(dk); }
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        try {
          const st = fs.statSync(abs, { bigint: true });
          if (st.dev === dev) stack.push({ dir: abs, dev, st });
        } catch {}
        continue;
      }
      if (!e.isFile() || TEST_FILE.test(e.name)) continue;
      try {
        const st = fs.statSync(abs, { bigint: true });
        const k = key(st);
        if (k) { if (seenFiles.has(k)) continue; seenFiles.add(k); }
        const size = Number(st.size);
        // (Windows gives no block count: the length there)
        const onDisk = typeof st.blocks === "bigint" && st.blocks > 0n ? Number(st.blocks) * 512 : st.blocks === 0n ? 0 : size;
        bytes += onDisk;
        apparent += size;
        files++;
      } catch {}
    }
  }
  return { bytes, apparent, files, partial };
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

// The file calls the speed check makes, in one place — so a test can make
// the drive slow (AURORA_DRIVES_FAKE_SLOW_MS_PER_MB: every MB written or read
// takes that much longer) and see the check stop on its budget.
const slowMsPerMB = () => Number(process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB || 0) || 0;
const nap = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const io = {
  write: (fd, buf) => { nap((slowMsPerMB() * buf.length) / MB); return fs.writeSync(fd, buf, 0, buf.length); },
  sync: (fd) => (fs.fdatasyncSync || fs.fsyncSync)(fd),
  readSync: (fd, buf, at) => { const n = fs.readSync(fd, buf, 0, buf.length, at); nap((slowMsPerMB() * n) / MB); return n; },
  read: async (fh, buf, at) => {
    const { bytesRead } = await fh.read(buf, 0, buf.length, at);
    const ms = (slowMsPerMB() * bytesRead) / MB;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return bytesRead;
  },
};
// A line the parent keeps while the check runs: if the check is stopped on
// its deadline, what was measured so far still counts (run.js `progress`).
const emit = (o) => { if (require.main !== module) return; try { fs.writeSync(1, JSON.stringify({ progress: o }) + "\n"); } catch {} };
const hr = () => process.hrtime.bigint();
const secSince = (t) => Number(hr() - t) / 1e9;

// The test files a check leaves when it is killed mid-way (a speed check on a
// slow network drive past its deadline): `.aurora-<what>-<pid>-<hex>`.
const TEST_FILE = /^\.aurora-(speedtest|check)-(\d+)-[0-9a-f]+(\.renamed)?$/;
const alive = (pid) => {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
};
// Delete them in `dirs` (not recursive): those of a process that is gone (or
// in `pids`: the parent killed it), and any older than maxAgeMs.
const sweep = ({ dirs = [], pids = [], maxAgeMs = 10 * 60 * 1000 }) => {
  const removed = [];
  const now = Date.now();
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = TEST_FILE.exec(name);
      if (!m) continue;
      const abs = path.join(dir, name);
      const pid = Number(m[2]);
      let old = false;
      try { old = now - fs.statSync(abs).mtimeMs > maxAgeMs; } catch { continue; }
      if (!(pids.includes(pid) || !alive(pid) || old)) continue;
      try { fs.unlinkSync(abs); removed.push(abs); } catch {}
    }
  }
  return { removed };
};

// One reader, by dd with O_DIRECT (no page cache, no read-ahead), in pieces
// so it stops on its budget. On a network drive this is bound by round trips.
const directRead = (file, bytes, until) => {
  const PIECE = 16; // MB
  const total = Math.floor(bytes / MB);
  let mb = 0;
  let sec = 0;
  while (mb < total) {
    const left = until - Date.now();
    if (left <= 0) break;
    const count = Math.min(PIECE, total - mb);
    const r = spawnSync("dd", [`if=${file}`, "of=/dev/null", "bs=1M", `skip=${mb}`, `count=${count}`, "iflag=direct"], { encoding: "utf8", timeout: left + 2000 });
    const s = r.status === 0 ? ddSeconds(r.stderr) : null;
    if (s == null) break;
    sec += s;
    mb += count;
  }
  return { mb, MBps: mb && sec > 0 ? mb / sec : null, cut: mb > 0 && mb < total };
};
// One reader through the page cache (what a viewer's stream gets: the system
// reads ahead).
const bufferedRead = (file, bytes, until) => {
  const buf = Buffer.allocUnsafe(MB);
  const fd = fs.openSync(file, "r");
  let read = 0;
  const t = hr();
  try {
    while (read < bytes && Date.now() < until) { const n = io.readSync(fd, buf, read); if (!n) break; read += n; }
  } finally { fs.closeSync(fd); }
  const s = secSince(t);
  return { mb: read / MB, MBps: read && s > 0 ? read / MB / s : null, cut: read < bytes };
};
// N readers at once, each on its own part of the file with its own handle
// (its own read-ahead) — several people watching at the same time. The
// figure is all of them together.
const parallelRead = async (file, bytes, until, readers) => {
  const part = Math.floor(bytes / readers / MB) * MB;
  if (part < MB) return { mb: 0, MBps: null, cut: false };
  let total = 0;
  let cut = false;
  const t = hr();
  await Promise.all(Array.from({ length: readers }, async (_, i) => {
    const fh = await fs.promises.open(file, "r");
    const buf = Buffer.allocUnsafe(MB);
    let at = i * part;
    const end = at + part;
    try {
      while (at < end) {
        if (Date.now() >= until) { cut = true; break; }
        const n = await io.read(fh, buf, at);
        if (!n) break;
        at += n;
        total += n;
      }
    } finally { await fh.close(); }
  }));
  const s = secSince(t);
  return { mb: total / MB, MBps: total && s > 0 ? total / MB / s : null, cut };
};

// sizeMB    the most it writes (it stops earlier when its time is used)
// budgetMs  the time the whole check may take; each step has its share and
//           stops when that is used, keeping what it measured (`partial`, `cut`)
// network   a network drive: synced every 8 MB (a sync never waits on much)
const speed = async ({ dir, sizeMB = 256, budgetMs = 18000, network = false, readers = 4 }) => {
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  // (a share of the budget, at least a second, never past the end)
  const share = (f) => Date.now() + Math.max(1000, Math.min(budgetMs * f, left() - 1500));
  sweep({ dirs: [dir] }); // what an earlier check that was killed left here
  const file = testName(dir, "speedtest");
  const out = { sizeMB, network: !!network, partial: false, cut: [], readMethod: null };
  const cut = (step) => { out.partial = true; if (!out.cut.includes(step)) out.cut.push(step); };
  const syncEvery = (network ? 8 : 16) * MB;
  const chunk = crypto.randomBytes(4 * MB); // random: a compressing file system cannot cheat
  const dd = hasDd();
  try {
    // 1. sequential write, synced every few MB, so the time is what reached
    //    the drive (unsynced writes land in memory at once: a time check
    //    between them let the whole file through, then one long sync waited)
    let written = 0;
    let unsynced = 0;
    let lastEmit = 0;
    const until = share(0.35);
    const t0 = hr();
    const note = () => {
      const s = secSince(t0);
      out.writtenMB = Math.round(written / MB);
      out.writeMBps = written && s > 0 ? written / MB / s : null;
    };
    const fd = fs.openSync(file, "w");
    try {
      while (written < sizeMB * MB) {
        chunk.writeUInt32LE(written / MB, 0); // no two chunks alike (no dedupe)
        io.write(fd, chunk);
        written += chunk.length;
        unsynced += chunk.length;
        if (unsynced >= syncEvery) {
          io.sync(fd);
          unsynced = 0;
          note();
          if (Date.now() - lastEmit > 1000) { emit(out); lastEmit = Date.now(); }
        }
        if (Date.now() >= until && written < sizeMB * MB) { cut("write"); break; }
      }
      if (unsynced) io.sync(fd);
    } finally { fs.closeSync(fd); }
    note();
    emit(out);

    // 2. one reader, O_DIRECT (Linux): a detail
    if (dd) {
      dropCache(file);
      const r = directRead(file, written, share(0.15));
      if (r.MBps != null) {
        out.directMBps = r.MBps;
        if (r.cut) cut("direct read");
      }
      emit(out);
    }
    // 3. one reader through the page cache, its cache dropped first
    const dropped = dd && dropCache(file);
    const b = bufferedRead(file, written, share(0.15));
    out.bufferedMBps = b.MBps;
    out.bufferedMethod = dropped ? "cache dropped first (fadvise), the system reads ahead"
      : process.platform === "win32" ? "Windows: read right after writing — partly from memory, so this figure can be high"
        : "read right after writing — partly from memory, so this figure can be high";
    if (b.cut) cut("read");
    // the figure the local score has always used: the direct one where there is one
    out.readMBps = out.directMBps != null ? out.directMBps : out.bufferedMBps;
    out.readMethod = out.directMBps != null ? "direct (O_DIRECT, page cache bypassed)" : out.bufferedMethod;
    emit(out);
    // 4. several readers at once (a house watching together)
    if (dd) dropCache(file);
    const p = await parallelRead(file, written, share(0.15), readers);
    out.parallelMBps = p.MBps;
    out.parallelReaders = readers;
    if (p.cut) cut("readers at once");
    emit(out);

    // 5. small random reads (4 KB at random places: seeking about in a film)
    if (dd) dropCache(file);
    const small = Buffer.allocUnsafe(4096);
    const blocks = Math.max(1, Math.floor(written / 4096));
    const lat = [];
    const rfd = fs.openSync(file, "r");
    const rUntil = Date.now() + Math.min(4000, Math.max(1000, left() - 1000));
    try {
      while (lat.length < 400 && Date.now() < rUntil) {
        const at = Math.floor(Math.random() * blocks) * 4096;
        const t = hr();
        fs.readSync(rfd, small, 0, 4096, at);
        lat.push(Number(hr() - t) / 1e6);
      }
    } finally { fs.closeSync(rfd); }
    const total = lat.reduce((n, x) => n + x, 0);
    lat.sort((a, c) => a - c);
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
  sweep,
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
    const fail = (e) => ({ ok: false, error: `${(e && e.code) || ""} ${(e && e.message) || e}`.trim() });
    // (the answer is the LAST line: `speed` writes progress lines before it)
    const say = (res) => { try { fs.writeSync(1, JSON.stringify(res) + "\n"); } catch { process.stdout.write(JSON.stringify(res) + "\n"); } };
    Promise.resolve().then(() => {
      const fn = OPS[args.op];
      if (!fn) throw new Error(`unknown op ${args.op}`);
      return fn(args);
    }).then((result) => say({ ok: true, result }), (e) => say(fail(e)));
  }
}

module.exports = { OPS, ddSeconds, io, TEST_FILE };
