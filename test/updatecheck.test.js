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

test("a parent commit IS an ancestor (up to date / ahead → no update)", async () => {
  const parent = await git(["rev-parse", "HEAD~1"]);
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
