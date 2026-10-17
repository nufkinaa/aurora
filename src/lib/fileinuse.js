// "Is somebody reading this file right now?" asked by PATH — what every
// deletion (the admin's buttons, smart cleanup, My List's auto-delete) asks
// before it removes a library file or folder. The answer comes from
// lib/inuse.js, which the stream routes stamp with the LIBRARY ID of every
// file whose bytes are requested (a player that is playing asks again every
// few seconds; a stamp younger than inuse.WINDOW_MS means "someone is on it").
// This module only turns a path (or a folder) into those ids.
//
// A file in use is never deleted: a manual delete is refused with
// MESSAGE (HTTP 409, code "streaming"), an automatic one is postponed to its
// next round. Pulling a file out from under a viewer ends their film
// mid-scene — and on Windows the delete fails half-way on the open handle.
const path = require("path");
const inuse = require("./inuse");

const MESSAGE = "Someone is playing this right now — try again when they have stopped.";
const FOLDER_MESSAGE = "Someone is playing a file in this folder right now — try again when they have stopped.";

// Paths compare the way the file system does: case-blind on Windows.
const norm = (p) => {
  const r = path.resolve(String(p || ""));
  return process.platform === "win32" ? r.toLowerCase() : r;
};

// The library ids stamped inside the window, each with its file's path.
// (The stamps are few: one per file played in the last minutes.)
const recentPaths = (t = Date.now()) => {
  const scanner = require("../media/scanner");
  const out = [];
  const seen = (inuse._internals && inuse._internals.seen) || new Map();
  for (const id of seen.keys()) {
    if (!inuse.streamingNow(id, t)) continue;
    const entry = scanner.resolve(id);
    if (entry && entry.path) out.push({ id, path: entry.path });
  }
  return out;
};

// Is the file at `abs` being read right now?
const fileInUse = (abs, t = Date.now()) => {
  if (!abs) return false;
  const scanner = require("../media/scanner");
  const id = scanner.idForPath(abs) || scanner.idForPath(path.resolve(abs));
  if (id && inuse.streamingNow(id, t)) return true;
  const want = norm(abs);
  return recentPaths(t).some((r) => norm(r.path) === want);
};

// Is any file inside the folder `dir` (at any depth) being read right now?
const folderInUse = (dir, t = Date.now()) => {
  if (!dir) return false;
  const base = norm(dir);
  return recentPaths(t).some((r) => {
    const rel = path.relative(base, norm(r.path));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
};

module.exports = { fileInUse, folderInUse, MESSAGE, FOLDER_MESSAGE };
