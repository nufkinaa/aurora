#!/usr/bin/env node
"use strict";
// Turns the tracer's logs (trace-preload.cjs) into test-map.json:
//   { version, node, nodeVersion, platform, fullAt, fullCommit, updatedAt, updatedCommit,
//     tests: { "test/x.test.js": { files, dirs, trees, contents, spawns, untracedChild? } } }
// files  = git-tracked repo files the test loaded, read, opened, stat'ed or copied;
// dirs   = tracked folders it listed (an added or removed file there can change it);
// trees  = tracked folders it listed recursively (same, any depth);
// contents = tracked folders it copied whole (fs.cp): any change under them counts;
// absent = paths it looked for that git does not have (yet), inside a tracked folder;
// spawns = non-node programs it ran (ffmpeg, where, ...), for the reader;
// ms     = how long the test file's process lived (for time estimates).
// Paths are repo-relative with forward slashes on every OS. Only git-tracked paths are
// kept: node_modules, temp folders and generated files can never be a "changed file".
//
// usage: node tools/ci/build-test-map.js --trace <dir> --out <map.json>
//          [--merge <old map.json>]   keep the old entries of tests that did not run
//          [--full]                   every test ran
//          [--passed]                 ...and passed: the traces replace the map
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const MAP_VERSION = 1;

function trackedFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean);
}

function readTraces(traceDir) {
  const byTest = new Map(); // test -> { r:Set, d:Set, D:Set, x:Set, w:bool }
  let names = [];
  try { names = fs.readdirSync(traceDir); } catch { return byTest; }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    let text;
    try { text = fs.readFileSync(path.join(traceDir, name), "utf8"); } catch { continue; }
    let owner = null;
    for (const line of text.split("\n")) {
      if (line.length < 3 || line[1] !== " ") continue;
      const kind = line[0];
      const val = line.slice(2).replace(/\r$/, "");
      if (kind === "t") { owner = val; continue; }
      if (!owner) continue;
      let e = byTest.get(owner);
      if (!e) byTest.set(owner, (e = { r: new Set(), d: new Set(), D: new Set(), c: new Set(), x: new Set(), w: false, ms: 0 }));
      if (kind === "w") e.w = true;
      else if (kind === "e") e.ms = Math.max(e.ms, Number(val) || 0);
      else if (e[kind]) e[kind].add(val);
    }
  }
  return byTest;
}

function makeNormaliser(root, tracked) {
  const win = process.platform === "win32";
  const fileSet = new Set(tracked);
  const dirSet = new Set(["."]);
  for (const f of tracked) {
    let i = f.lastIndexOf("/");
    while (i > 0) { const d = f.slice(0, i); if (dirSet.has(d)) break; dirSet.add(d); i = d.lastIndexOf("/"); }
  }
  // Windows paths are case-insensitive: match a traced spelling to the tracked one.
  const lower = new Map();
  if (win) { for (const f of fileSet) lower.set(f.toLowerCase(), f); for (const d of dirSet) lower.set(d.toLowerCase(), d); }
  const rel = (abs) => {
    let r = path.isAbsolute(abs) ? path.relative(root, abs) : abs;
    r = r.split(path.sep).join("/").replace(/\\/g, "/");
    if (r === "") r = ".";
    if (win && !fileSet.has(r) && !dirSet.has(r)) r = lower.get(r.toLowerCase()) || r;
    return r;
  };
  return { rel, isFile: (r) => fileSet.has(r), isDir: (r) => dirSet.has(r), fileSet };
}

function entriesFromTraces(byTest, norm) {
  const tests = {};
  for (const [owner, e] of byTest) {
    const test = norm.rel(owner);
    const files = new Set(), dirs = new Set(), trees = new Set();
    const contents = new Set(), absent = new Set();
    // A path the test looked for that git doesn't have, in a folder git does have: adding
    // it later (or anything under it) can change the test's answer.
    const probe = (r) => { if (!norm.isFile(r) && !norm.isDir(r) && r !== "." && !r.startsWith("..") && norm.isDir(r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ".")) absent.add(r); };
    for (const p of e.r) { const r = norm.rel(p); if (norm.isFile(r)) files.add(r); else probe(r); }
    for (const p of e.d) { const r = norm.rel(p); if (norm.isDir(r)) dirs.add(r); else probe(r); }
    for (const p of e.D) { const r = norm.rel(p); if (norm.isDir(r)) trees.add(r); else probe(r); }
    for (const p of e.c) { const r = norm.rel(p); if (norm.isFile(r)) files.add(r); else if (norm.isDir(r)) contents.add(r); else probe(r); }
    const entry = { files: [...files].sort(), dirs: [...dirs].sort(), trees: [...trees].sort(), contents: [...contents].sort(), absent: [...absent].sort(), spawns: [...e.x].sort() };
    if (e.ms) entry.ms = e.ms;
    if (e.w) entry.untracedChild = true;
    tests[test] = entry;
  }
  return tests;
}

function headCommit(root = ROOT) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
}

// A full run that passed is the whole truth: its traces replace the map. Anything else
// (a partial run, or a run where tests failed and may have stopped early) only ADDS to
// what the map knew, so a crash that read less can never make the map forget a file.
function unite(a, b) {
  if (!a) return b;
  const u = (k) => [...new Set([...(a[k] || []), ...(b[k] || [])])].sort();
  const e = { files: u("files"), dirs: u("dirs"), trees: u("trees"), contents: u("contents"), absent: u("absent"), spawns: u("spawns") };
  if (b.ms || a.ms) e.ms = b.ms || a.ms;
  if (a.untracedChild || b.untracedChild) e.untracedChild = true;
  return e;
}

function build({ traceDir, old = null, full = false, passed = false, root = ROOT, now = new Date(), tracked = trackedFiles(root), commit = headCommit(root), nodeMajor = Number(process.versions.node.split(".")[0]) }) {
  const norm = makeNormaliser(root, tracked);
  const fresh = entriesFromTraces(readTraces(traceDir), norm);
  const base = old && old.version === MAP_VERSION && old.node === nodeMajor ? old : null;
  const replace = full && passed;
  const tests = {};
  if (base && !replace) for (const [t, e] of Object.entries(base.tests || {})) if (norm.isFile(t)) tests[t] = e;
  for (const [t, e] of Object.entries(fresh)) tests[t] = replace ? e : unite(tests[t], e);
  const sorted = {};
  for (const t of Object.keys(tests).sort()) sorted[t] = tests[t];
  const fresher = full || !base;
  return {
    version: MAP_VERSION,
    node: nodeMajor,
    nodeVersion: process.versions.node,
    platform: process.platform,
    fullAt: fresher ? now.toISOString() : base.fullAt,
    fullCommit: fresher ? commit : base.fullCommit,
    updatedAt: now.toISOString(),
    updatedCommit: commit,
    traced: Object.keys(fresh).length,
    tests: sorted,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const traceDir = opt("--trace"), outFile = opt("--out"), mergeFile = opt("--merge");
  const full = args.includes("--full");
  const passed = args.includes("--passed");
  if (!traceDir || !outFile) { console.error("usage: build-test-map.js --trace <dir> --out <file> [--merge <old>] [--full] [--passed]"); process.exit(2); }
  let old = null;
  if (mergeFile) { try { old = JSON.parse(fs.readFileSync(mergeFile, "utf8")); } catch { old = null; } }
  if (!full && !old) { console.log("build-test-map: not a full run and no old map to add to: nothing written"); process.exit(0); }
  const map = build({ traceDir, old, full, passed });
  const n = Object.keys(map.tests).length;
  if (!map.traced) { console.log("build-test-map: no traces found: nothing written"); process.exit(0); }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(map, null, 1) + "\n");
  const untraced = Object.entries(map.tests).filter(([, e]) => e.untracedChild).map(([t]) => t);
  console.log(`test map: ${n} test files (${map.traced} traced in this run, ${full && passed ? "full run: replaced" : full ? "full run with failures: added to" : "added to the old map"}), node ${map.node}, written to ${outFile}`);
  if (untraced.length) console.log(`  tests that start a node child with its own env (its reads are not seen; what it copies is): ${untraced.join(", ")}`);
}

module.exports = { build, unite, readTraces, makeNormaliser, entriesFromTraces, trackedFiles, MAP_VERSION };
