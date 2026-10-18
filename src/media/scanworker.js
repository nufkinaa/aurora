// The library walk (media/scanwalk.js) on a thread of its own, so the
// ten-minute rescan reads the disk while the event loop goes on serving.
// One long-lived worker (it keeps the last snapshot, for the folder-date
// skipping); it never keeps the process alive (unref).
//
//   const w = require("./scanworker");
//   const snap = await w.walk({ movies, shows, statExts, skipUnchanged })
//
// The previous snapshot stays IN the worker: nothing is copied back and forth
// but the request and the new snapshot. Should the worker fail to start or
// die, the walk is done on the calling thread instead (the same answer,
// only blocking) and a new worker is tried next time.
"use strict";
const { Worker, isMainThread, parentPort } = require("worker_threads");

if (!isMainThread && parentPort) {
  // ---- inside the worker
  const scanwalk = require("./scanwalk");
  let prev = null;
  parentPort.on("message", (msg) => {
    if (!msg || msg.type !== "walk") return;
    try {
      if (msg.reset) prev = null;
      const snap = scanwalk.walk({ ...msg.opts, prev });
      prev = snap;
      parentPort.postMessage({ id: msg.id, snap });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, error: (e && e.message) || String(e) });
    }
  });
} else {
  // ---- the server's side
  let worker = null;
  let seq = 0;
  const waiting = new Map(); // id -> { resolve, reject }
  const stats = { walks: 0, fallbacks: 0, restarts: 0 };

  const failAll = (err) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  const ensure = () => {
    if (worker) return worker;
    // (no inherited -r preloads or flags: the walk needs none of them, and a
    // preload written for the server must not start a second time in here)
    const w = new Worker(__filename, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.on("message", (m) => {
      const p = m && waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (!waiting.size) w.unref();
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.snap);
    });
    w.on("error", (e) => { if (worker === w) worker = null; failAll(e); });
    w.on("exit", (code) => { if (worker === w) worker = null; if (waiting.size) failAll(new Error(`scan worker exited (${code})`)); });
    // (after the listeners: attaching a "message" listener refs the port again)
    w.unref();
    worker = w;
    stats.restarts++;
    return w;
  };

  // -> Promise<snapshot>. `reset`: forget the worker's previous snapshot
  // (the next walk reads everything).
  const walk = (opts, { reset = false } = {}) => {
    stats.walks++;
    let w;
    try { w = ensure(); } catch (e) { return fallback(opts, e); }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.ref(); // held while a walk is out (a script with nothing else to do waits for it)
      try {
        w.postMessage({ type: "walk", id, opts, reset });
      } catch (e) {
        waiting.delete(id);
        reject(e);
      }
    }).catch((e) => fallback(opts, e));
  };
  const fallback = (opts, err) => {
    stats.fallbacks++;
    if (stats.fallbacks === 1 || stats.fallbacks % 50 === 0) console.warn(`[scan] the walk ran on the main thread (${(err && err.message) || err})`);
    return require("./scanwalk").walk({ ...opts, skipUnchanged: false });
  };
  const stop = async () => {
    const w = worker;
    worker = null;
    if (w) await w.terminate().catch(() => {});
  };

  module.exports = { walk, stop, stats: () => ({ ...stats, alive: !!worker }) };
}
