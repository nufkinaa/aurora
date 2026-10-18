#!/usr/bin/env node
// STORE WRITES ON DIFFERENT DISKS (server round 2026-10-18, STORAGE).
//
//   node tools/backend-perf/store-disk.js --dir <folder>[,<folder>…] [--rounds 40] [--hog] [--label x]
//   -> docs/qa/backend-efficiency/results/store-disk[-label].json and a table
//
// For each folder (an NVMe, a spinning disk, a network share, a Linux ext4,
// WSL's /mnt/c …) the same store writes are made both ways:
//   sync    lib/jsonstore.js atomicWriteSync — what every save cost the event
//           loop before (temp file, write, fsync, rename, folder fsync)
//   async   lib/jsonstore.js FileWriter.write — what it costs now: the loop's
//           delay is measured (monitorEventLoopDelay) while the writes run
// at two sizes (a 64 KB store, a 4 MB one — a grown profiles.json). With
// --hog a second process writes 16 MB + fsync flat out into the same folder
// (a busy disk: a download landing, a backup, another program).
// Each folder is also checked for what the stores rely on: rename over an
// existing file, the content read back whole, a folder fsync (Linux).
// Scratch files only, in <folder>/aurora-store-disk-<pid>, removed after.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { REPO, round, saveJson, arg, table } = require("./lib");
const js = require(path.join(REPO, "src", "lib", "jsonstore"));

const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const text = (bytes) => JSON.stringify({ v: 1, pad: "x".repeat(Math.max(0, bytes - 20)) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOG = `
const fs = require("fs"), path = require("path");
const dir = process.argv[1]; const buf = Buffer.alloc(16 * 1024 * 1024, 7);
let i = 0;
for (;;) { const f = path.join(dir, "hog-" + (i++ % 4)); const fd = fs.openSync(f, "w"); fs.writeSync(fd, buf); fs.fsyncSync(fd); fs.closeSync(fd); }
`;

const probeFs = (dir) => {
  const out = { renameOver: null, readBack: null, dirFsync: null };
  const a = path.join(dir, "probe-a.json");
  const b = path.join(dir, "probe-b.json");
  try {
    fs.writeFileSync(a, "old");
    fs.writeFileSync(b, JSON.stringify({ ok: true }));
    fs.renameSync(b, a);
    out.renameOver = true;
    out.readBack = JSON.parse(fs.readFileSync(a, "utf8")).ok === true;
  } catch (e) { out.renameOver = `failed: ${e.code || e.message}`; }
  if (process.platform !== "win32") {
    let fd = null;
    try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); out.dirFsync = true; } catch (e) { out.dirFsync = `not supported (${e.code}) — the stores carry on without it`; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  } else out.dirFsync = "n/a on Windows";
  return out;
};

const runSync = (dir, size, rounds) => {
  const file = path.join(dir, `sync-${size}.json`);
  const t = text(size);
  const ms = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    js.atomicWriteSync(file, t);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { loopBlockedMsP50: round(pct(ms, 50), 2), loopBlockedMsP99: round(pct(ms, 99), 2), loopBlockedMsMax: round(Math.max(...ms), 2), loopBlockedMsTotal: round(ms.reduce((a, b) => a + b, 0), 1) };
};

// How long the loop was held, measured by a chain of setImmediate: the gap
// between two turns is time the loop could not run anything else. (A timer-
// based delay monitor reads ~15 ms on an idle Windows loop — the timer
// resolution, not blocking — so it is not used here.)
const blockMeter = () => {
  let last = process.hrtime.bigint();
  let max = 0, over5 = 0, over20 = 0, on = true;
  const gaps = [];
  const tick = () => {
    if (!on) return;
    const now = process.hrtime.bigint();
    const g = Number(now - last) / 1e6;
    last = now;
    if (g > max) max = g;
    if (g > 5) over5++;
    if (g > 20) over20++;
    if (g > 1) gaps.push(g);
    setImmediate(tick);
  };
  setImmediate(tick);
  return () => { on = false; return { maxMs: round(max, 2), gapsOver5ms: over5, gapsOver20ms: over20, p99OfGapsOver1msMs: round(pct(gaps, 99) || 0, 2) }; };
};

const runAsync = async (dir, size, rounds) => {
  const w = new js.FileWriter(path.join(dir, `async-${size}.json`));
  const t = text(size);
  const stop = blockMeter();
  const done = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    await w.write(t);
    done.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const held = stop();
  const back = JSON.parse(fs.readFileSync(w.file, "utf8"));
  return { writeMsP50: round(pct(done, 50), 1), writeMsP99: round(pct(done, 99), 1), loopHeldMaxMs: held.maxMs, loopHeldOver5ms: held.gapsOver5ms, whole: back.v === 1 };
};

(async () => {
  const dirs = String(arg("dir", "")).split(",").filter(Boolean);
  if (!dirs.length) { console.error("--dir <folder>[,<folder>…]"); process.exit(2); }
  const rounds = +arg("rounds", 40);
  const hogOn = !!arg("hog");
  const out = { at: new Date().toISOString(), node: process.version, platform: process.platform, rounds, hog: hogOn, dirs: [] };
  const rows = [];
  for (const base of dirs) {
    const dir = path.join(base, `aurora-store-disk-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    let hog = null;
    try {
      const fsCheck = probeFs(dir);
      if (hogOn) { hog = spawn(process.execPath, ["-e", HOG, dir], { stdio: "ignore", windowsHide: true }); await sleep(1500); }
      const r = { dir: base, fs: fsCheck, sizes: {} };
      for (const [label, size] of [["64KB", 64 * 1024], ["4MB", 4 * 1024 * 1024]]) {
        const n = size > 1e6 ? Math.max(8, Math.round(rounds / 4)) : rounds;
        const s = runSync(dir, size, n);
        const a = await runAsync(dir, size, n);
        r.sizes[label] = { sync: s, async: a };
        rows.push({ dir: base, size: label, syncP50: s.loopBlockedMsP50, syncP99: s.loopBlockedMsP99, syncMax: s.loopBlockedMsMax, asyncWriteP50: a.writeMsP50, asyncHeldMax: a.loopHeldMaxMs, asyncOver5: a.loopHeldOver5ms, whole: a.whole });
      }
      out.dirs.push(r);
    } finally {
      if (hog) { try { hog.kill("SIGKILL"); } catch {} await sleep(500); }
      for (let i = 0; i < 20; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(250); } }
    }
  }
  console.log(`\nnode ${process.version} ${process.platform}${hogOn ? ", disk hog on" : ""}\n`);
  console.log(table(rows, [["folder", "dir"], ["size", "size"], ["sync: loop blocked p50 ms", "syncP50"], ["sync: p99 ms", "syncP99"], ["sync: max ms", "syncMax"], ["async: write p50 ms", "asyncWriteP50"], ["async: loop held max ms", "asyncHeldMax"], ["async: turns held > 5 ms", "asyncOver5"], ["read back whole", "whole"]]));
  for (const d of out.dirs) console.log(`${d.dir}: rename over a file ${d.fs.renameOver}, read back ${d.fs.readBack}, folder fsync ${d.fs.dirFsync}`);
  const label = arg("label") && arg("label") !== true ? `-${arg("label")}` : "";
  const f = saveJson(`store-disk${label}.json`, out);
  console.log(`\n${path.relative(process.cwd(), f)}`);
})().catch((e) => { console.error(e); process.exit(1); });
