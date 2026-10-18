// Removing a stream's job folder without stopping the server.
//
// A transcode's folder holds hundreds to thousands of segment files, and
// fs.rmSync of one ran on the event loop: measured by the load test
// (2026-10-18) at 12.8 s for one data/cache/hls job — every viewer, page and
// segment on the server waited that long. Now:
//   1. the folder is RENAMED out of the way at once (one metadata operation —
//      the name is free again immediately, so a new job can start there);
//   2. the renamed folder is deleted in the background, one at a time, by a
//      worker thread of its own (its rmSync blocks that thread only). Measured
//      for a 1,500-file, 1.5 GB job folder on this PC: fs.rmSync held the
//      loop 2.6–2.7 s; fs.promises.rm (per-file callbacks on the loop) left
//      it 16–420 ms worst-case; the worker 17–23 ms — the PC's own timer
//      noise. If a worker cannot be had, fs.promises.rm is used.
// If the rename is refused (Windows: a process that was just killed still
// has a file open), the RENAME is retried a few times — the folder is only
// ever deleted under its new name, so a new job that has meanwhile made a
// folder of the same name is never touched (the folder's file id is checked).
// Folders named "<x>.del-<tag>" are this queue's; a boot sweep that finds one
// left by a previous run deletes it (isLeftover).
"use strict";
const fs = require("fs");

const queue = [];
let running = false;
let removed = 0;
let failed = 0;

// The deleting thread: started on first use, does not keep the process up.
let worker = null;
let workerBroken = false;
const WORKER_SRC = `const { parentPort } = require("worker_threads");
const fs = require("fs");
parentPort.on("message", (p) => {
  let ok = true;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { ok = false; }
  parentPort.postMessage(ok);
});`;
const viaWorker = (p) => new Promise((resolve, reject) => {
  if (!worker) {
    const { Worker } = require("worker_threads");
    worker = new Worker(WORKER_SRC, { eval: true });
    worker.unref();
    worker.on("error", () => { workerBroken = true; worker = null; });
    worker.on("exit", () => { worker = null; });
  }
  const w = worker;
  const onExit = () => reject(new Error("remover stopped"));
  w.once("exit", onExit);
  w.once("message", (ok) => { w.off("exit", onExit); ok ? resolve() : reject(new Error("rm failed")); });
  w.postMessage(p);
});
const rm = (p) => (workerBroken ? fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) : viaWorker(p).catch((e) => {
  if (workerBroken) return fs.promises.rm(p, { recursive: true, force: true });
  throw e;
}));

const pump = async () => {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (job.orig) {
        // the rename was refused: try it again — and only ever delete what
        // was renamed, never a folder a new job may have made at that name
        const aside = renameAway(job.orig, job.ino);
        if (aside === false) {
          if (++job.tries < 6) setTimeout(() => { queue.push(job); pump(); }, 1000 * job.tries).unref?.();
          else failed++;
          continue;
        }
        if (aside === null) continue; // gone, or another folder by now
        job.path = aside;
        job.orig = null;
        job.tries = 0;
      }
      try {
        await rm(job.path);
        removed++;
      } catch {
        if (++job.tries < 4) setTimeout(() => { queue.push(job); pump(); }, 1000 * job.tries).unref?.();
        else failed++;
      }
    }
  } finally {
    running = false;
  }
};

let seq = 0;
// → the new name; null when there is nothing (or another folder) there;
// false when the OS refused the rename
const renameAway = (dir, ino = null) => {
  if (ino != null) {
    try { if (fs.statSync(dir).ino !== ino) return null; } catch { return null; }
  }
  const aside = `${dir}.del-${Date.now().toString(36)}${(seq++).toString(36)}`;
  try {
    fs.renameSync(dir, aside);
    return aside;
  } catch (e) {
    return e && e.code === "ENOENT" ? null : false;
  }
};
// Remove `dir` (recursively). Returns at once; the deleting happens later.
const removeDir = (dir) => {
  let ino = null;
  try { ino = fs.statSync(dir).ino; } catch { return; }
  const aside = renameAway(dir);
  if (aside === null) return;
  if (aside === false) queue.push({ orig: dir, ino, tries: 0 });
  else queue.push({ path: aside, tries: 0 });
  pump();
};

const isLeftover = (name) => /\.del-[0-9a-z]+$/.test(name);
// Resolves once everything queued so far is gone (tests, shutdown).
const drain = async () => {
  while (queue.length || running) await new Promise((r) => setTimeout(r, 20));
};
const stats = () => ({ queued: queue.length, running, removed, failed });

module.exports = { removeDir, isLeftover, drain, stats };
