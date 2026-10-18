// A file's date, from the library walk when there is one (media/scanwalk.js),
// from the disk otherwise.
//
// The subtitle passes key what they know on file dates (media/sublang.js,
// media/subaudio.js: a result is "fresh" while the subtitle and the video
// have the dates it was made for), and the scanner asks them about every
// track while it builds the index — one or two blocking stats per track,
// thousands per rescan. While the scanner builds (or lists the background
// work right after), the dates come from the snapshot the walk just took:
//
//   within(lookup, fn)   run fn with `lookup(path)` answering first:
//                        { size, mtimeMs } | null (known not to exist) |
//                        undefined (the walk did not look: ask the disk)
//   mtimeMs(path)        the date, or null when the file is not there
//
// Outside within() every call is the statSync it always was.
"use strict";
const fs = require("fs");

let active = null;

const within = (lookup, fn) => {
  const before = active;
  active = typeof lookup === "function" ? lookup : null;
  try {
    return fn();
  } finally {
    active = before;
  }
};

const mtimeMs = (p) => {
  if (active) {
    const hit = active(p);
    if (hit !== undefined) return hit ? hit.mtimeMs : null;
  }
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

module.exports = { within, mtimeMs, active: () => !!active };
