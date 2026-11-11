#!/usr/bin/env node
// Turn the children-mode migration back (docs/children-mode.md).
//
// The server, on its first start with children mode, turned every kids
// profile into an account with children mode on (src/profiles.js
// migrateChildMode) and copied profiles.json aside first, as
// data/profiles.pre-children-mode-<ms>.json. This script is for ROLLING THE
// SERVER BACK to a version from before children mode: it gives each account
// the migration changed its old `kids: { maxAge }` back — at the age it has
// NOW, if children mode is still on there (it is never made less strict) —
// and takes away the passcode the migration copied from the household PIN.
// An account a grown-up has taken out of children mode since stays out.
// Nothing else in profiles.json is touched (watch history since is kept).
//
//   node scripts/children-mode-undo.js            (dry run: says what it would do)
//   node scripts/children-mode-undo.js --write    (does it)
//   ... --data <folder>                           (another data folder)
//
// STOP THE SERVER FIRST. A server of THIS version started afterwards runs
// the migration again (that is the point of it) — roll the code back, then
// run this. The whole-file way back is the backup itself: copy
// data/profiles.pre-children-mode-<ms>.json over data/profiles.json (with
// the server stopped; whatever changed since the migration is lost then).
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const write = args.includes("--write");
const dataAt = args.indexOf("--data");
const dir = dataAt >= 0 ? path.resolve(args[dataAt + 1] || ".") : path.join(__dirname, "..", "data");
const file = path.join(dir, "profiles.json");

const undo = (data, now = Date.now()) => {
  const runs = data && data.migrations && Array.isArray(data.migrations.childMode) ? data.migrations.childMode : [];
  const ids = new Set();
  for (const r of runs) for (const p of r.profiles || []) ids.add(p.id);
  const said = [];
  for (const p of data.profiles || []) {
    if (!ids.has(p.id)) continue;
    if (p.childMode && typeof p.childMode.maxAge === "number") {
      p.kids = { maxAge: p.childMode.maxAge };
      said.push(`${p.name || p.id}: kids profile again, ${p.childMode.maxAge}+`);
    } else {
      said.push(`${p.name || p.id}: left as it is (Children mode was turned off since)`);
    }
    delete p.childMode;
    if (p.childPass && p.childPass.from === "household-pin") delete p.childPass;
  }
  if (runs.length) {
    data.migrations.childModeUndone = [...(data.migrations.childModeUndone || []), { at: now, runs }];
    delete data.migrations.childMode;
  }
  return said;
};

if (require.main === module) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    console.error(`Can't read ${file}: ${e.message}`);
    process.exit(1);
  }
  const said = undo(data);
  if (!said.length) { console.log("Nothing to undo: no children-mode migration is recorded in", file); process.exit(0); }
  for (const s of said) console.log(" -", s);
  if (!write) { console.log("(dry run — add --write to change", file + ")"); process.exit(0); }
  const tmp = file + ".undo-tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
  console.log("Written:", file);
}

module.exports = { undo };
