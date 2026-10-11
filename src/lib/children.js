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

const killAll = (signal = "SIGKILL") => {
  let n = 0;
  for (const child of [...live.keys()]) {
    try {
      if (child.exitCode == null && child.signalCode == null) { child.kill(signal); n++; }
    } catch {}
    live.delete(child);
  }
  return n;
};

const list = () => [...live.entries()].map(([c, m]) => ({ pid: c.pid, name: m.name, since: m.since }));
const count = () => live.size;

module.exports = { track, killAll, list, count };
