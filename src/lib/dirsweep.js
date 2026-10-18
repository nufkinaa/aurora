// Keeping a cache folder to a number of files — without holding the event
// loop. The picture-variant, artwork and speech-timeline caches used to be
// trimmed with readdirSync + a statSync per file: thousands of blocking calls
// in one go (a readdirSync of img-variants alone took 1.3 s on the loop under
// disk pressure — server round load test, 2026-10-18). Here every call is the
// asynchronous one, the stats go a few at a time, and one sweep of a folder
// runs at once.
//
//   trim(dir, { max, down = max, filter, onRemoved }) -> Promise<removed count>
//     When the folder holds more than `max` files (those `filter(name)`
//     accepts), the oldest by modification time go until `down` are left.
"use strict";
const fs = require("fs");
const path = require("path");

const running = new Map(); // dir -> Promise
const BATCH = 32;

const trim = (dir, { max, down = max, filter = null, onRemoved = null } = {}) => {
  if (running.has(dir)) return running.get(dir);
  const p = (async () => {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return 0; }
    if (filter) names = names.filter(filter);
    if (names.length <= max) return 0;
    const dated = [];
    for (let i = 0; i < names.length; i += BATCH) {
      const part = names.slice(i, i + BATCH);
      const stats = await Promise.all(part.map((n) => fs.promises.stat(path.join(dir, n)).then((st) => ({ n, m: st.mtimeMs, file: st.isFile() }), () => null)));
      for (const s of stats) if (s && s.file) dated.push(s);
    }
    if (dated.length <= max) return 0;
    dated.sort((a, b) => a.m - b.m);
    const victims = dated.slice(0, dated.length - Math.max(0, down));
    let removed = 0;
    for (let i = 0; i < victims.length; i += BATCH) {
      await Promise.all(victims.slice(i, i + BATCH).map((v) => fs.promises.unlink(path.join(dir, v.n)).then(() => {
        removed++;
        if (onRemoved) { try { onRemoved(path.join(dir, v.n)); } catch {} }
      }, () => {})));
    }
    return removed;
  })().finally(() => running.delete(dir));
  running.set(dir, p);
  return p;
};

module.exports = { trim };
