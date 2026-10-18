// The keeper's log files (src/lib/keeper.js): a log is set aside not only
// when the server starts but also WHILE it runs, a bounded number of copies
// is kept, and the live file plus its copies never pass a total — an
// oversized copy left from before the keeper (the live server had an 891 MB
// server-stdout.log.1) goes at the keeper's next start.
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

test("an oversized copy from before the keeper is removed at its start; the live log is kept", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server-stdout.log"), "x".repeat(1000));
    fs.writeFileSync(path.join(dir, "server-stdout.log.1"), "y".repeat(9000)); // "891 MB"
    const k = keeper(dir, { logMaxBytes: 4000, logKeep: 2, logTotalMaxBytes: 6000 });
    k._openLogs();
    await close(k);
    const s = sizes(dir);
    assert.equal(s["server-stdout.log"], 1000);
    assert.equal(s["server-stdout.log.1"], undefined, "over the total by itself: removed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("while the server runs, a log that passes the limit is set aside; copies shift and stay bounded", async () => {
  const dir = tmp();
  try {
    const k = keeper(dir, { logMaxBytes: 1000, logKeep: 2, logTotalMaxBytes: 10000 });
    k._openLogs();
    for (let i = 0; i < 35; i++) k._writeLog("out", "z".repeat(100)); // 3,500 bytes through a 1,000-byte limit
    await close(k);
    const s = sizes(dir);
    assert.ok(s["server-stdout.log"] <= 1000, JSON.stringify(s));
    assert.ok(s["server-stdout.log.1"] > 0 && s["server-stdout.log.1"] <= 1000);
    assert.ok(s["server-stdout.log.2"] > 0 && s["server-stdout.log.2"] <= 1000);
    assert.equal(s["server-stdout.log.3"], undefined, "never more than logKeep copies");
    const total = Object.entries(s).filter(([n]) => n.startsWith("server-stdout")).reduce((a, [, v]) => a + v, 0);
    assert.ok(total <= 3000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("at a start, a log over the limit is set aside as .1 (the previous .1 becomes .2)", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server-stderr.log"), "e".repeat(2000));
    fs.writeFileSync(path.join(dir, "server-stderr.log.1"), "o".repeat(500));
    fs.writeFileSync(path.join(dir, "server-stderr.log.5"), "stray");
    const k = keeper(dir, { logMaxBytes: 1000, logKeep: 2, logTotalMaxBytes: 10000 });
    k._openLogs();
    await close(k);
    const s = sizes(dir);
    assert.equal(s["server-stderr.log"], 0);
    assert.equal(s["server-stderr.log.1"], 2000);
    assert.equal(s["server-stderr.log.2"], 500);
    assert.equal(s["server-stderr.log.5"], undefined, "a copy beyond logKeep is removed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
