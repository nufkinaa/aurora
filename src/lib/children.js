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

// END ONE NOW. A helper running at a lowered priority (cpuwork's viewer and
// background classes, jit's yield, remux, torrent transcodes) that is killed
// while the CPU is busy is not gone: Windows ends it only when it next gets
// the CPU, so it keeps its files open, its RAM and its encoder slot for
// seconds to minutes (measured 2026-10-20 on a loaded box: below-normal
// 5-29 s, idle 15-93 s; raised to normal first: 20 ms). So it is given the
// normal priority back just before the kill. Returns whether a kill was sent.
const killNow = (child, signal = "SIGKILL") => {
  if (!child) return false;
  // an encoder held for somebody's start (lib/startfirst.js: SIGSTOP) is let go
  // first, so whatever the signal it is acted on at once
  try { require("./startfirst").letGo(child); } catch {}
  try {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      const os = require("os");
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_NORMAL); } catch {}
    }
  } catch {}
  try { child.kill(signal); return true; } catch { return false; }
};

const killAll = (signal = "SIGKILL") => {
  let n = 0;
  for (const pid of [...pids.keys()]) {
    try { process.kill(pid, signal); n++; } catch {}
    pids.delete(pid);
  }
  for (const child of [...live.keys()]) {
    try {
      if (child.exitCode == null && child.signalCode == null) { killNow(child, signal); n++; }
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

module.exports = { track, trackPid, untrackPid, killNow, killAll, list, count };
