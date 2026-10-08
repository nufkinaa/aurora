// The healer's slow-moving checks (src/lib/healer-checks/system.js): library
// folders and files, backups, update state, alert delivery, the clock, data
// growth. Pure decisions, and the checks themselves with everything handed in
// — no folder is walked, nothing is sent, the data folder is not touched.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const system = require("../src/lib/healer-checks/system");
const store = require("../src/lib/healer-checks/store");
const libroots = require("../src/lib/libroots");
const Y = system._internals;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const ok = (state) => ({ ran: true, state: state || "ran", sentence: "ran it" });

// ------------------------------------------------------------ library folders

test("a library folder that cannot be read is MISSING — and coming back is noticed once", () => {
  const prev = {};
  const fine = [{ kind: "movies", dir: "D:/Movies", ok: true, entries: 40, indexed: 40 }];
  assert.deepEqual(Object.keys(Y.judgeRoots(prev, fine, NOW)).filter((k) => Y.judgeRoots({ ...prev }, fine, NOW)[k].length), ["fine"]);
  const gone = [{ kind: "movies", dir: "D:/Movies", ok: false, entries: 0, indexed: 40 }];
  const a = Y.judgeRoots(prev, gone, NOW + MIN);
  assert.equal(a.missing.length, 1);
  assert.equal(a.back.length, 0);
  assert.equal(prev["D:/Movies"].ok, false);
  // still gone an hour later, and by now a scan has dropped its titles from the index
  const b = Y.judgeRoots(prev, [{ ...gone[0], indexed: 0 }], NOW + HOUR);
  assert.equal(b.missing.length, 1);
  assert.equal(b.missing[0].indexed, 40, "what the library HAD from it is remembered");
  assert.equal(prev["D:/Movies"].since, NOW + MIN, "the clock of the outage is not reset");
  // back
  const c = Y.judgeRoots(prev, fine, NOW + 3 * HOUR);
  assert.equal(c.back.length, 1);
  assert.ok(Math.abs(c.back[0].awayMs - (3 * HOUR - MIN)) < 1000);
  assert.equal(Y.judgeRoots(prev, fine, NOW + 4 * HOUR).back.length, 0, "said once");
});

test("a folder that opens but is EMPTY while the library has titles from it is a missing drive, never an empty library", () => {
  const prev = { "/mnt/media/Movies": { ok: true, since: NOW - DAY } };
  const empty = (indexed) => [{ kind: "movies", dir: "/mnt/media/Movies", ok: true, entries: 0, indexed }];
  const a = Y.judgeRoots(prev, empty(120), NOW);
  assert.equal(a.suspicious.length, 1);
  assert.equal(a.fine.length, 0);
  // the scanner has since emptied the index for it: it must STAY away, not become "fine, just empty"
  const b = Y.judgeRoots(prev, empty(0), NOW + 20 * MIN);
  assert.equal(b.suspicious.length, 1, "sticky");
  assert.equal(b.suspicious[0].indexed, 120);
  assert.equal(b.back.length, 0, "an empty folder is not a folder that came back");
  // the drive is mounted again
  const c = Y.judgeRoots(prev, [{ kind: "movies", dir: "/mnt/media/Movies", ok: true, entries: 118, indexed: 0 }], NOW + HOUR);
  assert.equal(c.back.length, 1);
  // a folder that was always empty (a new install) is simply fine
  assert.equal(Y.judgeRoots({}, empty(0), NOW).fine.length, 1);
  // …and one that has stayed empty for a week is accepted as really empty
  const old = { "/mnt/media/Movies": { ok: false, since: NOW - 8 * DAY, indexed: 120 } };
  assert.equal(Y.judgeRoots(old, empty(0), NOW).fine.length, 1);
  // a folder taken out of config.json leaves no ghost
  const ghost = { "X:/Old": { ok: false, since: NOW } };
  Y.judgeRoots(ghost, [], NOW);
  assert.deepEqual(ghost, {});
});

test("files: gone, empty and cut-short are told apart; files on a drive that is away are not judged at all", () => {
  const f = (o) => ({ name: "x.mkv", root: "D:/Movies", size: 2e9, mtimeMs: NOW - DAY, duration: 5400, exists: true, ...o });
  const files = [
    f({ name: "fine.mkv" }),
    f({ name: "gone.mkv", exists: false, size: 0 }),
    f({ name: "empty.mkv", size: 0 }),
    f({ name: "tiny.mkv", size: 2000, duration: 0 }),
    f({ name: "cut.mkv", size: 5e6, duration: 5400 }), // 5 MB for ninety minutes
    f({ name: "copying.mkv", size: 0, mtimeMs: NOW - MIN }), // still being written
    f({ name: "short-clip.mkv", size: 3e6, duration: 20 }),
    f({ name: "away.mkv", root: "E:/Shows", exists: false, size: 0 }),
  ];
  const v = Y.judgeFiles(files, ["E:/Shows"], NOW);
  assert.deepEqual(v.gone, ["gone.mkv"]);
  assert.deepEqual(v.empty, ["empty.mkv"]);
  assert.deepEqual(v.truncated, ["tiny.mkv", "cut.mkv"]);
  assert.equal(v.checked, 7, "the file on the unplugged drive is not counted, let alone called gone");
});

const scannerOf = (movies = 3) => ({ index: { movies: Array.from({ length: movies }, (_, i) => ({ id: `m${i}` })), shows: [] }, resolve: () => null, idForPath: () => null });

test("the library check: an unplugged drive is a failure said loudly, nothing about it reads as 'empty', and the alert is left to the health alerts", async () => {
  const st = store.useMemory({ roots: { [path.join(__dirname, "no-such-drive")]: { ok: true, since: NOW - DAY, indexed: 12 } } });
  const roots = [{ kind: "movies", dir: path.join(__dirname, "no-such-drive") }];
  const r = await system.checkLibrary({ now: NOW, store: st, roots, scanner: scannerOf(), config: {}, files: [], unscanned: [] });
  assert.equal(r.status, "fail");
  assert.equal(r.quiet, true, "lib/health.js already announces an unreachable drive — one page, not two");
  assert.match(r.summary, /1 of 1 library folders is away/);
  assert.match(r.findings[0].text, /cannot be read — the drive is unplugged, asleep or not mounted/);
  assert.match(r.findings[0].text, /Its titles are NOT deleted/);
  assert.doesNotMatch(r.summary + r.findings[0].text, /library is empty|0 films/);
});

test("the library check: a drive that comes back gets ONE rescan through the repair; an empty mount point alerts by itself", async () => {
  const dir = __dirname; // a folder that exists and has things in it
  const st = store.useMemory({ roots: { [dir]: { ok: false, since: NOW - 2 * HOUR, indexed: 30 } } });
  const asked = [];
  const ctx = { now: NOW, store: st, roots: [{ kind: "movies", dir }], scanner: scannerOf(), config: {}, files: [], unscanned: [], repair: (name, o) => { asked.push([name, o.subject]); return ok(); } };
  const r = await system.checkLibrary(ctx);
  assert.deepEqual(asked, [["rescan", dir]]);
  assert.equal(r.status, "ok");
  assert.match(r.healed, /rescanned the library/);
  assert.match(r.findings[0].text, /is readable again after 2 h/);
  await system.checkLibrary(ctx);
  assert.equal(asked.length, 1, "the next round asks for nothing");

  // an empty mount point: readable, nothing in it, the library had titles from it
  const fs = require("fs");
  const os = require("os");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-emptyroot-"));
  try {
    const st2 = store.useMemory({ roots: { [empty]: { ok: true, since: NOW - DAY, indexed: 25 } } });
    const sc = { index: { movies: [{ id: "m1" }], shows: [] }, resolve: () => ({ path: path.join(empty, "A Film", "a.mkv") }), idForPath: () => null };
    const s = await system.checkLibrary({ now: NOW, store: st2, roots: [{ kind: "movies", dir: empty }], scanner: sc, config: {}, files: [], unscanned: [] });
    assert.equal(s.status, "fail");
    assert.equal(s.quiet, false, "the health alerts see a readable folder here and stay silent, so this one speaks");
    assert.match(s.findings[0].title, /looks empty/);
    assert.match(s.findings[0].text, /treated as a missing drive, not as a library somebody emptied/);
    assert.equal(s.findings[0].press.action, "rescan");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the library check: damaged and vanished files are named, and new folders nobody scanned", async () => {
  const dir = __dirname;
  const st = store.useMemory();
  const files = [
    { name: "Gone.mkv", root: dir, exists: false, size: 0, mtimeMs: 0, duration: 0 },
    { name: "Empty.mkv", root: dir, exists: true, size: 0, mtimeMs: NOW - DAY, duration: 0 },
    { name: "Fine.mkv", root: dir, exists: true, size: 3e9, mtimeMs: NOW - DAY, duration: 6000 },
  ];
  const r = await system.checkLibrary({ now: NOW, store: st, roots: [{ kind: "movies", dir }], scanner: scannerOf(), config: {}, files, unscanned: ["New Film (2026)"] });
  assert.equal(r.status, "warn");
  assert.match(r.summary, /1 library folder readable · 3 files checked: 1 gone, 1 damaged, 1 not yet in the library/);
  const titles = r.findings.map((f) => f.title);
  assert.ok(titles.includes("Files in the library that are no longer on disk"));
  assert.ok(titles.includes("Empty video files"));
  assert.ok(titles.includes("New folders the library has not picked up"));
  assert.equal(r.findings.find((f) => /no longer on disk/.test(f.title)).press.action, "rescan");
});

test("libroots: a path is under a folder only as a whole path segment", () => {
  assert.equal(libroots.isUnder("D:/Movies/A Film/a.mkv", ["D:/Movies"]), true);
  assert.equal(libroots.isUnder("D:/Movies", ["D:/Movies"]), true);
  assert.equal(libroots.isUnder("D:/Movies2/a.mkv", ["D:/Movies"]), false);
  assert.equal(libroots.isUnder("E:/Shows/x.mkv", ["D:/Movies"]), false);
});

test("nothing is thrown away for a file whose drive is away: the finished-downloads list and the intro timestamps both ask first", () => {
  const fs = require("fs");
  const dl = fs.readFileSync(path.join(__dirname, "..", "src", "media", "downloads.js"), "utf8");
  assert.match(dl, /!fs\.existsSync\(j\.destPath\) && !away\(j\.destPath\)/);
  const intro = fs.readFileSync(path.join(__dirname, "..", "src", "media", "introdetect.js"), "utf8");
  assert.match(intro, /rootAway \? \[\] : Object\.keys\(store\.data\)/);
});

// ------------------------------------------------------------ backups

test("backups: fresh is fine; older than the alert line is stale; a newest snapshot that fails its check is said", () => {
  const base = { enabled: true, count: 5, newestAt: NOW - 20 * HOUR, newestVerified: true, newestOkAt: NOW - 20 * HOUR, sameDisk: false, maxAgeH: 48 };
  assert.deepEqual([Y.judgeBackups(base, NOW).status, Y.judgeBackups(base, NOW).stale], ["ok", false]);
  const stale = Y.judgeBackups({ ...base, newestAt: NOW - 60 * HOUR, newestOkAt: NOW - 60 * HOUR }, NOW);
  assert.deepEqual([stale.status, stale.stale], ["warn", true]);
  const broken = Y.judgeBackups({ ...base, newestVerified: false, newestOkAt: NOW - 30 * HOUR }, NOW);
  assert.deepEqual([broken.status, broken.stale, broken.broken], ["warn", false, true]);
  assert.equal(Y.judgeBackups({ enabled: false }, NOW).status, "info");
  assert.equal(Y.judgeBackups({ enabled: true, count: 0 }, NOW).none, true);
});

test("the backups check: a stale backup starts ONE backup through the repair; 'same disk' is said once and then only in the summary", async () => {
  const st = store.useMemory();
  const asked = [];
  const backup = { enabled: true, count: 4, newestAt: NOW - 70 * HOUR, newestVerified: true, newestName: "aurora-x.tar", newestOkAt: NOW - 70 * HOUR, sameDisk: true, maxAgeH: 48 };
  const ctx = { now: NOW, store: st, config: {}, backup, repair: (name, o) => { asked.push([name, o.subject]); return ok(); } };
  const r = await system.checkBackups(ctx);
  assert.equal(r.status, "warn");
  assert.equal(r.quiet, true, "the health alerts already announce a stale backup");
  assert.deepEqual(asked, [["backup-now", "stale"]]);
  assert.equal(r.healed, "started a backup");
  assert.match(r.summary, /newest working backup 3 d old · newest snapshot passes its check · 4 snapshots · on the same disk as the data/);
  assert.ok(r.findings.some((f) => f.title === "Backups share a disk with the data" && f.level === "info"));
  const again = await system.checkBackups({ ...ctx, backup: { ...backup, newestAt: NOW - HOUR, newestOkAt: NOW - HOUR } });
  assert.equal(again.status, "ok");
  assert.equal(again.findings.length, 0, "informational once, not nagging");
  assert.match(again.summary, /on the same disk as the data/);
  // backups switched off: no repair, no finding
  const off = await system.checkBackups({ now: NOW, store: store.useMemory(), config: {}, backup: { enabled: false }, repair: () => { throw new Error("must not be asked"); } });
  assert.equal(off.status, "info");
  // at its limit, the finding names the button
  const lim = await system.checkBackups({ ...ctx, store: store.useMemory({ notes: { backupSameDisk: 1 } }), repair: () => ({ ran: false, state: "limit", sentence: "tried 2 times today, needs you — Server → Actions → Back up now", press: { action: "backup-now", label: "Server → Actions → Back up now" } }) });
  assert.match(lim.findings[0].did, /tried 2 times today, needs you/);
  assert.equal(lim.findings[0].press.action, "backup-now");
});

// ------------------------------------------------------------ update state

test("lock drift: installed versions against the lock file; developer-only and optional packages are not expected", () => {
  const lock = { packages: { "": { name: "aurora" }, "node_modules/express": { version: "4.19.2" }, "node_modules/ws": { version: "8.18.0" }, "node_modules/playwright-core": { version: "1.64.0", dev: true }, "node_modules/fsevents": { version: "2.3.3", optional: true }, "node_modules/new-dep": { version: "1.0.0" } } };
  const installed = { packages: { "node_modules/express": { version: "4.18.2" }, "node_modules/ws": { version: "8.18.0" } } };
  assert.deepEqual(Y.lockDrift(lock, installed), ["express (4.18.2 installed, 4.19.2 wanted)", "new-dep (missing)"]);
  assert.deepEqual(Y.lockDrift(lock, { packages: { "node_modules/express": { version: "4.19.2" }, "node_modules/ws": { version: "8.18.0" }, "node_modules/new-dep": { version: "1.0.0" } } }), []);
  assert.equal(Y.lockDrift(lock, null), null, "nothing to compare is not 'out of step'");
});

test("update state: restart pending, dependencies out of step, an update waiting — each names its button", () => {
  const f = Y.judgeUpdates({ available: true, behind: 3, restartNeeded: true, running: "aaaaaaa1111", local: "bbbbbbb2222", drift: ["express (4.18.2 installed, 4.19.2 wanted)"] });
  const by = Object.fromEntries(f.map((x) => [x.title, x]));
  assert.equal(by["A restart is pending"].press.label, "Server → Actions → Restart Aurora");
  assert.match(by["A restart is pending"].text, /aaaaaaa is running, bbbbbbb is on disk/);
  assert.equal(by["Dependencies are out of step"].press.label, "Server → Actions → Install dependencies (npm install)");
  assert.equal(by["An update is available"].level, "info");
  assert.match(by["An update is available"].text, /3 commits ahead/);
  assert.deepEqual(Y.judgeUpdates({ available: false, restartNeeded: false, drift: [] }), []);
});

test("the update check re-applies a missing torrent patch through the repair — and never installs, pulls or restarts by itself", async () => {
  const asked = [];
  const r = await system.checkUpdates({ config: {}, update: { available: true, behind: null, restartNeeded: true, running: "a", local: "b", offline: false, drift: ["x (missing)"], patched: false }, repair: (name, o) => { asked.push(name); return ok(); } });
  assert.deepEqual(asked, ["patch-webtorrent"], "the only thing it does itself");
  assert.equal(r.status, "warn");
  assert.match(r.summary, /an update is available · restart pending · 1 dependencies out of step/);
  assert.match(r.healed, /re-applied the download engine patch/);
  const quiet = await system.checkUpdates({ config: {}, update: { available: false, restartNeeded: false, offline: false, drift: [], patched: true } });
  assert.equal(quiet.status, "ok");
  assert.match(quiet.summary, /up to date with GitHub · running the code that is on disk · dependencies match the lock file/);
});

// ------------------------------------------------------------ alert delivery

test("delivery: the last send failing is a finding with its reason; no channel is said once, calmly; push failing in bulk", () => {
  const sent = { ntfy: { lastOkAt: NOW - HOUR, lastFailAt: 0, lastError: null, failsInARow: 0 } };
  assert.deepEqual(Y.judgeDelivery(["ntfy"], sent, { ok: 5, fail: 0, gone: 0 }, NOW), []);
  const failing = { ntfy: { lastOkAt: NOW - 2 * DAY, lastFailAt: NOW - 10 * MIN, lastError: "HTTP 429", failsInARow: 3 } };
  const f = Y.judgeDelivery(["ntfy"], failing, { ok: 0, fail: 0, gone: 0 }, NOW);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /The last alert sent through ntfy did not get out \(HTTP 429\), 10 min ago; the last one that did was 2 d ago/);
  assert.equal(f[0].press.action, "notify-test");
  assert.equal(Y.judgeDelivery([], {}, { ok: 0, fail: 0, gone: 0 }, NOW)[0].level, "info");
  const push = Y.judgeDelivery(["ntfy"], sent, { ok: 2, fail: 9, gone: 1 }, NOW);
  assert.match(push[0].text, /9 of the last 11 notifications to phones and browsers failed/);
});

test("notify.js records what became of each send, and the delivery check keeps the last answer across a restart", async () => {
  const notify = require("../src/lib/notify");
  const n = notify._internals;
  for (const k of Object.keys(n.outcome)) delete n.outcome[k];
  n.noteOutcome("ntfy", true);
  n.noteOutcome("ntfy", false, "HTTP 500");
  n.noteOutcome("ntfy", false, "fetch failed");
  const o = notify.outcomes().ntfy;
  assert.equal(o.failsInARow, 2);
  assert.equal(o.lastError, "fetch failed");
  assert.equal(o.sent, 3);
  assert.ok(o.lastFailAt >= o.lastOkAt);
  for (const k of Object.keys(n.outcome)) delete n.outcome[k];

  // the check, with a stand-in notify that sends nothing
  const st = store.useMemory({ delivery: { ntfy: { lastOkAt: NOW - DAY, lastFailAt: 0, lastError: null, failsInARow: 0 } } });
  const fake = { channels: () => ["ntfy"], outcomes: () => ({}) }; // a fresh process: nothing sent yet
  const signals = { byKey: () => new Map() };
  const r = await system.checkDelivery({ now: NOW, store: st, notify: fake, signals, subs: 2 });
  assert.equal(r.status, "ok");
  assert.match(r.summary, /ntfy: last sent 24 h ago · push: 2 devices, 0 sent and 0 failed in 24 h/);
  const bad = await system.checkDelivery({ now: NOW, store: st, notify: { channels: () => ["ntfy"], outcomes: () => ({ ntfy: { lastOkAt: 0, lastFailAt: NOW - MIN, lastError: "HTTP 403", failsInARow: 1 } }) }, signals, subs: 2 });
  assert.equal(bad.status, "warn");
  assert.match(bad.summary, /ntfy: last send FAILED/);
  assert.equal(st.data.delivery.ntfy.lastError, "HTTP 403");
});

// ------------------------------------------------------------ clock

test("clock: the median of the answers decides; under 45 s is fine, over two minutes breaks things", () => {
  assert.equal(Y.judgeClock([]).status, "info");
  assert.equal(Y.judgeClock([400, -300, 900]).status, "ok");
  assert.equal(Y.judgeClock([70000, 71000, 500]).status, "warn");
  assert.equal(Y.judgeClock([-200000, -199000, -201000]).status, "fail");
  assert.equal(Y.judgeClock([500, 300, 9999999]).status, "ok", "one provider with a wrong clock does not decide");
});

test("the clock check says which way and what to do; with no recent answer it says so and judges nothing", async () => {
  const none = await system.checkClock({ now: NOW, reading: null });
  assert.equal(none.status, "info");
  assert.equal((await system.checkClock({ now: NOW, reading: { skews: [100], at: NOW - 2 * HOUR } })).status, "info", "a stale reading is no reading");
  const off = await system.checkClock({ now: NOW, reading: { skews: [181000, 180000, 182000], at: NOW - MIN } });
  assert.equal(off.status, "fail");
  assert.match(off.summary, /the server's clock is 3 minutes behind/);
  assert.match(off.findings[0].setting, /Sync now/);
  const fine = await system.checkClock({ now: NOW, reading: { skews: [300, -200], at: NOW - MIN } });
  assert.match(fine.summary, /within 1 s of the outside world \(2 answers compared\)/);
});

test("the clock is read from answers the healer already has — no request of its own", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "src", "lib", "healer.js"), "utf8");
  assert.match(src, /res\.headers\.get\("date"\)/);
  const sys = require("fs").readFileSync(path.join(__dirname, "..", "src", "lib", "healer-checks", "system.js"), "utf8");
  assert.doesNotMatch(sys, /\bfetch\(/, "system.js makes no outbound request at all");
});

// ------------------------------------------------------------ data growth

test("growth: fast means half as big again AND five megabytes in a day; a file past its sane size is big", () => {
  const MB = 1024 ** 2;
  const s = (pairs) => pairs.map(([agoH, mb]) => ({ at: NOW - agoH * HOUR, bytes: mb * MB }));
  assert.equal(Y.growthOf(s([[20, 10], [10, 16], [0, 22]]), NOW).fast, true);
  assert.equal(Y.growthOf(s([[20, 100], [0, 108]]), NOW).fast, false, "8 MB on 100 is not fast");
  assert.equal(Y.growthOf(s([[20, 1], [0, 3]]), NOW).fast, false, "tripled, but only 2 MB");
  assert.equal(Y.growthOf(s([[2, 1], [0, 90]]), NOW).fast, false, "two hours of history is not a trend");
  const history = { "gone.json": [{ at: NOW - HOUR, bytes: 1 }] };
  const items = [{ name: "profiles.json", kind: "store", bytes: 30 * MB }, { name: "server-stdout.log", kind: "log", bytes: 50 * MB }, { name: "usage/", kind: "usage", bytes: 10 * MB }];
  const j = Y.judgeGrowth(items, history, NOW);
  assert.deepEqual(j.big.map((b) => b.name), ["profiles.json"], "a 50 MB log is under its own line of 200");
  assert.equal(history["profiles.json"].length, 1);
  assert.equal(history["gone.json"], undefined);
  Y.judgeGrowth(items, history, NOW + 10 * MIN);
  assert.equal(history["profiles.json"].length, 1, "one sample an hour");
});

test("the growth check trims only what is designed to be trimmed (old usage months) and names what it will not touch", async () => {
  const MB = 1024 ** 2;
  const st = store.useMemory();
  let pruned = 0;
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-usage-"));
  for (const m of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) fs.writeFileSync(path.join(dir, `events-${m}.jsonl`), "{}\n");
  try {
    const usage = { DIR: dir, KEEP_MONTHS: 3, prune: () => { pruned++; } };
    const items = [{ name: "server-stdout.log", kind: "log", bytes: 300 * MB }, { name: "profiles.json", kind: "store", bytes: 1 * MB }];
    const r = await system.checkGrowth({ now: NOW, store: st, config: {}, items, usage });
    assert.equal(pruned, 1);
    assert.match(r.healed, /deleted 2 old months of usage statistics \(three are kept\)/);
    assert.equal(r.status, "warn");
    assert.match(r.findings[0].text, /server-stdout\.log has grown to 300 MB.*the healer does not touch it/);
    assert.match(r.summary, /301 MB of records, statistics and logs \(server-stdout\.log 300 MB, profiles\.json 1\.0 MB\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
