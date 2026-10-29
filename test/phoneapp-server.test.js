// The phone app's doors on a real (private) server, with sign-in REQUIRED —
// a phone meets them before it can sign in: /phone-version.json answered
// from the APK, /download/phone handing it over, /aurora-phone.apk pointing
// there, and /.well-known/assetlinks.json vouching for the app (App Links).
// A private instance (the UI tests' harness: a temp folder, a free port, no
// outbound network); without ffmpeg (its library is made with it) it is skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const TV_APK = path.join(__dirname, "..", "public", "aurora-tv.apk");
const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};
const skip = !haveFfmpeg() ? "ffmpeg not found" : !fs.existsSync(TV_APK) ? "no APK in public/ to stand in for the phone's" : false;

const get = (srv, url) =>
  new Promise((resolve) => {
    const req = http.request(`${srv.url}${url}`, { agent: false, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString("utf8"), json });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, headers: {} }); });
    req.on("error", () => resolve({ status: 0, headers: {} }));
    req.end();
  });

test("the phone's doors, no session, sign-in required: nothing published, then a build", { skip, timeout: 180000 }, async () => {
  const { start } = require("../scripts/ui-test-server");
  const srv = await start({ config: { authMode: "closed" }, waitForLibrary: false });
  try {
    // the wall is up: data needs a session
    assert.equal((await get(srv, "/api/library")).status, 401);

    // ---- nothing published
    let r = await get(srv, "/phone-version.json");
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: "no Android phone build has been published" });
    assert.equal(r.headers["cache-control"], "no-cache");
    r = await get(srv, "/download/phone");
    assert.equal(r.status, 404);
    assert.equal(r.text, "No Android phone build has been published yet.");
    r = await get(srv, "/aurora-phone.apk");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/download/phone");
    r = await get(srv, "/.well-known/assetlinks.json");
    assert.equal(r.status, 404);
    assert.match(r.json.error, /AURORA_PHONE_CERT_SHA256/);

    // ---- a build is published (any APK: the version and signature are read out of the file)
    const apk = path.join(srv.root, "public", "aurora-phone.apk");
    fs.copyFileSync(TV_APK, apk);
    const info = require("../src/lib/apkinfo").read(apk, { hash: false });
    fs.writeFileSync(path.join(srv.root, "public", "phone-version.json"), JSON.stringify({ versionName: info.versionName, notes: "Saved films play offline.", date: "2026-10-29" }));
    r = await get(srv, "/phone-version.json");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { versionName: info.versionName, versionCode: info.versionCode, sizeBytes: info.sizeBytes, notes: "Saved films play offline." });
    assert.equal(r.headers["cache-control"], "no-cache");
    r = await get(srv, "/download/phone");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-disposition"], /attachment; filename="aurora-phone\.apk"/);
    assert.equal(r.buf.length, fs.statSync(apk).size, "the whole file, with no session");
    r = await get(srv, "/.well-known/assetlinks.json");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^application\/json/);
    assert.equal(r.headers["cache-control"], "public, max-age=3600");
    const want = require("../src/lib/apksign").read(TV_APK).sha256;
    assert.deepEqual(r.json, [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "com.aurora.phone", sha256_cert_fingerprints: [want] },
    }]);
    // the TV's doors are where they were
    assert.equal((await get(srv, "/aurora-tv.apk")).headers.location, "/download");
  } finally {
    await srv.stop();
  }
});

test("assetlinks: a fingerprint in the config wins, in any spelling, with no APK at all", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 180000 }, async () => {
  const { start } = require("../scripts/ui-test-server");
  const hex = "6d0d98ef3995189eec4dbd5689615b5edc57e8a87ae7068ec8b71d3571d5ebc3";
  const srv = await start({ config: { authMode: "closed", phoneCertSha256: hex }, waitForLibrary: false });
  try {
    const r = await get(srv, "/.well-known/assetlinks.json");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json[0].target.sha256_cert_fingerprints, [hex.toUpperCase().match(/../g).join(":")]);
  } finally {
    await srv.stop();
  }
});
