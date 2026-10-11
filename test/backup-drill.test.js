// lib/backup.js, the parts that make a backup something to rely on: what a
// snapshot holds is counted and compared with the one before, a second
// location gets a checked copy, a restore is PROVED in a temp folder (the
// drill), a real restore first snapshots the present, a store that cannot be
// read at boot finds its file in the newest good snapshot — and "is the
// backup on the data's disk?" is told the same way on Windows and Linux.
// Everything happens in temp folders; the real data directory is never used.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const backup = require("../src/lib/backup");
const B = backup._internals;

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `aurora-drill-${label}-`));
const rm = (...dirs) => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const house = (profiles, rowsEach) => {
  const d = { profiles: [], state: {} };
  for (let i = 0; i < profiles; i++) {
    d.profiles.push({ id: `p${i}`, name: `Person ${i}` });
    const progress = {};
    for (let r = 0; r < rowsEach; r++) progress[`m${r}`] = { position: r };
    d.state[`p${i}`] = { progress, titles: { [`t${i}`]: { at: 1 } } };
  }
  return d;
};
const dataFolder = (profiles = 4, rowsEach = 10) => {
  const root = tmp("data");
  const dataDir = path.join(root, "data");
  put(dataDir, "profiles.json", JSON.stringify(house(profiles, rowsEach)));
  put(dataDir, "sessions.json", JSON.stringify({ a: { profileId: "p0" }, b: { profileId: "p1" } }));
  put(dataDir, "settings.json", JSON.stringify({ authMode: "closed" }));
  put(dataDir, "downloads.json", "[]");
  return { root, dataDir, backupDir: path.join(root, "backups") };
};
const T0 = Date.UTC(2026, 9, 8, 3, 15, 0);

test("a snapshot counts the household, and its manifest carries the numbers", async () => {
  const f = dataFolder(4, 10);
  try {
    const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    assert.deepEqual({ profiles: snap.summary.profiles, historyRows: snap.summary.historyRows, sessions: snap.summary.sessions, stores: snap.summary.stores }, { profiles: 4, historyRows: 44, sessions: 2, stores: 4 });
    assert.equal(snap.warnings.length, 0);
    assert.equal(snap.manifest.summary.profiles, 4);
    assert.ok(snap.manifest.summary.newestChangeAt > 0);
    assert.equal((await backup.summaryOf(snap.path)).historyRows, 44);
  } finally { rm(f.root); }
});

test("counts wildly below the previous snapshot are a warning — the 'empty house' is never archived as a good backup", async () => {
  const f = dataFolder(8, 30);
  try {
    const first = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    // the house is replaced by the default one (what a damaged profiles.json used to become)
    put(f.dataDir, "profiles.json", JSON.stringify({ profiles: [{ id: "default", name: "Watcher" }], state: {} }));
    const second = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 + 86400000, previousSummary: first.summary });
    assert.equal(second.warnings.length, 1);
    assert.match(second.warnings[0], /shrank sharply.*the profiles went from 8 to 1.*the watch-history rows went from 248 to 0/);
    // a household that changes a little is fine
    assert.deepEqual(B.shrinkage({ profiles: 8, historyRows: 248 }, { profiles: 7, historyRows: 250 }), []);
    assert.deepEqual(B.shrinkage({ profiles: 1, historyRows: 5 }, { profiles: 0, historyRows: 0 }), [], "too small to judge");
    assert.deepEqual(B.shrinkage(null, { profiles: 3 }), []);
  } finally { rm(f.root); }
});

test("a store of the wrong shape is copied, and said", async () => {
  const f = dataFolder();
  try {
    put(f.dataDir, "profiles.json", "[]");
    const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    assert.ok(snap.warnings.some((w) => /data\/profiles\.json has the wrong shape/.test(w)));
    assert.equal(snap.summary.profiles, null);
  } finally { rm(f.root); }
});

test("the second location: a copy that is checked THERE; a folder that cannot be written is an error, not a silence", async () => {
  const f = dataFolder();
  const mirror = tmp("mirror");
  try {
    const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    const m = await backup.mirrorSnapshot(snap.path, path.join(mirror, "aurora"));
    assert.equal(m.ok, true);
    assert.equal((await backup.verify(m.path)).ok, true);
    assert.deepEqual(fs.readdirSync(path.join(mirror, "aurora")), [snap.name], "no partial file left");
    // a "folder" that is really a file
    const blocked = put(mirror, "not-a-folder", "x");
    const bad = await backup.mirrorSnapshot(snap.path, blocked);
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
    assert.equal((await backup.mirrorSnapshot(path.join(f.root, "notes.txt"), mirror)).ok, false);
  } finally { rm(f.root, mirror); }
});

test("a store's file is found in the newest snapshot that passes its check — in either folder, skipping a damaged one", async () => {
  const f = dataFolder(3, 2);
  const mirror = tmp("mirror");
  try {
    const old = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    put(f.dataDir, "profiles.json", JSON.stringify(house(5, 2)));
    const newer = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: mirror, now: T0 + 86400000 });
    const hit = B.copyFromSnapshotsSync("profiles.json", [f.backupDir, mirror]);
    assert.equal(hit.name, newer.name);
    assert.equal(JSON.parse(hit.text).profiles.length, 5);
    assert.equal(hit.at, T0 + 86400000);
    // the newest is damaged on disk: the older one answers
    const bytes = fs.readFileSync(newer.path);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(newer.path, bytes);
    const fallback = B.copyFromSnapshotsSync("profiles.json", [f.backupDir, mirror]);
    assert.equal(fallback.name, old.name);
    assert.equal(JSON.parse(fallback.text).profiles.length, 3);
    assert.equal(B.copyFromSnapshotsSync("never-existed.json", [f.backupDir, mirror]), null);
    assert.equal(B.copyFromSnapshotsSync("profiles.json", [path.join(f.root, "no-such-folder")]), null);
  } finally { rm(f.root, mirror); }
});

test("a damaged profiles.json with no last-good copy is restored from the backup by the store itself (the two halves together)", async () => {
  const f = dataFolder(6, 3);
  const { JsonStore, _internals: I } = require("../src/lib/jsonstore");
  let s = null;
  const saved = console.error;
  try {
    await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    const file = path.join(f.dataDir, "profiles.json");
    const whole = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length * 0.6))); // cut off at 60 %, as the study did
    const lines = [];
    console.error = (...a) => lines.push(a.join(" "));
    s = new JsonStore(file, () => ({ profiles: [{ id: "default", name: "Watcher" }], state: {} }), {
      backupLookup: (p) => B.copyFromSnapshotsSync(path.basename(p), [f.backupDir]),
    });
    assert.equal(s.data.profiles.length, 6, "the household is back, not 'Watcher'");
    assert.equal(s.safeMode, null);
    assert.ok(lines.some((l) => /RESTORED from the backup aurora-backup-20261008-031500\.tar\.gz/.test(l)));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profiles.length, 6, "and on disk");
    I.instances.delete(s);
  } finally {
    console.error = saved;
    if (s) I.instances.delete(s);
    rm(f.root);
  }
});

test("the restore drill: the newest good snapshot is restored into a temp folder, read as the server would, counted — and nothing live is touched", async () => {
  const f = dataFolder(5, 12);
  const scratch = tmp("scratch");
  try {
    assert.deepEqual({ ok: (await backup.drill({ backupDirs: [f.backupDir], tmpRoot: scratch })).ok, error: (await backup.drill({ backupDirs: [f.backupDir], tmpRoot: scratch })).error }, { ok: false, error: "there is no snapshot to restore" });
    const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    const before = fs.readFileSync(path.join(f.dataDir, "profiles.json"), "utf8");
    const r = await backup.drill({ backupDirs: [f.backupDir, null], tmpRoot: scratch });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot, snap.name);
    assert.deepEqual([r.profiles, r.historyRows, r.sessions], [5, 65, 2]);
    assert.ok(r.newestChangeAt > 0);
    assert.deepEqual(r.problems, []);
    assert.match(backup.drillSentence(r), /aurora-backup-20261008-031500\.tar\.gz restores: 5 profiles, 65 history rows, newest change \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.equal(fs.readFileSync(path.join(f.dataDir, "profiles.json"), "utf8"), before, "live data untouched");
    assert.deepEqual(fs.readdirSync(scratch), [], "the temp folder is removed");
    assert.deepEqual(fs.readdirSync(f.backupDir), [snap.name], "and nothing was added to the backups");
  } finally { rm(f.root, scratch); }
});

test("the drill FAILS when what the snapshot holds would not load: wrong shape, not JSON, no profiles at all", async () => {
  const scratch = tmp("scratch");
  const cases = [
    ["profiles.json", "[]", /profiles\.json is the wrong shape/],
    ["profiles.json", "{ half a file", /profiles\.json is not valid JSON/],
    ["sessions.json", JSON.stringify({ a: "not a row" }), /sessions\.json is the wrong shape/],
  ];
  try {
    for (const [name, content, re] of cases) {
      const f = dataFolder();
      put(f.dataDir, name, content);
      await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
      const r = await backup.drill({ backupDirs: [f.backupDir], tmpRoot: scratch });
      assert.equal(r.ok, false, name);
      assert.match(r.error, re);
      assert.match(backup.drillSentence(r), /FAILED/);
      rm(f.root);
    }
    const f = dataFolder();
    fs.rmSync(path.join(f.dataDir, "profiles.json"));
    await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    const r = await backup.drill({ backupDirs: [f.backupDir], tmpRoot: scratch });
    assert.equal(r.ok, false);
    assert.match(r.error, /profiles\.json is not in the snapshot/);
    rm(f.root);
    assert.deepEqual(fs.readdirSync(scratch), []);
  } finally { rm(scratch); }
});

test("the drill skips a snapshot that fails its check and tests the newest that passes", async () => {
  const f = dataFolder(2, 1);
  const scratch = tmp("scratch");
  try {
    const good = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    const bad = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 + 86400000 });
    fs.writeFileSync(bad.path, fs.readFileSync(bad.path).subarray(0, 200));
    const r = await backup.drill({ backupDirs: [f.backupDir], tmpRoot: scratch });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot, good.name);
  } finally { rm(f.root, scratch); }
});

test("a real restore: the present is snapshotted FIRST, then the data files are put back and the stale last-good copies removed", async () => {
  const f = dataFolder(6, 4);
  try {
    const good = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: T0 });
    // the present: a damaged house, a store the snapshot never had, and good-copies of the damaged state
    put(f.dataDir, "profiles.json", JSON.stringify({ profiles: [{ id: "default", name: "Watcher" }], state: {} }));
    put(f.dataDir, "profiles.json.good1", "the state being replaced");
    put(f.dataDir, "newer-store.json", JSON.stringify({ kept: true }));
    const r = await backup.restoreLive({ archivePath: good.path, dataDir: f.dataDir, backupDir: f.backupDir, now: T0 + 3600000 });
    assert.equal(r.restored, 4);
    assert.equal(r.snapshot, good.name);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "profiles.json"), "utf8")).profiles.length, 6);
    assert.ok(!fs.existsSync(path.join(f.dataDir, "profiles.json.good1")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, "newer-store.json"), "utf8")), { kept: true }, "a file the snapshot does not have is left alone");
    // the way back exists and holds the state from before the restore
    const pre = path.join(f.backupDir, r.preRestore);
    assert.equal((await backup.verify(pre)).ok, true);
    assert.equal((await backup.summaryOf(pre)).profiles, 1);
    // a damaged snapshot changes nothing
    fs.writeFileSync(good.path, fs.readFileSync(good.path).subarray(0, 300));
    await assert.rejects(backup.restoreLive({ archivePath: good.path, dataDir: f.dataDir, backupDir: f.backupDir }), /damaged.*nothing was changed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "profiles.json"), "utf8")).profiles.length, 6);
  } finally { rm(f.root); }
});

test("same volume or not: by the device the OS reports; by drive letter or share where it reports none; for folders that do not exist yet", () => {
  // Linux: two mounts, device ids differ
  const linux = { platform: "linux", exists: (p) => ["/", "/srv", "/srv/aurora", "/srv/aurora/data", "/mnt", "/mnt/nas"].includes(p), stat: (p) => ({ dev: p.startsWith("/mnt/nas") ? 2049 : 2050 }) };
  assert.equal(B.sameVolume("/srv/aurora/data", "/srv/aurora/data/backups", linux), true);
  assert.equal(B.sameVolume("/srv/aurora/data", "/mnt/nas/aurora-backups/not/made/yet", linux), false, "judged by the nearest folder that exists");
  assert.equal(B.volumeKey("/mnt/nas/x", linux), "dev:2049");
  // Windows: volume serials
  const win = { platform: "win32", exists: (p) => /^[CD]:\\?$/i.test(p) || p === "C:\\elia" || p === "D:\\backups", stat: (p) => ({ dev: /^d:/i.test(p) ? 111 : 222 }) };
  assert.equal(B.sameVolume("C:\\elia\\aurora\\data", "C:\\elia\\aurora\\data\\backups", win), true);
  assert.equal(B.sameVolume("C:\\elia\\aurora\\data", "D:\\backups\\aurora", win), false);
  // Windows with no device id: the drive letter, case-insensitively; a share is its own volume
  const noDev = { platform: "win32", exists: () => true, stat: () => ({ dev: 0 }) };
  assert.equal(B.sameVolume("C:\\a", "c:\\b", noDev), true);
  assert.equal(B.sameVolume("C:\\a", "E:\\b", noDev), false);
  assert.equal(B.sameVolume("C:\\a", "\\\\nas\\share\\aurora", noDev), false);
  assert.equal(B.sameVolume("\\\\nas\\share\\a", "\\\\NAS\\share\\b", noDev), true);
  // nothing can be told: null, never a guess
  assert.equal(B.sameVolume("/a", "/b", { platform: "linux", exists: () => true, stat: () => ({ dev: 0 }) }), null);
  assert.equal(B.sameVolume("/a", "/b", { platform: "linux", exists: () => true, stat: () => { throw new Error("EIO"); } }), null);
  // and for real, on this machine
  assert.equal(B.sameVolume(os.tmpdir(), path.join(os.tmpdir(), "does", "not", "exist", "yet")), true);
});

test("is any backup off the data's disk? — the folder itself, or the second location", () => {
  const deps = { platform: "linux", exists: () => true, stat: (p) => ({ dev: p.startsWith("/mnt") ? 9 : 1 }) };
  const cfg = (backupDir, mirror) => ({ DATA_DIR: "/srv/aurora/data", BACKUP_DIR: backupDir, BACKUP_MIRROR_DIR: mirror });
  assert.equal(backup.locations(cfg("/srv/aurora/data/backups", null), deps).offDisk, false, "the default: beside the data");
  assert.equal(backup.locations(cfg("/mnt/nas/aurora", null), deps).offDisk, true);
  const both = backup.locations(cfg("/srv/aurora/data/backups", "/mnt/usb/aurora"), deps);
  assert.deepEqual([both.sameDiskAsData, both.mirrorSameDisk, both.offDisk], [true, false, true], "the default folder kept, a second one elsewhere");
  assert.equal(backup.locations(cfg("/srv/aurora/data/backups", "/srv/other"), deps).offDisk, false, "a second folder on the same disk does not count");
});

test("the healer's reading of the drill and of the stores", () => {
  const { judgeDrill, judgeStores } = require("../src/lib/healer-checks/system")._internals;
  const now = 1e12;
  const DAY = 86400000;
  assert.equal(judgeDrill({ drill: null, oldestAt: now - 2 * DAY }, now).finding, undefined, "a new server is given a week");
  assert.equal(judgeDrill({ drill: null, oldestAt: now - 9 * DAY }, now).finding.level, "warn");
  assert.match(judgeDrill({ drill: null, oldestAt: now - 9 * DAY }, now).finding.press.action, /backup-drill/);
  assert.equal(judgeDrill({ drill: { ok: true, at: now - 3 * DAY } }, now).finding, undefined);
  assert.match(judgeDrill({ drill: { ok: true, at: now - 3 * DAY } }, now).words, /a restore was tested 3 d ago/);
  assert.equal(judgeDrill({ drill: { ok: true, at: now - 40 * DAY } }, now).finding.level, "warn");
  const failed = judgeDrill({ drill: { ok: false, at: now - DAY, snapshot: "aurora-backup-x.tar.gz", error: "profiles.json is the wrong shape" } }, now);
  assert.equal(failed.finding.level, "fail");
  assert.match(failed.finding.text, /wrong shape/);
  assert.equal(judgeDrill({ drill: { ok: false, at: now, error: "there is no snapshot to restore" }, oldestAt: null }, now).finding, undefined, "nothing to test yet is not a failure");

  const fine = judgeStores({ stores: [{ name: "profiles.json", kind: "critical" }, { name: "x.json", kind: "cache" }], safeMode: [], unsaved: [], recoveries: [] }, now);
  assert.equal(fine.status, "ok");
  assert.match(fine.summary, /1 store saved and readable/);
  const safe = judgeStores({ stores: [{ name: "profiles.json", kind: "critical", safeMode: { problem: "not valid JSON", keptAs: "profiles.json.corrupt-1" } }], safeMode: ["profiles.json"], unsaved: [], recoveries: [{ store: "profiles.json", safeMode: true, at: now }] }, now);
  assert.equal(safe.status, "fail");
  assert.match(safe.findings[0].text, /writes NOTHING to that file.*People see an empty house/);
  assert.match(safe.summary, /SAFE MODE: profiles\.json/);
  const recovered = judgeStores({ stores: [], safeMode: [], unsaved: [], recoveries: [{ store: "downloads.json", at: now - 3600000, acknowledged: false }, { store: "old.json", at: now - 9 * DAY, acknowledged: true }] }, now, (r) => `${r.store} was restored`);
  assert.equal(recovered.status, "warn");
  assert.equal(recovered.findings.length, 1, "an acknowledged recovery is no longer a finding");
  const stuck = judgeStores({ stores: [{ name: "profiles.json", unsavedSince: now - 5 * 60000, failures: 150 }], safeMode: [], unsaved: ["profiles.json"], recoveries: [] }, now);
  assert.equal(stuck.status, "fail");
  assert.match(stuck.findings[0].title, /cannot be saved/);
  const blip = judgeStores({ stores: [{ name: "profiles.json", unsavedSince: now - 3000, failures: 1 }], safeMode: [], unsaved: ["profiles.json"], recoveries: [] }, now);
  assert.equal(blip.status, "ok", "a file held for a few seconds is not a finding");
});
