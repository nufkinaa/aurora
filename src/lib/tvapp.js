// The published Android builds — the TV app and the phone app — each as one
// honest picture: what the APK on disk really is (lib/apkinfo.js reads it out
// of the file), what its notes file (tv-version.json / phone-version.json)
// announces to the devices, and what the source in tv-native/ says the next
// build will be — plus every way those three can disagree.
//
// The server announces updates from the APK itself (see /tv-version.json and
// /phone-version.json in server.js), so a stale or mistyped JSON can no longer
// send a device into an update that installs the version it already has. This
// module is what the admin's Server page and the healer read to SAY so when
// the pieces are out of step: built but not published, published but not
// committed, the app's own version constant forgotten.
//
// One factory (appFor), two apps. The TV's exports stay where they always
// were (status, announcement, APK_PATH); the phone's are under `phone`.
const fs = require("fs");
const path = require("path");
const apkinfo = require("./apkinfo");

const ROOT = path.join(__dirname, "..", "..");
const GRADLE_PATH = path.join(ROOT, "tv-native", "android", "app", "build.gradle");
const UPDATE_TS_PATH = path.join(ROOT, "tv-native", "src", "update.ts");

const cmp = (a, b) => {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

const readJsonAt = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};
const readText = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

// PURE: build.gradle's text → the versions of each app.
// The TV's are defaultConfig's own lines — the FIRST versionCode/versionName
// in the file (the phone's come later, inside `if (auroraPhone) { … }`). The
// phone's are the ones inside that block.
const gradleVersions = (g) => {
  const out = { tv: { versionName: null, versionCode: null }, phone: { versionName: null, versionCode: null } };
  if (!g) return out;
  // (the phone blocks are cut out first, so the TV's never come from them)
  const phoneBlocks = [...g.matchAll(/if\s*\(\s*auroraPhone\s*\)\s*\{([^{}]*)\}/g)].map((m) => m[1]);
  const tvText = g.replace(/if\s*\(\s*auroraPhone\s*\)\s*\{[^{}]*\}/g, "");
  out.tv.versionName = (tvText.match(/versionName\s+"([^"]+)"/) || [])[1] || null;
  out.tv.versionCode = parseInt((tvText.match(/versionCode\s+(\d+)/) || [])[1], 10) || null;
  const phone = phoneBlocks.find((b) => /versionName\s+"/.test(b)) || "";
  out.phone.versionName = (phone.match(/versionName\s+"([^"]+)"/) || [])[1] || null;
  out.phone.versionCode = parseInt((phone.match(/versionCode\s+(\d+)/) || [])[1], 10) || null;
  return out;
};
// PURE: update.ts's text → the app's own version constant (`APP_VERSION` for
// the TV — not the end of `PHONE_APP_VERSION` — or `PHONE_APP_VERSION`).
const constantIn = (ts, name) => {
  if (!ts) return null;
  const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\s*=\\s*'([^']+)'`);
  return (ts.match(re) || [])[1] || null;
};

// What each app is called in the sentences, and where its pieces live.
const TV = {
  key: "tv",
  apkPath: path.join(ROOT, "public", "aurora-tv.apk"),
  jsonPath: path.join(ROOT, "public", "tv-version.json"),
  words: {
    json: "tv-version.json",
    apk: "public/aurora-tv.apk",
    devices: "TVs",
    rebuild: "run build-apk.bat again",
    constant: "APP_VERSION",
  },
};
const PHONE = {
  key: "phone",
  apkPath: path.join(ROOT, "public", "aurora-phone.apk"),
  jsonPath: path.join(ROOT, "public", "phone-version.json"),
  words: {
    json: "phone-version.json",
    apk: "public/aurora-phone.apk",
    devices: "phones",
    rebuild: "build the phone app again (-Paurora=phone)",
    constant: "PHONE_APP_VERSION",
  },
};

// The disagreements, as sentences. Pure: (apk, json, source, words?) →
// [{level, text}]. `words` defaults to the TV's.
const problemsOf = (apk, json, source, w = TV.words) => {
  const out = [];
  if (apk.error) {
    out.push({ level: /no APK/.test(apk.error) ? "info" : "fail", text: apk.error });
    return out;
  }
  if (json && json.versionName && json.versionName !== apk.versionName) {
    out.push({
      level: "warn",
      text: `${w.json} says ${json.versionName} but the APK on the server is ${apk.versionName}. ${w.devices[0].toUpperCase()}${w.devices.slice(1)} are being told ${apk.versionName} (the truth); ` +
        (cmp(json.versionName, apk.versionName) > 0
          ? `the newer APK was never copied here — ${w.rebuild}, commit ${w.apk}, and pull.`
          : "update the notes file to match."),
    });
  }
  if (!json) out.push({ level: "info", text: `no ${w.json} — ${w.devices} are told the APK's version, with no release notes.` });
  if (source.versionName && cmp(source.versionName, apk.versionName) > 0) {
    out.push({ level: "warn", text: `the source is at ${source.versionName} but the published APK is still ${apk.versionName} — it was not rebuilt (or the build's copy step failed).` });
  }
  if (source.versionName && source.appVersion && source.versionName !== source.appVersion) {
    out.push({ level: "warn", text: `build.gradle says ${source.versionName} but the app's own ${w.constant} (tv-native/src/update.ts) says ${source.appVersion} — the next build would misjudge whether it is up to date.` });
  }
  if (source.versionCode && apk.versionCode && source.versionName === apk.versionName && source.versionCode !== apk.versionCode) {
    out.push({ level: "warn", text: `same version name, different build number (source ${source.versionCode}, APK ${apk.versionCode}) — Android refuses an "update" whose build number did not go up.` });
  }
  return out;
};

const appFor = (app) => {
  const readJson = () => readJsonAt(app.jsonPath);
  const readSource = () => {
    const v = gradleVersions(readText(GRADLE_PATH))[app.key];
    return { versionName: v.versionName, versionCode: v.versionCode, appVersion: constantIn(readText(UPDATE_TS_PATH), app.words.constant) };
  };
  const status = () => {
    const apk = apkinfo.read(app.apkPath);
    const json = readJson();
    const source = readSource();
    const problems = problemsOf(apk, json, source, app.words);
    return {
      apk,
      announced: json ? { versionName: json.versionName || null, notes: json.notes || null } : null,
      source,
      problems,
      level: problems.some((p) => p.level === "fail") ? "fail" : problems.some((p) => p.level === "warn") ? "warn" : "ok",
    };
  };
  // What a device asking for its version file is told: the APK's real
  // version, with the notes when they were written for it. null → serve the
  // static file (the APK reader could not make sense of the file; don't break
  // updates over it) or nothing at all (no APK: nothing to announce).
  const announcement = () => {
    const apk = apkinfo.read(app.apkPath, { hash: false });
    if (apk.error) return /no APK/.test(apk.error) ? { none: true } : null;
    const json = readJson();
    const out = { versionName: apk.versionName, versionCode: apk.versionCode, sizeBytes: apk.sizeBytes };
    if (json && json.versionName === apk.versionName && json.notes) out.notes = json.notes;
    return out;
  };
  return { status, announcement, APK_PATH: app.apkPath, JSON_PATH: app.jsonPath };
};

const tv = appFor(TV);
const phone = appFor(PHONE);
// The phone's picture also says which signing certificate the server vouches
// for at /.well-known/assetlinks.json (App Links), and where that came from.
{
  const base = phone.status;
  phone.status = () => {
    const s = base();
    let links = null;
    try { links = require("./assetlinks").fingerprints(); } catch {}
    s.appLinks = links && links.fingerprints ? { sha256: links.fingerprints, source: links.source } : { sha256: [], source: null };
    return s;
  };
}

module.exports = {
  status: tv.status, announcement: tv.announcement, APK_PATH: tv.APK_PATH,
  tv, phone,
  _internals: { problemsOf, cmp, gradleVersions, constantIn, appFor, TV, PHONE },
};
