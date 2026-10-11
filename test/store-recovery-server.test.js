// What the capacity study reproduced, end to end on the real server: a
// damaged profiles.json used to boot as an empty house ("Watcher", everyone
// signed out) and the next save wrote that over the real file.
//
// Three private instances (the UI tests' harness: a temp folder, a free port,
// outbound network refused), each started on a damaged data folder:
//   1. a last-good copy exists        → the household is back, by itself
//   2. only a backup snapshot exists  → the household is back from the backup
//   3. nothing good exists anywhere   → SAFE MODE: nothing is written, the
//      doors are closed, the admin is told, and decides
//
// The instances' library is made with ffmpeg; without it this is skipped
// (jsonstore.test.js and backup-drill.test.js cover the logic with nothing).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};
const call = (srv, method, url, body) =>
  new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${srv.url}${url}`, { method, agent: false, timeout: 8000, headers: { "X-Admin-Password": srv.adminPassword, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end(data || undefined);
  });

const HOUSE = (n) => {
  const d = { profiles: [], state: {}, pending: [], access: {} };
  for (let i = 0; i < n; i++) {
    d.profiles.push({ id: `fam${i}`, name: `Family ${i}`, color: "#e05f2c", avatar: "🍿" });
    d.state[`fam${i}`] = { progress: { [`m${i}`]: { position: 100 + i, duration: 5000, updatedAt: 1 } }, watchlist: [] };
  }
  return d;
};
const cutOff = (obj) => { const s = JSON.stringify(obj); return s.slice(0, Math.floor(s.length * 0.6)); };

test("a damaged profiles.json with a last-good copy: the household is back by itself, the admin is told once what was lost", { timeout: 300000 }, async (t) => {
  if (!haveFfmpeg()) return t.skip("no ffmpeg on this machine (the private instance builds its library with it)");
  const { start } = require("../scripts/ui-test-server");
  const srv = await start({
    waitForLibrary: false,
    seed: {
      "profiles.json": cutOff(HOUSE(5)), // cut off at 60 %, as in the study
      "profiles.json.good1": HOUSE(5),
      "sessions.json": "", // and an empty sessions file
      "sessions.json.good1": {},
    },
  });
  try {
    const people = await call(srv, "GET", "/api/admin/profiles");
    assert.deepEqual(people.body.map((p) => p.name), ["Family 0", "Family 1", "Family 2", "Family 3", "Family 4"], "not 'Watcher'");
    assert.equal((await call(srv, "GET", "/api/server-info")).body.safeMode, undefined);
    // on disk too, at once — and the damaged bytes are kept beside it
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8"));
    assert.equal(onDisk.profiles.length, 5);
    assert.ok(fs.readdirSync(srv.dataDir).some((n) => n.startsWith("profiles.json.corrupt-")));
    // the admin's view: both recoveries, with sentences
    const st = await call(srv, "GET", "/api/admin/stores");
    assert.deepEqual(st.body.safeMode, []);
    const recs = st.body.recoveries.map((r) => r.store).sort();
    assert.deepEqual(recs, ["profiles.json", "sessions.json"]);
    assert.match(st.body.recoveries.find((r) => r.store === "profiles.json").sentence, /could not be read \(not valid JSON\) and was restored from its last good copy/);
    // announced once, through the health alerts
    const alerts = await call(srv, "GET", "/api/admin/alerts");
    const said = alerts.body.checks.find((c) => c.id === "store:profiles.json");
    assert.ok(said, "an alert was raised");
    assert.equal(said.level, "warn");
    assert.ok(srv.log().some((l) => /\[health\] ALERT warn store:profiles\.json/.test(l)));
    // the healer lists it until it is acknowledged
    const healer = await call(srv, "POST", "/api/admin/healer/run");
    const check = (healer.body.last || healer.body).checks.find((c) => c.id === "stores");
    assert.equal(check.status, "warn");
    assert.equal((await call(srv, "POST", "/api/admin/stores/ack")).body.acknowledged, 2);
    const after = await call(srv, "POST", "/api/admin/healer/run");
    assert.equal((after.body.last || after.body).checks.find((c) => c.id === "stores").status, "ok");
    assert.equal((await call(srv, "GET", "/api/admin/alerts")).body.checks.find((c) => c.id === "store:profiles.json").level, "ok");
  } finally {
    await srv.stop();
  }
});

test("a damaged profiles.json with only a backup: restored from the newest verified snapshot; and the restore drill works on the live server", { timeout: 300000 }, async (t) => {
  if (!haveFfmpeg()) return t.skip("no ffmpeg on this machine (the private instance builds its library with it)");
  const { start } = require("../scripts/ui-test-server");
  const backup = require("../src/lib/backup");
  // last night's snapshot, made here from a healthy data folder
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-recovery-"));
  let srv = null;
  try {
    fs.mkdirSync(path.join(scratch, "data"));
    fs.writeFileSync(path.join(scratch, "data", "profiles.json"), JSON.stringify(HOUSE(7)));
    fs.writeFileSync(path.join(scratch, "data", "sessions.json"), "{}");
    const snap = await backup.createSnapshot({ dataDir: path.join(scratch, "data"), backupDir: path.join(scratch, "backups"), now: Date.now() - 20 * 3600 * 1000 });
    srv = await start({
      waitForLibrary: false,
      seed: { "profiles.json": cutOff(HOUSE(7)), [`backups/${snap.name}`]: fs.readFileSync(snap.path) },
    });
    const people = await call(srv, "GET", "/api/admin/profiles");
    assert.equal(people.body.length, 7, "the household from the backup");
    const st = await call(srv, "GET", "/api/admin/stores");
    const rec = st.body.recoveries.find((r) => r.store === "profiles.json");
    assert.equal(rec.source, "backup");
    assert.match(rec.sentence, new RegExp(`restored from the backup ${snap.name.replace(/\./g, "\\.")}`));
    assert.match(rec.sentence, /Changes made in the 20 hours before the damage are lost/);
    // the drill, from the admin API: a temp folder, counted, live data untouched
    const before = fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8");
    const drill = await call(srv, "POST", "/api/admin/backups/drill");
    assert.equal(drill.body.ok, true);
    assert.equal(drill.body.profiles, 7);
    assert.match(drill.body.sentence, /restores: 7 profiles, 7 history rows/);
    assert.equal(fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8"), before);
    const status = await call(srv, "GET", "/api/admin/backups");
    assert.equal(status.body.drill.ok, true, "and it is remembered for the admin page");
    assert.equal(status.body.offDisk, false);
    assert.match(status.body.advice, /backupMirrorDir/);
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("nothing good anywhere: SAFE MODE — the damaged files are never overwritten, the doors close, the admin decides", { timeout: 300000 }, async (t) => {
  if (!haveFfmpeg()) return t.skip("no ffmpeg on this machine (the private instance builds its library with it)");
  const { start } = require("../scripts/ui-test-server");
  const brokenProfiles = cutOff(HOUSE(5));
  const brokenSettings = "{ \"authMode\": \"open\", \"maxActiveDown";
  const srv = await start({ waitForLibrary: false, seed: { "profiles.json": brokenProfiles, "settings.json": brokenSettings } });
  try {
    // said to every client, in a field with no details
    const info = await call(srv, "GET", "/api/server-info");
    assert.equal(info.body.safeMode, true);
    assert.equal(info.body.authMode, "closed", "settings unknown: the wall is closed, not opened");
    // the house looks empty — and that is exactly what must not be saved
    const people = await call(srv, "GET", "/api/admin/profiles");
    assert.deepEqual(people.body.map((p) => p.name), ["Watcher"]);
    await call(srv, "POST", "/api/admin/profiles/default/kids", { kids: false }); // something that saves the profiles
    await new Promise((r) => setTimeout(r, 2500)); // past the save debounce
    assert.equal(fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8"), brokenProfiles, "profiles.json is byte for byte the damaged file");
    assert.equal(fs.readFileSync(path.join(srv.dataDir, "settings.json"), "utf8"), brokenSettings);
    // the admin is told: a critical alert, the healer failing, the store list
    const alerts = await call(srv, "GET", "/api/admin/alerts");
    const said = alerts.body.checks.find((c) => c.id === "store:profiles.json");
    assert.equal(said.level, "critical");
    assert.match(said.message, /SAFE MODE/);
    const healer = await call(srv, "POST", "/api/admin/healer/run");
    const check = (healer.body.last || healer.body).checks.find((c) => c.id === "stores");
    assert.equal(check.status, "fail");
    const st = await call(srv, "GET", "/api/admin/stores");
    assert.deepEqual(st.body.safeMode.sort(), ["profiles.json", "settings.json"]);
    // a name that is not in safe mode is refused
    assert.equal((await call(srv, "POST", "/api/admin/stores/downloads.json/accept")).status, 404);
    assert.equal((await call(srv, "POST", "/api/admin/stores/..%2F..%2Fconfig.json/accept")).status, 404);
    // the decision: start both fresh
    assert.equal((await call(srv, "POST", "/api/admin/stores/profiles.json/accept")).status, 200);
    assert.equal((await call(srv, "POST", "/api/admin/stores/settings.json/accept")).status, 200);
    assert.equal((await call(srv, "GET", "/api/server-info")).body.safeMode, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8")).profiles[0].name, "Watcher");
    assert.ok(fs.readdirSync(srv.dataDir).some((n) => n.startsWith("profiles.json.corrupt-")), "the damaged file is still kept");
  } finally {
    await srv.stop();
  }
});
