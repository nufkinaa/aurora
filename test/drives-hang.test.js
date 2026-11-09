// A network drive that stops answering (src/lib/drives): asked in a child
// process with a deadline, marked "not answering", viewers refused at once
// with the sentence every app shows, ONE alert per outage and one when it is
// back — then everything resumes by itself. The hung drive is a folder the
// probe child is told never to answer for (AURORA_DRIVES_FAKE_HANG).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drives-hang-"));
const movies = path.join(dir, "Aurora", "Movies");
fs.mkdirSync(movies, { recursive: true });
fs.writeFileSync(path.join(movies, "x.mkv"), "not really a film");
process.env.AURORA_DRIVES_EXTRA = JSON.stringify([{ path: dir, network: true }]);

const config = require("../src/config");
const drives = require("../src/lib/drives");
const run = require("../src/lib/drives/run");

const sent = [];
let clock = 1_800_000_000_000;
Object.assign(drives.deps, {
  now: () => clock,
  windowsDisks: async () => "[]",
  readMountinfo: () => "",
  announce: (id, name, type, level, message) => sent.push({ id, type, level, message }),
  titlesUnder: () => 7,
  watchingNow: () => 1, // no speed check in this test
});
drives.limits.checkTimeoutMs = 800;
drives.limits.guardTimeoutMs = 300;

after(() => { drives.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const waitFree = async (key) => { for (let i = 0; i < 100 && run._internals.outstanding.has(key); i++) await new Promise((r) => setTimeout(r, 50)); };

test("a hung network drive: fails fast, one alert, one 'back', resumes", { timeout: 30000 }, async (t) => {
  const savedMovies = config.LIBRARIES.movies.slice();
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, movies);
  t.after(() => {
    config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...savedMovies);
    delete process.env.AURORA_DRIVES_FAKE_HANG;
  });
  const file = path.join(movies, "x.mkv");

  // 1. answering: measured from the child, files pass the guard
  await drives._internals.round({ all: true });
  const before = drives.onPath(file);
  assert.equal(before.network, true);
  assert.equal(before.answering, true);
  assert.ok(drives.spaceOf(file).total > 0, "free/total from the child's statfs");
  assert.deepEqual(await drives.guard(file, "viewer-a"), { ok: true });
  assert.equal(drives.unavailableFor(file), null);

  // 2. it stops answering: the check times out, the drive is marked
  process.env.AURORA_DRIVES_FAKE_HANG = dir;
  clock += 20e3;
  const t0 = Date.now();
  await drives._internals.round();
  assert.ok(Date.now() - t0 < 5000, "the server waited no longer than the deadline");
  assert.equal(drives.isDown(file), true);
  assert.equal(drives.spaceOf(file), null, "no numbers from a drive that does not answer");
  assert.equal(drives.rootReadable(movies), false);

  // viewers: refused at once, with the one sentence
  const t1 = Date.now();
  const g = await drives.guard(file, "viewer-a");
  assert.ok(Date.now() - t1 < 100, "no file call was made");
  assert.deepEqual(g, { ok: false, status: 503, code: "drive-down", message: drives.VIEWER_MESSAGE });
  await drives.guard(file, "viewer-b");
  await drives.guard(file, "viewer-b");
  assert.deepEqual(drives.unavailableFor(file), { code: "drive-down", message: drives.VIEWER_MESSAGE });
  assert.equal(sent.length, 0, "not announced in the first minute");

  // new downloads go elsewhere: the down drive is not a candidate that answers
  const cands = drives.candidatesFor("movie");
  assert.equal(cands[0].answering, false);

  // 3. a minute later: ONE alert, with what it means
  clock += 61e3;
  await drives._internals.round();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "alert");
  assert.equal(sent[0].level, "critical");
  assert.match(sent[0].message, new RegExp(`Storage drive ${dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} isn't answering since \\d\\d:\\d\\d — 7 titles can't play\\. 2 people tried to watch\\.`));
  for (let i = 0; i < 4; i++) { clock += 60e3; await drives._internals.round(); }
  assert.equal(sent.length, 1, "no repeat while it stays down");

  // 4. it answers again: resumes by itself, and says so once
  delete process.env.AURORA_DRIVES_FAKE_HANG;
  await waitFree(`${dir}:check`);
  clock += 60e3;
  await drives._internals.round();
  assert.equal(drives.isDown(file), false);
  assert.deepEqual(await drives.guard(file, "viewer-a"), { ok: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, "recovered");
  assert.match(sent[1].message, /is answering again after \d+ min — 2 people tried to watch meanwhile\. Its titles play again\./);
  clock += 60e3;
  await drives._internals.round();
  assert.equal(sent.length, 2);
});

test("a file call that hangs on a drive thought to be fine: the guard gives up in time and marks the drive", { timeout: 15000 }, async (t) => {
  const savedMovies = config.LIBRARIES.movies.slice();
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, movies);
  const realStat = drives.deps.stat;
  drives.deps.stat = () => new Promise(() => {}); // never settles
  t.after(() => {
    drives.deps.stat = realStat;
    config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...savedMovies);
    delete process.env.AURORA_DRIVES_FAKE_HANG;
  });
  fs.mkdirSync(movies, { recursive: true });
  await waitFree(`${dir}:check`);
  await drives._internals.round({ all: true });
  assert.equal(drives.isDown(path.join(movies, "x.mkv")), false);
  process.env.AURORA_DRIVES_FAKE_HANG = dir; // (the follow-up check finds it hung too)
  const t0 = Date.now();
  const keep = setInterval(() => {}, 100); // (the guard's own timer does not hold a process open)
  const g = await drives.guard(path.join(movies, "x.mkv"), "viewer-c");
  clearInterval(keep);
  assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms`);
  assert.equal(g.code, "drive-down");
  assert.equal(drives.isDown(path.join(movies, "x.mkv")), true);
});
