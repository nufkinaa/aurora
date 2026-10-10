#!/usr/bin/env node
// A frozen copy of the app at a commit, to measure against.
//
//   node tools/ttff/snapshot.js base            HEAD, as tools/ttff/.runs/trees/base
//   node tools/ttff/snapshot.js before d4d26cf  that commit
//   node tools/ttff/run.js --tree base --label baseline
//
// The harness (this folder) is always the working tree's; only the APP —
// server.js, src/, public/ and what the private instance needs to boot — comes
// from the snapshot. So "before" and "after" are measured by the same code,
// and a long run is not disturbed by edits made while it is going.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..", "..");
const TREES = path.join(__dirname, ".runs", "trees");
const PARTS = ["server.js", "src", "public", "scripts", "test/ui/support", "package.json", "CHANGELOG.md"];

const treeDir = (name) => path.join(TREES, name);

const make = (name, rev = "HEAD") => {
  const dir = treeDir(name);
  // (the link first, by rmdir: a recursive delete must never follow it)
  try { fs.rmdirSync(path.join(dir, "node_modules")); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(TREES, `${name}.tar`);
  const a = spawnSync("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, rev, ...PARTS], { encoding: "utf-8", windowsHide: true });
  if (a.status !== 0) throw new Error(`git archive ${rev} failed: ${a.stderr}`);
  const x = spawnSync("tar", ["-xf", tar, "-C", dir], { encoding: "utf-8", windowsHide: true });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  fs.rmSync(tar, { force: true });
  // the TV build is 45 MB the instance never serves in a test
  fs.rmSync(path.join(dir, "public", "aurora-tv.apk"), { force: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "junction");
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "--short", rev], { encoding: "utf-8" }).trim();
  fs.writeFileSync(path.join(dir, ".rev"), sha);
  return { dir, sha };
};

module.exports = { make, treeDir };

if (require.main === module) {
  const [name, rev] = process.argv.slice(2);
  if (!name) { console.log("usage: node tools/ttff/snapshot.js <name> [<git rev>]"); process.exit(1); }
  const { dir, sha } = make(name, rev || "HEAD");
  console.log(`${name}: ${sha} → ${dir}`);
}
