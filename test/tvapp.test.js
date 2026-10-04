// The TV build: the server announces what the APK really is, and says so
// when the APK, the notes file and the source disagree.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { _internals: t } = require("../src/lib/tvapp");
const apkinfo = require("../src/lib/apkinfo");

const apk = { versionName: "5.0.1", versionCode: 56 };
const src = (o = {}) => ({ versionName: "5.0.1", versionCode: 56, appVersion: "5.0.1", ...o });

test("everything in step: nothing to say", () => {
  assert.deepEqual(t.problemsOf(apk, { versionName: "5.0.1", notes: "x" }, src()), []);
});

test("a notes file ahead of the APK is the update-loop case, and is called out", () => {
  const p = t.problemsOf(apk, { versionName: "5.0.2" }, src());
  assert.equal(p.length, 1);
  assert.equal(p[0].level, "warn");
  assert.match(p[0].text, /says 5\.0\.2 but the APK on the server is 5\.0\.1/);
  assert.match(p[0].text, /never copied/);
});

test("source bumped but not rebuilt; version constant forgotten; build number not raised", () => {
  assert.match(t.problemsOf(apk, { versionName: "5.0.1" }, src({ versionName: "5.0.2", appVersion: "5.0.2", versionCode: 57 }))[0].text, /not rebuilt/);
  assert.match(t.problemsOf(apk, { versionName: "5.0.1" }, src({ appVersion: "5.0.0" }))[0].text, /APP_VERSION/);
  assert.match(t.problemsOf(apk, { versionName: "5.0.1" }, src({ versionCode: 57 }))[0].text, /build number/);
});

test("no APK is information, an unreadable one is a failure", () => {
  assert.equal(t.problemsOf({ error: "no APK has been published" }, null, src())[0].level, "info");
  assert.equal(t.problemsOf({ error: "the APK could not be read: bad" }, null, src())[0].level, "fail");
});

test("the published APK is readable and names its own version", { skip: !fs.existsSync(path.join(__dirname, "..", "public", "aurora-tv.apk")) }, () => {
  const info = apkinfo.read(path.join(__dirname, "..", "public", "aurora-tv.apk"), { hash: false });
  assert.equal(info.error, undefined);
  assert.match(info.versionName, /^\d+\.\d+/);
  assert.ok(info.versionCode > 0);
  assert.equal(info.package, "com.auroratv");
});

test("a file that is not an APK is an error, never a crash", () => {
  assert.match(apkinfo.read(__filename, { hash: false }).error, /could not be read/);
});
