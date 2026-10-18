#!/usr/bin/env node
// MIGRATION DRILL for the watch journal (server round 2026-10-18, STORAGE;
// docs/qa/server-round/STORAGE.md), on a COPY of a real data folder.
//
//   node tools/backend-perf/storage-drill.js --data <data dir to copy> [--old 4862136] [--rounds 5]
//   -> docs/qa/backend-efficiency/results/storage-drill.json
//
// The data folder is only READ (copied into EFF_WORK; cache/, backups/,
// aria2/ and logs are left out — backups hold config.json and .env). Every
// server here is a private instance (instance.js: own folder, own port,
// outbound network refused). Progress is driven INSIDE the instance
// (inproc/watch-ticks.js) on one profile — the test profile, --pid.
//
//   1. KILL -9 ROUNDS (this build): play, kill at a random moment, boot again:
//      no recovery, no safe mode, the household whole, the resume point not
//      behind the last seek that had time to reach the disk, never beyond
//      the last save.
//   2. DOWNGRADE AFTER A HARD KILL: this build plays item A and is killed;
//      the OLD build (--old) boots on the folder: the household whole (it
//      reads profiles.json, A as of the last checkpoint at most); it plays
//      item B, writes, stops; THIS build boots again: the journal is merged
//      (newest wins) — A and B are both there.
//   3. DOWNGRADE AFTER A GRACEFUL STOP: this build plays, flushes as a
//      shutdown does; the old build sees the very last save.
const fs = require("fs");
const path = require("path");
const { start } = require("./instance");
const { REPO, WORK, saveJson, arg, sleep } = require("./lib");
const ui = require(path.join(REPO, "scripts", "ui-test-server"));

const SRC = arg("data");
const OLD = arg("old", "4862136");
const ROUNDS = +arg("rounds", 5);
const PID = arg("pid", "242da3b05797");
if (!SRC || SRC === true || !fs.existsSync(path.join(SRC, "profiles.json"))) { console.error("--data <a data folder with profiles.json>"); process.exit(2); }

const SKIP = /^(cache|backups|aria2|usage)$|\.log(\.\d+)?$|\.bak-|\.corrupt-|\.tmp$/i;
const copyData = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.test(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) fs.cpSync(a, b, { recursive: true });
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
};

const lib = path.join(WORK, "drill-library");
for (const d of ["movies", "shows"]) fs.mkdirSync(path.join(lib, d), { recursive: true });
const ds = (seedDir) => ({ seedDir, library: { movies: path.join(lib, "movies"), shows: path.join(lib, "shows") }, sessions: [{ sid: "none", profileId: PID }] });
const INPROC = path.join(__dirname, "inproc");

// one server on `seedDir` (copied into its own root); returns { srv, data }
const boot = async (seedDir, ref) => {
  const srv = await start({ ds: ds(seedDir), ref, mode: "open", keepRoot: true, config: { scanIntervalMinutes: 24 * 60 } });
  return srv;
};
const household = (srv, item) => srv.exec(path.join(INPROC, "household.js"), { pid: PID, item });
const ticks = (srv, a) => srv.exec(path.join(INPROC, "watch-ticks.js"), a);
const killHard = async (srv) => { await srv.stop(); }; // taskkill /T /F — TerminateProcess, no shutdown runs
const handOver = (srv) => {
  const next = fs.mkdtempSync(path.join(WORK, "drill-data-"));
  fs.rmSync(next, { recursive: true, force: true });
  copyData(path.join(srv.root, "data"), next);
  try { ui.removeRoot(srv.root); } catch (e) { console.warn(`could not remove ${srv.root}: ${e.message}`); }
  return next;
};

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };

(async () => {
  const out = { at: new Date().toISOString(), source: "a copy of the live data folder (read only)", old: OLD, rounds: [], downgradeHard: null, downgradeGraceful: null, checks };
  let seed = fs.mkdtempSync(path.join(WORK, "drill-data-"));
  copyData(SRC, seed);
  // the household before anything ran: as the OLD build reads it
  let srv = await boot(seed, OLD);
  const base = await household(srv);
  out.base = { profiles: base.profiles, rows: base.rows };
  console.log(`household: ${base.profiles} profiles, ${base.rows} history rows`);
  await killHard(srv);
  seed = handOver(srv);

  // 1. kill -9 rounds
  for (let r = 0; r < ROUNDS; r++) {
    srv = await boot(seed);
    const h = await household(srv, "drill|film");
    if (r > 0) {
      const prev = out.rounds[r - 1];
      check(`round ${r}: boots clean after the kill`, h.recoveries === 0 && !h.safeMode.length, { recoveries: h.recoveries, safeMode: h.safeMode, journal: h.journal });
      check(`round ${r}: the household is whole`, h.profiles === base.profiles && h.rows >= base.rows, { profiles: h.profiles, rows: h.rows });
      const pos = h.item ? h.item.position : null;
      const floor = prev.lastUrgentAt && prev.killedAt - prev.lastUrgentAt > 2500 ? prev.lastUrgent : 0;
      check(`round ${r}: resume point ${pos} within [${floor}, ${prev.last}]`, pos != null && pos >= floor && pos <= prev.last, { pos, floor, last: prev.last, lostSec: pos != null ? prev.last - pos : null });
    }
    await ticks(srv, { op: "start", pid: PID, item: "drill|film", from: 100 + r * 10000, everyMs: 200, seekEvery: 25 });
    await sleep(4000 + Math.random() * 8000);
    // the ticks stop (nothing is written by that) and the kill follows at once
    const st = await ticks(srv, { op: "stop" });
    const killedAt = Date.now();
    await killHard(srv);
    out.rounds.push({ ...st, killedAt });
    seed = handOver(srv);
  }
  {
    srv = await boot(seed);
    const h = await household(srv, "drill|film");
    const prev = out.rounds[out.rounds.length - 1];
    check(`after the last round: boots clean`, h.recoveries === 0 && !h.safeMode.length, { recoveries: h.recoveries, journal: h.journal });
    const floor = prev.lastUrgentAt && prev.killedAt - prev.lastUrgentAt > 2500 ? prev.lastUrgent : 0;
    check(`after the last round: resume point within [${floor}, ${prev.last}]`, h.item && h.item.position >= floor && h.item.position <= prev.last, { pos: h.item && h.item.position });
    await killHard(srv);
    seed = handOver(srv);
  }

  // 2. downgrade after a hard kill, then upgrade again
  {
    srv = await boot(seed);
    await ticks(srv, { op: "start", pid: PID, item: "drill|journal-only", from: 300, everyMs: 200, seekEvery: 1000 });
    await sleep(5000);
    const a = await ticks(srv, { op: "stop" });
    await sleep(2500); // the first save (urgent) is on disk; the rest waits for the minute
    await killHard(srv);
    seed = handOver(srv);

    srv = await boot(seed, OLD);
    const o = await household(srv, "drill|journal-only");
    check("old build after a hard kill: boots clean", o.recoveries === 0 && !o.safeMode.length, { recoveries: o.recoveries, safeMode: o.safeMode });
    check("old build after a hard kill: the household is whole", o.profiles === base.profiles && o.rows >= base.rows, { profiles: o.profiles, rows: o.rows });
    out.downgradeHard = { newBuildLast: a.last, oldBuildSees: o.item ? o.item.position : null };
    console.log(`  the old build sees ${o.item ? `position ${o.item.position}` : "no row"} for the item the new build last saved at ${a.last} (a hard kill: the journal is not read by it)`);
    await ticks(srv, { op: "start", pid: PID, item: "drill|old-build", from: 5000, everyMs: 200, seekEvery: 1000 });
    await sleep(3000);
    const b = await ticks(srv, { op: "stop" });
    await srv.exec(path.join(INPROC, "flush-all.js"));
    await killHard(srv);
    seed = handOver(srv);

    srv = await boot(seed);
    const n = await household(srv, "drill|journal-only");
    const nb = await household(srv, "drill|old-build");
    check("upgrade again: boots clean, the journal merged", n.recoveries === 0 && n.journal && n.journal.boot && n.journal.boot.mode === "merge", n.journal);
    check("upgrade again: the row only the journal had is back", n.item && n.item.position >= 300 && n.item.position <= a.last, { pos: n.item && n.item.position, last: a.last });
    check("upgrade again: the row the old build wrote is there", nb.item && nb.item.position === b.last, { pos: nb.item && nb.item.position, last: b.last });
    check("upgrade again: the household is whole", n.profiles === base.profiles && n.rows >= base.rows + 2, { profiles: n.profiles, rows: n.rows });
    out.downgradeHard.afterUpgrade = { journalOnly: n.item && n.item.position, oldBuild: nb.item && nb.item.position, journal: n.journal };
    await killHard(srv);
    seed = handOver(srv);
  }

  // 3. downgrade after a graceful stop
  {
    srv = await boot(seed);
    await ticks(srv, { op: "start", pid: PID, item: "drill|graceful", from: 700, everyMs: 200, seekEvery: 1000 });
    await sleep(4000);
    const a = await ticks(srv, { op: "stop" });
    await srv.exec(path.join(INPROC, "flush-all.js"));
    await killHard(srv);
    seed = handOver(srv);
    srv = await boot(seed, OLD);
    const o = await household(srv, "drill|graceful");
    check("old build after a graceful stop: sees the very last save", o.item && o.item.position === a.last, { pos: o.item && o.item.position, last: a.last });
    check("old build after a graceful stop: the household is whole", o.profiles === base.profiles && o.rows >= base.rows, { profiles: o.profiles, rows: o.rows });
    out.downgradeGraceful = { last: a.last, oldBuildSees: o.item && o.item.position };
    await killHard(srv);
    seed = handOver(srv);
  }
  try { fs.rmSync(seed, { recursive: true, force: true }); } catch {}
  const failed = checks.filter((c) => !c.ok).length;
  out.passed = checks.length - failed;
  out.failed = failed;
  const f = saveJson(`storage-drill${arg("label") && arg("label") !== true ? `-${arg("label")}` : ""}.json`, out);
  console.log(`\n${checks.length - failed} of ${checks.length} checks passed — ${path.relative(process.cwd(), f)}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
