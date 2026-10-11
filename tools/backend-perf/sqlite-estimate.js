#!/usr/bin/env node
// WHAT SQLITE WOULD BUY for the store that is rewritten while people watch.
// Nothing is migrated: this takes the SAME household data as dataset.js
// (profiles.json), does one viewer-hour of progress saves both ways, and
// reports CPU, event-loop time and bytes written.
//
//   node tools/backend-perf/sqlite-estimate.js [--weak] [--rows 1500|today]
//   -> docs/qa/backend-efficiency/results/sqlite-estimate[-today][-weak].json
//
//   JSON, as today   every save: JSON.stringify(whole store) + writeFileSync(.tmp) + renameSync
//                    (lib/jsonstore.js _writeNow), one save per 1.5 s while a viewer posts
//                    progress every 5 s = 720 saves a viewer-hour
//   SQLite (WAL)     every progress POST: one transaction of two upserts (the played row and the
//                    title row), journal_mode=WAL, synchronous=NORMAL — 720 transactions
//
// SQLite here is Node's built-in `node:sqlite` (Node 22.5+; experimental in
// 22.x). better-sqlite3 is the same engine behind a native module; its speed
// for this is the same order. Run with --weak to pin to two cores.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WEAK, pin, round, saveJson, arg, table } = require("./lib");
const dataset = require("./dataset");

(async () => {
  const weak = !!arg("weak");
  if (weak) pin(process.pid, WEAK.mask);
  const today = arg("rows") === "today";
  const ds = today ? dataset.build({ rows: 40, profiles: 5 }) : dataset.build();
  const store = JSON.parse(fs.readFileSync(path.join(ds.seedDir, "profiles.json"), "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-sqlite-est-"));
  const SAVES = 720;
  const cpuOf = (fn) => { const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint(); const r = fn(); const c = process.cpuUsage(c0); return { r, cpuMs: (c.user + c.system) / 1000, wallMs: Number(process.hrtime.bigint() - t0) / 1e6 }; };
  const profile = store.profiles[0].id;
  const items = Object.keys(store.state[profile].progress);

  // ---- JSON, exactly as lib/jsonstore.js writes it
  const file = path.join(dir, "profiles.json");
  let bytesJson = 0, longest = 0;
  const json = cpuOf(() => {
    for (let i = 0; i < SAVES; i++) {
      const row = store.state[profile].progress[items[i % 5]];
      row.position = 600 + i * 5; row.updatedAt = Date.now();
      const t0 = process.hrtime.bigint();
      const text = JSON.stringify(store);
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
      longest = Math.max(longest, Number(process.hrtime.bigint() - t0) / 1e6);
      bytesJson += Buffer.byteLength(text);
    }
  });
  const jsonLoad = cpuOf(() => JSON.parse(fs.readFileSync(file, "utf8")));

  // ---- SQLite
  let sqlite;
  try { sqlite = require("node:sqlite"); } catch { sqlite = null; }
  let out = { at: new Date().toISOString(), weak, household: today ? "today (5 profiles, about 40 rows each)" : "grown (8 profiles, up to 1,500 rows)", storeBytes: fs.statSync(file).size, savesPerViewerHour: SAVES,
    json: { cpuMsPerSave: round(json.cpuMs / SAVES, 3), loopMsPerSave: round(json.wallMs / SAVES, 3), longestSaveMs: round(longest, 1), mbWrittenPerViewerHour: round(bytesJson / 1048576, 1), loopBlockedSecPerViewerHour: round(json.wallMs / 1000, 2), loadMs: round(jsonLoad.wallMs, 1) } };
  if (sqlite) {
    const dbFile = path.join(dir, "aurora.db");
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec("CREATE TABLE progress (profile TEXT NOT NULL, item TEXT NOT NULL, position INTEGER, duration INTEGER, finished INTEGER, updatedAt INTEGER, plays INTEGER, PRIMARY KEY (profile, item)) WITHOUT ROWID;");
    db.exec("CREATE TABLE titles (profile TEXT NOT NULL, key TEXT NOT NULL, position INTEGER, duration INTEGER, finished INTEGER, updatedAt INTEGER, item TEXT, PRIMARY KEY (profile, key)) WITHOUT ROWID;");
    db.exec("CREATE TABLE stream_items (profile TEXT NOT NULL, item TEXT NOT NULL, meta TEXT, PRIMARY KEY (profile, item)) WITHOUT ROWID;");
    const insP = db.prepare("INSERT INTO progress VALUES (?,?,?,?,?,?,?) ON CONFLICT(profile, item) DO UPDATE SET position=excluded.position, duration=excluded.duration, finished=excluded.finished, updatedAt=excluded.updatedAt");
    const insT = db.prepare("INSERT INTO titles VALUES (?,?,?,?,?,?,?) ON CONFLICT(profile, key) DO UPDATE SET position=excluded.position, duration=excluded.duration, finished=excluded.finished, updatedAt=excluded.updatedAt, item=excluded.item");
    const insS = db.prepare("INSERT OR REPLACE INTO stream_items VALUES (?,?,?)");
    const imp = cpuOf(() => {
      db.exec("BEGIN");
      for (const [pid, s] of Object.entries(store.state)) {
        for (const [item, r] of Object.entries(s.progress || {})) insP.run(pid, item, r.position, r.duration, r.finished ? 1 : 0, r.updatedAt, r.plays || 0);
        for (const [key, r] of Object.entries(s.titles || {})) insT.run(pid, key, r.position, r.duration, r.finished ? 1 : 0, r.updatedAt, r.itemId || null);
        for (const [item, meta] of Object.entries(s.streamItems || {})) insS.run(pid, item, JSON.stringify(meta));
      }
      db.exec("COMMIT");
    });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const size0 = fs.statSync(dbFile).size;
    let walPeak = 0, longestTx = 0;
    const sq = cpuOf(() => {
      for (let i = 0; i < SAVES; i++) {
        const t0 = process.hrtime.bigint();
        db.exec("BEGIN");
        insP.run(profile, items[i % 5], 600 + i * 5, 6000, 0, Date.now(), 0);
        insT.run(profile, `tt1${String(i % 5).padStart(6, "0")}`, 600 + i * 5, 6000, 0, Date.now(), items[i % 5]);
        db.exec("COMMIT");
        longestTx = Math.max(longestTx, Number(process.hrtime.bigint() - t0) / 1e6);
        try { walPeak = Math.max(walPeak, fs.statSync(`${dbFile}-wal`).size); } catch {}
      }
    });
    // bytes: every committed transaction appends its changed pages to the WAL (frames of page size + 24 B)
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const walBytes = (() => { try { return fs.statSync(`${dbFile}-wal`).size; } catch { return 0; } })();
    const sel = db.prepare("SELECT item, position, duration, finished, updatedAt FROM progress WHERE profile = ?");
    const read = cpuOf(() => { for (let i = 0; i < 50; i++) sel.all(profile); });
    db.close();
    out.sqlite = { engine: `node:sqlite (SQLite ${process.versions.sqlite || "?"})`, dbBytes: size0, pageSize, importMs: round(imp.wallMs, 0),
      cpuMsPerSave: round(sq.cpuMs / SAVES, 3), loopMsPerSave: round(sq.wallMs / SAVES, 3), longestSaveMs: round(longestTx, 1),
      mbWrittenPerViewerHour: round(Math.max(walBytes, walPeak) / 1048576, 2), loopBlockedSecPerViewerHour: round(sq.wallMs / 1000, 3), readOneProfileMs: round(read.wallMs / 50, 2) };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  saveJson(`sqlite-estimate${today ? "-today" : ""}${weak ? "-weak" : ""}.json`, out);
  const rows = [{ how: "JSON store, as today", ...out.json }, ...(out.sqlite ? [{ how: "SQLite, WAL, one transaction per progress POST", ...out.sqlite }] : [])];
  console.log(`${out.household}; profiles.json is ${round(out.storeBytes / 1024, 0)} KB; ${SAVES} saves = one viewer-hour\n`);
  console.log(table(rows, [["", "how"], ["CPU ms / save", "cpuMsPerSave"], ["loop blocked ms / save", "loopMsPerSave"], ["longest ms", "longestSaveMs"], ["MB written / viewer-hour", "mbWrittenPerViewerHour"], ["loop blocked s / viewer-hour", "loopBlockedSecPerViewerHour"]]));
  if (out.sqlite) console.log(`\nSQLite: one-time import ${out.sqlite.importMs} ms, database ${round(out.sqlite.dbBytes / 1024, 0)} KB, reading one profile's ${items.length} rows ${out.sqlite.readOneProfileMs} ms (in memory today: 0)`);
})().catch((e) => { console.error(e); process.exit(1); });
