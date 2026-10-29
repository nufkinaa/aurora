// The Android phone build, beside the TV's: what the server announces from
// the APK (lib/tvapp.js `phone`), the versions it reads from the source
// (build.gradle's phone block, update.ts's PHONE_APP_VERSION), the signing
// certificate read out of the APK (lib/apksign.js) for App Links
// (lib/assetlinks.js), and "phone" as a third app wherever the usage stats
// count an app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tvapp = require("../src/lib/tvapp");
const apksign = require("../src/lib/apksign");
const assetlinks = require("../src/lib/assetlinks");

const t = tvapp._internals;
const TV_APK = path.join(__dirname, "..", "public", "aurora-tv.apk");
const haveTvApk = fs.existsSync(TV_APK);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-phoneapp-"));

// ---------- versions in the source ----------
const GRADLE = `
android {
    defaultConfig {
        applicationId "com.auroratv"
        // keeps showing the icon against its versionCode, so a reinstall
        versionCode 188
        versionName "5.8.0"
        buildConfigField "boolean", "PHONE", auroraPhone ? 'true' : 'false'
        if (auroraPhone) {
            applicationId "com.aurora.phone"
            versionCode 3
            versionName "1.0.2"
        }
    }
    if (auroraPhone) {
        sourceSets { main { manifest.srcFile 'src/phone/AndroidManifest.xml' } }
    }
}`;

test("build.gradle: the TV reads defaultConfig's own lines, the phone its auroraPhone block", () => {
  const v = t.gradleVersions(GRADLE);
  assert.deepEqual(v.tv, { versionName: "5.8.0", versionCode: 188 });
  assert.deepEqual(v.phone, { versionName: "1.0.2", versionCode: 3 });
  // the phone block first in the file still cannot hand the TV its numbers
  const swapped = `if (auroraPhone) {\n versionCode 3\n versionName "1.0.2"\n}\n defaultConfig {\n versionCode 188\n versionName "5.8.0"\n}`;
  assert.deepEqual(t.gradleVersions(swapped).tv, { versionName: "5.8.0", versionCode: 188 });
  // no phone block: no phone versions (and the TV's are untouched)
  assert.deepEqual(t.gradleVersions(`versionCode 9\nversionName "5.0.0"`).phone, { versionName: null, versionCode: null });
  assert.deepEqual(t.gradleVersions(null).tv, { versionName: null, versionCode: null });
});

test("update.ts: APP_VERSION is the TV's, never the end of PHONE_APP_VERSION", () => {
  const ts = "export const PHONE_APP_VERSION = '1.0.2';\nexport const APP_VERSION = '5.8.0';\n";
  assert.equal(t.constantIn(ts, "APP_VERSION"), "5.8.0");
  assert.equal(t.constantIn(ts, "PHONE_APP_VERSION"), "1.0.2");
  assert.equal(t.constantIn("export const PHONE_APP_VERSION = '1.0.2';", "APP_VERSION"), null);
});

test("the real source: the TV still reads 5.x from defaultConfig, the phone its own block", { skip: !fs.existsSync(path.join(__dirname, "..", "tv-native", "android", "app", "build.gradle")) }, () => {
  const tv = tvapp.status().source;
  const phone = tvapp.phone.status().source;
  assert.match(String(tv.versionName), /^5\./);
  assert.ok(phone.versionName && phone.versionName !== tv.versionName, `phone ${phone.versionName} vs TV ${tv.versionName}`);
  assert.ok(phone.versionCode >= 1 && phone.versionCode < tv.versionCode);
});

// ---------- the phone's sentences ----------
test("the phone's disagreements are said in the phone's words", () => {
  const apk = { versionName: "1.0.0", versionCode: 1 };
  const src = { versionName: "1.0.0", versionCode: 1, appVersion: "1.0.0" };
  const W = t.PHONE.words;
  assert.deepEqual(t.problemsOf(apk, { versionName: "1.0.0", notes: "x" }, src, W), []);
  const ahead = t.problemsOf(apk, { versionName: "1.0.1" }, src, W);
  assert.match(ahead[0].text, /^phone-version\.json says 1\.0\.1 but the APK on the server is 1\.0\.0\. Phones are being told 1\.0\.0/);
  assert.match(ahead[0].text, /public\/aurora-phone\.apk/);
  assert.match(t.problemsOf(apk, null, src, W)[0].text, /no phone-version\.json — phones are told/);
  assert.match(t.problemsOf(apk, { versionName: "1.0.0" }, { ...src, appVersion: "0.9.0" }, W)[0].text, /PHONE_APP_VERSION/);
  // the TV's words are unchanged by default
  assert.match(t.problemsOf({ versionName: "5.0.1", versionCode: 56 }, { versionName: "5.0.2" }, { versionName: "5.0.1" })[0].text, /^tv-version\.json says 5\.0\.2 .* TVs are being told/);
});

test("no phone APK: nothing announced, said as information", () => {
  const dir = tmp();
  try {
    const app = t.appFor({ ...t.PHONE, apkPath: path.join(dir, "aurora-phone.apk"), jsonPath: path.join(dir, "phone-version.json") });
    assert.deepEqual(app.announcement(), { none: true });
    const s = app.status();
    assert.equal(s.level, "ok");
    assert.equal(s.problems[0].level, "info");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a published phone APK is announced from the file: notes only when written for this build", { skip: !haveTvApk && "no APK in public/ to stand in" }, () => {
  const dir = tmp();
  try {
    const apkPath = path.join(dir, "aurora-phone.apk");
    const jsonPath = path.join(dir, "phone-version.json");
    fs.copyFileSync(TV_APK, apkPath); // (any APK: the version is read out of the file)
    const app = t.appFor({ ...t.PHONE, apkPath, jsonPath });
    const real = require("../src/lib/apkinfo").read(apkPath, { hash: false });
    assert.deepEqual(app.announcement(), { versionName: real.versionName, versionCode: real.versionCode, sizeBytes: real.sizeBytes });
    fs.writeFileSync(jsonPath, JSON.stringify({ versionName: real.versionName, notes: "Faster start.", date: "2026-10-29" }));
    assert.equal(app.announcement().notes, "Faster start.");
    fs.writeFileSync(jsonPath, JSON.stringify({ versionName: "0.0.1", notes: "old notes" }));
    assert.equal(app.announcement().notes, undefined, "notes written for another build are not handed out");
    assert.equal(app.status().level, "warn");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the signing certificate ----------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const lp = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length), body]); };
// signers[ signer[ signedData[ digests[], certificates[ cert ] ], signatures, publicKey ] ]
const schemeValue = (cert) => lp(lp(lp(lp(lp(u32(0x0103), lp(Buffer.alloc(32)))), lp(lp(cert)), lp()), lp(), lp(Buffer.from("pk"))));
const signingBlock = (pairs) => {
  const body = Buffer.concat(pairs.map(([id, value]) => Buffer.concat([u64(value.length + 4), u32(id), value])));
  const size = body.length + 8 + 16;
  return Buffer.concat([u64(size), body, u64(size), Buffer.from(apksign._internals.MAGIC, "latin1")]);
};
// a zip with nothing in it but the block: [junk][block][empty central directory][EOCD]
const fakeApk = (block) => {
  const head = Buffer.from("PK-not-really-entries-here");
  const cdOffset = head.length + block.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(0, 12); // central directory size
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([head, block, eocd]);
};
const fp = (buf) => crypto.createHash("sha256").update(buf).digest("hex").toUpperCase().match(/../g).join(":");

test("the signing block: the first signer's first certificate, v2 before v3; a v1-only APK says so", () => {
  const dir = tmp();
  try {
    const v2cert = Buffer.from("a DER certificate, v2");
    const v3cert = Buffer.from("another one, v3");
    const both = path.join(dir, "both.apk");
    fs.writeFileSync(both, fakeApk(signingBlock([[0x42726577, Buffer.alloc(12)], [0xf05368c0, schemeValue(v3cert)], [0x7109871a, schemeValue(v2cert)]])));
    assert.deepEqual(apksign.read(both), { sha256: fp(v2cert), scheme: "v2" });
    const v3 = path.join(dir, "v3.apk");
    fs.writeFileSync(v3, fakeApk(signingBlock([[0xf05368c0, schemeValue(v3cert)]])));
    assert.deepEqual(apksign.read(v3), { sha256: fp(v3cert), scheme: "v3" });
    const none = path.join(dir, "v1.apk");
    fs.writeFileSync(none, fakeApk(Buffer.alloc(0)));
    assert.match(apksign.read(none).error, /no APK Signing Block/);
    const truncated = path.join(dir, "bad.apk");
    const bad = signingBlock([[0x7109871a, Buffer.concat([u32(9999), Buffer.alloc(8)])]]);
    fs.writeFileSync(truncated, fakeApk(bad));
    assert.match(apksign.read(truncated).error, /could not be read/);
    assert.match(apksign.read(__filename).error, /could not be read/, "not a zip: an error, never a crash");
    assert.match(apksign.read(path.join(dir, "missing.apk")).error, /no APK/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the published APK's certificate reads as an upper-case colon fingerprint", { skip: !haveTvApk && "no APK in public/" }, () => {
  const s = apksign.read(TV_APK);
  assert.equal(s.error, undefined);
  assert.match(s.sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(s.scheme, /^v[23]/);
});

// ---------- App Links ----------
const FP = "6D:0D:98:EF:39:95:18:9E:EC:4D:BD:56:89:61:5B:5E:DC:57:E8:A8:7A:E7:06:8E:C8:B7:1D:35:71:D5:EB:C3";
test("assetlinks: the config's fingerprint in any spelling, else the APK's, else nothing", () => {
  assert.deepEqual(assetlinks.fromConfig(FP.toLowerCase()), [FP]);
  assert.deepEqual(assetlinks.fromConfig(FP.replace(/:/g, "")), [FP]);
  assert.deepEqual(assetlinks.fromConfig(`${FP}, ${FP.replace(/:/g, "").replace(/^6D/, "AA")}`).length, 2);
  assert.deepEqual(assetlinks.fromConfig([FP, "nonsense"]), [FP]);
  assert.deepEqual(assetlinks.fromConfig("not a fingerprint"), []);
  assert.deepEqual(assetlinks.fromConfig(null), []);
  const dir = tmp();
  try {
    const missing = path.join(dir, "aurora-phone.apk");
    assert.deepEqual(assetlinks.fingerprints({ configured: FP, apkPath: missing }), { fingerprints: [FP], source: "config" });
    assert.match(assetlinks.fingerprints({ configured: null, apkPath: missing }).error, /AURORA_PHONE_CERT_SHA256/);
    const cert = Buffer.from("cert");
    fs.writeFileSync(missing, fakeApk(signingBlock([[0x7109871a, schemeValue(cert)]])));
    assert.deepEqual(assetlinks.fingerprints({ configured: "", apkPath: missing }), { fingerprints: [fp(cert)], source: "apk" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(assetlinks.statement([FP]), [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.aurora.phone", sha256_cert_fingerprints: [FP] },
  }]);
});

// ---------- "phone", the third app ----------
test("usage stats: a phone batch is counted as the phone app — errors, timings, controls, events", () => {
  const tel = require("../src/lib/tel");
  const usage = require("../src/lib/usage");
  const vocab = require("../src/lib/tel/vocab");
  tel._reset();
  usage._reset();
  const env = tel.envelope({ app: "phone", v: "1.0.0", model: "Google Pixel 9" });
  assert.equal(env.app, "phone");
  assert.equal(env.device, "phone", "no device said: a phone");
  assert.equal(tel.envelope({ device: "tv", look: "tv" }).app, "tv", "an older TV build still reads as the TV");
  assert.equal(tel.envelope({ app: "web" }).app, "web");
  const phoneOnly = Object.keys(vocab.CONTROLS).find((id) => vocab.CONTROLS[id] === "p");
  const webOnly = Object.keys(vocab.CONTROLS).find((id) => vocab.CONTROLS[id] === "w");
  const shared = Object.keys(vocab.CONTROLS).find((id) => /t/.test(vocab.CONTROLS[id]) && /p/.test(vocab.CONTROLS[id]));
  assert.ok(phoneOnly && webOnly && shared);
  const kept = tel.record({
    profile: "p1", iid: "phoneaaaaaaa1", app: "phone", v: "1.0.0", device: "phone", look: "glass",
    tel: { s: 1, e: [{ k: "js", m: "boom" }], t: [["nav_paint", 300, "tv:home"]], u: [["tv:home", phoneOnly, "touch", 2, 1], ["tv:home", shared, "touch", 1, 1], ["tv:home", webOnly, "touch", 5, 1]] },
  });
  assert.equal(kept.controls, 2, "a control the phone does not have is dropped");
  const s = tel.controls.summary();
  assert.equal(s.phone.sessions, 1);
  assert.deepEqual(s.phone.used.map((u) => u.id).sort(), [phoneOnly, shared].sort());
  assert.equal(s.tv.sessions, 0);
  assert.equal(s.web.sessions, 0);
  assert.match(tel.controls.text(), /Most used — phone/);
  assert.ok(Object.keys(tel.timings._internals.hists).some((k) => k.split("|")[1] === "phone"));
  assert.equal(tel.errors.list()[0].app, "phone");
  usage.record({ profile: "p1", sid: "abcd1234", device: "phone", look: "glass", app: "phone", events: [{ n: "route", t: Date.now(), p: { r: "tv:home", ms: 10 } }] }, { persist: false });
  usage.record({ profile: "p1", sid: "abcd1235", device: "tv", look: "tv", events: [{ n: "route", t: Date.now(), p: { r: "tv:home", ms: 10 } }] }, { persist: false });
  assert.deepEqual(usage.summary().apps, { phone: 1, tv: 1 });
  assert.match(usage.text(), /Apps: (phone 1, tv 1|tv 1, phone 1)/);
  tel._reset();
  usage._reset();
});

test("play marks: the phone app is its own app and path, whatever its user-agent says", () => {
  const pm = require("../src/lib/playmarks");
  const now = Date.now();
  const p = pm.record({ id: "x1", name: "mount", extra: { app: "phone" }, ip: "10.0.0.9", ua: "okhttp/4.12.0", now });
  assert.equal(p.app, "phone");
  assert.equal(p.device, "phone", "okhttp reads as a TV — the app's word wins");
  assert.equal(p.path, "phone");
  pm.record({ id: "x1", name: "path", extra: { app: "phone", path: "jit" }, ip: "10.0.0.9", now: now + 10 });
  assert.equal(p.path, "phone");
  const s = pm.recordStart({ id: "x1", extra: { app: "phone", steps: "open:10,frame:900" }, ip: "10.0.0.9", ua: "okhttp/4.12.0", now });
  assert.equal(s.app, "phone");
  assert.equal(s.device, "phone");
  // the TV's and the site's are as they were
  assert.equal(pm.record({ id: "x2", name: "mount", extra: { app: "tv" }, ip: "10.0.0.8", now }).path, "tv");
  assert.equal(pm.record({ id: "x3", name: "mount", extra: {}, ip: "10.0.0.7", ua: "Mozilla/5.0 (iPhone)", now }).app, "web");
});

// ---------- the published files, as committed (what nufurora serves after it pulls) ----------
// The release copies a phone build to public/aurora-phone.apk and writes its notes in
// public/phone-version.json by hand. The server announces the APK's own version whatever
// the JSON says (so a phone is never sent into an update loop), but a JSON written for
// another build means the release notes are silently dropped and the admin page warns:
// a release that commits the two out of step fails here, before it is pushed.
const PHONE_APK = path.join(__dirname, "..", "public", "aurora-phone.apk");
const PHONE_JSON = path.join(__dirname, "..", "public", "phone-version.json");
test("the committed phone build and its notes file name the same version, and the APK is the phone app", { skip: !fs.existsSync(PHONE_APK) && "no phone APK published" }, () => {
  const apk = require("../src/lib/apkinfo").read(PHONE_APK, { hash: false });
  assert.ok(!apk.error, apk.error);
  assert.equal(apk.package, "com.aurora.phone", "public/aurora-phone.apk must be the phone build (-Paurora=phone), not the TV's");
  assert.match(apk.versionName, /^\d+\.\d+\.\d+$/);
  assert.ok(apk.versionCode > 0);
  if (fs.existsSync(PHONE_JSON)) {
    const j = JSON.parse(fs.readFileSync(PHONE_JSON, "utf8"));
    assert.equal(j.versionName, apk.versionName, "public/phone-version.json was written for another build than public/aurora-phone.apk");
    if (j.date != null) assert.match(j.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof (j.notes || ""), "string");
  }
  // what the phones are told is exactly that file
  const a = tvapp.phone.announcement();
  assert.equal(a.versionName, apk.versionName);
  assert.equal(a.versionCode, apk.versionCode);
  assert.equal(a.sizeBytes, fs.statSync(PHONE_APK).size);
  // and the published build is signed with the key the App Links statement vouches for
  const signer = apksign.read(PHONE_APK);
  assert.ok(signer.sha256, "the phone APK carries a v2/v3 signature");
});

test("the committed TV build and tv-version.json name the same version", { skip: !haveTvApk && "no TV APK published" }, () => {
  const apk = require("../src/lib/apkinfo").read(TV_APK, { hash: false });
  assert.ok(!apk.error, apk.error);
  assert.equal(apk.package, "com.auroratv");
  const jf = path.join(__dirname, "..", "public", "tv-version.json");
  if (fs.existsSync(jf)) assert.equal(JSON.parse(fs.readFileSync(jf, "utf8")).versionName, apk.versionName, "public/tv-version.json was written for another build than public/aurora-tv.apk");
});
