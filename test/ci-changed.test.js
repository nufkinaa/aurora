// CI's path gate for the tv-native job (tools/ci/ci-tests.js `changed`): run the
// job when anything under the given paths changed in the range the root tests use,
// and whenever there is any doubt.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { matchesAny, decideChanged } = require("../tools/ci/ci-tests");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "ci", "ci-tests.js");
const PREFIXES = ["tv-native/", ".github/workflows/"];
const has = (sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT, stdio: "ignore" }).status === 0;
// Real master commits: one touched only tv-native/, one only docs/, one .github/ (and more).
const TV_ONLY = "911fd4d7";
const DOCS_ONLY = "5c255014";
const WORKFLOW = "126fbf40";
const haveHistory = [TV_ONLY, DOCS_ONLY, WORKFLOW].every(has);

test("prefix matching: a folder prefix, or a whole path", () => {
  assert.equal(matchesAny("tv-native/src/api.ts", PREFIXES), true);
  assert.equal(matchesAny(".github/workflows/ci.yml", PREFIXES), true);
  assert.equal(matchesAny("tv-native-old/x", PREFIXES), false);
  assert.equal(matchesAny("docs/ci.md", PREFIXES), false);
  assert.equal(matchesAny("tv-native", ["tv-native"]), true);
  assert.equal(matchesAny("tv-native/a", ["tv-native"]), true);
  assert.equal(matchesAny("tv-nativex", ["tv-native"]), false);
});

test("a commit that changed tv-native runs the job; a docs-only one does not; the workflow file does", { skip: haveHistory ? false : "these commits are not in this clone" }, async () => {
  const tv = await decideChanged({ prefixes: PREFIXES, env: {}, base: `${TV_ONLY}^`, head: TV_ONLY });
  assert.equal(tv.run, true);
  assert.ok(tv.matched.every((p) => p.startsWith("tv-native/")) && tv.matched.length > 0);
  const docs = await decideChanged({ prefixes: PREFIXES, env: {}, base: `${DOCS_ONLY}^`, head: DOCS_ONLY });
  assert.equal(docs.run, false);
  assert.match(docs.reason, /nothing under tv-native\/ or \.github\/workflows\/ changed/);
  const wf = await decideChanged({ prefixes: PREFIXES, env: {}, base: `${WORKFLOW}^`, head: WORKFLOW });
  assert.equal(wf.run, true);
  assert.deepEqual(wf.matched, [".github/workflows/ci.yml"]);
});

test("any doubt runs the job: a run by hand, a tag, a re-run, a nightly without a green base, a bad range", async () => {
  const gh = { GITHUB_ACTIONS: "true" };
  assert.equal((await decideChanged({ prefixes: PREFIXES, env: { ...gh, GITHUB_EVENT_NAME: "workflow_dispatch" } })).run, true);
  assert.equal((await decideChanged({ prefixes: PREFIXES, env: { ...gh, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/server-1.2.3-stable" } })).run, true);
  assert.equal((await decideChanged({ prefixes: PREFIXES, env: { ...gh, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master", GITHUB_RUN_ATTEMPT: "2" } })).run, true);
  // no repository in the environment: the last green run cannot be found
  const nightly = await decideChanged({ prefixes: PREFIXES, env: { ...gh, GITHUB_EVENT_NAME: "schedule" } });
  assert.equal(nightly.run, true);
  assert.match(nightly.reason, /no safe base/);
  const bad = await decideChanged({ prefixes: PREFIXES, env: {}, base: "0000000000000000000000000000000000000001", head: "HEAD" });
  assert.equal(bad.run, true);
  assert.match(bad.reason, /git could not compare/);
});

test("the CLI writes run=true|false for the workflow, and refuses no --match", { skip: haveHistory ? false : "these commits are not in this clone" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changed-"));
  try {
    const out = path.join(dir, "out.txt");
    const env = { ...process.env, GITHUB_OUTPUT: out };
    delete env.GITHUB_ACTIONS;
    const r = spawnSync(process.execPath, [SCRIPT, "changed", "--match", "tv-native/", "--base", `${DOCS_ONLY}^`, "--head", DOCS_ONLY], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Skipping: /);
    assert.equal(fs.readFileSync(out, "utf8"), "run=false\n");
    fs.rmSync(out);
    const t = spawnSync(process.execPath, [SCRIPT, "changed", "--match", "tv-native/", "--base", `${TV_ONLY}^`, "--head", TV_ONLY], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(t.status, 0, t.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), "run=true\n");
    fs.rmSync(out);
    // a mistake in the call itself still runs the job
    const none = spawnSync(process.execPath, [SCRIPT, "changed"], { cwd: ROOT, env, encoding: "utf8" });
    assert.match(none.stderr, /at least one --match/);
    assert.equal(fs.readFileSync(out, "utf8"), "run=true\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
