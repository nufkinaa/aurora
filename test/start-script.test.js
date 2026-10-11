// start-aurora.cmd must point at files that exist: an edit once dropped every
// backslash from it ("scriptskeeper.js") and the server could not be started.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const text = fs.readFileSync(path.join(root, "start-aurora.cmd"), "utf8");

test("the start script's entry and every path it names exist", () => {
  const entries = [...text.matchAll(/AURORA_ENTRY=([^"\r\n]+)/g)].map((m) => m[1]);
  assert.ok(entries.length >= 2, "an entry for the keeper and one for --bare");
  const named = [...text.matchAll(/((?:deploy|docs|scripts)\\[\w\\.-]+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 2);
  for (const rel of [...entries, ...named]) {
    assert.ok(fs.existsSync(path.join(root, ...rel.split("\\"))), `${rel} is missing`);
  }
});

test("no line of the script is a stray fragment", () => {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    assert.match(line, /^(@echo|rem\b|cd |set |if |node |\s+"|\s+goto|\))/, `unexpected line: ${line}`);
  }
});

test("the keeper refuses an argument it does not know instead of starting a second server", () => {
  const { spawnSync } = require("child_process");
  const keeper = path.join(root, "scripts", "keeper.js");
  const help = spawnSync(process.execPath, [keeper, "--help"], { encoding: "utf8", timeout: 20000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--status/);
  const bad = spawnSync(process.execPath, [keeper, "--no-such-thing"], { encoding: "utf8", timeout: 20000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument --no-such-thing/);
});
