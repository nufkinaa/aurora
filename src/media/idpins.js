// A library id that stays with a TITLE when its file is replaced.
//
// A library id is a pure function of the file's path (scanner.js makeId), and
// everything a person has — watch progress, My List, ratings, Up Next, the
// page they have bookmarked, a copy saved offline on a phone — is filed under
// it. "Get another version" (media/replace.js) swaps a bad copy for a new
// file, and the new file usually has another path: another container
// ("Film.mkv" for "Film.mp4"). So the new file is PINNED to the old id:
//
//   data/idpins.json   { "<new file's path>": { id: "<old id>", from: "<old file's path>", at } }
//
// and the scanner registers that path under that id instead of its own.
// Everything the server keeps ABOUT the file's bytes is keyed by the id and
// the file's date together (the jit tables, the HLS and offline copies, the
// stills, the probes) or by its path, so none of it carries the old copy's
// answers over: the new file is a new mtime.
//
// A pin is used only while the file it replaced is NOT on disk (an old copy
// that comes back takes its own id back, and the pin waits), and it is
// dropped once its own file is gone from a folder the walk could read (an
// unplugged drive is not a deleted file).
"use strict";
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "idpins.json"), {});
const MAX = 5000;

// Paths compare the way the file system does: case-blind on Windows.
const norm = (p) => {
  const r = path.resolve(String(p || ""));
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const data = () => (store.data && typeof store.data === "object" && !Array.isArray(store.data) ? store.data : (store.data = {}));

const pin = (newPath, id, fromPath, now = Date.now()) => {
  if (!newPath || !id) return;
  const d = data();
  // one pin per id: a title replaced twice keeps one line, the newest file
  for (const [k, v] of Object.entries(d)) if (v && v.id === id) delete d[k];
  // (the paths themselves are kept as given: the walk's lookups are exact)
  d[norm(newPath)] = { id: String(id), path: String(newPath), from: fromPath ? String(fromPath) : null, at: now };
  const keys = Object.keys(d);
  if (keys.length > MAX) {
    keys.sort((a, b) => (d[a].at || 0) - (d[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX)) delete d[k];
  }
  store.save();
};

// No pin for this id any more (its file is back on its own path).
const unpinId = (id) => {
  const d = data();
  let n = 0;
  for (const [k, v] of Object.entries(d)) if (v && v.id === id) { delete d[k]; n++; }
  if (n) store.save();
  return n > 0;
};

// The pins in force for one walk, as a Map(normalised path → id). `lookup`
// is the walk's own view of a path (scanner.js snapLookup: a stat, null when
// the folder was read and the file is not in it, undefined when the walk did
// not look). A pin whose own file is gone is dropped here — never in its
// first hour: a walk that set out before the swap still sees the old file
// and not the new one, and must not take the pin away.
const SETTLE_MS = 60 * 60 * 1000;
const active = (lookup, now = Date.now()) => {
  const d = data();
  const out = new Map();
  let dropped = false;
  for (const [k, v] of Object.entries(d)) {
    if (!v || !v.id || !v.path) { delete d[k]; dropped = true; continue; }
    const own = lookup ? lookup(v.path) : undefined;
    if (own === null && now - (v.at || 0) > SETTLE_MS) { delete d[k]; dropped = true; continue; }
    if (v.from && lookup && lookup(v.from)) continue; // the old copy is back: it keeps its id
    out.set(k, v.id);
  }
  if (dropped) store.save();
  return out;
};

const rev = () => store.rev;
const list = () => ({ ...data() });

module.exports = { pin, unpinId, active, rev, list, norm, _internals: { store } };
