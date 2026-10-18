// The long-lived helper processes the server owns (ffmpeg producers, the
// play-ready copy, OCR), in one place — so a shutdown can stop them all.
// Windows has no process groups: a child there outlives its parent unless the
// parent ends it, and an encoder left behind keeps its CPU and its files.
//
//   track(child, "jit")   remember it until it exits (returns the child)
//   killAll()             end every one that is still alive; returns how many
//   list()                [{ pid, name, since }] for whoever wants to look
"use strict";

const live = new Map(); // child -> { name, since }

const track = (child, name = "child") => {
  if (!child || typeof child.once !== "function") return child;
  live.set(child, { name, since: Date.now() });
  const gone = () => live.delete(child);
  child.once("exit", gone);
  child.once("error", gone);
  return child;
};

// Helpers started by another thread (lib/spawner.js) are known by pid only.
const pids = new Map(); // pid -> { name, since }
const trackPid = (pid, name = "child") => { if (pid) pids.set(pid, { name, since: Date.now() }); };
const untrackPid = (pid) => { pids.delete(pid); };

const killAll = (signal = "SIGKILL") => {
  let n = 0;
  for (const pid of [...pids.keys()]) {
    try { process.kill(pid, signal); n++; } catch {}
    pids.delete(pid);
  }
  for (const child of [...live.keys()]) {
    try {
      if (child.exitCode == null && child.signalCode == null) { child.kill(signal); n++; }
    } catch {}
    live.delete(child);
  }
  return n;
};

const list = () => [...live.entries()].map(([c, m]) => ({ pid: c.pid, name: m.name, since: m.since })).concat([...pids.entries()].map(([pid, m]) => ({ pid, name: m.name, since: m.since })));

// However the process ends — a crash past every handler, process.exit() from
// anywhere, the keeper's kill — the helpers it started go with it. On Windows
// nothing else ends them: an ffmpeg left behind kept decoding a film for
// nobody (server round, 2026-10-18). ("exit" handlers must be synchronous:
// child.kill is.)
let hooked = false;
const hookExit = () => {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { try { killAll("SIGKILL"); } catch {} });
};
hookExit();
const count = () => live.size + pids.size;

module.exports = { track, trackPid, untrackPid, killAll, list, count };
