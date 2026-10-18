// The keeper's log files (src/lib/keeper.js): a log is set aside not only
// when the server starts but also WHILE it runs, as <name>.r1 / .r2 — a
// bounded number of copies, the live file plus its copies never past a
// total. ONLY those .rN copies are ever removed: an old log the rotation did
// not make (the live server has an 891 MB server-stdout.log.1 from before)
// is left where it is, and the healer's data-growth check names it on the
// admin page with how to delete it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Keeper } = require("../src/lib/keeper");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-keeperlogs-"));
const sizes = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((n) => /\.log/.test(n)).sort().map((n) => [n, fs.statSync(path.join(dir, n)).size]));
const keeper = (dir, cfg) => new Keeper({ script: path.join(dir, "x.js"), dataDir: dir, quiet: true, cfg, deps: { log: () => {}, saveState: () => {} } });
const close = (k) => new Promise((resolve) => { let n = 0; for (const key of ["out", "err"]) { if (k[key]) k[key].end(() => { if (++n === 2) resolve(); }); else if (++n === 2) resolve(); } });

test("an old log the rotation did not make is never removed, however big — not at a start, not by the cap", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server-stdout.log"), "x".repeat(1000));
    fs.writeFileSync(path.join(dir, "server-stdout.log.1"), "y".repeat(9000)); // "891 MB", from before
    fs.writeFileSync(path.join(dir, "server-stderr.log.3"), "z".repeat(9000));
    const k = keeper(dir, { logMaxBytes: 4000, logKeep: 2, logTotalMaxBytes: 6000 });
    k._openLogs();
    for (let i = 0; i < 100; i++) k._writeLog("out", "w".repeat(100)); // through the limit, more than once
    await close(k);
    const s = sizes(dir);
    assert.equal(s["server-stdout.log.1"], 9000, "the old log is left as it was");
    assert.equal(s["server-stderr.log.3"], 9000);
    assert.ok(s["server-stdout.log.r1"] > 0, "the rotation's own copy is .r1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("while the server runs, a log that passes the limit is set aside as .r1; copies shift and stay bounded", async () => {
  const dir = tmp();
  try {
    const k = keeper(dir, { logMaxBytes: 1000, logKeep: 2, logTotalMaxBytes: 10000 });
    k._openLogs();
    for (let i = 0; i < 35; i++) k._writeLog("out", "z".repeat(100)); // 3,500 bytes through a 1,000-byte limit
    await close(k);
    const s = sizes(dir);
    assert.ok(s["server-stdout.log"] <= 1000, JSON.stringify(s));
    assert.ok(s["server-stdout.log.r1"] > 0 && s["server-stdout.log.r1"] <= 1000);
    assert.ok(s["server-stdout.log.r2"] > 0 && s["server-stdout.log.r2"] <= 1000);
    assert.equal(s["server-stdout.log.r3"], undefined, "never more than logKeep copies");
    const total = Object.entries(s).filter(([n]) => n.startsWith("server-stdout")).reduce((a, [, v]) => a + v, 0);
    assert.ok(total <= 3000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("at a start, a log over the limit is set aside as .r1 (the previous .r1 becomes .r2); the cap removes only .rN copies", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server-stderr.log"), "e".repeat(2000));
    fs.writeFileSync(path.join(dir, "server-stderr.log.r1"), "o".repeat(500));
    fs.writeFileSync(path.join(dir, "server-stderr.log.r5"), "stray");
    const k = keeper(dir, { logMaxBytes: 1000, logKeep: 2, logTotalMaxBytes: 10000 });
    k._openLogs();
    await close(k);
    const s = sizes(dir);
    assert.equal(s["server-stderr.log"], 0);
    assert.equal(s["server-stderr.log.r1"], 2000);
    assert.equal(s["server-stderr.log.r2"], 500);
    assert.equal(s["server-stderr.log.r5"], undefined, "a copy of its own beyond logKeep is removed");
    // over the total: the oldest of its own copies goes first
    const k2 = keeper(dir, { logMaxBytes: 100000, logKeep: 2, logTotalMaxBytes: 2100 });
    k2._openLogs();
    await close(k2);
    const s2 = sizes(dir);
    assert.equal(s2["server-stderr.log.r1"], 2000);
    assert.equal(s2["server-stderr.log.r2"], undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the healer names an old log on the admin page, with how to delete it, and touches nothing", async () => {
  const system = require("../src/lib/healer-checks/system");
  const MB = 1024 ** 2;
  const dir = tmp();
  try {
    const usage = { DIR: dir, KEEP_MONTHS: 3, prune: () => {} };
    const st = { data: { growth: {} }, save() {} };
    const items = [{ name: "server-stdout.log", kind: "log", bytes: 1 * MB }, { name: "server-stdout.log.1", kind: "old-log", bytes: 891 * MB }];
    const r = await system.checkGrowth({ now: Date.now(), store: st, config: { DATA_DIR: path.join("C:", "aurora", "data") }, items, usage });
    const f = r.findings.find((x) => /old log/.test(x.title));
    assert.ok(f, JSON.stringify(r.findings));
    assert.match(f.title, /^An old log of 891 MB in data\/ — you can delete it$/);
    assert.match(f.setting, process.platform === "win32" ? /del ".*server-stdout\.log\.1"$/ : /rm '.*server-stdout\.log\.1'$/);
    assert.equal(r.findings.filter((x) => /server-stdout\.log\.1 is large/.test(x.title)).length, 0, "said once, not twice");
    assert.notEqual(f.level, "fail", "a warning on the admin page, never an alert");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
