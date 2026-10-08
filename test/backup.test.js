// lib/backup.js: the archive format, create → verify → restore, what is and
// is not copied, and the retention rule. Everything happens in temp folders —
// never in the real data directory.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const backup = require("../src/lib/backup");
const { tarPack, tarUnpack, splitName, nameFor, timeOf, isSnapshotName } = backup._internals;

const DAY = 24 * 3600 * 1000;
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `aurora-backup-${label}-`));
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rnd = () => Math.random().toString(36).slice(2);

// A data folder shaped like the real one: state, caches, logs, leftovers.
const fakeData = () => {
  const root = tmp("data");
  const dataDir = path.join(root, "data");
  put(dataDir, "profiles.json", JSON.stringify({ profiles: [{ id: "p1", name: "Noa" }], state: { p1: { progress: { m1: { position: 61 } } } } }));
  put(dataDir, "sessions.json", JSON.stringify({ abc: { profileId: "p1" } }));
  put(dataDir, "settings.json", JSON.stringify({ authMode: "open" }));
  put(dataDir, "push.json", JSON.stringify({ vapid: null, subs: [], pending: {} }));
  put(dataDir, "downloads.json", "[]");
  put(dataDir, "intros.json", "{}");
  put(dataDir, "usage/events-2026-10.jsonl", "{\"e\":\"play\"}\n{\"e\":\"stop\"}\n");
  put(dataDir, "avatars/p1.jpg", crypto.randomBytes(3000)); // binary, not a multiple of 512
  put(dataDir, "avatars/empty.jpg", Buffer.alloc(0));
  // not state:
  put(dataDir, "metadata-cache.json", JSON.stringify({ big: "x".repeat(5000) }));
  put(dataDir, "online-metadata.json", "{}");
  put(dataDir, "daily.json", "{}");
  put(dataDir, "watchdog.json", "{}");
  put(dataDir, "health.json", "{}");
  put(dataDir, "ocr-failed.json", "{}");
  put(dataDir, "cache/posters/a.jpg", crypto.randomBytes(2000));
  put(dataDir, "cache/discover.json", "{}");
  put(dataDir, "aria2/dht.dat", "dht");
  put(dataDir, "backups/profiles-pre-auth-2026-08-24.json", "{}");
  put(dataDir, "server-stdout.log", "log");
  put(dataDir, "profiles.json.tmp", "{half");
  put(dataDir, "profiles.json.bak-tvtest", "{}");
  put(dataDir, "profiles.json.corrupt-123", "{{{");
  const cfg = put(root, "config.json", JSON.stringify({ port: 4000 }));
  const env = put(root, ".env", "AURORA_ADMIN_PASSWORD=not-a-real-one\n");
  return {
    root,
    dataDir,
    backupDir: path.join(dataDir, "backups"),
    configFiles: [{ abs: cfg, as: "config/config.json" }, { abs: env, as: "config/.env" }, { abs: path.join(root, "absent.json"), as: "config/absent.json" }],
  };
};

test("tar: what is packed comes back byte for byte, in ustar form", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from("{}") },
    { name: "data/a.bin", data: crypto.randomBytes(1300) },
    { name: "data/exact.bin", data: crypto.randomBytes(1024) },
    { name: "data/empty", data: Buffer.alloc(0) },
    { name: `data/${"d".repeat(60)}/${"f".repeat(80)}.json`, data: Buffer.from("long") }, // needs the prefix field
  ];
  const tar = tarPack(entries);
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.subarray(257, 262).toString(), "ustar");
  const back = tarUnpack(tar);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data), entries[i].name);
  assert.equal(splitName("x".repeat(101)), null); // one 101-byte segment fits nowhere
  assert.throws(() => tarPack([{ name: "x".repeat(101), data: Buffer.alloc(0) }]), /too long/);
});

test("tar: a damaged header, a file past the end and a cut-short archive are all refused", () => {
  const tar = tarPack([{ name: "a", data: Buffer.from("hello") }, { name: "b", data: Buffer.from("world") }]);
  const flipped = Buffer.from(tar);
  flipped[3] ^= 0xff;
  assert.throws(() => tarUnpack(flipped), /damaged/);
  assert.throws(() => tarUnpack(tar.subarray(0, 512 + 512 + 512)), /damaged/);
  assert.throws(() => tarUnpack(tar.subarray(0, 600)), /damaged/);
});

test("snapshot names: made from UTC time, parsed back, and nothing else passes", () => {
  const t = Date.UTC(2026, 9, 8, 3, 15, 9);
  assert.equal(nameFor(t), "aurora-backup-20261008-031509.tar.gz");
  assert.equal(timeOf("aurora-backup-20261008-031509.tar.gz"), t);
  for (const bad of [
    "profiles-pre-auth-2026-08-24.json", "aurora-backup-20261008-031509.tar", "aurora-backup-20261340-031509.tar.gz",
    "aurora-backup-20261008-251509.tar.gz", "../aurora-backup-20261008-031509.tar.gz", "aurora-backup-20261008-031509.tar.gz.partial",
    ".aurora-backup-20261008-031509.tar.gz.partial", "aurora-backup-20261008-031509.tar.gz/..", "", null, undefined, 5,
  ]) assert.equal(isSnapshotName(bad), false, String(bad));
});

test("create → verify → restore gives back every state file byte for byte, and only state", async () => {
  const f = fakeData();
  const now = Date.UTC(2026, 9, 8, 3, 0, 0);
  const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, configFiles: f.configFiles, version: "9.9.9", now });
  assert.equal(snap.name, "aurora-backup-20261008-030000.tar.gz");
  assert.deepEqual(snap.warnings, []);
  assert.ok(fs.existsSync(snap.path));
  assert.deepEqual(fs.readdirSync(f.backupDir).filter((n) => n.includes(".partial")), []); // no leftovers

  const got = snap.manifest.files.map((x) => x.path).sort();
  assert.deepEqual(got, [
    "config/.env", "config/config.json",
    "data/avatars/empty.jpg", "data/avatars/p1.jpg",
    "data/downloads.json", "data/intros.json", "data/profiles.json", "data/push.json", "data/sessions.json", "data/settings.json",
    "data/usage/events-2026-10.jsonl",
  ]);
  assert.equal(snap.manifest.format, "aurora-backup");
  assert.equal(snap.manifest.version, "9.9.9");
  assert.equal(snap.manifest.createdAt, new Date(now).toISOString());

  const v = await backup.verify(snap.path);
  assert.equal(v.ok, true);
  assert.equal(v.files, 11);

  const into = path.join(f.root, "restored");
  const r = await backup.restore(snap.path, { into });
  assert.equal(r.files, 11);
  for (const file of snap.manifest.files) {
    const restored = fs.readFileSync(path.join(into, ...file.path.split("/")));
    const original = file.path.startsWith("config/")
      ? fs.readFileSync(path.join(f.root, file.path.slice("config/".length)))
      : fs.readFileSync(path.join(f.dataDir, ...file.path.slice("data/".length).split("/")));
    assert.ok(restored.equals(original), `${file.path} differs after restore`);
    assert.equal(sha(restored), file.sha256);
    assert.equal(restored.length, file.size);
  }
  assert.ok(fs.existsSync(path.join(into, "manifest.json")));
  assert.equal(fs.existsSync(path.join(into, "data", "cache")), false);
  assert.equal(fs.existsSync(path.join(into, "data", "metadata-cache.json")), false);

  // the archive is an ordinary .tar.gz: gunzip + a ustar header, nothing of ours needed
  const raw = zlib.gunzipSync(fs.readFileSync(snap.path));
  assert.equal(raw.subarray(0, 13).toString(), "manifest.json");
  assert.equal(raw.subarray(257, 262).toString(), "ustar");
});

test("the system's own tar opens a snapshot (when there is one)", async (t) => {
  const { spawnSync } = require("child_process");
  // Windows ships bsdtar in System32; elsewhere `tar` is on the PATH
  const exe = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  if (spawnSync(exe, ["--version"]).status !== 0) return t.skip("no tar on this machine");
  const f = fakeData();
  const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, configFiles: f.configFiles, now: Date.UTC(2026, 9, 8) });
  const out = path.join(f.root, "by-tar");
  fs.mkdirSync(out);
  const r = spawnSync(exe, ["-xzf", snap.path, "-C", out]);
  assert.equal(r.status, 0, String(r.stderr));
  for (const file of snap.manifest.files) {
    assert.equal(sha(fs.readFileSync(path.join(out, ...file.path.split("/")))), file.sha256, file.path);
  }
});

test("restore only unpacks into a new or empty folder, and never anything from a damaged archive", async () => {
  const f = fakeData();
  const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: Date.UTC(2026, 9, 8) });
  await assert.rejects(backup.restore(snap.path, { into: f.dataDir }), /not empty/); // live data, of all places
  await assert.rejects(backup.restore(snap.path, {}), /needs a folder/);
  const empty = path.join(f.root, "empty");
  fs.mkdirSync(empty);
  assert.equal((await backup.restore(snap.path, { into: empty })).files, snap.files); // an empty one is fine

  const bad = path.join(f.root, "bad.tar.gz");
  const bytes = Buffer.from(fs.readFileSync(snap.path));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  const into = path.join(f.root, "from-bad");
  await assert.rejects(backup.restore(bad, { into }), /damaged/);
  assert.equal(fs.existsSync(into), false);
});

test("restore refuses an archive whose paths climb out of the folder", async () => {
  const f = fakeData();
  for (const evil of ["../outside.json", "data/../../outside.json", "/abs.json", "C:/abs.json", "data\\..\\x.json", "data//x.json"]) {
    const data = Buffer.from("{}");
    const manifest = { format: "aurora-backup", formatVersion: 1, files: [{ path: evil, size: data.length, sha256: sha(data) }] };
    const file = path.join(f.root, `evil-${rnd()}.tar.gz`);
    fs.writeFileSync(file, zlib.gzipSync(tarPack([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: evil, data }])));
    const into = path.join(f.root, `out-${rnd()}`);
    await assert.rejects(backup.restore(file, { into }), /unsafe path/, evil);
    assert.equal(fs.existsSync(into), false);
  }
  assert.equal(fs.existsSync(path.join(f.root, "outside.json")), false);
});

test("verify catches every kind of damage", async () => {
  const f = fakeData();
  const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: Date.UTC(2026, 9, 8) });
  const good = fs.readFileSync(snap.path);
  const write = (buf) => { const p = path.join(f.root, `v-${rnd()}.tar.gz`); fs.writeFileSync(p, buf); return p; };

  assert.equal((await backup.verify(path.join(f.root, "nope.tar.gz"))).ok, false);
  assert.equal((await backup.verify(write(Buffer.from("not gzip at all")))).ok, false);
  assert.equal((await backup.verify(write(good.subarray(0, good.length - 40)))).ok, false); // cut short
  // a flipped bit anywhere in the compressed body must be noticed (gzip's CRC, or ours)
  for (let i = Math.floor(good.length / 3); i < Math.floor((good.length * 2) / 3); i += 97) {
    const b = Buffer.from(good);
    b[i] ^= 0x01;
    assert.equal((await backup.verify(write(b))).ok, false, `flip at ${i}`);
  }

  // a well-formed archive whose content no longer matches its manifest
  const entries = tarUnpack(zlib.gunzipSync(good)).map((e) => ({ name: e.name, data: Buffer.from(e.data) }));
  const tampered = entries.map((e) => (e.name === "data/profiles.json" ? { ...e, data: Buffer.from(e.data.toString().replace("Noa", "Bob")) } : e));
  const r1 = await backup.verify(write(zlib.gzipSync(tarPack(tampered))));
  assert.equal(r1.ok, false);
  assert.match(r1.error, /profiles\.json does not match its checksum/);
  const missing = entries.filter((e) => e.name !== "data/sessions.json");
  assert.match((await backup.verify(write(zlib.gzipSync(tarPack(missing))))).error, /sessions\.json is missing/);
  const extra = [...entries, { name: "data/smuggled.json", data: Buffer.from("{}") }];
  assert.match((await backup.verify(write(zlib.gzipSync(tarPack(extra))))).error, /not in its manifest/);
  const noManifest = entries.filter((e) => e.name !== "manifest.json");
  assert.match((await backup.verify(write(zlib.gzipSync(tarPack(noManifest))))).error, /no manifest/);
  const other = [{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "other", files: [] })) }];
  assert.match((await backup.verify(write(zlib.gzipSync(tarPack(other))))).error, /not an Aurora backup/);
});

test("a store saved again mid-backup: the snapshot is still consistent and holds the version it read", async () => {
  const f = fakeData();
  const before = fs.readFileSync(path.join(f.dataDir, "profiles.json"));
  let changed = 0;
  const snap = await backup.createSnapshot({
    dataDir: f.dataDir,
    backupDir: f.backupDir,
    now: Date.UTC(2026, 9, 8),
    hooks: {
      // the moment profiles.json has been read, everything changes under us
      afterRead: (w) => {
        if (w.as !== "data/profiles.json") return;
        fs.writeFileSync(path.join(f.dataDir, "profiles.json"), JSON.stringify({ profiles: [], grown: "y".repeat(9000) }));
        fs.writeFileSync(path.join(f.dataDir, "sessions.json"), "{}"); // read AFTER this point: the new one is taken
        fs.appendFileSync(path.join(f.dataDir, "usage", "events-2026-10.jsonl"), "{\"e\":\"late\"}\n");
        fs.unlinkSync(path.join(f.dataDir, "settings.json")); // vanishes before its turn
        changed++;
      },
    },
  });
  assert.equal(changed, 1);
  assert.equal((await backup.verify(snap.path)).ok, true);
  const into = path.join(f.root, "r");
  await backup.restore(snap.path, { into });
  assert.ok(fs.readFileSync(path.join(into, "data", "profiles.json")).equals(before)); // as it was when read
  assert.equal(fs.readFileSync(path.join(into, "data", "sessions.json"), "utf8"), "{}");
  assert.match(fs.readFileSync(path.join(into, "data", "usage", "events-2026-10.jsonl"), "utf8"), /late/);
  assert.equal(fs.existsSync(path.join(into, "data", "settings.json")), false);
  assert.deepEqual(snap.warnings, []); // a file that went away is not an error
});

test("a snapshot that fails its read-back check is deleted and the earlier ones stay", async () => {
  const f = fakeData();
  const first = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: Date.UTC(2026, 9, 7) });
  await assert.rejects(
    backup.createSnapshot({
      dataDir: f.dataDir,
      backupDir: f.backupDir,
      now: Date.UTC(2026, 9, 8),
      hooks: { afterWrite: (partial) => { const b = fs.readFileSync(partial); b[b.length >> 1] ^= 0xff; fs.writeFileSync(partial, b); } }, // the disk lied
    }),
    (e) => e.verifyFailed === true && /failed its check/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(f.backupDir).sort(), [first.name, "profiles-pre-auth-2026-08-24.json"].sort());
  assert.equal((await backup.verify(first.path)).ok, true);
  await assert.rejects(backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: Date.UTC(2026, 9, 7) }), /already exists/);
});

test("a store that no longer parses is copied, but flagged — so nothing good gets rotated away for it", async () => {
  const f = fakeData();
  fs.writeFileSync(path.join(f.dataDir, "profiles.json"), "{\"profiles\":[{\"id\":");
  const snap = await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: Date.UTC(2026, 9, 8) });
  assert.equal(snap.warnings.length, 1);
  assert.match(snap.warnings[0], /profiles\.json is not valid JSON/);
  assert.deepEqual(snap.manifest.warnings, snap.warnings);
  assert.equal((await backup.verify(snap.path)).ok, true); // the archive itself is sound
});

test("list and retention only ever see (and delete) files named like a snapshot", async () => {
  const f = fakeData();
  const now = Date.UTC(2026, 9, 30, 4, 0, 0);
  const made = [];
  for (let d = 0; d < 20; d++) made.push((await backup.createSnapshot({ dataDir: f.dataDir, backupDir: f.backupDir, now: now - d * DAY - 3600 * 1000 })).name);
  put(f.backupDir, "notes.txt", "mine");
  put(f.backupDir, "aurora-backup-20260101-000000.tar.gz.old", "mine too");
  put(f.backupDir, "aurora-backup-2026.tar.gz", "not a snapshot name");
  const stale = put(f.backupDir, ".aurora-backup-20261001-000000.tar.gz.partial", "stale half-write");
  fs.utimesSync(stale, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  const fresh = put(f.backupDir, ".aurora-backup-20261030-035959.tar.gz.partial", "being written right now");
  fs.utimesSync(fresh, new Date(now - 1000), new Date(now - 1000));
  fs.mkdirSync(path.join(f.backupDir, "aurora-backup-20250101-000000.tar.gz")); // a FOLDER with a snapshot's name

  const listed = await backup.list(f.backupDir);
  assert.equal(listed.length, 20);
  assert.equal(listed[0].name, made[0]); // newest first
  const removed = await backup.applyRetention(f.backupDir, now);
  const left = fs.readdirSync(f.backupDir);
  for (const keep of ["notes.txt", "aurora-backup-20260101-000000.tar.gz.old", "aurora-backup-2026.tar.gz", "profiles-pre-auth-2026-08-24.json", ".aurora-backup-20261030-035959.tar.gz.partial", "aurora-backup-20250101-000000.tar.gz"]) {
    assert.ok(left.includes(keep), `${keep} must be left alone`);
  }
  assert.equal(left.includes(".aurora-backup-20261001-000000.tar.gz.partial"), false); // the stale half-write is swept
  assert.ok(left.includes(made[0]));
  assert.ok(removed.length > 0 && removed.every((n) => isSnapshotName(n)));
  assert.equal((await backup.list(f.backupDir)).length, 20 - removed.length);
  assert.deepEqual(await backup.list(path.join(f.root, "no-such-folder")), []);
});

// ---------------------------------------------------------------- prune

const snapAt = (ms) => ({ name: nameFor(ms) });
const dailyRun = (now, days, hour = 3) => {
  const start = Math.floor(now / DAY) * DAY + hour * 3600 * 1000;
  return Array.from({ length: days }, (_, d) => snapAt(start - d * DAY));
};

test("prune: nothing to do on nothing, one, or a week", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  assert.deepEqual(backup.prune([], now), { keep: [], remove: [] });
  assert.deepEqual(backup.prune(null, now), { keep: [], remove: [] });
  const one = [snapAt(now - 400 * DAY)];
  assert.deepEqual(backup.prune(one, now), { keep: [one[0].name], remove: [] }); // the newest, however old
  assert.equal(backup.prune(dailyRun(now, 7), now).remove.length, 0);
});

test("prune: a year of dailies leaves 7 dailies, 4 weeklies, 3 monthlies", () => {
  const now = Date.UTC(2026, 9, 30, 12); // Friday 30 Oct 2026
  const all = dailyRun(now, 365);
  const { keep, remove } = backup.prune(all, now);
  assert.equal(keep.length + remove.length, 365);
  const days = keep.map((n) => new Date(timeOf(n)).toISOString().slice(0, 10));
  assert.deepEqual(days, [
    "2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-26", "2026-10-25", "2026-10-24", // 7 days
    "2026-10-18", "2026-10-11", "2026-10-04", // the Sundays closing the four weeks before those…
    "2026-09-30", // …(the fourth is 27 Sep, below) and the last day of the three months before:
    "2026-09-27", "2026-08-31", "2026-07-31",
  ]);
  assert.equal(keep.length, 14);
  assert.equal(keep[0], all[0].name);
  assert.equal(new Set([...keep, ...remove]).size, 365);
});

test("prune: running it again changes nothing; simulated day by day for a year it stays small and never loses the newest", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  let have = dailyRun(now, 120);
  const first = backup.prune(have, now);
  have = have.filter((s) => first.keep.includes(s.name));
  assert.deepEqual(backup.prune(have, now).remove, []);

  let pool = [];
  const day0 = Date.UTC(2026, 0, 1, 3);
  for (let d = 0; d < 400; d++) {
    const t = day0 + d * DAY;
    pool.push(snapAt(t));
    const r = backup.prune(pool, t + 3600 * 1000);
    pool = pool.filter((s) => r.keep.includes(s.name));
    assert.ok(pool.length <= 14, `day ${d}: ${pool.length} kept`);
    if (d >= 6) assert.ok(pool.length >= 7, `day ${d}: only ${pool.length} kept`);
    assert.ok(r.keep.includes(nameFor(t)), "the newest is always kept");
  }
  // after that year: fourteen kept, the oldest about three months old, not from January
  assert.equal(pool.length, 14);
  const oldest = Math.min(...pool.map((s) => timeOf(s.name)));
  const last = day0 + 399 * DAY;
  assert.ok(last - oldest < 125 * DAY && last - oldest > 60 * DAY, `${(last - oldest) / DAY} days`);
  // and what a day-by-day server ends up with is exactly what the rule says of the full history
  const full = Array.from({ length: 400 }, (_, d) => snapAt(day0 + d * DAY));
  assert.deepEqual(pool.map((s) => s.name).sort(), backup.prune(full, last + 3600 * 1000).keep.sort());
});

test("prune: several in one day keep that day's newest — but nothing under 24 hours old is touched", () => {
  const now = Date.UTC(2026, 9, 30, 23);
  const today = [22, 15, 9, 3].map((h) => snapAt(Date.UTC(2026, 9, 30, h)));
  const earlier = [20, 12, 3].map((h) => snapAt(Date.UTC(2026, 9, 27, h)));
  const { keep, remove } = backup.prune([...earlier, ...today], now);
  for (const s of today) assert.ok(keep.includes(s.name)); // a by-hand one before a risky change survives that night's
  assert.ok(keep.includes(earlier[0].name));
  assert.deepEqual(remove.sort(), [earlier[1].name, earlier[2].name].sort());
});

test("prune: a server that was off for months keeps its last seven, not nothing", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  const old = dailyRun(now - 200 * DAY, 10);
  const { keep, remove } = backup.prune(old, now);
  assert.ok(keep.length >= 7);
  assert.equal(keep[0], old[0].name);
  assert.ok(remove.length <= 3);
});

test("prune: a clock that jumped — snapshots dated in the future are never deleted, and do not push real ones out", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  const real = dailyRun(now, 9);
  const future = [snapAt(now + 40 * DAY), snapAt(now + 41 * DAY)];
  const { keep, remove } = backup.prune([...real, ...future], now);
  for (const s of future) assert.ok(keep.includes(s.name));
  for (const s of real.slice(0, 7)) assert.ok(keep.includes(s.name));
  assert.ok(!remove.some((n) => future.map((s) => s.name).includes(n)));
});

test("prune: non-snapshot names are in neither list; the rule can be changed; input order does not matter", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  const all = dailyRun(now, 40);
  const junk = [{ name: "notes.txt" }, { name: "profiles-pre-auth-2026-08-24.json" }, { name: "../aurora-backup-20261008-031509.tar.gz" }, {}, null];
  const r = backup.prune([...junk, ...all], now);
  assert.equal(r.keep.length + r.remove.length, 40);
  for (const j of junk) if (j && j.name) assert.ok(!r.keep.includes(j.name) && !r.remove.includes(j.name));
  const reversed = [...all].reverse();
  assert.deepEqual(backup.prune(reversed, now), backup.prune(all, now));
  assert.equal(backup.prune(all, now, { daily: 2, weekly: 0, monthly: 0 }).keep.length, 2);
  assert.equal(backup.prune(all, now, { daily: 0, weekly: 0, monthly: 0 }).keep.length, 1); // the newest, always
  assert.equal(backup.prune(all, now, { daily: "nonsense", weekly: -3 }).keep.length, backup.prune(all, now).keep.length);
  assert.ok(backup.prune(all, now, { daily: 30 }).keep.length >= 30);
});

test("requiring the module starts nothing and knows where the live folders are", () => {
  const config = require("../src/config");
  assert.ok(path.isAbsolute(config.BACKUP_DIR));
  assert.equal(typeof config.BACKUPS, "boolean");
  assert.equal(backup._internals.live.running, null);
  assert.equal(backup._internals.sameVolume(os.tmpdir(), path.join(os.tmpdir(), "does", "not", "exist", "yet")), true);
});
