// Ask lib/drives/probe-child.js something about a drive, in its own process,
// with a deadline. The server never waits on a drive longer than `timeoutMs`:
// past it the answer is { timeout: true }, the child is killed, and — for a
// drive that may stay hung — no second child is started for the same drive
// while the first has not gone (a process stuck in a hung NFS call can take a
// while to die; piling them up would be the same leak in another place).
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "probe-child.js");
const outstanding = new Map(); // key -> { child, since }

const deps = {
  spawn: (args, env) => spawn(process.execPath, [SCRIPT, JSON.stringify(args)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env }),
};

const lastProgress = (out) => {
  const lines = String(out || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && o.progress) return o.progress; } catch {}
  }
  return null;
};

// -> Promise<{ ok, result } | { ok: false, error } | { ok: false, timeout: true, pid, progress } | { ok: false, busy: true }>
// low: the child gets the lowest CPU and I/O priority (moving a title must
// never slow a stream down; Linux: nice 19 + ionice idle class)
const lower = (pid) => {
  try { require("os").setPriority(pid, 19); } catch {}
  if (process.platform === "linux") { try { require("child_process").execFile("ionice", ["-c", "3", "-p", String(pid)], { timeout: 3000 }, () => {}); } catch {} }
};
const ask = (op, args = {}, { timeoutMs = 8000, key = null, env = process.env, low = false } = {}) =>
  new Promise((resolve) => {
    const k = key || null;
    if (k && outstanding.has(k)) {
      const o = outstanding.get(k);
      // the last one is still out: this drive is not answering (or still busy)
      return resolve({ ok: false, busy: true, timeout: !!o.timedOut, since: o.since });
    }
    let child;
    try { child = deps.spawn({ op, ...args }, env); } catch (e) {
      return resolve({ ok: false, error: `could not start the drive check: ${(e && e.message) || e}` });
    }
    if (low && child.pid) lower(child.pid);
    const rec = { child, since: Date.now(), timedOut: false };
    if (k) outstanding.set(k, rec);
    let out = "";
    let err = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      rec.timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
      // what the child measured before its deadline (a speed check writes
      // progress lines as it goes), and its pid (the test files it leaves
      // carry it: the caller sweeps them)
      finish({ ok: false, timeout: true, pid: child.pid, progress: lastProgress(out) });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => { out += c; if (out.length > 1e6) out = out.slice(-1e6); });
    child.stderr.on("data", (c) => { err += c; if (err.length > 1e5) err = err.slice(-1e5); });
    child.on("error", (e) => {
      if (k && outstanding.get(k) === rec) outstanding.delete(k);
      finish({ ok: false, error: (e && e.message) || String(e) });
    });
    child.on("close", () => {
      // only now may another child go to this drive
      if (k && outstanding.get(k) === rec) outstanding.delete(k);
      if (done) return;
      const line = out.trim().split(/\r?\n/).pop() || "";
      try { finish(JSON.parse(line)); } catch { finish({ ok: false, error: (err.trim().split(/\r?\n/).pop() || "the drive check gave no answer").slice(0, 300) }); }
    });
  });

// until the last child for `key` has gone (a killed one can take a moment)
const settled = async (key, ms = 10000) => {
  for (const end = Date.now() + ms; outstanding.has(key) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  return !outstanding.has(key);
};

module.exports = { ask, settled, deps, _internals: { outstanding, SCRIPT, lastProgress } };
