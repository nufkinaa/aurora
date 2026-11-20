// The update checker's git plumbing. The network half is deliberately not
// tested (offline = silent), but the ancestor logic is what keeps elia's
// local-until-approved commits from reading as "update available" — pin it.
const test = require("node:test");
const assert = require("node:assert");

const { _internals } = require("../src/lib/updatecheck");
const { git, isAncestor } = _internals;

test("git plumbing resolves HEAD", async () => {
  const head = await git(["rev-parse", "HEAD"]);
  assert.match(head, /^[0-9a-f]{40}$/);
});

test("a parent commit IS an ancestor (up to date / ahead → no update)", async (t) => {
  const parent = await git(["rev-parse", "HEAD~1"]);
  if (!parent) {
    // GitHub Actions checks out a SHALLOW clone (depth 1) — HEAD has no
    // parent there. The ancestor semantics are still pinned by the
    // HEAD-of-itself and unknown-sha tests below.
    t.skip("shallow clone: HEAD~1 does not exist");
    return;
  }
  assert.match(parent, /^[0-9a-f]{40}$/);
  assert.equal(await isAncestor(parent), true);
});

test("HEAD is an ancestor of itself (identical → no update)", async () => {
  const head = await git(["rev-parse", "HEAD"]);
  assert.equal(await isAncestor(head), true);
});

test("an unknown sha is NOT an ancestor (a commit we lack → update)", async () => {
  assert.equal(await isAncestor("0123456789abcdef0123456789abcdef01234567"), false);
});

// package-lock.json changed by `npm install` on a server blocked every pull
// (elia, 2026-11-20, nufurora). resetLock puts back ONLY that file.
test("resetLock puts back a package-lock.json changed on the server, and nothing else", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { resetLock } = require("../src/lib/updatecheck");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lock-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  try {
    g("init", "-q");
    g("config", "user.email", "t@example.invalid");
    g("config", "user.name", "t");
    g("config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":1}\n');
    fs.writeFileSync(path.join(dir, "other.js"), "a\n");
    g("add", ".");
    g("commit", "-q", "-m", "c");
    assert.equal(await resetLock(dir), "", "clean: nothing to say");
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":2}\n');
    fs.writeFileSync(path.join(dir, "other.js"), "changed by hand\n");
    const note = await resetLock(dir);
    assert.match(note, /package-lock\.json .*put back/);
    assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), '{"v":1}\n');
    assert.equal(fs.readFileSync(path.join(dir, "other.js"), "utf8"), "changed by hand\n", "any other file is left alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Pull and Install actions put package-lock.json back, and only it", () => {
  const { ACTIONS } = require("../src/lib/adminactions")._internals;
  const pull = ACTIONS.find((a) => a.id === "git-pull");
  const install = ACTIONS.find((a) => a.id === "npm-install");
  assert.deepEqual(pull.steps[0].args, ["checkout", "--", "package-lock.json"]);
  assert.deepEqual(pull.steps[1].args, ["pull", "--ff-only", "origin", "master"]);
  assert.deepEqual(install.steps[install.steps.length - 1].args, ["checkout", "--", "package-lock.json"]);
});
