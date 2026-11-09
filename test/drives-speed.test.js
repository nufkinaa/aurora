// The drives feature's speed check and Aurora's share (src/lib/drives):
// - the speed check is bounded by its time for real — on a slow drive it
//   stops on its budget and reports what it measured (partly measured);
// - a check killed on its deadline still counts (its progress lines), its
//   test file is swept, and the drive is NOT marked "not answering";
// - the leftover sweep: dead or killed checks' files go, live ones stay;
// - Aurora's share counts each file once across roots (nested roots, the same
//   root twice, hard links between two roots) and never its own test files.
// The slow drive is AURORA_DRIVES_FAKE_SLOW_MS_PER_MB (probe-child's io).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drives-speed-"));
const netDrive = path.join(base, "net");
const movies = path.join(netDrive, "Aurora", "Movies");
fs.mkdirSync(movies, { recursive: true });
process.env.AURORA_DRIVES_EXTRA = JSON.stringify([{ path: netDrive, network: true }]);

const config = require("../src/config");
const drives = require("../src/lib/drives");
const run = require("../src/lib/drives/run");
const { OPS, TEST_FILE } = require("../src/lib/drives/probe-child");

after(() => { drives.stop(); delete process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB; fs.rmSync(base, { recursive: true, force: true }); });

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /^\.aurora-/.test(n));
const slow = (t, ms) => {
  process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB = String(ms);
  t.after(() => { delete process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB; });
};

test("speed: a slow drive — every step stops on its budget and what it measured is reported", { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(base, "slow-"));
  slow(t, 50); // 4 MB written = 200 ms, 1 MB read = 50 ms
  const t0 = Date.now();
  const m = await OPS.speed({ dir, sizeMB: 64, budgetMs: 3000, network: true });
  const took = Date.now() - t0;
  assert.ok(took < 9000, `the check took ${took} ms on a 3 s budget`);
  assert.ok(m.writtenMB > 0 && m.writtenMB < 64, `it stopped writing on its budget (${m.writtenMB} MB of 64)`);
  assert.equal(m.partial, true);
  assert.ok(m.cut.includes("write"), m.cut.join());
  assert.ok(m.writeMBps > 0 && m.writeMBps < 40, `the write figure is the slow drive's (${m.writeMBps} MB/s)`);
  assert.ok(m.bufferedMBps > 0, "one reader measured");
  assert.ok(m.parallelMBps > 0, "readers at once measured");
  assert.equal(m.parallelReaders, 4);
  assert.ok(m.readMBps > 0);
  assert.deepEqual(leftovers(dir), [], "its test file is deleted");
});

test("speed: a quick drive runs every step to the end and is not partial", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(base, "quick-"));
  const m = await OPS.speed({ dir, sizeMB: 16, budgetMs: 8000 });
  assert.equal(m.writtenMB, 16);
  assert.equal(m.partial, false, m.cut.join());
  for (const k of ["writeMBps", "readMBps", "bufferedMBps", "parallelMBps", "iops"]) assert.ok(m[k] > 0, k);
  assert.deepEqual(leftovers(dir), []);
});

test("speed: killed on its deadline — its progress still counts; the sweep removes its file", { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(base, "killed-"));
  slow(t, 100); // 8 MB (one sync) = 0.8 s
  const key = "test:killed";
  const res = await run.ask("speed", { dir, sizeMB: 128, budgetMs: 60000, network: true }, { timeoutMs: 2500, key });
  assert.equal(res.timeout, true);
  assert.ok(res.pid > 0);
  assert.ok(res.progress && res.progress.writeMBps > 0 && res.progress.writtenMB > 0, JSON.stringify(res.progress));
  await run.settled(key);
  assert.equal(leftovers(dir).length, 1, "the killed child could not delete its test file");
  const sw = OPS.sweep({ dirs: [dir], pids: [res.pid] });
  assert.equal(sw.removed.length, 1);
  assert.deepEqual(leftovers(dir), []);
});

test("sweep: files of gone processes and old ones go; a live check's fresh file stays", () => {
  const dir = fs.mkdtempSync(path.join(base, "sweep-"));
  const gone = ".aurora-speedtest-999999-abc123"; // (no such pid)
  const mine = `.aurora-check-${process.pid}-def456`;
  const old = `.aurora-check-${process.pid}-0aa0aa.renamed`;
  const other = ".aurora-notes";
  for (const n of [gone, mine, old, other]) fs.writeFileSync(path.join(dir, n), "x");
  const long = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(dir, old), long, long);
  assert.ok(TEST_FILE.test(gone) && TEST_FILE.test(mine) && TEST_FILE.test(old) && !TEST_FILE.test(other));
  OPS.sweep({ dirs: [dir, path.join(dir, "missing")] });
  assert.deepEqual(leftovers(dir).sort(), [other, mine].sort());
});

test("the server: a speed check past its deadline keeps a partial score, leaves no file, and the drive still answers", { timeout: 40000 }, async (t) => {
  slow(t, 100);
  const savedMovies = config.LIBRARIES.movies.slice();
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, movies);
  const savedLimits = drives.limits.speed.network;
  drives.limits.speed.network = { sizeMB: 128, budgetMs: 60000, timeoutMs: 3000 };
  Object.assign(drives.deps, { windowsDisks: async () => "[]", readMountinfo: () => "", watchingNow: () => 0, titlesUnder: () => 0, announce: () => {} });
  t.after(() => { config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...savedMovies); drives.limits.speed.network = savedLimits; });
  const id = path.resolve(netDrive);
  await drives._internals.refreshMounts();
  await drives._internals.check(drives._internals.live.drives.find((d) => d.id === id));
  drives._internals.queueSpeed(id);
  const live = drives._internals.live;
  for (const end = Date.now() + 30000; Date.now() < end && (live.speedRunning || live.speedQueue.length || !drives._internals.data().scores[id]); ) await new Promise((r) => setTimeout(r, 100));
  for (const end = Date.now() + 15000; Date.now() < end && live.speedRunning; ) await new Promise((r) => setTimeout(r, 100));
  const sc = drives._internals.data().scores[id];
  assert.ok(sc && sc.value != null, `a score from what was measured: ${JSON.stringify(sc)}`);
  assert.equal(sc.scale, "network");
  assert.equal(sc.measured.partial, true);
  assert.ok(sc.measured.cut.includes("stopped at the time limit"));
  assert.equal(sc.error, undefined);
  assert.deepEqual(leftovers(movies), [], "the killed check's test file was swept");
  assert.equal(drives.onPath(path.join(movies, "x.mkv")).answering, true, "a slow speed check is not a drive that is down");
});

test("Aurora's share: each file once across nested roots, the same root twice and hard links between roots; no test files", () => {
  const a = fs.mkdtempSync(path.join(base, "share-a-"));
  const b = fs.mkdtempSync(path.join(base, "share-b-"));
  const sub = path.join(a, "staging");
  fs.mkdirSync(sub);
  const film = path.join(a, "film.mkv");
  fs.writeFileSync(film, Buffer.alloc(300 * 1024, 1));
  fs.writeFileSync(path.join(sub, "part.mkv"), Buffer.alloc(100 * 1024, 2));
  fs.writeFileSync(path.join(b, "show.mkv"), Buffer.alloc(200 * 1024, 3));
  fs.linkSync(film, path.join(b, "film-landed.mkv")); // the same bytes, reached from two roots
  fs.writeFileSync(path.join(a, ".aurora-speedtest-1234-abcdef"), Buffer.alloc(500 * 1024, 4));
  const onDisk = (f) => { const st = fs.statSync(f); return st.blocks != null ? st.blocks * 512 : st.size; };
  const want = onDisk(film) + onDisk(path.join(sub, "part.mkv")) + onDisk(path.join(b, "show.mkv"));
  const u = OPS.usage({ paths: [a, sub, b, a, path.join(a, ".")] });
  assert.equal(u.files, 3);
  assert.equal(u.apparent, 600 * 1024);
  assert.equal(u.bytes, want);
  // the server hands the child only the top folders
  assert.deepEqual(drives._internals.topDirs([a, sub, b, a + path.sep, sub]), [a, b]);
  assert.deepEqual(drives._internals.topDirs([sub, a]), [a]);
});
