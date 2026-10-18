// What the library folders hold: every folder listing and the size and date
// of every file the index is made from — read in ONE pass, as plain data.
//
// The scanner (media/scanner.js) used to ask the disk itself while it built
// the index: a readdirSync per folder and a statSync per video, and the
// subtitle passes a statSync per subtitle and per video on top (about 7,000
// blocking calls for a library of 1,800 files, a 0.55 s freeze every ten
// minutes on a two-core box — docs/qa/backend-efficiency). This file does
// only the reading. It runs in a worker thread for the ten-minute rescan
// (media/scanworker.js), so the event loop keeps serving while the disk is
// read, and on the main thread for a scan somebody waits for (after a
// download landed, a delete). The scanner then builds the index from the
// snapshot without a single filesystem call.
//
//   walk({ movies, shows, statExts, prev, skipUnchanged }) -> snapshot
//     movies, shows   the library roots
//     statExts        the file extensions whose size and date are kept
//                     (videos, extras, subtitles: what the index and the
//                     subtitle passes look at)
//     prev            the previous snapshot (for skipUnchanged)
//     skipUnchanged   FOLDER DATES: a folder whose date has not moved since
//                     prev and that lists exactly the same entries keeps its
//                     files' sizes and dates from prev — one stat for the
//                     folder instead of one per file (adding, removing or
//                     renaming an entry moves a folder's date on NTFS and on
//                     Linux file systems; the listing itself is always read,
//                     so a file system that does not date folders, FAT, still
//                     shows a new file at once). What it cannot see is a file
//                     rewritten IN PLACE under the same name: the scanner
//                     therefore makes every few walks a full one.
//
//   snapshot = {
//     dirs:  { [folder]: [[name, kind], …] }    kind 1 folder, 2 file, 0 other
//     dirAt: { [folder]: mtimeMs }               (folders it could read)
//     files: { [file]: [size, mtimeMs] }         (statExts only)
//     hash:  a digest of all of the above        (equal = nothing on disk changed)
//     calls: { readdir, stat }                   what the walk asked the disk
//     reused: folders taken from prev
//   }
// Which folders are read is exactly what the scanner reads: each root; under
// a movies root every folder one level down (hidden ones skipped); under a
// shows root every folder, at any depth, of each show folder.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = 1;
const FILE = 2;

// dateFolders: false — no stat of the folders themselves (a walk on the
// main thread, which keeps no previous walk to compare dates with)
const walk = ({ movies = [], shows = [], statExts = [], prev = null, skipUnchanged = false, dateFolders = true } = {}) => {
  const exts = new Set(statExts.map((e) => String(e).toLowerCase()));
  const dirs = Object.create(null);
  const dirAt = Object.create(null);
  const files = Object.create(null);
  const calls = { readdir: 0, stat: 0 };
  let reused = 0;
  const usable = skipUnchanged && prev && prev.dirs && prev.dirAt && prev.files;

  const statFile = (abs) => {
    calls.stat++;
    try {
      const st = fs.statSync(abs);
      files[abs] = [st.size, st.mtimeMs];
    } catch {}
  };
  // one folder: its listing, and the size and date of the files in it —
  // taken from prev when the folder's date has not moved AND it lists the
  // same entries (the listing is always read: a file system that does not
  // date its folders, FAT, still shows a new file at once)
  const read = (dir) => {
    if (dirs[dir]) return dirs[dir];
    let entries;
    calls.readdir++;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      dirs[dir] = [];
      return dirs[dir];
    }
    const list = entries.map((e) => [e.name, e.isDirectory() ? DIR : e.isFile() ? FILE : 0]);
    dirs[dir] = list;
    let at = null;
    if (dateFolders || usable) {
      calls.stat++;
      try { at = fs.statSync(dir).mtimeMs; } catch { at = null; }
    }
    if (at != null) dirAt[dir] = at;
    const before = usable && at != null && prev.dirAt[dir] === at ? prev.dirs[dir] : null;
    const same = !!before && sameList(before, list);
    if (same) reused++;
    for (const [name, kind] of list) {
      if (kind !== FILE || !exts.has(path.extname(name).toLowerCase())) continue;
      const abs = path.join(dir, name);
      const known = same ? prev.files[abs] : null;
      if (known) files[abs] = known;
      else statFile(abs);
    }
    return list;
  };
  const deep = (dir) => {
    for (const [name, kind] of read(dir)) if (kind === DIR) deep(path.join(dir, name));
  };

  for (const root of movies) {
    for (const [name, kind] of read(root)) {
      if (kind !== DIR || name.startsWith(".")) continue;
      read(path.join(root, name));
    }
  }
  for (const root of shows) {
    for (const [name, kind] of read(root)) {
      if (kind !== DIR || name.startsWith(".")) continue;
      deep(path.join(root, name));
    }
  }
  return { dirs, dirAt, files, exts: [...exts], hash: digest(dirs, files), calls, reused };
};

const sameList = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
};

// Equal digests: the same folders with the same entries and the same files
// with the same sizes and dates. (Folder dates are left out: a folder whose
// date moved but whose entries did not changes nothing the index shows.)
const digest = (dirs, files) => {
  const h = crypto.createHash("sha1");
  for (const dir of Object.keys(dirs).sort()) {
    h.update(dir);
    h.update("\u0000");
    for (const [name, kind] of dirs[dir]) {
      h.update(name);
      h.update(kind === DIR ? "\u0001" : kind === FILE ? "\u0002" : "\u0003");
    }
  }
  for (const file of Object.keys(files).sort()) {
    const [size, at] = files[file];
    h.update(`${file}\u0000${size}\u0000${at}\u0004`);
  }
  return h.digest("hex");
};

module.exports = { walk, digest, DIR, FILE };
