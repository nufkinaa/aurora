// "Tune this network drive" on the server (src/lib/drives/tune.js), with the
// root helper stubbed at its seam (tune.deps.helper — in production `sudo -n
// /usr/local/sbin/aurora-mount-helper …` by execFile) and the drive's checks
// stubbed at drives.deps.ask. What is held:
//   - the preview: what would change; the setup commands when the helper or
//     its sudo rule is missing;
//   - a run: refused while someone plays from the drive; the drive paused
//     (a fast "being tuned" answer, a landing waits), no new downloads during
//     it, landings already copying finish first, speed before → helper →
//     the drive answers → speed after; new downloads back as they were;
//   - not faster → "Put it back" (revert) runs the same way;
//   - the helper failing (mount failed, busy) is said plainly, and nothing stays paused;
//   - a restart in the middle puts new downloads back.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drives-tune-"));
const netDrive = path.join(base, "storagespace");
const movies = path.join(netDrive, "Aurora", "Movies");
fs.mkdirSync(movies, { recursive: true });
process.env.AURORA_DRIVES_EXTRA = JSON.stringify([{ path: netDrive, network: true, label: "storagespace" }]);

const config = require("../src/config");
const drives = require("../src/lib/drives");
const tune = require("../src/lib/drives/tune");

const ID = path.resolve(netDrive);
const savedMovies = config.LIBRARIES.movies.slice();
config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, movies);
after(() => {
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...savedMovies);
  drives.stop();
  fs.rmSync(base, { recursive: true, force: true });
});

const OLD = "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536";
const TUNED = "rw,vers=3,proto=tcp,nolock,rsize=1048576,wsize=1048576,nconnect=4,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2";
const measured = (parallelMBps) => ({ writeMBps: 45, readMBps: 22, directMBps: 22, bufferedMBps: 41, parallelMBps, parallelReaders: 4, iops: 300, latencyMs: 3, writtenMB: 128, seconds: 60, partial: false, cut: [] });

// the world the run sees, set per test
let world;
const reset = () => {
  world = {
    speeds: [22, 95], // 4 readers together: before, after
    helperCalls: [],
    status: { ok: true, helper: "aurora-mount-helper", version: 1, action: "status", mountpoint: ID, fstype: "nfs", mounted: true, fstabOptions: OLD, liveOptions: "rw,vers=3,rsize=65536,wsize=65536,hard,proto=tcp", tunedOptions: TUNED, isTuned: false, canRevert: false, originalOptions: "" },
    change: (args) => ({ ok: true, action: args[0], changed: true, fstabBefore: OLD, fstabAfter: TUNED, liveBefore: "rw,vers=3,rsize=65536,wsize=65536,hard", liveAfter: "rw,vers=3,rsize=1048576,wsize=1048576,soft,nconnect=4,timeo=100,retrans=2", clamped: [], missing: [], backup: "/var/lib/aurora-mount-helper/fstab.x", message: "Mounted with the new options." }),
    installed: true,
    stderr: "",
    playing: 0,
    landings: [],
    duringChange: null, // a look at the server while the helper "runs"
  };
};
reset();

Object.assign(drives.deps, {
  windowsDisks: async () => "[]",
  readMountinfo: () => "",
  watchingNow: () => 0,
  titlesUnder: () => 3,
  announce: () => {},
  playingOn: () => world.playing,
  landingsOn: () => (world.landings.length ? world.landings.shift() : 0),
  ask: async (op, args) => {
    if (op === "check") return { ok: true, result: { total: 1e12, free: 9e11, used: 1e11, roots: Object.fromEntries((args.roots || []).map((r) => [r, true])) } };
    if (op === "speed") return { ok: true, result: measured(world.speeds.shift()) };
    if (op === "sweep") return { ok: true, result: { removed: [] } };
    if (op === "usage") return { ok: true, result: { bytes: 0, apparent: 0, files: 0 } };
    return { ok: false, error: "not stubbed" };
  },
});
Object.assign(tune.deps, {
  platform: () => "linux",
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  settled: async () => true,
  user: () => "elia",
  repoHelper: () => "/home/elia/aurora/scripts/nufurora/aurora-mount-helper",
  helperInstalled: () => world.installed,
  helper: async (args) => {
    world.helperCalls.push(args);
    if (!world.installed) throw new Error("the helper was called while it is not installed");
    if (world.stderr) return { code: 1, stdout: "", stderr: world.stderr, killed: false, spawnError: null };
    if (args[0] === "status") return { code: 0, stdout: JSON.stringify(world.status) + "\n", stderr: "", killed: false, spawnError: null };
    if (world.duringChange) world.duringChange();
    const j = world.change(args);
    return { code: j.ok ? 0 : 1, stdout: JSON.stringify(j) + "\n", stderr: "", killed: false, spawnError: null };
  },
});
tune.limits.pollMs = 5;

beforeEach(async () => {
  reset();
  tune._internals.reset();
  const d = drives._internals.data();
  d.tunes = {};
  delete d.noNew[ID];
  await drives._internals.refreshMounts();
  await drives._internals.check(drives._internals.live.drives.find((x) => x.id === ID));
});

const cardOf = async () => (await drives.list()).find((d) => d.id === ID);
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (fn()) return true;
  throw new Error("timed out");
};
const finished = () => until(() => !tune._internals.current());

test("the card offers it only for an NFS drive on Linux", async () => {
  const c = await cardOf();
  assert.deepEqual(c.tune, { supported: true, running: null, elsewhere: false, last: null });
  tune.deps.platform = () => "win32";
  try {
    assert.equal((await cardOf()).tune, null);
    assert.match((await tune.preview(ID)).error, /Only an NFS drive on a Linux server/);
  } finally { tune.deps.platform = () => "linux"; }
});

test("preview: the line now, what would change, and the pause note", async () => {
  const p = await tune.preview(ID);
  assert.equal(p.installed, true);
  assert.equal(p.fstabOptions, OLD);
  assert.equal(p.tunedOptions, TUNED);
  assert.deepEqual(p.remove, ["hard", "rsize=65536", "wsize=65536"]);
  assert.deepEqual(p.add, ["rsize=1048576", "wsize=1048576", "nconnect=4", "_netdev", "nofail", "x-systemd.mount-timeout=30s", "soft", "timeo=100", "retrans=2"]);
  assert.equal(p.already, false);
  assert.equal(p.canRevert, false);
  assert.match(p.pauseNote, /pauses this drive for about three minutes: nobody can watch from it/);
  assert.equal(p.watching, false);
  assert.equal(p.outdated, false);
  assert.deepEqual(world.helperCalls, [["status", ID]]);
});

test("helper missing: the two one-time commands, and a run is refused without calling it", async () => {
  world.installed = false;
  const p = await tune.preview(ID);
  assert.equal(p.installed, false);
  assert.equal(p.missing, "helper");
  assert.deepEqual(p.setup.commands, [
    "sudo install -o root -g root -m 0755 /home/elia/aurora/scripts/nufurora/aurora-mount-helper /usr/local/sbin/aurora-mount-helper",
    "t=$(mktemp) && echo 'elia ALL=(root) NOPASSWD: /usr/local/sbin/aurora-mount-helper' > \"$t\" && sudo visudo -cf \"$t\" && sudo install -o root -g root -m 0440 \"$t\" /etc/sudoers.d/aurora-mount; rm -f \"$t\"",
  ]);
  const r = await tune.start(ID);
  assert.match(r.error, /isn't set up on this server yet/);
  assert.equal(r.setup.commands.length, 2);
  assert.deepEqual(world.helperCalls, []);
  assert.equal(drives.onPath(path.join(movies, "x.mkv")).paused, false);

  // installed, but no sudo rule: sudo -n says a password is required
  world.installed = true;
  world.stderr = "sudo: a password is required\n";
  const p2 = await tune.preview(ID);
  assert.equal(p2.installed, false);
  assert.equal(p2.missing, "sudo");
  assert.match(p2.why, /sudo rule/);
  assert.equal(p2.setup.commands.length, 2);
});

test("refused while someone plays from the drive — nothing paused, the helper only asked for its status", async () => {
  world.playing = 1;
  const r = await tune.start(ID);
  assert.equal(r.watching, true);
  assert.equal(r.error, "Someone is watching a title from this drive right now — try again when nobody is.");
  assert.ok(!world.helperCalls.some((a) => a[0] === "apply"));
  assert.equal(drives.onPath(path.join(movies, "x.mkv")).paused, false);
  assert.equal(drives._internals.data().noNew[ID], undefined);
  assert.equal(tune._internals.current(), null);
});

test("refused while titles are being moved off the drive (Stop using this drive)", async () => {
  const d = drives._internals.data();
  d.evacuate = d.evacuate || {};
  d.evacuate[ID] = { since: Date.now() };
  try {
    const r = await tune.start(ID);
    assert.equal(r.error, "Titles are being moved to or from this drive — try again when that is done.");
    assert.ok(!world.helperCalls.some((a) => a[0] === "apply"));
    assert.equal(tune._internals.current(), null);
  } finally { delete d.evacuate[ID]; }
});

test("a run: paused (viewers told fast, landings wait), no new downloads meanwhile, speed before → helper → speed after, all back as it was", async () => {
  const file = path.join(movies, "Film (2020)", "Film (2020).mkv");
  world.landings = [1, 1]; // a download copying there: the run waits for it
  let seen = null;
  let landing = null;
  world.duringChange = () => {
    const o = drives.onPath(file);
    seen = {
      paused: o.paused, answering: o.answering, noNew: drives._internals.data().noNew[ID],
      unavailable: drives.unavailableFor(file),
      queued: drives.candidatesFor("movie").find((c) => c.drive === ID).accepts,
    };
    // a download that comes to land now waits for the drive
    landing = drives.confirm(file).then((x) => ({ at: Date.now(), paused: x.paused, answering: x.answering }));
  };
  const r = await tune.start(ID);
  assert.deepEqual(r, { ok: true, started: true, action: "apply" });
  // one at a time
  assert.match((await tune.start(ID)).error, /being tuned already/);
  const running = (await cardOf()).tune.running;
  assert.ok(running && running.action === "apply", JSON.stringify(running));
  // viewers: a fast, plain answer while it runs
  const g = await drives.guard(file, "someone");
  assert.deepEqual(g, { ok: false, status: 503, code: "drive-down", message: "This title's storage drive is being tuned for a few minutes — try again shortly." });
  await finished();
  assert.deepEqual(seen, { paused: true, answering: false, noNew: true, unavailable: { code: "drive-down", message: drives.PAUSED_MESSAGE }, queued: false });
  const landed = await landing;
  assert.equal(landed.paused, false, "the landing went on once the drive was back");
  assert.equal(landed.answering, true);
  assert.deepEqual(world.helperCalls, [["status", ID], ["apply", ID, "tuned"]]);
  const c = await cardOf();
  assert.equal(c.paused, false);
  assert.equal(c.newDownloads, true, "new downloads as before");
  assert.equal(drives._internals.data().noNew[ID], undefined);
  assert.equal((await drives.guard(file)).ok, true, "plays again");
  const last = c.tune.last;
  assert.equal(last.ok, true);
  assert.equal(last.action, "apply");
  assert.equal(last.better, true);
  assert.equal(last.before.parallelMBps, 22);
  assert.equal(last.after.parallelMBps, 95);
  assert.equal(last.message, "Faster: read 22 → 95 MB/s for 4 viewers together.");
  assert.match(last.optionsAfter, /nconnect=4/);
  assert.equal(last.fstabAfter, TUNED);
  // the score on the card is the one measured after
  assert.equal(c.score.measured.parallelMBps, 95);
});

test("not faster: said so, and Put it back runs the revert the same way", async () => {
  world.speeds = [22, 23, 23, 22];
  await tune.start(ID);
  await finished();
  let last = (await cardOf()).tune.last;
  assert.equal(last.ok, true);
  assert.equal(last.better, false);
  assert.equal(last.message, "Not faster: read 22 → 23 MB/s for 4 viewers together. \"Put it back\" returns the old options.");

  world.status = { ...world.status, fstabOptions: TUNED, isTuned: true, canRevert: true, originalOptions: OLD };
  world.change = (args) => ({ ok: true, action: args[0], changed: true, fstabBefore: TUNED, fstabAfter: OLD, liveBefore: "rw,soft,nconnect=4", liveAfter: "rw,hard,rsize=65536", clamped: [], missing: [], message: "The old line is back and mounted." });
  assert.match((await tune.start(ID, "apply")).error, /already has the tuned options/);
  const r = await tune.start(ID, "revert");
  assert.equal(r.ok, true);
  await finished();
  assert.deepEqual(world.helperCalls.filter((a) => a[0] !== "status"), [["apply", ID, "tuned"], ["revert", ID]]);
  last = (await cardOf()).tune.last;
  assert.equal(last.action, "revert");
  assert.equal(last.ok, true);
  assert.equal(last.better, null);
  assert.equal(last.message, "The old options are back: read 23 → 22 MB/s for 4 viewers together.");
  assert.equal(last.fstabAfter, OLD);
  // nothing to put back any more
  world.status = { ...world.status, fstabOptions: OLD, isTuned: false, canRevert: false };
  assert.match((await tune.start(ID, "revert")).error, /no earlier line to put back/);
});

test("the new options do not mount: said plainly, nothing stays paused, new downloads as they were (here: off)", async () => {
  drives._internals.data().noNew[ID] = true; // the admin had stopped new downloads there
  world.change = () => ({ ok: false, action: "apply", code: "mount-failed", error: "the new options did not mount: the old line is back", fstabRestored: true, mountedOldWay: true, detail: "mount.nfs: an incorrect mount option was specified" });
  await tune.start(ID);
  await finished();
  const c = await cardOf();
  const last = c.tune.last;
  assert.equal(last.ok, false);
  assert.equal(last.message, "The new options did not mount (mount.nfs: an incorrect mount option was specified). The old line is back and the drive is mounted the old way.");
  assert.deepEqual(last.helper, { code: "mount-failed", fstabRestored: true, mountedOldWay: true });
  assert.equal(c.paused, false);
  assert.equal(drives._internals.data().noNew[ID], true, "still off, as the admin left it");
  assert.equal(last.after, null);
});

test("a busy drive: nothing changed, said so", async () => {
  world.change = () => ({ ok: false, action: "apply", code: "busy", error: "something still has a file open", fstabRestored: true, mountedOldWay: true });
  await tune.start(ID);
  await finished();
  const last = (await cardOf()).tune.last;
  assert.equal(last.ok, false);
  assert.match(last.message, /still had a file open on the drive, so it was not unmounted — nothing changed/);
  assert.equal(drives.onPath(path.join(movies, "x.mkv")).paused, false);
});

test("a restart in the middle: new downloads put back as they were, the card says what happened", () => {
  const d = drives._internals.data();
  d.noNew[ID] = true;
  d.tunes[ID] = { running: { action: "apply", startedAt: Date.now() - 60000, prevNoNew: false } };
  assert.equal(tune.recover(), 1);
  assert.equal(d.noNew[ID], undefined);
  assert.equal(d.tunes[ID].last.interrupted, true);
  assert.match(d.tunes[ID].last.message, /Aurora restarted in the middle of this/);
  assert.equal(d.tunes[ID].running, undefined);
  assert.equal(tune.recover(), 0);
});

test("the helper's answer is read from its last JSON line; a killed or silent helper is an error, not a crash", async () => {
  const { parse, askHelper } = tune._internals;
  assert.deepEqual(parse('noise\n{"ok":true,"x":1}\n'), { ok: true, x: 1 });
  assert.equal(parse("sudo: something\n"), null);
  const saved = tune.deps.helper;
  try {
    tune.deps.helper = async () => ({ code: 143, stdout: "", stderr: "", killed: true, spawnError: null });
    assert.match((await askHelper(["status", ID], 20000)).error, /did not finish in 20 s/);
    tune.deps.helper = async () => ({ code: null, stdout: "", stderr: "", killed: false, spawnError: "ENOENT" });
    assert.equal((await askHelper(["status", ID], 20000)).missing, "sudo");
  } finally { tune.deps.helper = saved; }
});
