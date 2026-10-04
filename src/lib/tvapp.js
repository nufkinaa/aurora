// The published Android TV build, as one honest picture: what the APK on
// disk really is (lib/apkinfo.js reads it out of the file), what
// tv-version.json announces to the TVs, and what the source in tv-native/
// says the next build will be — plus every way those three can disagree.
//
// The server announces updates from the APK itself (see /tv-version.json in
// server.js), so a stale or mistyped JSON can no longer send TVs into an
// update that installs the version they already have. This module is what
// the admin's Server page and the healer read to SAY so when the pieces
// are out of step: built but not published, published but not committed,
// the app's own version constant forgotten.
const fs = require("fs");
const path = require("path");
const apkinfo = require("./apkinfo");

const ROOT = path.join(__dirname, "..", "..");
const APK_PATH = path.join(ROOT, "public", "aurora-tv.apk");
const JSON_PATH = path.join(ROOT, "public", "tv-version.json");
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

const readJson = () => {
  try { return JSON.parse(fs.readFileSync(JSON_PATH, "utf8")); } catch { return null; }
};
const readSource = () => {
  const out = { versionName: null, versionCode: null, appVersion: null };
  try {
    const g = fs.readFileSync(GRADLE_PATH, "utf8");
    out.versionName = (g.match(/versionName\s+"([^"]+)"/) || [])[1] || null;
    out.versionCode = parseInt((g.match(/versionCode\s+(\d+)/) || [])[1], 10) || null;
  } catch {}
  try {
    out.appVersion = (fs.readFileSync(UPDATE_TS_PATH, "utf8").match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || null;
  } catch {}
  return out;
};

// The disagreements, as sentences. Pure: (apk, json, source) → [{level, text}].
const problemsOf = (apk, json, source) => {
  const out = [];
  if (apk.error) {
    out.push({ level: /no APK/.test(apk.error) ? "info" : "fail", text: apk.error });
    return out;
  }
  if (json && json.versionName && json.versionName !== apk.versionName) {
    out.push({
      level: "warn",
      text: `tv-version.json says ${json.versionName} but the APK on the server is ${apk.versionName}. TVs are being told ${apk.versionName} (the truth); ` +
        (cmp(json.versionName, apk.versionName) > 0
          ? "the newer APK was never copied here — run build-apk.bat again, commit public/aurora-tv.apk, and pull."
          : "update the notes file to match."),
    });
  }
  if (!json) out.push({ level: "info", text: "no tv-version.json — TVs are told the APK's version, with no release notes." });
  if (source.versionName && cmp(source.versionName, apk.versionName) > 0) {
    out.push({ level: "warn", text: `the source is at ${source.versionName} but the published APK is still ${apk.versionName} — it was not rebuilt (or the build's copy step failed).` });
  }
  if (source.versionName && source.appVersion && source.versionName !== source.appVersion) {
    out.push({ level: "warn", text: `build.gradle says ${source.versionName} but the app's own APP_VERSION (tv-native/src/update.ts) says ${source.appVersion} — the next build would misjudge whether it is up to date.` });
  }
  if (source.versionCode && apk.versionCode && source.versionName === apk.versionName && source.versionCode !== apk.versionCode) {
    out.push({ level: "warn", text: `same version name, different build number (source ${source.versionCode}, APK ${apk.versionCode}) — Android refuses an "update" whose build number did not go up.` });
  }
  return out;
};

const status = () => {
  const apk = apkinfo.read(APK_PATH);
  const json = readJson();
  const source = readSource();
  const problems = problemsOf(apk, json, source);
  return {
    apk,
    announced: json ? { versionName: json.versionName || null, notes: json.notes || null } : null,
    source,
    problems,
    level: problems.some((p) => p.level === "fail") ? "fail" : problems.some((p) => p.level === "warn") ? "warn" : "ok",
  };
};

// What a TV asking for tv-version.json is told: the APK's real version, with
// the notes when they were written for it. null → serve the static file (the
// APK reader could not make sense of the file; don't break updates over it)
// or nothing at all (no APK: nothing to announce).
const announcement = () => {
  const apk = apkinfo.read(APK_PATH, { hash: false });
  if (apk.error) return /no APK/.test(apk.error) ? { none: true } : null;
  const json = readJson();
  const out = { versionName: apk.versionName, versionCode: apk.versionCode, sizeBytes: apk.sizeBytes };
  if (json && json.versionName === apk.versionName && json.notes) out.notes = json.notes;
  return out;
};

module.exports = { status, announcement, APK_PATH, _internals: { problemsOf, cmp } };
