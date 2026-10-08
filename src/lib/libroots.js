// Are the library folders there? A drive that is unplugged, asleep or not
// mounted makes its folder unreadable — or, on Linux, an EMPTY mount point —
// and everything that asks "does this file still exist?" then hears "no".
// That is not the same as the file having been deleted, and nothing should be
// thrown away on the strength of it. This module is the one place that
// question is answered:
//
//   missing()        the configured library folders that cannot be read now
//   under(absPath)   is this path inside one of them?
//
// Callers that prune records for files that are "gone" (the finished
// downloads list, the intro timestamps) ask under() first and keep what they
// cannot see. The healer's "Library folders" check reports the folder itself.
// Cached for a few seconds: these are synchronous stats on a hot path.
"use strict";
const fs = require("fs");
const path = require("path");

const CACHE_MS = 15000;
let cache = { at: 0, list: [] };

const roots = () => {
  const config = require("../config");
  const out = [];
  for (const kind of ["movies", "shows"]) for (const dir of (config.LIBRARIES && config.LIBRARIES[kind]) || []) out.push({ kind, dir });
  return out;
};

const readable = (dir) => {
  try { return fs.statSync(dir).isDirectory() && (fs.readdirSync(dir), true); } catch { return false; }
};

const missing = (now = Date.now()) => {
  if (now - cache.at < CACHE_MS) return cache.list;
  cache = { at: now, list: roots().filter((r) => !readable(r.dir)) };
  return cache.list;
};

const norm = (p) => {
  const r = path.resolve(String(p || ""));
  return process.platform === "win32" ? r.toLowerCase() : r;
};
// PURE: is `abs` inside one of `dirs`?
const isUnder = (abs, dirs) => {
  const a = norm(abs);
  return dirs.some((d) => { const r = norm(d); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });
};
const under = (abs) => {
  const gone = missing();
  return gone.length > 0 && isUnder(abs, gone.map((r) => r.dir));
};

module.exports = { roots, missing, under, isUnder, readable, _reset: () => { cache = { at: 0, list: [] }; } };
