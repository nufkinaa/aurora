// lib/drivecopies.js + drivecopies-ops.js + restoreboot.js: a copy of the
// household's data on every drive. Rotation (7 daily + 4 weekly), the check
// of each copy (written, read back, its checksum and every file inside), the
// skip rules (switched off, someone watching, a restore under way, a drive not
// answering or full, a failed copy that rotates nothing away), the secrets
// left out of config.json, and the restore (staged; at the next start the
// current data is copied aside, the copy put in place, an interrupted or
// failed one put back). Temp folders only — never the real data folder.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const backup = require("../src/lib/backup");
const ops = require("../src/lib/drivecopies-ops");
const dc = require("../src/lib/drivecopies");
const restoreboot = require("../src/lib/restoreboot");

const DAY = 24 * 3600 * 1000;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drivecopies-test-"));
process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
let n = 0;
const tmp = (label) => { const d = path.join(SCRATCH, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const profiles = (names, rows = {}) => JSON.stringify({ profiles: names.map((x, i) => ({ id: `p${i}`, name: x })), state: { p0: { progress: rows } } });

// A server root: config.json with secrets, .env, a data folder.
const fakeRoot = () => {
  const root = tmp("root");
  const dataDir = path.join(root, "data");
  put(dataDir, "profiles.json", profiles(["Noa", "Ari"], { m1: { position: 61 } }));
  put(dataDir, "sessions.json", JSON.stringify({ h1: { profileId: "p0" } }));
  put(dataDir, "settings.json", JSON.stringify({ authMode: "open" }));
  put(dataDir, "watch-history.json", "[]");
  put(dataDir, "drives.json", JSON.stringify({ scores: {} }));
  put(dataDir, "downloads.json", "[]");
  put(dataDir, "reports.json", "[]");
  put(dataDir, "usage/events.jsonl", "{\"e\":\"play\"}\n");
  put(dataDir, "avatars/p0.jpg", Buffer.from([1, 2, 3]));
  put(dataDir, "metadata-cache.json", "{}"); // a cache: not in a copy
  put(dataDir, "cache/posters/a.jpg", Buffer.alloc(100)); // films' art: not in a copy
  put(root, "config.json", JSON.stringify({
    port: 4000, adminName: "Elia", adminPassword: "hunter2-not-real", tmdbApiKey: "tmdb-not-real", openrouterApiKey: "or-not-real",
    notifications: { ntfy: { topic: "secret-topic" } }, healthPingUrl: "https://ping.example/abc",
    libraries: { movies: ["D:\\Movies"], shows: [] }, upstream: { someToken: "tok-not-real", nested: { clientSecret: "s" } },
    passwordReset: { email: { enabled: true, from: "a@b.c", smtp: { host: "smtp.x", user: "me" } } },
  }));
  put(root, ".env", "AURORA_ADMIN_PASSWORD=not-real\n");
  return { root, dataDir, backupDir: path.join(dataDir, "backups") };
};

// A staged archive the way drivecopies.stage makes it.
const stageOf = async (r, now) => {
  const dir = tmp("stage");
  const snap = await backup.createSnapshot({ dataDir: r.dataDir, backupDir: dir, now, configFiles: [] });
  const buf = fs.readFileSync(snap.path);
  return { path: snap.path, name: snap.name, size: snap.size, sha256: backup._internals.sha256(buf) };
};
const copy = (dirDrive, st, now, extra = {}) => ops.backupCopy({ dir: dirDrive, src: st.path, sha256: st.sha256, size: st.size, now, keep: dc.KEEP, ...extra });
const namesIn = (dir) => fs.readdirSync(dir).filter((x) => backup._internals.isSnapshotName(x)).sort();

// ---------------------------------------------------------------- rotation
test("rotation: two months of daily copies leave the last 7 dailies and 4 weeklies, nothing else of ours, nothing of anyone else's", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  put(drive, "notes.txt", "mine"); // not ours: never touched
  put(drive, "aurora-backup-notes.tar.gz", "not a backup's name"); // not ours either
  const start = Date.UTC(2026, 8, 1, 2, 0, 0);
  let res;
  for (let d = 0; d < 60; d++) {
    const now = start + d * DAY;
    const st = await stageOf(r, now);
    res = copy(drive, st, now);
    assert.equal(res.ok, true);
  }
  const kept = namesIn(drive);
  const want = backup.prune(kept.map((name) => ({ name })), start + 59 * DAY, dc.KEEP).keep;
  assert.deepEqual(kept.slice().sort(), want.slice().sort());
  assert.equal(kept.length, 11, `7 daily + 4 weekly, got ${kept.length}: ${kept.join(", ")}`);
  // the newest 7 days are all there
  for (let d = 53; d < 60; d++) assert.ok(kept.includes(backup._internals.nameFor(start + d * DAY)), `day ${d} kept`);
  assert.ok(fs.existsSync(path.join(drive, "notes.txt")));
  assert.ok(fs.existsSync(path.join(drive, "aurora-backup-notes.tar.gz")));
  // what the drive's listing says after the copy
  assert.equal(res.copies.length, 11);
  assert.ok(res.copies.every((c) => c.ok));
});

test("rotation: copies made by hand the same day are all kept for a day", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const t = Date.UTC(2026, 9, 1, 9, 0, 0);
  for (let i = 0; i < 4; i++) copy(drive, await stageOf(r, t + i * 3600e3), t + i * 3600e3);
  assert.equal(namesIn(drive).length, 4);
});

// ------------------------------------------------------------ verification
test("verification: a copy the drive garbles is caught before it gets its name, and older copies stay", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const t0 = Date.UTC(2026, 9, 1, 3, 0, 0);
  for (let d = 0; d < 9; d++) copy(drive, await stageOf(r, t0 + d * DAY), t0 + d * DAY);
  const before = namesIn(drive);
  ops.deps.afterWrite = (partial) => { const b = fs.readFileSync(partial); b[b.length - 40] ^= 0xff; fs.writeFileSync(partial, b); };
  try {
    const st = await stageOf(r, t0 + 30 * DAY);
    assert.throws(() => copy(drive, st, t0 + 30 * DAY), /does not match the original|failed its check/);
  } finally { ops.deps.afterWrite = null; }
  assert.deepEqual(namesIn(drive), before, "a failed copy rotates nothing away");
  assert.ok(!fs.readdirSync(drive).some((x) => x.endsWith(".partial")), "no half copy left behind");
});

test("verification: a staged archive that changed since it was made is refused", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const st = await stageOf(r, Date.UTC(2026, 9, 2));
  assert.throws(() => copy(drive, { ...st, sha256: "0".repeat(64) }, Date.UTC(2026, 9, 2)), /changed before it was copied/);
  assert.deepEqual(namesIn(drive), []);
});

test("verification: a copy damaged later on the drive is listed as damaged, holds no rotation place, and is never the reason a good one goes", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const t0 = Date.UTC(2026, 9, 1, 3, 0, 0);
  for (let d = 0; d < 8; d++) copy(drive, await stageOf(r, t0 + d * DAY), t0 + d * DAY);
  const victim = backup._internals.nameFor(t0 + 6 * DAY);
  const abs = path.join(drive, victim);
  const b = fs.readFileSync(abs); b[Math.floor(b.length / 2)] ^= 0x55; fs.writeFileSync(abs, b);
  const list = ops.backupList({ dir: drive }).copies;
  const bad = list.find((c) => c.name === victim);
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  assert.equal(list.filter((c) => c.ok).length, 6); // (7 were kept: days 1-7; one of them is now damaged)
  // the next copy: the damaged one does not count as one of the 7 dailies
  const res = copy(drive, await stageOf(r, t0 + 8 * DAY), t0 + 8 * DAY);
  assert.equal(res.ok, true);
  const good = res.copies.filter((c) => c.ok).map((c) => c.name);
  for (let d = 2; d <= 8; d++) if (d !== 6) assert.ok(good.includes(backup._internals.nameFor(t0 + d * DAY)), `day ${d} still there`);
  assert.ok(namesIn(drive).includes(victim), "a damaged copy is shown, not silently deleted");
  // the inspect of a damaged copy says so
  const look = ops.backupInspect({ dir: drive, name: victim });
  assert.equal(look.ok, false);
  // and fetching it for a restore is refused
  assert.throws(() => ops.backupFetch({ dir: drive, name: victim, dst: path.join(tmp("dst"), victim) }), /damaged/);
});

test("verification: only names like a backup's are read — no path tricks", () => {
  const drive = tmp("drive");
  for (const name of ["../profiles.json", "..\\x.tar.gz", "aurora-backup-20261301-000000.tar.gz", "x.tar.gz"]) {
    assert.throws(() => ops.backupInspect({ dir: drive, name }), /not a backup's name/);
    assert.throws(() => ops.backupFetch({ dir: drive, name, dst: path.join(drive, "o") }), /not a backup's name/);
  }
});

// -------------------------------------------------------------- skip rules
test("a full drive is skipped with nothing written and nothing removed", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const t0 = Date.UTC(2026, 9, 1, 3);
  for (let d = 0; d < 3; d++) copy(drive, await stageOf(r, t0 + d * DAY), t0 + d * DAY);
  const before = namesIn(drive);
  const real = ops.deps.statfs;
  ops.deps.statfs = () => ({ free: 1000, total: 1e9 });
  try {
    const res = copy(drive, await stageOf(r, t0 + 40 * DAY), t0 + 40 * DAY);
    assert.equal(res.skipped, "full");
    assert.equal(res.copies.length, 3);
  } finally { ops.deps.statfs = real; }
  assert.deepEqual(namesIn(drive), before);
});

test("a copy with warnings (noPrune) rotates nothing away", async () => {
  const r = fakeRoot();
  const drive = tmp("drive");
  const t0 = Date.UTC(2026, 9, 1, 3);
  for (let d = 0; d < 20; d++) copy(drive, await stageOf(r, t0 + d * DAY), t0 + d * DAY, { noPrune: true });
  assert.equal(namesIn(drive).length, 20);
});

// The server side: drivecopies with made-up drives, the ops run in-process.
const harness = (r, drives, { watching = 0, supervised = "keeper", askHook = null } = {}) => {
  const settings = { data: {}, save() {} };
  const health = [];
  let clock = Date.UTC(2026, 9, 10, 12, 0, 0);
  dc._internals.reset();
  Object.assign(dc.deps, {
    now: () => clock,
    config: () => ({ DATA_DIR: r.dataDir, BACKUP_DIR: r.backupDir, ROOT: r.root, BACKUPS: true }),
    settings: () => settings,
    watchingNow: () => watching,
    tmpdir: () => tmp("t"),
    health: (fn) => fn({ raise: (...a) => health.push(["raise", ...a]), clear: (...a) => health.push(["clear", ...a]) }),
    supervisor: () => ({ detect: () => supervised, NOT_SUPERVISED: "Nothing supervises this server.", requestRestart: () => {} }),
    restartSoon: () => { restarts++; },
    drives: () => ({
      list: async () => drives.map((d) => ({ inUse: true, gone: false, answering: true, paused: false, network: false, folders: [{ kind: "movies", dir: path.join(d.mount, "Aurora", "Movies") }], ...d })),
      onPath: (p) => { const d = drives.find((x) => path.resolve(p).startsWith(path.resolve(x.mount) + path.sep)); return d ? { drive: { id: d.id } } : null; },
    }),
    ask: async (op, args) => {
      if (askHook) { const h = await askHook(op, args); if (h) return h; }
      try { return { ok: true, result: ops[op](args) }; } catch (e) { return { ok: false, error: e.message }; }
    },
  });
  let restarts = 0;
  return { settings, health, set: (ms) => { clock = ms; }, at: () => clock, restarts: () => restarts };
};

test("the switch is OFF until the admin allows it; then the copy waits for its time, for nobody watching, and is not made twice", async () => {
  const r = fakeRoot();
  const a = tmp("driveA"); const b = tmp("driveB");
  let watching = 0;
  const h = harness(r, [{ id: a, name: "A", mount: a }, { id: b, name: "B", mount: b }]);
  dc.deps.watchingNow = () => watching;
  assert.equal(await dc.tick(), "off");
  assert.equal((await dc.status()).enabled, false);
  assert.equal(dc.SWITCH_LABEL, "Keep a copy of the household's data on every drive");
  assert.match(dc.setSettings({ time: "25:00" }).error, /HH:MM/);
  dc.setSettings({ enabled: true, time: "04:00" });
  // 10 Oct 12:00 local: today's 04:00 has passed and nothing was made → due
  h.set(new Date(2026, 9, 10, 12, 0).getTime());
  watching = 1;
  assert.equal(await dc.tick(), "watching");
  assert.match((await dc.status()).waiting, /someone is watching/);
  watching = 0;
  assert.equal(await dc.tick(), "ran");
  for (const d of [a, b]) assert.equal(namesIn(path.join(d, "Aurora", ".backups")).length, 1);
  assert.equal(await dc.tick(), "not due");
  // next day before 04:00: still not due; after: due again
  h.set(new Date(2026, 9, 11, 3, 0).getTime());
  assert.equal(await dc.tick(), "not due");
  h.set(new Date(2026, 9, 11, 4, 1).getTime());
  assert.equal(await dc.tick(), "ran");
  for (const d of [a, b]) assert.equal(namesIn(path.join(d, "Aurora", ".backups")).length, 2);
  const st = await dc.status();
  assert.equal(st.drives.length, 2);
  for (const d of st.drives) { assert.equal(d.status, "ok"); assert.ok(d.lastSize > 0); assert.equal(d.copies.length, 2); }
  assert.ok(st.nextAt > h.at());
});

test("a drive that isn't answering is skipped and tried again after half an hour; the others are copied", async () => {
  const r = fakeRoot();
  const a = tmp("driveA"); const b = tmp("driveB");
  let hang = true;
  const h = harness(r, [{ id: a, name: "A", mount: a, network: true }, { id: b, name: "B", mount: b }], {
    askHook: (op, args) => (hang && args.dir && args.dir.startsWith(a) ? { ok: false, timeout: true } : null),
  });
  dc.setSettings({ enabled: true, time: "04:00" });
  h.set(new Date(2026, 9, 10, 5, 0).getTime());
  assert.equal(await dc.tick(), "ran");
  let st = await dc.status();
  const sa = st.drives.find((d) => d.id === a);
  assert.equal(sa.status, "skipped");
  assert.equal(sa.why, "not-answering");
  assert.match(sa.note, /did not answer/);
  assert.equal(st.drives.find((d) => d.id === b).status, "ok");
  // ten minutes later: not yet
  h.set(h.at() + 10 * 60e3);
  assert.equal(await dc.tick(), "not due");
  // half an hour later, the drive answers again: only it is copied
  hang = false;
  h.set(h.at() + 25 * 60e3);
  assert.equal(await dc.tick(), "ran");
  st = await dc.status();
  assert.equal(st.drives.find((d) => d.id === a).status, "ok");
  assert.equal(namesIn(path.join(b, "Aurora", ".backups")).length, 1, "the drive that had its copy got no second one");
  // a drive the drives module already knows is down is not even asked
  const c = tmp("driveC");
  harness(r, [{ id: c, name: "C", mount: c, answering: false }]);
  dc.setSettings({ enabled: true });
  const run = await dc.run({ force: true });
  assert.equal(run.skipped, 1);
  assert.equal(fs.existsSync(path.join(c, "Aurora", ".backups")), false);
});

test("a copy that keeps failing raises one warning after 3 days; a full drive is only a note", async () => {
  const r = fakeRoot();
  const a = tmp("driveA"); const f = tmp("driveF");
  const realStatfs = ops.deps.statfs;
  ops.deps.statfs = (dir) => (dir.startsWith(f) ? { free: 10, total: 1e9 } : realStatfs(dir));
  try {
    const h = harness(r, [{ id: a, name: "A", mount: a }, { id: f, name: "F", mount: f }], {
      askHook: (op, args) => (op === "backupCopy" && args.dir.startsWith(a) ? { ok: false, error: "EIO: i/o error, write" } : null),
    });
    dc.setSettings({ enabled: true, time: "04:00" });
    h.set(h.at());
    await dc.run({ force: true });
    let st = await dc.status();
    assert.equal(st.drives.find((d) => d.id === a).status, "failed");
    assert.match(st.drives.find((d) => d.id === a).error, /EIO/);
    const full = st.drives.find((d) => d.id === f);
    assert.equal(full.status, "skipped");
    assert.match(full.note, /full/);
    assert.ok(!h.health.some((x) => x[0] === "raise"), "no warning on the first day");
    h.set(h.at() + 3 * DAY + 1000);
    await dc.run({ force: true });
    const raised = h.health.filter((x) => x[0] === "raise");
    assert.equal(raised.length, 1);
    assert.match(raised[0][3], new RegExp(a.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.ok(!raised[0][3].includes(f), "the full drive is not part of the warning");
    st = await dc.status();
    assert.equal(st.lastRun.failed, 1);
  } finally { ops.deps.statfs = realStatfs; }
});

test("the drive that holds the daily backups gets no second copy beside them: it is listed as covered", async () => {
  const r = fakeRoot();
  const sys = path.dirname(r.dataDir); // the "drive" the data (and data/backups) is on
  const a = tmp("driveA");
  harness(r, [{ id: sys, name: "System", mount: sys }, { id: a, name: "A", mount: a }]);
  await backup.createSnapshot({ dataDir: r.dataDir, backupDir: r.backupDir, configFiles: [] });
  dc.setSettings({ enabled: true });
  const run = await dc.run({ force: true });
  assert.equal(run.drives, 1);
  assert.equal(fs.existsSync(path.join(sys, "Aurora")), false);
  const st = await dc.status();
  const cov = st.drives.find((d) => d.id === sys);
  assert.equal(cov.covered, true);
  assert.equal(cov.status, "ok");
  assert.equal(cov.copies.length, 1);
});

test("where the copies go: next to the drive's Aurora folder; a Linux system disk is not written at its top", () => {
  const { dirFor } = dc._internals;
  assert.equal(dirFor({ mount: path.resolve("/mnt/x"), folders: [{ kind: "movies", dir: path.resolve("/mnt/x/Aurora/Movies") }] }), path.join(path.resolve("/mnt/x"), "Aurora", ".backups"));
  assert.equal(dirFor({ mount: path.resolve("/mnt/y"), folders: [{ kind: "shows", dir: path.resolve("/mnt/y/media/TV") }] }), path.join(path.resolve("/mnt/y"), "Aurora", ".backups"));
  if (process.platform !== "win32") assert.equal(dirFor({ mount: "/", folders: [{ kind: "movies", dir: "/opt/aurora/media/Movies" }] }), "/opt/aurora/media/Aurora/.backups");
});

test("the secrets are left out of config.json (not encrypted), and .env is not in the copy at all", async () => {
  const r = fakeRoot();
  const a = tmp("driveA");
  harness(r, [{ id: a, name: "A", mount: a }]);
  dc.setSettings({ enabled: true });
  await dc.run({ force: true });
  const dir = path.join(a, "Aurora", ".backups");
  const [name] = namesIn(dir);
  const out = tmp("unpacked");
  await backup.restore(path.join(dir, name), { into: out });
  const cfg = JSON.parse(fs.readFileSync(path.join(out, "config", "config.json"), "utf8"));
  for (const k of ["adminPassword", "tmdbApiKey", "openrouterApiKey", "notifications", "healthPingUrl"]) assert.ok(!(k in cfg), `${k} left out`);
  assert.ok(!("someToken" in cfg.upstream) && !("clientSecret" in cfg.upstream.nested), "nested secrets left out");
  assert.equal(cfg.adminName, "Elia");
  assert.deepEqual(cfg.libraries.movies, ["D:\\Movies"]);
  assert.equal(cfg.passwordReset.email.smtp.host, "smtp.x");
  assert.equal(fs.existsSync(path.join(out, "config", ".env")), false);
  const all = fs.readFileSync(path.join(dir, name));
  const text = require("zlib").gunzipSync(all).toString("latin1");
  for (const s of ["hunter2-not-real", "tmdb-not-real", "or-not-real", "secret-topic", "tok-not-real", "ping.example", "AURORA_ADMIN_PASSWORD"]) assert.ok(!text.includes(s), `${s} is not anywhere in the copy`);
  const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(m.kind, "drive-copy");
  assert.ok(m.secretsLeftOut.includes("adminPassword") && m.secretsLeftOut.includes(".env"));
  // the household is there: stores, usage, avatars — and no caches, no films' art
  for (const f of ["profiles.json", "sessions.json", "settings.json", "watch-history.json", "drives.json", "downloads.json", "reports.json", "usage/events.jsonl", "avatars/p0.jpg"]) assert.ok(fs.existsSync(path.join(out, "data", ...f.split("/"))), f);
  assert.equal(fs.existsSync(path.join(out, "data", "metadata-cache.json")), false);
  assert.equal(fs.existsSync(path.join(out, "data", "cache")), false);
});

test("the schedule: the newest due moment, and a copy made after it is not due again", () => {
  const { latestScheduled, isDue, RETRY_MS } = dc._internals;
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  assert.equal(latestScheduled(at(10, 12, 0), "04:00"), at(10, 4, 0));
  assert.equal(latestScheduled(at(10, 3, 59), "04:00"), at(9, 4, 0));
  assert.equal(isDue({}, at(10, 12, 0), "04:00"), true);
  assert.equal(isDue({ lastOkAt: at(10, 4, 5) }, at(10, 23, 0), "04:00"), false);
  assert.equal(isDue({ lastOkAt: at(10, 4, 5) }, at(11, 4, 0), "04:00"), true);
  assert.equal(isDue({ lastAttemptAt: at(10, 4, 5) }, at(10, 4, 20), "04:00"), false);
  assert.equal(isDue({ lastAttemptAt: at(10, 4, 5) }, at(10, 4, 5) + RETRY_MS, "04:00"), true);
});

// ---------------------------------------------------------------- restore
test("restore: needs the typed word and a supervisor; then it is staged and the server restarts — and no copy is made meanwhile", async () => {
  const r = fakeRoot();
  const a = tmp("driveA");
  let h = harness(r, [{ id: a, name: "A", mount: a }], { supervised: null });
  dc.setSettings({ enabled: true });
  await dc.run({ force: true });
  const [name] = namesIn(path.join(a, "Aurora", ".backups"));
  assert.match((await dc.restore({ location: a, name, confirm: "yes" })).error, /type RESTORE/);
  const ns = await dc.restore({ location: a, name, confirm: "RESTORE" });
  assert.equal(ns.status, 409);
  assert.match(ns.error, /Nothing was restored/);
  assert.equal(fs.existsSync(path.join(r.dataDir, "restore-pending.json")), false);

  h = harness(r, [{ id: a, name: "A", mount: a }]);
  dc.setSettings({ enabled: true });
  const look = await dc.inspect({ location: a, name });
  assert.equal(look.ok, true);
  assert.equal(look.summary.profiles, 2);
  assert.ok(look.files.some((f) => f.path === "data/profiles.json"));
  assert.equal((await dc.inspect({ location: "nowhere", name })).status, 404);
  const ok = await dc.restore({ location: a, name, confirm: "restore" });
  assert.equal(ok.ok, true);
  assert.equal(h.restarts(), 1);
  assert.ok(fs.existsSync(path.join(r.dataDir, "restore-pending.json")));
  assert.ok(fs.existsSync(path.join(r.dataDir, ".restore-pending", name)));
  // never while a restore runs
  assert.equal(await dc.tick(), "restoring");
  assert.equal((await dc.runNow()).status, 409);
  assert.equal((await dc.restore({ location: a, name, confirm: "RESTORE" })).status, 409);
});

const stageRestore = async (r, archive, extra = {}) => {
  const name = path.basename(archive);
  fs.mkdirSync(path.join(r.dataDir, ".restore-pending"), { recursive: true });
  fs.copyFileSync(archive, path.join(r.dataDir, ".restore-pending", name));
  fs.writeFileSync(path.join(r.dataDir, "restore-pending.json"), JSON.stringify({ name, sha256: backup._internals.sha256(fs.readFileSync(archive)), requestedAt: Date.now(), location: "x", ...extra }));
  return name;
};

test("restore at the next start: the current data is copied aside, the copy goes in place, the data comes back", async () => {
  const r = fakeRoot();
  const snap = await backup.createSnapshot({ dataDir: r.dataDir, backupDir: tmp("d"), configFiles: [] });
  // the household changes after the copy: a profile gone, a journal written, a new store
  put(r.dataDir, "profiles.json", profiles(["Noa"]));
  put(r.dataDir, "profiles.json.good1", profiles(["Noa"]));
  put(r.dataDir, "watch-journal.json", JSON.stringify({ v: 1, rows: { p0: { progress: { m9: { position: 5 } } } } }));
  put(r.dataDir, "requests.json", "[\"new\"]");
  const cfgBefore = fs.readFileSync(path.join(r.root, "config.json"), "utf8");
  const name = await stageRestore(r, snap.path);
  const res = restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir });
  assert.equal(res.applied, true, JSON.stringify(res));
  // the data is back
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "profiles.json"), "utf8")).profiles.length, 2);
  assert.equal(fs.existsSync(path.join(r.dataDir, "profiles.json.good1")), false, "the last-good copy of the replaced state is gone");
  assert.equal(fs.existsSync(path.join(r.dataDir, "watch-journal.json")), false, "a newer journal is not laid over the restored profiles");
  assert.equal(fs.readFileSync(path.join(r.dataDir, "requests.json"), "utf8"), "[\"new\"]", "a file the copy does not have is left alone");
  assert.equal(fs.readFileSync(path.join(r.root, "config.json"), "utf8"), cfgBefore, "config.json is never touched");
  // the data from before is kept aside, twice
  const last = JSON.parse(fs.readFileSync(path.join(r.dataDir, "restore-last.json"), "utf8"));
  assert.equal(last.status, "done");
  assert.equal(last.name, name);
  const aside = path.join(r.dataDir, last.aside);
  assert.equal(JSON.parse(fs.readFileSync(path.join(aside, "profiles.json"), "utf8")).profiles.length, 1);
  assert.ok(fs.existsSync(path.join(aside, "watch-journal.json")));
  assert.ok(fs.existsSync(path.join(aside, "usage", "events.jsonl")));
  const before = path.join(r.backupDir, last.beforeSnapshot);
  assert.equal((await backup.verify(before)).ok, true);
  assert.equal((await backup.summaryOf(before)).profiles, 1);
  // the request is gone: the next start restores nothing
  assert.equal(fs.existsSync(path.join(r.dataDir, "restore-pending.json")), false);
  assert.equal(fs.existsSync(path.join(r.dataDir, ".restore-pending")), false);
  assert.equal(restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir }).skipped, "nothing to restore");
  // the aside folder and the request files are never in a backup
  const snap2 = await backup.createSnapshot({ dataDir: r.dataDir, backupDir: tmp("d2"), configFiles: [] });
  assert.ok(!snap2.manifest.files.some((f) => /before-restore|restore-last|restore-pending/.test(f.path)));
});

test("restore at the next start: a request that is too old, or a damaged copy, changes nothing", async () => {
  const r = fakeRoot();
  const snap = await backup.createSnapshot({ dataDir: r.dataDir, backupDir: tmp("d"), configFiles: [] });
  put(r.dataDir, "profiles.json", profiles(["Solo"]));
  await stageRestore(r, snap.path, { requestedAt: Date.now() - 31 * 60e3 });
  assert.equal(restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir }).skipped, "too old");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "profiles.json"), "utf8")).profiles[0].name, "Solo");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "restore-last.json"), "utf8")).status, "expired");

  const name = await stageRestore(r, snap.path);
  const p = path.join(r.dataDir, ".restore-pending", name);
  const b = fs.readFileSync(p); b[b.length >> 1] ^= 1; fs.writeFileSync(p, b);
  assert.ok(restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir }).failed);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "profiles.json"), "utf8")).profiles[0].name, "Solo");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "restore-last.json"), "utf8")).status, "failed");
  assert.ok(!fs.readdirSync(r.dataDir).some((x) => x.startsWith("before-restore-")), "nothing was set aside for a copy that was never used");
});

test("restore at the next start: a failure half-way puts the data from before back; so does a start after a crash half-way", async () => {
  const r = fakeRoot();
  const snap = await backup.createSnapshot({ dataDir: r.dataDir, backupDir: tmp("d"), configFiles: [] });
  put(r.dataDir, "profiles.json", profiles(["Solo"]));
  fs.rmSync(path.join(r.dataDir, "usage"), { recursive: true });
  // a folder where the copy's usage file must go: that write fails
  fs.mkdirSync(path.join(r.dataDir, "usage", "events.jsonl"), { recursive: true });
  await stageRestore(r, snap.path);
  const res = restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir });
  assert.ok(res.failed, JSON.stringify(res));
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "profiles.json"), "utf8")).profiles[0].name, "Solo", "the data from before is back");
  const last = JSON.parse(fs.readFileSync(path.join(r.dataDir, "restore-last.json"), "utf8"));
  assert.equal(last.status, "failed");
  assert.match(last.error, /put back/);

  // a run that died while applying: the file still says "applying"
  fs.rmSync(path.join(r.dataDir, "usage"), { recursive: true });
  const aside = path.join(r.dataDir, "before-restore-crash");
  put(aside, "profiles.json", profiles(["Before", "Crash"]));
  put(r.dataDir, "profiles.json", profiles(["Half", "Way", "There"]));
  put(r.dataDir, "added-by-restore.json", "{}");
  fs.writeFileSync(path.join(r.dataDir, "restore-last.json"), JSON.stringify({ status: "applying", name: snap.name, aside: "before-restore-crash", added: ["added-by-restore.json"] }));
  restoreboot.applyPendingSync({ dataDir: r.dataDir, backupDir: r.backupDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dataDir, "profiles.json"), "utf8")).profiles.map((x) => x.name), ["Before", "Crash"]);
  assert.equal(fs.existsSync(path.join(r.dataDir, "added-by-restore.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, "restore-last.json"), "utf8")).status, "failed");
});

test("in its own process (lib/drives/run.js, the lowest priority): the copy lands; a hung drive only costs the deadline", async () => {
  const run = require("../src/lib/drives/run");
  const r = fakeRoot();
  const drive = tmp("drive");
  const st = await stageOf(r, Date.UTC(2026, 9, 3, 4));
  const res = await run.ask("backupCopy", { dir: path.join(drive, "Aurora", ".backups"), src: st.path, sha256: st.sha256, size: st.size, now: Date.UTC(2026, 9, 3, 4), keep: dc.KEEP }, { timeoutMs: 30000, low: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.name, st.name);
  assert.equal(res.result.copies[0].ok, true);
  const list = await run.ask("backupList", { dir: path.join(drive, "Aurora", ".backups") }, { timeoutMs: 30000 });
  assert.equal(list.result.copies.length, 1);
  const hung = tmp("hung");
  const t0 = Date.now();
  const h = await run.ask("backupCopy", { dir: path.join(hung, "Aurora", ".backups"), src: st.path, sha256: st.sha256, size: st.size }, { timeoutMs: 1500, env: { ...process.env, AURORA_DRIVES_FAKE_HANG: hung } });
  assert.equal(h.timeout, true);
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(fs.existsSync(path.join(hung, "Aurora")), false);
});
