#!/usr/bin/env node
"use strict";
// One command for an Aurora release (the flow that used to be done by hand).
//
//   node tools/release.js --version 1.15.12 --branches a,b --notes-file notes.md [--tv] [--phone]
//        [--tv-notes "…"] [--phone-notes "…"] [--dry-run] [--push] [--restart] [--qa-tv]
//
// What it does, in order, stopping at the first failure with a sentence that
// says what failed and what was (not) changed:
//   1  checks       everything it can before touching anything (always, also in --dry-run)
//   2  fetch        git fetch <remote> --tags
//   3  branch       in the release worktree: git checkout -B rel-<v> <remote>/master
//   4  merge        each --branches entry (the local branch, else <remote>/<branch>)
//   5  changelog    the notes file, inserted before the top "## " heading
//   6  version      npm version <v> --no-git-tag-version
//   7  apps         (--tv / --phone) in the build worktree, which holds the signing
//                   files and node_modules: check out the merged commit, gradlew
//                   assembleRelease (TV first, copied out: the phone build reuses
//                   the output folder), then verify each APK: package, versionCode/
//                   Name against build.gradle, signing certificate SHA-256 against
//                   the published APK (aapt + apksigner, and the server's own
//                   readers), then copy them to public/
//   8  notes json   public/tv-version.json, public/phone-version.json
//   9  commit       the release commit on rel-<v>
//   10 tests        the release tests (test/phoneapp*.test.js, test/tvapp.test.js) and
//                   the root tests the change can reach (tools/ci/ci-tests.js select)
//   11 live         fast-forward the live tree's master to rel-<v>
//   12 tag          server-<v>-stable (app releases, or --tag)
//   13 push         (--push) master and the tag
//   14 restart      (--restart) node scripts/keeper.js --restart in the live tree, wait for /healthz
//   15 qa tv        (--qa-tv) a QA TV build (only http://127.0.0.1:4000, versionCode + N)
//                   installed on the test TV over adb
//   16 ci           (after --push) watch the CI run through GitHub's public API
//
// --dry-run runs only the read-only checks and prints every other step's
// commands. Pushing, restarting the live server and installing on the TV each
// need their own flag. Nothing this prints may carry the admin password or the
// signing passwords: every line goes through redact().
//
// The pure parts are exported for test/release.test.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

const TOOL_ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const STABLE_TAG = (v) => `server-${v}-stable`;
const REL_BRANCH = (v) => `rel-${v}`;

// ------------------------------------------------------------------ options

const DEFAULTS = {
  repo: process.env.AURORA_RELEASE_REPO || "C:/elia/aurora-tvround",
  live: process.env.AURORA_RELEASE_LIVE || "C:/elia/aurora",
  buildDir: process.env.AURORA_RELEASE_BUILD || "C:/elia/aurora-rel57",
  remote: "origin",
  sdk: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "C:/elia/android-tools/sdk",
  javaHome: process.env.JAVA_HOME || "C:/elia/android-tools/jdk",
  map: "C:/Users/netan/AppData/Local/Temp/aurora-agents/shared/test-map.json",
  healthUrl: "http://127.0.0.1:4000/healthz",
  adbTarget: "192.168.50.31:5555",
  qaBump: 1,
  ciPollSec: 150,
  ciTimeoutMin: 45,
  healthTimeoutSec: 120,
};

const USAGE = `usage: node tools/release.js --version X.Y.Z --notes-file notes.md [--branches a,b] [options]

  --version X.Y.Z        the server version (package.json)
  --branches a,b         branches to merge (a local branch, else <remote>/<branch>)
  --notes-file f.md      the CHANGELOG entry (with or without its "## X.Y.Z — date" heading)
  --tv / --phone         build, verify and publish the TV / phone APK
  --tv-notes "…"         tv-version.json "notes" (required with --tv)
  --phone-notes "…"      phone-version.json "notes" (required with --phone)
  --summary "…"          the commit subject after "X.Y.Z[ / TV a][ / phone b]: " (default: from the notes)
  --trailer "…"          a line at the end of the commit message (repeatable)
  --tag / --no-tag       tag server-X.Y.Z-stable (default: only for app releases)
  --dry-run              read-only checks, then print every step instead of doing it
  --push                 push master and the tag
  --restart              restart the live server (keeper.js --restart) and wait for /healthz
  --qa-tv                build a QA TV variant and install it on the test TV (needs --tv)
  --no-ci-wait           after --push, do not watch the CI run
  --skip-tests           do not run tests (refused together with --push)

  paths: --repo ${DEFAULTS.repo}  --live ${DEFAULTS.live}  --build-dir ${DEFAULTS.buildDir}
         --remote ${DEFAULTS.remote}  --sdk ${DEFAULTS.sdk}  --java-home <JAVA_HOME>
         --map <test-map.json | none>  --health-url ${DEFAULTS.healthUrl}
         --adb-target ${DEFAULTS.adbTarget}  --qa-bump ${DEFAULTS.qaBump}  --staging <dir>
         --date YYYY-MM-DD  --ci-poll-sec ${DEFAULTS.ciPollSec}  --ci-timeout-min ${DEFAULTS.ciTimeoutMin}`;

const BOOL = new Set(["tv", "phone", "dry-run", "push", "restart", "qa-tv", "no-ci-wait", "skip-tests", "tag", "no-tag", "help"]);
const VALUE = new Set(["version", "branches", "notes-file", "tv-notes", "phone-notes", "summary", "trailer", "repo", "live", "build-dir", "remote", "sdk", "java-home", "map", "health-url", "adb-target", "qa-bump", "staging", "date", "ci-poll-sec", "ci-timeout-min", "health-timeout-sec"]);

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// PURE: argv → options, or { error }.
function parseArgs(argv, defaults = DEFAULTS) {
  const o = { ...defaults, trailers: [], branches: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return { error: `unexpected argument "${a}"` };
    let name = a.slice(2), val = null;
    const eq = name.indexOf("=");
    if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
    if (BOOL.has(name)) {
      if (val !== null) return { error: `--${name} takes no value` };
      o[camel(name)] = true;
      continue;
    }
    if (!VALUE.has(name)) return { error: `unknown option --${name}` };
    if (val === null) {
      val = argv[++i];
      if (val === undefined || (val.startsWith("--") && name !== "summary")) return { error: `--${name} needs a value` };
    }
    if (name === "trailer") o.trailers.push(val);
    else if (name === "branches") o.branches = val.split(",").map((s) => s.trim()).filter(Boolean);
    else o[camel(name)] = val;
  }
  for (const k of ["qaBump", "ciPollSec", "ciTimeoutMin", "healthTimeoutSec"]) o[k] = Number(o[k]);
  if (o.help) return o;
  if (!o.version) return { error: "--version is required" };
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) return { error: `--version must look like 1.15.12 (got "${o.version}")` };
  if (!o.notesFile) return { error: "--notes-file is required (the CHANGELOG entry)" };
  if (o.qaTv && !o.tv) return { error: "--qa-tv needs --tv (the QA variant is built from the release's TV source)" };
  if (o.tv && !o.tvNotes) return { error: "--tv needs --tv-notes \"…\" (tv-version.json's notes)" };
  if (o.phone && !o.phoneNotes) return { error: "--phone needs --phone-notes \"…\" (phone-version.json's notes)" };
  if (o.tag && o.noTag) return { error: "--tag and --no-tag together" };
  if (o.skipTests && o.push) return { error: "--skip-tests with --push: a release is never pushed untested" };
  if (!(o.qaBump >= 1)) return { error: "--qa-bump must be 1 or more" };
  if (o.date && !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return { error: "--date must be YYYY-MM-DD" };
  for (const b of o.branches) if (!/^[A-Za-z0-9._\/-]+$/.test(b)) return { error: `branch name "${b}" has characters this tool does not accept` };
  o.date = o.date || localDate();
  o.tagIt = o.noTag ? false : o.tag ? true : !!(o.tv || o.phone);
  return o;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ------------------------------------------------------------------ pure helpers

const eolOf = (text) => (/\r\n/.test(text) ? "\r\n" : "\n");
const toEol = (text, eol) => text.replace(/\r?\n/g, eol);

const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

// PURE: the notes file → the CHANGELOG entry, with its "## v — date" heading.
// A heading already there must name this version.
function changelogEntry(notes, version, date) {
  const text = String(notes).replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("the notes file is empty");
  const lines = text.split("\n");
  if (/^#\s/.test(lines[0])) throw new Error('the notes file starts with a "# " title; use "## <version> — <date>" or no heading');
  if (/^##\s/.test(lines[0])) {
    const m = lines[0].match(/^##\s+(\S+)/);
    if (!m || m[1] !== version) throw new Error(`the notes file's heading "${lines[0]}" does not name ${version}`);
    if (lines.slice(1).some((l) => /^##\s/.test(l))) throw new Error("the notes file holds more than one \"## \" heading");
    return text + "\n";
  }
  if (lines.some((l) => /^##\s/.test(l))) throw new Error("the notes file has a \"## \" heading below its first line");
  return `## ${version} — ${date}\n\n${text}\n`;
}

// PURE: insert the entry before the first "## " heading of CHANGELOG.md, keeping
// the file's line endings. Refuses a version that is already there.
function insertChangelog(changelog, entry, version) {
  const eol = eolOf(changelog);
  const lines = changelog.split(/\r?\n/);
  if (lines.some((l) => new RegExp(`^##\\s+${version.replace(/\./g, "\\.")}(\\s|$)`).test(l))) throw new Error(`CHANGELOG.md already has a ${version} entry`);
  const at = lines.findIndex((l) => /^##\s/.test(l));
  if (at < 0) throw new Error('CHANGELOG.md has no "## " heading to insert before');
  const body = entry.replace(/\r?\n$/, "").split("\n");
  const out = [...lines.slice(0, at), ...body, "", ...lines.slice(at)];
  return out.join(eol);
}

// PURE: the version json files, keeping their key order, indent and line endings.
function updateVersionJson(text, fields) {
  const j = JSON.parse(text);
  for (const [k, v] of Object.entries(fields)) j[k] = v;
  const eol = eolOf(text);
  const trailing = /\r?\n$/.test(text) ? eol : "";
  return toEol(JSON.stringify(j, null, 2), eol) + trailing;
}

// PURE: `aapt dump badging` → { package, versionCode, versionName }.
function parseAapt(out) {
  const m = String(out).match(/^package:\s*name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']*)'/m);
  if (!m) return null;
  return { package: m[1], versionCode: Number(m[2]), versionName: m[3] };
}

// PURE: `apksigner verify --print-certs` → the signers' certificate SHA-256s (lowercase hex).
function parseApksigner(out) {
  return [...String(out).matchAll(/certificate SHA-256 digest:\s*([0-9a-fA-F:]{64,95})/g)].map((m) => m[1].replace(/:/g, "").toLowerCase());
}

// PURE: tv-native/src/api.ts with only the loopback address in SERVER_CANDIDATES
// (the QA variant; Gradle's -PauroraQa guard checks the same).
function qaApiTs(text) {
  const eol = eolOf(text);
  const i = text.indexOf("export const SERVER_CANDIDATES = [");
  if (i < 0) throw new Error("SERVER_CANDIDATES not found in tv-native/src/api.ts");
  const j = text.indexOf("];", i);
  if (j < 0) throw new Error("SERVER_CANDIDATES has no end in tv-native/src/api.ts");
  return text.slice(0, i) + "export const SERVER_CANDIDATES = [" + eol + "  'http://127.0.0.1:4000', // QA VARIANT (private instance only)" + eol + text.slice(j);
}

// PURE: build.gradle with the TV's own versionCode (defaultConfig's first one,
// outside `if (auroraPhone) { … }`) set to `code`.
function setTvVersionCode(gradle, code) {
  const block = /if\s*\(\s*auroraPhone\s*\)\s*\{[^{}]*\}/g;
  const spans = [...gradle.matchAll(block)].map((m) => [m.index, m.index + m[0].length]);
  const re = /versionCode\s+(\d+)/g;
  let m;
  while ((m = re.exec(gradle))) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    return gradle.slice(0, m.index) + `versionCode ${code}` + gradle.slice(m.index + m[0].length);
  }
  throw new Error("no TV versionCode in build.gradle");
}

// PURE: `adb shell dumpsys package <pkg>` → the installed versionCode, or null.
const parseDumpsysVersionCode = (out) => {
  const m = String(out).match(/versionCode=(\d+)/);
  return m ? Number(m[1]) : null;
};

// PURE: the commit subject from the notes (first bold phrase, else the first line).
function summaryFromNotes(entry) {
  const body = entry.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() && !/^##\s/.test(l));
  const bold = (body.join(" ").match(/\*\*([^*]+)\*\*/) || [])[1];
  let s = (bold || body[0] || "release").replace(/^[-*]\s+/, "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/[.:;,—-]+\s*$/, "");
  if (s.length > 100) s = s.slice(0, 97).replace(/\s+\S*$/, "") + "…";
  return s.charAt(0).toLowerCase() === s.charAt(0) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function commitMessage({ version, tvName, phoneName, summary, trailers }) {
  const head = `${version}${tvName ? ` / TV ${tvName}` : ""}${phoneName ? ` / phone ${phoneName}` : ""}: ${summary}`;
  return trailers && trailers.length ? `${head}\n\n${trailers.join("\n")}\n` : `${head}\n`;
}

// PURE: owner/repo from a GitHub remote URL, or null (a local path, another host).
const githubRepoOf = (url) => {
  const m = String(url || "").match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
};

// Secrets this run must never print: the signing passwords (keystore.properties)
// and the admin password (env, .env, config.json) of the trees it works in.
// Read in-process only; the values never leave redact().
function collectSecrets(dirs, buildDir) {
  const out = new Set();
  const add = (v) => { if (typeof v === "string" && v.length >= 3) out.add(v); };
  add(process.env.AURORA_ADMIN_PASSWORD);
  for (const d of dirs.filter(Boolean)) {
    try { add(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).adminPassword); } catch {}
    try {
      for (const line of fs.readFileSync(path.join(d, ".env"), "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*AURORA_ADMIN_PASSWORD\s*=\s*(.*?)\s*$/);
        if (m) add(m[1].replace(/^(["'])(.*)\1$/, "$2"));
      }
    } catch {}
  }
  if (buildDir) {
    for (const f of ["tv-native/android/keystore.properties", "tv-native/android/app/keystore.properties"]) {
      try {
        for (const line of fs.readFileSync(path.join(buildDir, f), "utf8").split(/\r?\n/)) {
          const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
          if (m && /pass|secret|token/i.test(m[1])) add(m[2]);
        }
      } catch {}
    }
  }
  return [...out];
}

function makeRedact(secrets) {
  const list = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
  const patterns = list.map((v) => new RegExp(`(?<![A-Za-z0-9_])${escape(v)}(?![A-Za-z0-9_])`, "g"));
  return (text) => {
    let s = String(text);
    // whole tokens only: a secret that happens to be part of a longer word (a
    // folder name) is not a leak, and masking it there would garble paths
    for (const re of patterns) s = s.replace(re, "***");
    // credentials inside URLs (https://user:token@host)
    return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi, "$1***@");
  };
}

// ------------------------------------------------------------------ running things

class Stop extends Error {}

function quoteWin(a) {
  if (a === "") return '""';
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

// Children never inherit a test runner's context: under `node --test` (this
// tool's own tests) NODE_TEST_CONTEXT would make the release's `node --test`
// runs report to the outer runner instead of printing, and pass regardless.
const cleanEnv = (env = process.env) => {
  const e = { ...env };
  delete e.NODE_TEST_CONTEXT;
  return e;
};

class Runner {
  constructor({ dry, redact, log = (s) => process.stdout.write(s) }) {
    this.dry = dry;
    this.redact = redact;
    this.write = log;
    this.step = 0;
  }
  say(s = "") { this.write(this.redact(s) + "\n"); }
  title(t) { this.step++; this.say(`\n[${this.step}] ${t}`); }
  fail(msg) { throw new Stop(msg); }
  show(cmd, args, cwd) {
    return `$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}${cwd ? `   (in ${cwd})` : ""}`;
  }
  // A read-only command: runs in --dry-run too. Returns { status, out, err }.
  read(cmd, args, { cwd, env, timeoutMs = 120000 } = {}) {
    const r = this._sync(cmd, args, { cwd, env, timeoutMs });
    return r;
  }
  _sync(cmd, args, { cwd, env, timeoutMs }) {
    env = cleanEnv(env);
    const shell = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
    const r = shell
      ? spawnSync([cmd, ...args].map(quoteWin).join(" "), { cwd, env, shell: true, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 })
      : spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 });
    return { status: r.error ? -1 : r.status, out: r.stdout || "", err: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
  }
  // A command that changes something: printed, and in --dry-run not run.
  // `stream` echoes its output (redacted) as it comes; `logFile` keeps it there
  // instead, and only the tail is shown on failure.
  async run(cmd, args, { cwd, env, timeoutMs = 30 * 60000, stream = false, logFile = null, okCodes = [0] } = {}) {
    this.say(this.show(cmd, args, cwd));
    if (this.dry) return { status: 0, out: "", err: "", dry: true };
    env = cleanEnv(env);
    return new Promise((resolve) => {
      const shell = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
      const child = shell
        ? spawn([cmd, ...args].map(quoteWin).join(" "), { cwd, env, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env, windowsHide: true });
      let out = "", err = "";
      const sink = logFile ? fs.createWriteStream(logFile) : null;
      let pending = "";
      const echo = (chunk) => {
        if (!stream) return;
        pending += chunk;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop();
        for (const p of parts) this.say(`    ${p}`);
      };
      child.stdout.on("data", (d) => { const s = d.toString(); out += s; if (sink) sink.write(s); echo(s); });
      child.stderr.on("data", (d) => { const s = d.toString(); err += s; if (sink) sink.write(s); echo(s); });
      const timer = setTimeout(() => { try { child.kill(); } catch {} err += `\n(timed out after ${Math.round(timeoutMs / 1000)} s)`; }, timeoutMs);
      child.on("error", (e) => { err += String(e.message); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (pending && stream) this.say(`    ${pending}`);
        if (sink) sink.end();
        resolve({ status: okCodes.includes(code) ? 0 : code === null ? -1 : code, code, out, err });
      });
    });
  }
  // A change done in-process (a file written): described, and in --dry-run not done.
  doing(desc, fn) {
    this.say(`  ${desc}`);
    if (this.dry) return undefined;
    return fn();
  }
}

const tail = (text, n = 25) => String(text).split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => `    ${l}`).join("\n");

// ------------------------------------------------------------------ the release

const npmCmd = IS_WIN ? "npm.cmd" : "npm";
const gradlewOf = (buildDir) => path.join(buildDir, "tv-native", "android", IS_WIN ? "gradlew.bat" : "gradlew");
const APPS = {
  tv: { key: "tv", package: "com.auroratv", out: "app-release.apk", publish: "aurora-tv.apk", json: "tv-version.json", gradleArgs: [], constant: "APP_VERSION", label: "TV" },
  phone: { key: "phone", package: "com.aurora.phone", out: "aurora-phone-release.apk", publish: "aurora-phone.apk", json: "phone-version.json", gradleArgs: ["-Paurora=phone"], constant: "PHONE_APP_VERSION", label: "phone" },
};

function findBuildTool(sdk, name) {
  const dir = path.join(sdk, "build-tools");
  let versions = [];
  try { versions = fs.readdirSync(dir).filter((v) => /^\d/.test(v)).sort(cmpVersion).reverse(); } catch { return null; }
  const exts = IS_WIN ? (name === "apksigner" ? [".bat"] : [".exe"]) : [""];
  for (const v of versions) for (const e of exts) {
    const p = path.join(dir, v, name + e);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function release(o, deps = {}) {
  const lib = {
    tvapp: require(path.join(TOOL_ROOT, "src", "lib", "tvapp.js"))._internals,
    apkinfo: require(path.join(TOOL_ROOT, "src", "lib", "apkinfo.js")),
    apksign: require(path.join(TOOL_ROOT, "src", "lib", "apksign.js")),
  };
  const apps = [o.tv && APPS.tv, o.phone && APPS.phone].filter(Boolean);
  const redact = makeRedact(collectSecrets([o.repo, o.live], apps.length ? o.buildDir : null));
  const x = new Runner({ dry: !!o.dryRun, redact, log: deps.log });
  const git = (dir, ...args) => x.read("git", ["-C", dir, ...args]);
  const gitOut = (dir, ...args) => { const r = git(dir, ...args); return r.status === 0 ? r.out.trim() : null; };
  const must = async (r, what) => { if (r.status !== 0) x.fail(`${what} failed:\n${tail(r.err || r.out)}`); return r; };
  const v = o.version;
  const rel = REL_BRANCH(v);
  const tag = STABLE_TAG(v);
  const staging = o.staging || path.join(os.tmpdir(), "aurora-release", v);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const javaEnv = { ...env, JAVA_HOME: o.javaHome };
  const notes = { file: o.notesFile };
  const state = { mergedSha: null, apps: {}, pushed: false, liveMoved: false, tagged: false, committed: null };

  x.say(`Aurora release ${v}${o.dryRun ? " (DRY RUN: only read-only checks run; every other step is printed)" : ""}`);
  x.say(`  release worktree ${o.repo}, live tree ${o.live}, remote ${o.remote}${apps.length ? `, build worktree ${o.buildDir}` : ""}`);
  x.say(`  branches: ${o.branches.length ? o.branches.join(", ") : "(none: release master as it is)"}; apps: ${apps.map((a) => a.label).join(", ") || "none"}; tag ${o.tagIt ? tag : "none"}`);
  x.say(`  then: ${[o.push && "push", o.restart && "restart the live server", o.qaTv && "QA TV install", o.push && !o.noCiWait && "watch CI"].filter(Boolean).join(", ") || "nothing leaves this PC (no --push / --restart / --qa-tv)"}`);

  // ---------------------------------------------------------------- 1 checks
  x.title("Checks (read-only)");
  const problems = [];
  const problem = (s) => { problems.push(s); x.say(`  PROBLEM: ${s}`); };
  const ok = (s) => x.say(`  ok: ${s}`);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  try { notes.text = fs.readFileSync(o.notesFile, "utf8"); notes.entry = changelogEntry(notes.text, v, o.date); ok(`notes file ${o.notesFile} (${notes.entry.split("\n").length} lines)`); } catch (e) { problem(`notes file ${o.notesFile}: ${e.code === "ENOENT" ? "not found" : e.message}`); }
  const top = (d) => gitOut(d, "rev-parse", "--show-toplevel");
  const repoTop = top(o.repo), liveTop = top(o.live);
  if (!repoTop) problem(`${o.repo} is not a git worktree`);
  if (!liveTop) problem(`${o.live} is not a git worktree`);
  if (repoTop && liveTop && same(repoTop, liveTop)) problem("the release worktree is the live tree: releases are prepared in a separate worktree (--repo)");
  const dirty = (d) => { const r = git(d, "status", "--porcelain", "--untracked-files=no"); return r.status === 0 ? r.out.trim() : "(git status failed)"; };
  if (repoTop) { const d = dirty(o.repo); if (d) problem(`the release worktree has uncommitted changes:\n${d.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n")}`); else ok("release worktree clean"); }
  if (liveTop) {
    const b = gitOut(o.live, "rev-parse", "--abbrev-ref", "HEAD");
    if (b !== "master") problem(`the live tree is on "${b}", not master`);
    const d = dirty(o.live); if (d) problem(`the live tree has uncommitted changes to tracked files:\n${d.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n")}`); else ok("live tree on master, no tracked changes");
  }
  const remoteUrl = repoTop ? gitOut(o.repo, "remote", "get-url", o.remote) : null;
  if (repoTop && !remoteUrl) problem(`no remote "${o.remote}" in ${o.repo}`);
  else if (remoteUrl) ok(`remote ${o.remote} = ${remoteUrl}`);
  const base = `${o.remote}/master`;
  if (repoTop) {
    if (gitOut(o.repo, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) problem(`the tag ${tag} already exists`);
    if (!x.dry) ok(`(fetch comes next; branches and versions are checked again after it)`);
    const pj = gitOut(o.repo, "show", `${base}:package.json`);
    try {
      const cur = JSON.parse(pj).version;
      if (cmpVersion(v, cur) <= 0) problem(`${v} is not newer than ${base}'s ${cur}`);
      else ok(`${base} is at ${cur}; releasing ${v}`);
    } catch { problem(`could not read package.json at ${base}`); }
  }
  const resolveBranch = (b) => {
    if (gitOut(o.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`)) return b;
    if (gitOut(o.repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${o.remote}/${b}^{commit}`)) return `${o.remote}/${b}`;
    return null;
  };
  if (repoTop) for (const b of o.branches) {
    const r = resolveBranch(b);
    if (!r) problem(`branch "${b}" not found (neither local nor ${o.remote}/${b})`);
    else ok(`branch ${b} -> ${r} at ${(gitOut(o.repo, "rev-parse", "--short", r) || "?")}`);
  }
  let tools = {};
  if (apps.length) {
    const bTop = top(o.buildDir);
    if (!bTop) problem(`the build worktree ${o.buildDir} is not a git worktree`);
    else {
      const d = dirty(o.buildDir); if (d) problem(`the build worktree has uncommitted changes to tracked files:\n${d.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n")}`); else ok("build worktree clean");
      if (!fs.existsSync(gradlewOf(o.buildDir))) problem(`no ${gradlewOf(o.buildDir)}`);
      if (!fs.existsSync(path.join(o.buildDir, "tv-native", "android", "keystore.properties"))) problem("the build worktree has no tv-native/android/keystore.properties (the signing setup)");
      if (!fs.existsSync(path.join(o.buildDir, "tv-native", "node_modules"))) problem("the build worktree has no tv-native/node_modules");
    }
    tools.aapt = findBuildTool(o.sdk, "aapt");
    tools.apksigner = findBuildTool(o.sdk, "apksigner");
    if (!tools.aapt) problem(`no aapt under ${o.sdk}/build-tools`); else ok(`aapt ${tools.aapt}`);
    if (!tools.apksigner) problem(`no apksigner under ${o.sdk}/build-tools`); else ok(`apksigner ${tools.apksigner}`);
    if (!fs.existsSync(path.join(o.javaHome, "bin", IS_WIN ? "java.exe" : "java"))) problem(`JAVA_HOME ${o.javaHome} has no bin/java`);
    for (const a of apps) if (repoTop && !fs.existsSync(path.join(o.repo, "public", a.publish))) problem(`no published ${a.publish} in ${o.repo}/public to compare the signing certificate with`);
  }
  if (o.qaTv) {
    tools.adb = path.join(o.sdk, "platform-tools", IS_WIN ? "adb.exe" : "adb");
    if (!fs.existsSync(tools.adb)) problem(`no adb at ${tools.adb}`); else ok(`adb ${tools.adb}, test TV ${o.adbTarget}`);
  }
  if (o.restart && liveTop && !fs.existsSync(path.join(o.live, "scripts", "keeper.js"))) problem("the live tree has no scripts/keeper.js");
  if (problems.length) {
    if (x.dry) x.say(`\n  ${problems.length} problem(s) above: a real run would stop here. The steps it would run follow anyway.`);
    else x.fail(`${problems.length} problem(s) found before anything was changed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  // ---------------------------------------------------------------- 2 fetch
  x.title(`Fetch ${o.remote}`);
  await must(await x.run("git", ["-C", o.repo, "fetch", o.remote, "--tags"], { env }), "git fetch");
  if (!x.dry) {
    if (gitOut(o.repo, "ls-remote", "--tags", o.remote, `refs/tags/${tag}`)) x.fail(`the tag ${tag} already exists on ${o.remote}`);
    for (const b of o.branches) if (!resolveBranch(b)) x.fail(`branch "${b}" not found after the fetch`);
    const cur = JSON.parse(gitOut(o.repo, "show", `${base}:package.json`) || "{}").version;
    if (!cur || cmpVersion(v, cur) <= 0) x.fail(`${v} is not newer than ${base}'s ${cur}`);
  }

  // ---------------------------------------------------------------- 3 branch
  x.title(`Branch ${rel} from ${base}`);
  await must(await x.run("git", ["-C", o.repo, "checkout", "-B", rel, base]), `git checkout -B ${rel}`);

  // ---------------------------------------------------------------- 4 merge
  x.title(`Merge ${o.branches.length} branch(es)`);
  if (!o.branches.length) x.say("  (none)");
  for (const b of o.branches) {
    const ref = resolveBranch(b) || b;
    const r = await x.run("git", ["-C", o.repo, "merge", "--no-edit", ref], { env });
    if (r.status !== 0) {
      const conflicts = gitOut(o.repo, "diff", "--name-only", "--diff-filter=U") || "";
      x.read("git", ["-C", o.repo, "merge", "--abort"]);
      x.fail(`merging ${ref} into ${rel} failed${conflicts ? ` (conflicts in: ${conflicts.split("\n").join(", ")})` : ""}. The merge was aborted; ${rel} is left in ${o.repo} with the branches before it. Resolve on the branch and run again.\n${tail(r.out + r.err, 12)}`);
    }
  }
  state.mergedSha = x.dry ? `<${rel} after the merges>` : gitOut(o.repo, "rev-parse", "HEAD");
  if (!x.dry) {
    const api = gitOut(o.repo, "show", "HEAD:tv-native/src/api.ts") || "";
    if (/QA VARIANT/.test(api)) x.fail("tv-native/src/api.ts on the merged commit holds a QA VARIANT marker: a QA build's server list was committed. Fix the branch first.");
    x.say(`  merged: ${state.mergedSha.slice(0, 10)}`);
  }

  // ---------------------------------------------------------------- 5 changelog
  x.title("CHANGELOG entry");
  const clPath = path.join(o.repo, "CHANGELOG.md");
  x.doing(`insert the ${v} entry (${(notes.entry || "").split("\n").length} lines) before the top "## " heading of ${clPath}`, () => {
    fs.writeFileSync(clPath, insertChangelog(fs.readFileSync(clPath, "utf8"), notes.entry, v));
  });

  // ---------------------------------------------------------------- 6 version
  x.title(`Version ${v}`);
  await must(await x.run(npmCmd, ["version", v, "--no-git-tag-version", "--allow-same-version"], { cwd: o.repo }), "npm version");

  // ---------------------------------------------------------------- 7 apps
  if (apps.length) {
    x.title(`Build and verify: ${apps.map((a) => a.label).join(" + ")}`);
    if (!x.dry) fs.mkdirSync(staging, { recursive: true });
    x.say(`  staging folder ${staging} (the APKs only; the keystore is never copied)`);
    const before = gitOut(o.buildDir, "rev-parse", "HEAD");
    await must(await x.run("git", ["-C", o.buildDir, "checkout", "-B", `build-${v}`, x.dry ? `<${rel} after the merges>` : state.mergedSha]), "checking out the merged commit in the build worktree");
    const lockChanged = x.dry ? null : git(o.buildDir, "diff", "--quiet", before, "HEAD", "--", "tv-native/package-lock.json").status !== 0;
    if (lockChanged || x.dry) {
      if (x.dry) x.say("  (only if tv-native/package-lock.json changed since the build worktree's last build:)");
      await must(await x.run(npmCmd, ["ci", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: path.join(o.buildDir, "tv-native"), logFile: x.dry ? null : path.join(staging, "tv-native-npm-ci.log") }), "npm ci in the build worktree's tv-native");
    }
    const gradle = x.dry ? null : fs.readFileSync(path.join(o.buildDir, "tv-native", "android", "app", "build.gradle"), "utf8");
    const updateTs = x.dry ? null : fs.readFileSync(path.join(o.buildDir, "tv-native", "src", "update.ts"), "utf8");
    const want = gradle ? lib.tvapp.gradleVersions(gradle) : null;
    const outDir = path.join(o.buildDir, "tv-native", "android", "app", "build", "outputs", "apk", "release");
    for (const a of apps) {
      const exp = want ? want[a.key] : null;
      if (!x.dry) {
        if (!exp.versionName || !exp.versionCode) x.fail(`build.gradle has no ${a.label} versionName/versionCode`);
        const constant = lib.tvapp.constantIn(updateTs, a.constant);
        if (constant !== exp.versionName) x.fail(`build.gradle says ${a.label} ${exp.versionName} but tv-native/src/update.ts ${a.constant} says ${constant}: bump both on the branch`);
        const pub = lib.apkinfo.read(path.join(o.repo, "public", a.publish), { hash: false });
        if (pub && !pub.error && !(exp.versionCode > pub.versionCode && cmpVersion(exp.versionName, pub.versionName) > 0)) {
          x.fail(`the ${a.label} source is ${exp.versionName} (${exp.versionCode}) but the published APK is already ${pub.versionName} (${pub.versionCode}): the branches did not bump the ${a.label} app`);
        }
        x.say(`  ${a.label}: building ${exp.versionName} (versionCode ${exp.versionCode})`);
      }
      const outApk = path.join(outDir, a.out);
      x.doing(`remove any old ${outApk}`, () => fs.rmSync(outApk, { force: true }));
      const log = path.join(staging, `${a.key}-build.log`);
      const r = await x.run(gradlewOf(o.buildDir), ["assembleRelease", ...a.gradleArgs, "--console=plain"], { cwd: path.join(o.buildDir, "tv-native", "android"), env: javaEnv, logFile: x.dry ? null : log, timeoutMs: 60 * 60000 });
      if (r.status !== 0 || (!x.dry && !/BUILD SUCCESSFUL/.test(r.out))) {
        const why = String(r.out + r.err).split(/\r?\n/).filter((l) => /What went wrong|error:|^e: |FAILED/.test(l)).slice(0, 12).join("\n    ");
        x.fail(`the ${a.label} build failed (full log: ${log}):\n    ${why || tail(r.out + r.err, 20)}`);
      }
      const staged = path.join(staging, a.publish);
      x.doing(`copy ${outApk} -> ${staged}`, () => {
        if (!fs.existsSync(outApk)) x.fail(`gradle said BUILD SUCCESSFUL but ${outApk} is missing`);
        fs.copyFileSync(outApk, staged);
      });
      // verify
      if (x.dry) {
        x.say(dryVerifyLine(a, tools, o));
        continue;
      }
      const info = lib.apkinfo.read(staged, { hash: false });
      if (info.error) x.fail(`the new ${a.label} APK could not be read: ${info.error}`);
      if (info.package && info.package !== a.package) x.fail(`the new ${a.label} APK is package ${info.package}, expected ${a.package}`);
      if (info.versionName !== exp.versionName || info.versionCode !== exp.versionCode) x.fail(`the new ${a.label} APK is ${info.versionName} (${info.versionCode}), build.gradle says ${exp.versionName} (${exp.versionCode})`);
      const badging = parseAapt(x.read(tools.aapt, ["dump", "badging", staged]).out);
      if (!badging) x.fail(`aapt could not read the new ${a.label} APK`);
      if (badging.package !== a.package) x.fail(`the new ${a.label} APK is package ${badging.package}, expected ${a.package}`);
      if (badging.versionCode !== exp.versionCode || badging.versionName !== exp.versionName) x.fail(`aapt says the new ${a.label} APK is ${badging.versionName} (${badging.versionCode}), expected ${exp.versionName} (${exp.versionCode})`);
      const signNew = x.read(tools.apksigner, ["verify", "--print-certs", staged], { env: javaEnv });
      if (signNew.status !== 0) x.fail(`apksigner does not accept the new ${a.label} APK:\n${tail(signNew.out + signNew.err, 10)}`);
      const published = path.join(o.repo, "public", a.publish);
      const signOld = x.read(tools.apksigner, ["verify", "--print-certs", published], { env: javaEnv });
      const newCert = parseApksigner(signNew.out)[0], oldCert = parseApksigner(signOld.out)[0];
      if (!newCert || !oldCert) x.fail(`apksigner gave no certificate digest for the ${!newCert ? "new" : "published"} ${a.label} APK`);
      if (newCert !== oldCert) x.fail(`the new ${a.label} APK is signed by ${newCert.slice(0, 16)}…, the published one by ${oldCert.slice(0, 16)}…: devices would refuse the update. Was it built with the release keystore?`);
      const jsCert = lib.apksign.read(staged);
      if (jsCert && jsCert.sha256 && String(jsCert.sha256).replace(/:/g, "").toLowerCase() !== newCert) x.fail(`apksigner and the server's own reader disagree on the ${a.label} APK's certificate`);
      x.say(`  ${a.label}: ${badging.package} ${badging.versionName} (${badging.versionCode}), signed ${newCert.slice(0, 16)}… = the published APK's certificate`);
      state.apps[a.key] = { versionName: info.versionName, versionCode: info.versionCode, staged };
    }
    for (const a of apps) {
      x.doing(`copy ${path.join(staging, a.publish)} -> ${path.join(o.repo, "public", a.publish)}`, () => fs.copyFileSync(state.apps[a.key].staged, path.join(o.repo, "public", a.publish)));
    }

    // ---------------------------------------------------------------- 8 notes json
    x.title("Version notes files");
    for (const a of apps) {
      const p = path.join(o.repo, "public", a.json);
      const fields = a.key === "tv" ? { versionName: (state.apps.tv || {}).versionName || "<the TV APK's versionName>", notes: o.tvNotes } : { versionName: (state.apps.phone || {}).versionName || "<the phone APK's versionName>", date: o.date, notes: o.phoneNotes };
      x.doing(`public/${a.json}: ${JSON.stringify(fields)}`, () => fs.writeFileSync(p, updateVersionJson(fs.readFileSync(p, "utf8"), fields)));
    }
  }

  // ---------------------------------------------------------------- 9 commit
  x.title("Commit");
  const summary = o.summary || summaryFromNotes(notes.entry || "release");
  const msg = commitMessage({ version: v, tvName: o.tv && ((state.apps.tv || {}).versionName || "<TV versionName>"), phoneName: o.phone && ((state.apps.phone || {}).versionName || "<phone versionName>"), summary, trailers: o.trailers });
  x.say(`  message: ${msg.split("\n")[0]}`);
  const files = ["CHANGELOG.md", "package.json", "package-lock.json", ...apps.flatMap((a) => [`public/${a.publish}`, `public/${a.json}`])]
    .filter((f) => x.dry || fs.existsSync(path.join(o.repo, f)));
  await must(await x.run("git", ["-C", o.repo, "add", "--", ...files]), "git add");
  const msgFile = path.join(os.tmpdir(), `aurora-release-msg-${process.pid}.txt`);
  if (!x.dry) fs.writeFileSync(msgFile, msg);
  const c = await x.run("git", ["-C", o.repo, "commit", "-F", msgFile], { env });
  try { fs.rmSync(msgFile, { force: true }); } catch {}
  await must(c, "git commit");
  state.committed = x.dry ? `<the release commit>` : gitOut(o.repo, "rev-parse", "HEAD");
  if (!x.dry) x.say(`  ${state.committed.slice(0, 10)} on ${rel}`);
  const notPushed = () => `The release commit is only on ${rel} in ${o.repo}; nothing was pushed, the live tree was not moved.`;

  // ---------------------------------------------------------------- 10 tests
  x.title("Tests");
  if (o.skipTests) x.say("  skipped (--skip-tests)");
  else {
    const testDir = path.join(o.repo, "test");
    const list = () => { try { return fs.readdirSync(testDir); } catch { return []; } };
    const releaseTests = list().filter((f) => /^(phoneapp.*|tvapp)\.test\.js$/.test(f)).sort().map((f) => `test/${f}`);
    if (releaseTests.length) {
      x.say("  release tests:");
      const r = await x.run(process.execPath, ["--test", ...releaseTests], { cwd: o.repo, stream: true });
      if (r.status !== 0) x.fail(`the release tests failed. ${notPushed()}`);
    } else x.say("  (no release tests in this tree)");
    const selector = path.join(o.repo, "tools", "ci", "ci-tests.js");
    const selOut = path.join(os.tmpdir(), `aurora-release-tests-${process.pid}.txt`);
    if (!fs.existsSync(selector)) {
      x.say("  no tools/ci/ci-tests.js in this tree: running the whole root suite");
      const r = await x.run(npmCmd, ["test"], { cwd: o.repo, stream: true });
      if (r.status !== 0) x.fail(`the root tests failed. ${notPushed()}`);
    } else {
      const mapArgs = o.map && o.map !== "none" ? ["--map", o.map] : [];
      x.say("  affected root tests:");
      const sel = x.dry
        ? (x.say(x.show(process.execPath, [selector, "select", ...mapArgs, "--base", base, "--head", "HEAD", "--out", selOut], o.repo)), x.read(process.execPath, [selector, "select", ...mapArgs, "--base", base, "--head", "HEAD"], { cwd: o.repo }))
        : await x.run(process.execPath, [selector, "select", ...mapArgs, "--base", base, "--head", "HEAD", "--out", selOut], { cwd: o.repo });
      const first = (sel.out || "").split(/\r?\n/)[0] || "";
      for (const l of (sel.out || "").split(/\r?\n/).filter(Boolean).slice(0, 40)) x.say(`    ${l}`);
      if (x.dry) x.say("    (in the dry run this compares the current state; the real run compares the release commit, then runs what it lists, or `npm test` when it says ALL)");
      else {
        const chosen = (fs.existsSync(selOut) ? fs.readFileSync(selOut, "utf8") : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        try { fs.rmSync(selOut, { force: true }); } catch {}
        let r;
        if (/^Running ALL/.test(first)) r = await x.run(npmCmd, ["test"], { cwd: o.repo, stream: true });
        else {
          const rest = chosen.filter((t) => !releaseTests.includes(t));
          if (!rest.length) { x.say("    nothing more to run"); r = { status: 0 }; }
          else r = await x.run(process.execPath, ["--test", ...rest], { cwd: o.repo, stream: true });
        }
        if (r.status !== 0) x.fail(`the root tests failed. ${notPushed()}`);
      }
    }
  }

  // ---------------------------------------------------------------- 11 live
  x.title("Fast-forward the live tree");
  const ff = await x.run("git", ["-C", o.live, "merge", "--ff-only", rel], { env });
  if (ff.status !== 0) x.fail(`the live tree's master could not be fast-forwarded to ${rel} (it has commits of its own, or files in the way):\n${tail(ff.out + ff.err, 10)}\n${notPushed()}`);
  state.liveMoved = !x.dry;

  // ---------------------------------------------------------------- 12 tag
  x.title("Tag");
  if (o.tagIt) {
    await must(await x.run("git", ["-C", o.repo, "tag", tag, rel]), `git tag ${tag}`);
    state.tagged = !x.dry;
  } else x.say("  no tag (a server-only release; pass --tag to tag it, which also lets nufurora's auto-update in stable mode take it)");

  // ---------------------------------------------------------------- 13 push
  x.title("Push");
  if (!o.push) x.say("  not pushed (no --push). Later: git push " + o.remote + " master" + (o.tagIt ? ` && git push ${o.remote} ${tag}` : ""));
  else {
    await must(await x.run("git", ["-C", o.repo, "push", o.remote, "refs/heads/master:refs/heads/master"], { env }), "git push master");
    if (o.tagIt) await must(await x.run("git", ["-C", o.repo, "push", o.remote, `refs/tags/${tag}`], { env }), `git push ${tag}`);
    state.pushed = !x.dry;
  }

  // ---------------------------------------------------------------- 14 restart
  x.title("Restart the live server");
  if (!o.restart) x.say("  not restarted (no --restart). Later: node scripts/keeper.js --restart (in the live tree)");
  else {
    await must(await x.run(process.execPath, ["scripts/keeper.js", "--restart"], { cwd: o.live, timeoutMs: 60000 }), "keeper.js --restart");
    x.say(`  waiting for ${o.healthUrl} to say version ${v} (up to ${o.healthTimeoutSec} s)`);
    if (!x.dry) {
      const h = await waitHealth(o.healthUrl, v, o.healthTimeoutSec * 1000, deps.fetchJson);
      if (!h.ok) x.fail(`the live server did not come back on ${v} within ${o.healthTimeoutSec} s (last answer: ${h.last}). Check node scripts/keeper.js --status in the live tree.`);
      x.say(`  up on ${v} (uptime ${h.body.uptime} s)`);
    }
  }

  // ---------------------------------------------------------------- 15 qa tv
  x.title("QA TV variant");
  if (!o.qaTv) x.say("  not built (no --qa-tv)");
  else await qaTv(o, x, { tools, staging, lib, javaEnv, release: state.apps.tv, gradlewOf });

  // ---------------------------------------------------------------- 16 ci
  x.title("CI");
  const gh = githubRepoOf(remoteUrl);
  if (!o.push) x.say("  nothing pushed, nothing to watch");
  else if (o.noCiWait) x.say("  not watched (--no-ci-wait)");
  else if (!gh) x.say(`  the remote ${remoteUrl} is not on GitHub: nothing to watch`);
  else {
    x.say(`  https://api.github.com/repos/${gh}/actions/runs?head_sha=<release commit>, every ${o.ciPollSec} s (unauthenticated: 60 requests an hour), up to ${o.ciTimeoutMin} min`);
    if (!x.dry) {
      const r = await watchCi(gh, state.committed, o, x, deps.fetchJson);
      if (!r.ok) x.fail(`CI: ${r.text}`);
      x.say(`  ${r.text}`);
    }
  }

  x.say(`\n${x.dry ? "Dry run done: nothing was changed." : `Release ${v} done.`}`);
  return state;
}

// (a sentence for --dry-run's verification step)
function dryVerifyLine(a, tools, o) {
  return `  verify: apkinfo (versionName/versionCode = build.gradle), ${tools.aapt || "aapt"} dump badging (package ${a.package}), ${tools.apksigner || "apksigner"} verify --print-certs (certificate SHA-256 = public/${a.publish}'s)`;
}

async function qaTv(o, x, { tools, staging, lib, javaEnv, release, gradlewOf: gw }) {
  const adb = (args, t = 30000) => x.read(tools.adb, ["-s", o.adbTarget, ...args], { timeoutMs: t });
  const tvn = path.join(o.buildDir, "tv-native");
  const apiPath = path.join(tvn, "src", "api.ts");
  const gradlePath = path.join(tvn, "android", "app", "build.gradle");
  x.say(`  test TV ${o.adbTarget}: read the installed versionCode`);
  let installed = null;
  if (!x.dry) {
    x.read(tools.adb, ["connect", o.adbTarget], { timeoutMs: 15000 });
    const d = adb(["shell", "dumpsys", "package", "com.auroratv"], 20000);
    if (d.status !== 0) x.fail(`adb could not reach the test TV ${o.adbTarget}:\n${tail(d.err || d.out, 5)}`);
    installed = parseDumpsysVersionCode(d.out);
  }
  const baseCode = Math.max((release && release.versionCode) || 0, installed || 0);
  const qaCode = x.dry ? `<max(release, installed) + ${o.qaBump}>` : baseCode + o.qaBump;
  x.say(`  QA versionCode ${qaCode} (release ${(release && release.versionCode) || "?"}, installed ${installed == null ? "none/unknown" : installed})`);
  const apiBak = x.dry ? null : fs.readFileSync(apiPath);
  const gradleBak = x.dry ? null : fs.readFileSync(gradlePath);
  const restore = () => { if (apiBak) fs.writeFileSync(apiPath, apiBak); if (gradleBak) fs.writeFileSync(gradlePath, gradleBak); };
  let built;
  try {
    x.doing(`tv-native/src/api.ts: SERVER_CANDIDATES = ['http://127.0.0.1:4000', // QA VARIANT] (restored after the build)`, () => fs.writeFileSync(apiPath, qaApiTs(apiBak.toString("utf8"))));
    x.doing(`build.gradle: TV versionCode ${qaCode} (restored after the build)`, () => fs.writeFileSync(gradlePath, setTvVersionCode(gradleBak.toString("utf8"), qaCode)));
    const log = path.join(staging, "tv-qa-build.log");
    const outApk = path.join(tvn, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
    x.doing(`remove any old ${outApk}`, () => fs.rmSync(outApk, { force: true }));
    const r = await x.run(gw(o.buildDir), ["assembleRelease", "-PauroraQa", "--console=plain"], { cwd: path.join(tvn, "android"), env: javaEnv, logFile: x.dry ? null : log, timeoutMs: 60 * 60000 });
    if (r.status !== 0 || (!x.dry && !/BUILD SUCCESSFUL/.test(r.out))) x.fail(`the QA TV build failed (log: ${log}):\n${tail(r.out + r.err, 15)}`);
    built = path.join(staging, "aurora-tv-qa.apk");
    x.doing(`copy ${outApk} -> ${built}`, () => fs.copyFileSync(outApk, built));
  } finally {
    if (!x.dry) {
      restore();
      const markers = (fs.readFileSync(apiPath, "utf8").match(/QA VARIANT/g) || []).length;
      const d = x.read("git", ["-C", o.buildDir, "status", "--porcelain", "--untracked-files=no"]).out.trim();
      if (markers || d) x.say(`  WARNING: after the QA build the build worktree is not clean (${markers} QA markers; ${d || "no tracked changes"})`);
      else x.say("  api.ts and build.gradle restored; 0 QA VARIANT markers left");
    }
  }
  if (!x.dry) {
    const info = lib.apkinfo.read(built, { hash: false });
    if (info.error || info.versionCode !== qaCode) x.fail(`the QA APK is ${info.error || `versionCode ${info.versionCode}`}, expected ${qaCode}`);
    const badging = parseAapt(x.read(tools.aapt, ["dump", "badging", built]).out);
    if (!badging || badging.package !== "com.auroratv") x.fail("the QA APK is not com.auroratv");
  }
  x.say(x.show(tools.adb, ["-s", o.adbTarget, "install", "-r", built || "<aurora-tv-qa.apk>"]));
  if (!x.dry) {
    const i = adb(["install", "-r", built], 180000);
    if (i.status !== 0 || !/Success/.test(i.out)) x.fail(`adb install failed:\n${tail(i.out + i.err, 8)}`);
  }
  x.say(x.show(tools.adb, ["-s", o.adbTarget, "reverse", "tcp:4000", "tcp:4000"]));
  x.say(x.show(tools.adb, ["-s", o.adbTarget, "shell", "svc", "power", "stayon", "true"]));
  if (!x.dry) {
    adb(["reverse", "tcp:4000", "tcp:4000"], 15000);
    adb(["shell", "svc", "power", "stayon", "true"], 15000);
    x.say(`  installed QA ${qaCode} on ${o.adbTarget}`);
  }
}

// ------------------------------------------------------------------ http

function fetchJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { "User-Agent": "aurora-release", Accept: "application/json", ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => resolve({ status: 0, json: null, error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(url, version, timeoutMs, fj = fetchJson, everyMs = 2000) {
  const t0 = Date.now();
  let last = "no answer";
  while (Date.now() - t0 < timeoutMs) {
    const r = await fj(url, { timeoutMs: 4000 });
    if (r.json && r.json.ok && r.json.version === version) return { ok: true, body: r.json };
    last = r.json ? JSON.stringify(r.json).slice(0, 120) : r.error || `HTTP ${r.status}`;
    await sleep(everyMs);
  }
  return { ok: false, last };
}

async function watchCi(gh, sha, o, x, fj = fetchJson) {
  const url = `https://api.github.com/repos/${gh}/actions/runs?head_sha=${sha}&per_page=20`;
  const t0 = Date.now();
  let seen = "";
  while (Date.now() - t0 < o.ciTimeoutMin * 60000) {
    const r = await fj(url, { timeoutMs: 15000, headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 403) x.say("  (rate-limited by GitHub; trying again next time)");
    const runs = (r.json && r.json.workflow_runs) || [];
    const line = runs.map((w) => `${w.name} #${w.run_number} (${w.event}): ${w.status}${w.conclusion ? `/${w.conclusion}` : ""}`).join("; ");
    if (line && line !== seen) { x.say(`  ${new Date().toISOString().slice(11, 19)} ${line}`); seen = line; }
    if (runs.length && runs.every((w) => w.status === "completed")) {
      const bad = runs.filter((w) => !["success", "skipped", "neutral"].includes(w.conclusion));
      return bad.length ? { ok: false, text: `${bad.map((w) => `${w.name} #${w.run_number} ${w.conclusion}`).join(", ")}: ${bad[0].html_url}` } : { ok: true, text: `green: ${runs.map((w) => `${w.name} #${w.run_number}`).join(", ")}` };
    }
    await sleep(o.ciPollSec * 1000);
  }
  return { ok: false, text: `no finished run within ${o.ciTimeoutMin} min (the release itself is pushed; check https://github.com/${gh}/actions)` };
}

// ------------------------------------------------------------------ main

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); process.exit(0); }
  if (o.error) { console.error(`release: ${o.error}\n\n${USAGE}`); process.exit(2); }
  release(o).then(
    () => process.exit(0),
    (e) => {
      const redact = makeRedact(collectSecrets([o.repo, o.live], o.buildDir));
      if (e instanceof Stop) console.error(redact(`\nSTOPPED: ${e.message}`));
      else console.error(redact(`\nSTOPPED by an unexpected error: ${(e && e.stack) || e}`));
      process.exit(1);
    },
  );
}

module.exports = {
  parseArgs, changelogEntry, insertChangelog, updateVersionJson, parseAapt, parseApksigner, qaApiTs,
  setTvVersionCode, parseDumpsysVersionCode, summaryFromNotes, commitMessage, githubRepoOf, collectSecrets,
  makeRedact, cmpVersion, waitHealth, watchCi, release, Runner, Stop, DEFAULTS, STABLE_TAG, REL_BRANCH,
};
