#!/usr/bin/env node
// Another version of the site, to measure beside this one.
//
//   node tools/mobile-perf/snapshot.js <git ref>        -> prints the folder
//
// Unpacks the commit into tools/mobile-perf/.cache/snap/<short sha>/ (git
// archive: tracked files only, no .git) and links this checkout's
// node_modules into it. Then:
//
//   node tools/mobile-perf/instance.js --repo <that folder> --state .cache/before.json
//   node tools/mobile-perf/lighthouse.js --instance .cache/before.json --label before
//
// runs that commit's server and website under this harness — the "before" in
// every before/after of the report, measured in the same hour on the same
// machine as the "after".
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ref = process.argv[2];
if (!ref) { console.error("usage: node snapshot.js <git ref>"); process.exit(1); }
const repo = path.join(__dirname, "..", "..");
const sha = execFileSync("git", ["rev-parse", "--short=10", ref], { cwd: repo, encoding: "utf-8" }).trim();
const dir = path.join(__dirname, ".cache", "snap", sha);
if (!fs.existsSync(path.join(dir, "server.js"))) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, "..", `${sha}.tar`);
  execFileSync("git", ["archive", "--format=tar", "-o", tar, sha, "server.js", "package.json", "CHANGELOG.md", "src", "public", "scripts", "test/ui/support"], { cwd: repo });
  // (relative names: GNU tar reads "C:\…" as a host name)
  const r = spawnSync("tar", ["-xf", `${sha}.tar`, "-C", sha], { stdio: "inherit", cwd: path.join(dir, "..") });
  if (r.status !== 0) throw new Error("tar failed");
  fs.rmSync(tar, { force: true });
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "junction");
  // the generated test library is shared, not rebuilt
  fs.mkdirSync(path.join(dir, "test", "ui"), { recursive: true });
  if (fs.existsSync(path.join(repo, "test", "ui", ".cache"))) fs.symlinkSync(path.join(repo, "test", "ui", ".cache"), path.join(dir, "test", "ui", ".cache"), "junction");
}
console.log(dir);
