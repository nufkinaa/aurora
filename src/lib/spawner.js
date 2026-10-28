// Starting helper processes without holding the event loop.
//
// Starting a process is a blocking call: on Windows CreateProcess (and the
// antivirus looking at the new process) took 50–90 ms each on a loaded
// two-core box, and a Home page seen for the first time makes a picture
// variant per poster — 9–13 s of a three-minute window in which nobody else
// was answered (server round 2026-10-18, tools/backend-perf/loopload.js
// --profile; docs/qa/server-round/EVENTLOOP.md). Here the process is started
// from a worker thread: the blocking part happens there, and the server
// hears back when the process has ended.
//
//   run(file, args, { timeoutMs, input, maxBuffer, name }) -> Promise<{ code, signal, stdout, stderr, timedOut }>
//     stdout: a Buffer (at most maxBuffer, default 8 MB); stderr: its last 4 KB as text
//     input:  a Buffer written to the process's stdin (then closed)
//     It never rejects for the process's own failure: look at code / error.
//
// The processes are the server's like any other: their pids are handed to
// lib/children.js, which ends them if the server's process ends. Where the
// worker cannot be had, the process is started here, as before.
"use strict";
const { Worker, isMainThread, parentPort } = require("worker_threads");
const { spawn } = require("child_process");

const runHere = (file, args, opts, onSpawn) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, signal: null, stdout: Buffer.alloc(0), stderr: String((e && e.message) || e), timedOut: false, error: String((e && e.message) || e) });
    }
    // opts.lower: below normal priority — pictures and other decoration, which
    // must not take the CPU from the segment somebody is waiting to see
    // (measured on a 2-CPU box: a title page's still frame and its picture
    // variants beside the first segment of the film being pressed on)
    if (opts.lower && child.pid) { try { require("os").setPriority(child.pid, require("os").constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
    if (onSpawn) { try { onSpawn(child); } catch {} }
    const out = [];
    let outBytes = 0;
    let err = "";
    let timedOut = false;
    const max = opts.maxBuffer || 8 * 1024 * 1024;
    child.stdout.on("data", (d) => { if (outBytes < max) { out.push(d); outBytes += d.length; } });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs) : null;
    let done = false;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: err, timedOut, ...(error ? { error } : {}) });
    };
    child.on("error", (e) => finish(-1, null, String((e && e.message) || e)));
    child.on("close", (code, signal) => finish(code, signal));
    if (opts.input) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });

if (!isMainThread && parentPort) {
  // ---- inside the worker: start what is asked, say its pid, report the end
  parentPort.on("message", async (m) => {
    if (!m || m.type !== "run") return;
    const r = await runHere(m.file, m.args, m.opts || {}, (child) => parentPort.postMessage({ type: "spawned", id: m.id, pid: child.pid }));
    const transfer = r.stdout && r.stdout.length ? [r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length)] : [];
    parentPort.postMessage({ type: "done", id: m.id, r: { ...r, stdout: transfer[0] || null } }, transfer);
  });
} else {
  // ---- the server's side
  const lazy = require("./lazy");
  const childrenLib = lazy(require, "./children");
  let worker = null;
  let seq = 0;
  const waiting = new Map(); // id -> { resolve, name, pid }
  const stats = { started: 0, inWorker: 0, here: 0, restarts: 0 };

  const ensure = () => {
    if (worker) return worker;
    const w = new Worker(__filename, { execArgv: [] });
    w.on("message", (m) => {
      const job = m && waiting.get(m.id);
      if (!job) return;
      if (m.type === "spawned") {
        job.pid = m.pid;
        try { childrenLib().trackPid(m.pid, job.name); } catch {}
        return;
      }
      if (m.type !== "done") return;
      waiting.delete(m.id);
      if (job.pid) { try { childrenLib().untrackPid(job.pid); } catch {} }
      if (!waiting.size) w.unref();
      const r = m.r || {};
      job.resolve({ ...r, stdout: r.stdout ? Buffer.from(r.stdout) : Buffer.alloc(0) });
    });
    const fail = (why) => {
      if (worker === w) worker = null;
      // what was out is started again here: a picture is never lost to a worker
      for (const [id, job] of [...waiting]) {
        waiting.delete(id);
        if (job.pid) { try { childrenLib().untrackPid(job.pid); } catch {} }
        runHere(job.file, job.args, job.opts, (c) => { try { childrenLib().track(c, job.name); } catch {} }).then(job.resolve);
      }
      if (why) console.warn(`[spawner] the worker stopped (${why}); helpers start on the main thread until it is back`);
    };
    w.on("error", (e) => fail((e && e.message) || String(e)));
    w.on("exit", (code) => fail(code ? `exit ${code}` : null));
    w.unref();
    worker = w;
    stats.restarts++;
    return w;
  };

  const run = (file, args, opts = {}) => {
    stats.started++;
    const name = opts.name || "helper";
    let w = null;
    try { w = ensure(); } catch { w = null; }
    if (!w) {
      stats.here++;
      return runHere(file, args, opts, (c) => { try { childrenLib().track(c, name); } catch {} });
    }
    stats.inWorker++;
    const id = ++seq;
    const { input, ...rest } = opts;
    return new Promise((resolve) => {
      waiting.set(id, { resolve, name, pid: null, file, args, opts });
      w.ref();
      try {
        w.postMessage({ type: "run", id, file, args, opts: { ...rest, ...(input ? { input } : {}) } });
      } catch {
        waiting.delete(id);
        stats.here++;
        runHere(file, args, opts, (c) => { try { childrenLib().track(c, name); } catch {} }).then(resolve);
      }
    });
  };

  module.exports = { run, stats: () => ({ ...stats, waiting: waiting.size, alive: !!worker }), _internals: { runHere } };
}
