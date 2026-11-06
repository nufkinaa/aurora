// tools/release.js: the one-command release. Pure parts first, then whole runs in a
// throwaway repository (a bare "remote", a live clone on master, a release worktree),
// pushing to that fake remote only. App builds (gradle, signing) are not run here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const R = require("../tools/release");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "release.js");

// ------------------------------------------------------------------ pure

test("options: required, refused combinations, defaults", () => {
  assert.match(R.parseArgs([]).error, /--version is required/);
  assert.match(R.parseArgs(["--version", "1.2"]).error, /must look like/);
  assert.match(R.parseArgs(["--version", "1.2.3"]).error, /--notes-file is required/);
  const base = ["--version", "1.2.3", "--notes-file", "n.md"];
  assert.match(R.parseArgs([...base, "--qa-tv", "--tv", "--tv-notes", "x"]).error || "", /^$/);
  assert.match(R.parseArgs([...base, "--qa-tv"]).error, /--qa-tv needs --tv/);
  assert.match(R.parseArgs([...base, "--tv"]).error, /--tv-notes/);
  assert.match(R.parseArgs([...base, "--phone"]).error, /--phone-notes/);
  assert.match(R.parseArgs([...base, "--push", "--skip-tests"]).error, /never pushed untested/);
  assert.match(R.parseArgs([...base, "--bogus"]).error, /unknown option --bogus/);
  assert.match(R.parseArgs([...base, "--branches", "a;rm -rf"]).error, /characters/);
  const o = R.parseArgs([...base, "--branches", "a, b,,c", "--trailer", "X: 1", "--trailer", "Y: 2", "--date", "2026-11-06"]);
  assert.deepEqual(o.branches, ["a", "b", "c"]);
  assert.deepEqual(o.trailers, ["X: 1", "Y: 2"]);
  assert.equal(o.tagIt, false, "a server-only release is not tagged by default");
  assert.equal(R.parseArgs([...base, "--tv", "--tv-notes", "n"]).tagIt, true, "an app release is tagged");
  assert.equal(R.parseArgs([...base, "--tag"]).tagIt, true);
  assert.equal(R.parseArgs([...base, "--tv", "--tv-notes", "n", "--no-tag"]).tagIt, false);
  assert.equal(R.parseArgs([...base, "--version=1.2.4"]).version, "1.2.4");
});

test("CHANGELOG: heading added or checked, inserted above the newest entry, line endings kept", () => {
  assert.equal(R.changelogEntry("- a\n- b\n", "1.2.3", "2026-11-06"), "## 1.2.3 — 2026-11-06\n\n- a\n- b\n");
  assert.equal(R.changelogEntry("## 1.2.3 — 2026-11-05\n\n- a", "1.2.3", "x"), "## 1.2.3 — 2026-11-05\n\n- a\n");
  assert.throws(() => R.changelogEntry("## 1.2.4 — x\n- a", "1.2.3", "x"), /does not name 1\.2\.3/);
  assert.throws(() => R.changelogEntry("   \n", "1.2.3", "x"), /empty/);
  assert.throws(() => R.changelogEntry("- a\n## 1.2.2\n", "1.2.3", "x"), /below its first line/);
  assert.throws(() => R.changelogEntry("# Title\n- a", "1.2.3", "x"), /"# " title/);
  const cl = "# Changelog\r\n\r\nIntro.\r\n\r\n## 1.2.2 — 2026-11-01\r\n\r\n- old\r\n";
  const out = R.insertChangelog(cl, "## 1.2.3 — 2026-11-06\n\n- new\n", "1.2.3");
  assert.equal(out, "# Changelog\r\n\r\nIntro.\r\n\r\n## 1.2.3 — 2026-11-06\r\n\r\n- new\r\n\r\n## 1.2.2 — 2026-11-01\r\n\r\n- old\r\n");
  assert.throws(() => R.insertChangelog(out, "## 1.2.3 — x\n", "1.2.3"), /already has a 1\.2\.3 entry/);
  assert.throws(() => R.insertChangelog("# none\n", "## 1.2.3\n", "1.2.3"), /no "## " heading/);
  // the real CHANGELOG takes an entry
  const real = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const top = real.split(/\r?\n/).find((l) => /^## /.test(l));
  const next = R.insertChangelog(real, "## 99.0.0 — 2026-11-06\n\n- x\n", "99.0.0");
  assert.equal(next.split(/\r?\n/).find((l) => /^## /.test(l)), "## 99.0.0 — 2026-11-06");
  assert.ok(next.includes(top));
});

test("version json files keep key order, indent and line endings", () => {
  const tv = '{\r\n  "versionName": "5.8.4",\r\n  "notes": "old"\r\n}\r\n';
  assert.equal(R.updateVersionJson(tv, { versionName: "5.8.5", notes: "new" }), '{\r\n  "versionName": "5.8.5",\r\n  "notes": "new"\r\n}\r\n');
  const phone = '{\n  "versionName": "1.0.4",\n  "date": "2026-11-04",\n  "notes": "x"\n}\n';
  assert.equal(R.updateVersionJson(phone, { versionName: "1.0.5", date: "2026-11-06", notes: "y" }), '{\n  "versionName": "1.0.5",\n  "date": "2026-11-06",\n  "notes": "y"\n}\n');
});

test("aapt / apksigner / dumpsys output is read", () => {
  assert.deepEqual(R.parseAapt("package: name='com.auroratv' versionCode='196' versionName='5.8.4' platformBuildVersionName='16'\nsdkVersion:'21'"), { package: "com.auroratv", versionCode: 196, versionName: "5.8.4" });
  assert.equal(R.parseAapt("ERROR: dump failed"), null);
  const signer = "Signer #1 certificate DN: CN=Aurora, OU=Home\nSigner #1 certificate SHA-256 digest: 6d0d98ef3995189eec4dbd5689615b5edc57e8a87ae7068ec8b71d3571d5ebc3\nSigner #1 certificate SHA-1 digest: 9326ba8c35da54d5a46bdce05be2d3ceb5b9d1fc";
  assert.deepEqual(R.parseApksigner(signer), ["6d0d98ef3995189eec4dbd5689615b5edc57e8a87ae7068ec8b71d3571d5ebc3"]);
  assert.deepEqual(R.parseApksigner("DOES NOT VERIFY"), []);
  assert.equal(R.parseDumpsysVersionCode("    versionCode=197 minSdk=26 targetSdk=36\n"), 197);
  assert.equal(R.parseDumpsysVersionCode("Unable to find package"), null);
});

test("QA variant edits: only the loopback server, the TV's own versionCode", () => {
  const api = fs.readFileSync(path.join(ROOT, "tv-native", "src", "api.ts"), "utf8");
  const qa = R.qaApiTs(api);
  const list = qa.match(/export const SERVER_CANDIDATES = \[([\s\S]*?)\];/)[1];
  assert.deepEqual([...list.matchAll(/'([^']*)'/g)].map((m) => m[1]), ["http://127.0.0.1:4000"]);
  assert.ok(!/nufurora/i.test(list));
  assert.equal((qa.match(/QA VARIANT/g) || []).length, 1);
  assert.equal(qa.length - qa.indexOf("];"), api.length - api.indexOf("];", api.indexOf("SERVER_CANDIDATES")), "everything after the list is untouched");
  const gradle = fs.readFileSync(path.join(ROOT, "tv-native", "android", "app", "build.gradle"), "utf8");
  const { gradleVersions } = require("../src/lib/tvapp")._internals;
  const before = gradleVersions(gradle);
  const after = gradleVersions(R.setTvVersionCode(gradle, before.tv.versionCode + 7));
  assert.equal(after.tv.versionCode, before.tv.versionCode + 7);
  assert.deepEqual(after.phone, before.phone, "the phone's versionCode is left alone");
  assert.equal(after.tv.versionName, before.tv.versionName);
});

test("commit message, summary, GitHub repo from the remote", () => {
  assert.equal(R.summaryFromNotes("## 1.2.3 — x\n\n**Real watch time** — on the website.\n- a"), "real watch time");
  assert.equal(R.summaryFromNotes("- Fixed the thing.\n- b"), "fixed the thing");
  assert.equal(R.commitMessage({ version: "1.2.3", tvName: "5.8.5", phoneName: null, summary: "s", trailers: ["Co-Authored-By: X <x@y>"] }), "1.2.3 / TV 5.8.5: s\n\nCo-Authored-By: X <x@y>\n");
  assert.equal(R.commitMessage({ version: "1.2.3", tvName: "5.8.5", phoneName: "1.0.5", summary: "s", trailers: [] }), "1.2.3 / TV 5.8.5 / phone 1.0.5: s\n");
  assert.equal(R.githubRepoOf("https://github.com/nufkinaa/aurora.git"), "nufkinaa/aurora");
  assert.equal(R.githubRepoOf("git@github.com:nufkinaa/aurora.git"), "nufkinaa/aurora");
  assert.equal(R.githubRepoOf("C:/tmp/remote.git"), null);
});

test("redaction: secrets as whole tokens and URL credentials never reach the output", () => {
  const red = R.makeRedact(["hunter2!", "aurora-x"]);
  assert.equal(red("pw=hunter2! and 'hunter2!'"), "pw=*** and '***'");
  assert.equal(red("C:/elia/aurora-xround keeps its name; aurora-x.apk does not"), "C:/elia/aurora-xround keeps its name; ***.apk does not");
  assert.equal(red("https://user:ghp_abc@github.com/a/b.git"), "https://***@github.com/a/b.git");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-secrets-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ adminPassword: "adm-PW-1" }));
    fs.writeFileSync(path.join(dir, ".env"), "AURORA_ADMIN_PASSWORD='env-PW-2'\n");
    fs.mkdirSync(path.join(dir, "tv-native", "android"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tv-native", "android", "keystore.properties"), "storeFile=aurora.keystore\nstorePassword=store-PW-3\nkeyAlias=aurora\nkeyPassword=key-PW-4\n");
    const s = R.collectSecrets([dir], dir);
    for (const v of ["adm-PW-1", "env-PW-2", "store-PW-3", "key-PW-4"]) assert.ok(s.includes(v), v);
    assert.ok(!s.includes("aurora.keystore") && !s.includes("aurora"), "file names and aliases are not secrets");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("waiting for /healthz: the new version, not just an answer", async () => {
  const answers = [{ status: 0, json: null, error: "ECONNREFUSED" }, { status: 503, json: { ok: false, stopping: true } }, { status: 200, json: { ok: true, version: "1.0.0", uptime: 1 } }, { status: 200, json: { ok: true, version: "1.0.1", uptime: 2 } }];
  let i = 0;
  const h = await R.waitHealth("http://x/healthz", "1.0.1", 5000, async () => answers[Math.min(i++, answers.length - 1)], 1);
  assert.equal(h.ok, true);
  assert.equal(h.body.version, "1.0.1");
  const never = await R.waitHealth("http://x/healthz", "9.9.9", 30, async () => ({ status: 200, json: { ok: true, version: "1.0.0" } }), 5);
  assert.equal(never.ok, false);
  assert.match(never.last, /1\.0\.0/);
});

test("watching CI: finished runs decide, a red one fails", async () => {
  const lines = [];
  const x = { say: (s) => lines.push(s) };
  const o = { ciTimeoutMin: 1, ciPollSec: 0 };
  const seq = [
    { status: 200, json: { workflow_runs: [] } },
    { status: 200, json: { workflow_runs: [{ name: "CI", run_number: 7, event: "push", status: "in_progress", conclusion: null }] } },
    { status: 200, json: { workflow_runs: [{ name: "CI", run_number: 7, event: "push", status: "completed", conclusion: "success" }] } },
  ];
  let i = 0;
  const green = await R.watchCi("a/b", "abc", o, x, async (url) => { assert.match(url, /repos\/a\/b\/actions\/runs\?head_sha=abc/); return seq[Math.min(i++, seq.length - 1)]; });
  assert.equal(green.ok, true);
  const red = await R.watchCi("a/b", "abc", o, x, async () => ({ status: 200, json: { workflow_runs: [{ name: "CI", run_number: 8, event: "push", status: "completed", conclusion: "failure", html_url: "https://github.com/a/b/actions/runs/8" }] } }));
  assert.equal(red.ok, false);
  assert.match(red.text, /CI #8 failure/);
});

// ------------------------------------------------------------------ whole runs in a sandbox

const SECRET = "Sandbox-Admin-PW-77";
const ID = { GIT_AUTHOR_NAME: "Release Test", GIT_AUTHOR_EMAIL: "release@test.invalid", GIT_COMMITTER_NAME: "Release Test", GIT_COMMITTER_EMAIL: "release@test.invalid" };
const gitIn = (dir, ...args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...ID } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "rel-sandbox-"));
  const remote = path.join(t, "remote.git");
  const seed = path.join(t, "seed");
  const live = path.join(t, "live");
  const repo = path.join(t, "rel");
  spawnSync("git", ["init", "-q", "--bare", "-b", "master", remote]);
  fs.mkdirSync(seed);
  gitIn(seed, "init", "-q", "-b", "master");
  write(path.join(seed, "package.json"), JSON.stringify({ name: "fake-aurora", version: "1.0.0", private: true, scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n");
  write(path.join(seed, "package-lock.json"), JSON.stringify({ name: "fake-aurora", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fake-aurora", version: "1.0.0" } } }, null, 2) + "\n");
  write(path.join(seed, "CHANGELOG.md"), "# Changelog\n\nNewest first.\n\n## 1.0.0 — 2026-01-01\n\n- First.\n");
  write(path.join(seed, ".gitignore"), "config.json\nnode_modules/\n");
  write(path.join(seed, "a.txt"), "a\n");
  // the release tests: one of them prints the admin password, which must come out masked
  write(path.join(seed, "test", "tvapp.test.js"), `const t=require("node:test");const fs=require("fs");t("tv",()=>{console.log("pw is "+JSON.parse(fs.readFileSync(__dirname+"/../config.json","utf8")).adminPassword);});\n`);
  write(path.join(seed, "test", "phoneapp.test.js"), `require("node:test")("phone",()=>{});\n`);
  write(path.join(seed, "test", "other.test.js"), `require("node:test")("other",()=>{});\n`);
  for (const f of ["ci-tests.js", "select-tests.js"]) write(path.join(seed, "tools", "ci", f), fs.readFileSync(path.join(ROOT, "tools", "ci", f)));
  gitIn(seed, "add", "-A");
  gitIn(seed, "commit", "-q", "-m", "seed");
  gitIn(seed, "remote", "add", "origin", remote);
  gitIn(seed, "push", "-q", "origin", "master");
  spawnSync("git", ["clone", "-q", remote, live], { env: { ...process.env, ...ID } });
  write(path.join(live, "config.json"), JSON.stringify({ adminPassword: SECRET }));
  // branch a: local only; branch b: only on the remote
  gitIn(live, "checkout", "-q", "-b", "a");
  write(path.join(live, "a.txt"), "a changed\n");
  gitIn(live, "commit", "-qam", "a: change");
  gitIn(live, "checkout", "-q", "master");
  gitIn(live, "checkout", "-q", "-b", "b");
  write(path.join(live, "b.txt"), "b\n");
  gitIn(live, "add", "b.txt");
  gitIn(live, "commit", "-qm", "b: add");
  gitIn(live, "push", "-q", "origin", "b");
  gitIn(live, "checkout", "-q", "master");
  gitIn(live, "branch", "-q", "-D", "b");
  // c conflicts with a; broken adds a failing test
  gitIn(live, "checkout", "-q", "-b", "c");
  write(path.join(live, "a.txt"), "c changed it differently\n");
  gitIn(live, "commit", "-qam", "c: conflict");
  gitIn(live, "checkout", "-q", "master");
  gitIn(live, "checkout", "-q", "-b", "broken");
  write(path.join(live, "test", "broken.test.js"), `require("node:test")("broken",()=>{throw new Error("red")});\n`);
  gitIn(live, "add", "-A");
  gitIn(live, "commit", "-qm", "broken test");
  gitIn(live, "checkout", "-q", "master");
  gitIn(live, "worktree", "add", "-q", "--detach", repo);
  write(path.join(repo, "config.json"), JSON.stringify({ adminPassword: SECRET }));
  const notes = path.join(t, "notes.md");
  write(notes, "**Sandbox release** — nothing real.\n- One line.\n");
  return { t, remote, live, repo, notes, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
}

const runTool = (s, args) => {
  const r = spawnSync(process.execPath, [TOOL, "--repo", s.repo, "--live", s.live, "--remote", "origin", "--map", "none", "--staging", path.join(s.t, "staging"), "--date", "2026-11-06", ...args], { encoding: "utf8", env: { ...process.env, ...ID }, timeout: 120000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const snapshot = (s) => ({
  remote: gitIn(s.remote, "for-each-ref", "--format=%(refname) %(objectname)"),
  live: gitIn(s.live, "rev-parse", "HEAD"),
  relHead: gitIn(s.repo, "rev-parse", "HEAD"),
  relStatus: gitIn(s.repo, "status", "--porcelain"),
  branches: gitIn(s.live, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"),
});

test("sandbox: a dry run prints every step and changes nothing; the real run merges, commits, tests, tags and pushes", { timeout: 240000 }, () => {
  const s = sandbox();
  try {
    const before = snapshot(s);
    const dry = runTool(s, ["--version", "1.0.1", "--branches", "a,b", "--notes-file", s.notes, "--tag", "--push", "--dry-run", "--trailer", "Co-Authored-By: Test <t@t>"]);
    assert.equal(dry.status, 0, dry.out);
    for (const step of ["Checks (read-only)", "Fetch origin", "Branch rel-1.0.1", "Merge 2 branch(es)", "CHANGELOG entry", "Version 1.0.1", "Commit", "Tests", "Fast-forward the live tree", "Tag", "Push", "Restart the live server", "QA TV variant", "CI"]) {
      assert.ok(dry.out.includes(step), `dry run names "${step}"`);
    }
    assert.match(dry.out, /merge --no-edit a\b/);
    assert.match(dry.out, /merge --no-edit origin\/b\b/, "a branch only on the remote is merged from there");
    assert.match(dry.out, /push origin refs\/tags\/server-1\.0\.1-stable/);
    assert.match(dry.out, /Dry run done: nothing was changed/);
    assert.deepEqual(snapshot(s), before, "the dry run changed nothing");
    assert.ok(!dry.out.includes(SECRET));

    const real = runTool(s, ["--version", "1.0.1", "--branches", "a,b", "--notes-file", s.notes, "--tag", "--push", "--trailer", "Co-Authored-By: Test <t@t>"]);
    assert.equal(real.status, 0, real.out);
    assert.ok(!real.out.includes(SECRET), "the admin password printed by a test is masked");
    assert.match(real.out, /pw is \*\*\*/);
    assert.match(real.out, /Running ALL/, "no map: the whole suite runs");
    const head = gitIn(s.remote, "rev-parse", "refs/heads/master");
    assert.equal(gitIn(s.remote, "rev-parse", "refs/tags/server-1.0.1-stable"), head);
    assert.equal(gitIn(s.remote, "log", "-1", "--format=%s", head), "1.0.1: sandbox release");
    assert.match(gitIn(s.remote, "log", "-1", "--format=%b", head), /Co-Authored-By: Test <t@t>/);
    const cl = gitIn(s.remote, "show", `${head}:CHANGELOG.md`);
    assert.ok(cl.indexOf("## 1.0.1 — 2026-11-06") > 0 && cl.indexOf("## 1.0.1") < cl.indexOf("## 1.0.0"));
    assert.equal(JSON.parse(gitIn(s.remote, "show", `${head}:package.json`)).version, "1.0.1");
    assert.equal(JSON.parse(gitIn(s.remote, "show", `${head}:package-lock.json`)).version, "1.0.1");
    assert.equal(gitIn(s.remote, "show", `${head}:a.txt`), "a changed");
    assert.equal(gitIn(s.remote, "show", `${head}:b.txt`), "b");
    assert.equal(gitIn(s.live, "rev-parse", "HEAD"), head, "the live tree was fast-forwarded");
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.live, "package.json"), "utf8")).version, "1.0.1");

    // the same version again is refused before anything changes
    const again = snapshot(s);
    const twice = runTool(s, ["--version", "1.0.1", "--notes-file", s.notes]);
    assert.equal(twice.status, 1);
    assert.match(twice.out, /not newer|already exists/);
    assert.deepEqual(snapshot(s), again);
  } finally { s.cleanup(); }
});

test("sandbox: a merge conflict and a failing test each stop the release with nothing pushed or moved", { timeout: 240000 }, () => {
  const s = sandbox();
  try {
    const before = snapshot(s);
    const conflict = runTool(s, ["--version", "1.0.1", "--branches", "a,c", "--notes-file", s.notes, "--push"]);
    assert.equal(conflict.status, 1, conflict.out);
    assert.match(conflict.out, /STOPPED: merging c into rel-1\.0\.1 failed \(conflicts in: a\.txt\)/);
    assert.ok(!fs.existsSync(path.join(gitIn(s.repo, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")), "the merge was aborted");
    assert.equal(gitIn(s.repo, "status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(snapshot(s).remote, before.remote, "nothing pushed");
    assert.equal(snapshot(s).live, before.live, "the live tree did not move");

    const red = runTool(s, ["--version", "1.0.1", "--branches", "a,broken", "--notes-file", s.notes, "--push", "--tag"]);
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, /STOPPED: the root tests failed\. The release commit is only on rel-1\.0\.1/);
    assert.equal(snapshot(s).remote, before.remote, "nothing pushed");
    assert.equal(snapshot(s).live, before.live, "the live tree did not move");
    assert.equal(gitIn(s.live, "tag", "-l", "server-*"), "", "no tag");
    assert.match(gitIn(s.repo, "log", "-1", "--format=%s"), /^1\.0\.1: /, "the commit stays on the release branch for a look");

    // a dirty release worktree is refused up front
    write(path.join(s.repo, "a.txt"), "local edit\n");
    const dirty = runTool(s, ["--version", "1.0.2", "--notes-file", s.notes]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.out, /the release worktree has uncommitted changes/);
  } finally { s.cleanup(); }
});
