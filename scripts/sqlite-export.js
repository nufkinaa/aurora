#!/usr/bin/env node
// Every store kept in SQLite (src/lib/sqlitestore.js), written back as the
// JSON file it was before the switch — the way back to an older Aurora.
//
//   node scripts/sqlite-export.js                  into the data folder, for a downgrade.
//                                                  Aurora must be STOPPED (it refuses otherwise).
//   node scripts/sqlite-export.js --out <folder>   into another folder: a copy to look at or keep,
//                                                  safe while Aurora runs
//   node scripts/sqlite-export.js --data <folder>  a data folder other than this install's
//   --dry-run                                      only say what would be written
//
// GOING BACK TO AN OLDER VERSION:
//   1. stop Aurora
//   2. node scripts/sqlite-export.js
//   3. check out / install the older version and start it: it reads the JSON
//      files as it always did (data/aurora.db is left where it is; it does
//      not look at it)
// Coming forward again later imports those JSON files into SQLite again (a
// JSON file newer than the database is the truth — sqlitestore.js).
//
// Nothing is deleted. A store whose JSON file is already newer than its rows
// is left alone (it is the truth already). Each file is written atomically
// and read back before it is counted. Exit code 1 when anything failed.
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes("--dry-run");

const main = () => {
  const sqlitestore = require("../src/lib/sqlitestore");
  const { atomicWriteSync, foreignOwnerOf } = require("../src/lib/jsonstore");
  const dataDir = path.resolve(opt("--data") || require("../src/config").DATA_DIR);
  const outDir = opt("--out") ? path.resolve(opt("--out")) : dataDir;
  const dbFile = path.join(dataDir, sqlitestore.DB_NAME);
  if (!fs.existsSync(dbFile)) { console.log(`No ${sqlitestore.DB_NAME} in ${dataDir}: every store is a JSON file already. Nothing to do.`); return 0; }
  if (!sqlitestore.loadEngine()) { console.error(`node:sqlite is not available in this Node (${process.versions.node}); run this with Node 22.13 or newer.`); return 1; }
  if (outDir === dataDir) {
    const owner = foreignOwnerOf(path.join(dataDir, "x"));
    if (owner) { console.error(`Aurora is running (pid ${owner}) and owns ${dataDir}. Stop it first — or use --out <folder> for a copy.`); return 1; }
  }
  const stores = sqlitestore.exportFromFile(dbFile);
  const names = Object.keys(stores).sort();
  if (!names.length) { console.log("The database holds no stores. Nothing to do."); return 0; }
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  let written = 0;
  for (const name of names) {
    const s = stores[name];
    const target = path.join(outDir, name);
    if (outDir === dataDir && fs.existsSync(target) && fs.statSync(target).mtimeMs > s.updatedAt) {
      console.log(`  ${name.padEnd(24)} left alone: its JSON file is newer than its rows (it is the truth already)`);
      continue;
    }
    if (dryRun) { console.log(`  ${name.padEnd(24)} would be written: ${s.rows} rows, ${s.text.length} bytes`); continue; }
    try {
      atomicWriteSync(target, s.text);
      const back = fs.readFileSync(target, "utf8");
      if (back !== s.text) throw new Error("it did not read back as written");
      JSON.parse(back);
      written++;
      console.log(`  ${name.padEnd(24)} written: ${s.rows} rows, ${s.text.length} bytes`);
    } catch (e) {
      failed++;
      console.error(`  ${name.padEnd(24)} FAILED: ${(e && e.message) || e}`);
    }
  }
  if (!dryRun) console.log(`${written} of ${names.length} stores written to ${outDir}${failed ? `, ${failed} FAILED` : ""}.${outDir === dataDir && !failed ? " An older Aurora can be started now." : ""}`);
  return failed ? 1 : 0;
};

if (require.main === module) {
  let code = 1;
  try { code = main(); } catch (e) { console.error(`sqlite-export: ${(e && e.message) || e}`); code = 1; }
  process.exitCode = code;
}

module.exports = { main };
