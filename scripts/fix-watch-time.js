#!/usr/bin/env node
// The one-off repair of watch time recorded before 2026-11-04 (src/lib/watchfix.js
// has the rules; docs/watch-time.md the story).
//
//   node scripts/fix-watch-time.js                 a DRY RUN on this server's data:
//                                                  says what would change, writes nothing
//   node scripts/fix-watch-time.js --file <path>   the same, on any copy of watch-sessions.json
//   node scripts/fix-watch-time.js --apply [--file <path>]
//                                                  backs the file up beside itself, then repairs it
//
// A running server repairs its own data ONCE at startup (data/watch-time-fix.json
// marks it done), so on a live server the usual way is simply a restart. Use
// --apply only on a copy, or with the server stopped: a running server writes
// its own copy of the list back over the file.
"use strict";
const fs = require("fs");
const path = require("path");
const watchfix = require("../src/lib/watchfix");

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const applyIt = args.includes("--apply");
let file = arg("--file");
if (!file) file = path.join(require("../src/config").DATA_DIR, "watch-sessions.json");
if (!fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(1); }

const sessions = JSON.parse(fs.readFileSync(file, "utf-8"));
if (!Array.isArray(sessions)) { console.error("Not a list of viewings."); process.exit(1); }
const p = watchfix.plan(sessions);
console.log(`${applyIt ? "Repairing" : "Dry run (nothing is written)"}: ${file}\n`);
console.log(watchfix.summary(sessions, p));
if (!applyIt) { console.log("\nRun again with --apply to write it (a backup is made first)."); process.exit(0); }
if (!p.changes.length) { console.log("\nNothing to change."); process.exit(0); }
const backup = `${file}.before-watch-fix-${watchfix.VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(file, backup);
watchfix.apply(sessions, p);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(sessions));
fs.renameSync(tmp, file);
console.log(`\nWritten. The file before is at ${backup}`);
