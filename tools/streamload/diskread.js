#!/usr/bin/env node
// How fast N films can be read at once from one disk, by chunk size: the
// read pattern of direct play (fs.createReadStream, one stream per viewer),
// without the server in the way. Each reader starts at a random offset
// (cold, most likely not in the OS cache) and reads flat out for --secs.
//
//   node tools/streamload/diskread.js --dir <folder of films> --n 5 --hwm 65536 --secs 15
//
// Prints one JSON line: total MB/s, per-reader MB/s (min / median), reads.
// READ-ONLY: files are opened "r", nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = arg("dir");
const n = parseInt(arg("n", "5"), 10);
const hwm = parseInt(arg("hwm", "65536"), 10);
const secs = parseFloat(arg("secs", "15"));
const limit = parseInt(arg("limit", "0"), 10); // >0: src/lib/diskread.js with that many reads per disk at once
const seed = parseInt(arg("seed", String(Date.now() % 100000)), 10);

let s = seed;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

const films = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mkv|mp4)$/i.test(e.name)) films.push({ p, size: fs.statSync(p).size });
  }
};
walk(dir);
if (!films.length) throw new Error("no films");

// Regions already read (any run): kept in a file so a later run picks bytes
// the OS cache has most likely never seen (--state, default none).
const stateFile = arg("state", null);
const MAX_BYTES = parseInt(arg("max", String(400 * 1024 * 1024)), 10);
let read = {};
try { if (stateFile) read = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
const pick = () => {
  for (let tries = 0; tries < 500; tries++) {
    const f = films[Math.floor(rand() * films.length)];
    const start = Math.floor((rand() * Math.max(0, f.size - MAX_BYTES)) / 1048576) * 1048576;
    const end = start + MAX_BYTES;
    const seen = read[f.p] || [];
    if (seen.some(([a, b]) => start < b && end > a)) continue;
    if (picked.some((x) => x.f === f && start < x.end && end > x.start)) continue;
    const x = { f, start, end };
    picked.push(x);
    return x;
  }
  throw new Error("no unread region left");
};
const picked = [];
const readers = [];
const until = Date.now() + secs * 1000;
const run = (i) => new Promise((resolve) => {
  const { f, start } = pick();
  const r = { bytes: 0, reads: 0, f, start };
  readers.push(r);
  const st = limit > 0
    ? require("../../src/lib/diskread").createReadStream(f.p, { start, highWaterMark: hwm, limit })
    : fs.createReadStream(f.p, { start, highWaterMark: hwm });
  st.on("data", (b) => {
    r.bytes += b.length;
    r.reads++;
    if (Date.now() > until || r.bytes >= MAX_BYTES) st.destroy();
  });
  st.on("close", resolve);
  st.on("error", resolve);
});

const t0 = Date.now();
Promise.all(Array.from({ length: n }, (_, i) => run(i))).then(() => {
  const el = (Date.now() - t0) / 1000;
  if (stateFile) {
    for (const r of readers) (read[r.f.p] = read[r.f.p] || []).push([r.start, r.start + r.bytes]);
    fs.writeFileSync(stateFile, JSON.stringify(read));
  }
  const per = readers.map((r) => r.bytes / 1e6 / el).sort((a, b) => a - b);
  const total = per.reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({
    n, hwm, secs: +el.toFixed(1), seed,
    totalMBs: +total.toFixed(1),
    minMBs: +per[0].toFixed(2),
    medMBs: +per[Math.floor(per.length / 2)].toFixed(2),
    reads: readers.reduce((a, r) => a + r.reads, 0),
  }));
});
