// "Is something working on this file right now?" — the one question every
// removal asks besides "is somebody playing it" (lib/fileinuse.js).
//
// A part of the server that moves, copies or rewrites library files (the
// drive mover in lib/drives, a remux, a copy being placed) says so here for
// as long as it works on them:
//
//   const done = busyfiles.mark(dirOrFile, "being moved to another drive");
//   … work …
//   done();
//
// or, when it already keeps its own record of what it is doing, registers a
// question once: busyfiles.register((abs) => reason | null).
//
// The admin's delete suggestions (media/untouched.js) never offer a file that
// is busy, and the deletes behind them refuse one. Memory only: a restart
// also ended whatever was working (the mover re-marks when it picks up).
"use strict";
const path = require("path");

const norm = (p) => {
  const r = path.resolve(String(p || ""));
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const inside = (abs, dir) => {
  if (abs === dir) return true;
  const rel = path.relative(dir, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const marks = new Map(); // token -> { path, why, at }
const providers = [];
let seq = 0;

// Mark a file or a folder (and everything in it) busy. Returns the release.
const mark = (p, why = "being worked on") => {
  if (!p) return () => {};
  const token = ++seq;
  marks.set(token, { path: norm(p), why: String(why).slice(0, 120), at: Date.now() });
  return () => { marks.delete(token); };
};

// A question asked on every check: (absPath) => a reason (string) or null.
const register = (fn) => {
  if (typeof fn === "function" && !providers.includes(fn)) providers.push(fn);
  return () => { const i = providers.indexOf(fn); if (i >= 0) providers.splice(i, 1); };
};

// Why this file is busy, or null.
const busyWhy = (abs) => {
  if (!abs) return null;
  const a = norm(abs);
  for (const m of marks.values()) if (inside(a, m.path)) return m.why;
  for (const fn of providers) {
    try { const r = fn(abs); if (r) return typeof r === "string" ? r : "being worked on"; } catch {}
  }
  return null;
};

module.exports = { mark, register, busyWhy, _internals: { marks, providers } };
