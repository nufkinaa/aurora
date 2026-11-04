// CI's affected-tests selection (tools/ci): which test files a change can reach, when to
// give up and run everything, and the tracer that builds the map it reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { select } = require("../tools/ci/select-tests");
const { build, unite, entriesFromTraces, makeNormaliser, readTraces } = require("../tools/ci/build-test-map");

const NOW = Date.parse("2026-11-04T12:00:00Z");
const TESTS = ["test/a.test.js", "test/b.test.js", "test/c.test.js", "test/d.test.js"];
const entry = (o = {}) => ({ files: [], dirs: [], trees: [], contents: [], spawns: [], ...o });
const fixtureMap = (over = {}) => ({
  version: 1,
  node: 22,
  fullAt: "2026-11-04T03:00:00Z",
  tests: {
    "test/a.test.js": entry({ files: ["test/a.test.js", "src/lib/x.js", "package.json"] }),
    "test/b.test.js": entry({ files: ["test/b.test.js", "src/lib/y.js", "tv-native/src/screens/WhatsNew.tsx", "docs/analytics.md"], dirs: ["public/js"] }),
    "test/c.test.js": entry({ files: ["test/c.test.js", "public/aurora-phone.apk"], trees: ["src/routes"] }),
    "test/d.test.js": entry({ files: ["test/d.test.js"], contents: ["src"] }),
  },
  ...over,
});
const run = (changes, o = {}) => select({ changes, map: fixtureMap(), testFiles: TESTS, now: NOW, nodeMajor: 22, ...o });
const M = (p) => ({ status: "M", path: p });
const A = (p) => ({ status: "A", path: p });
const D = (p) => ({ status: "D", path: p });

test("a changed source file runs exactly the tests that read it (a folder copied whole counts)", () => {
  const r = run([M("src/lib/x.js")]);
  assert.equal(r.mode, "some");
  assert.deepEqual(r.tests, ["test/a.test.js", "test/d.test.js"]);
  assert.deepEqual(r.why["test/a.test.js"], ["src/lib/x.js"]);
  assert.deepEqual(run([M("tv-native/src/screens/WhatsNew.tsx")]).tests, ["test/b.test.js"]);
  assert.deepEqual(run([M("public/aurora-phone.apk")]).tests, ["test/c.test.js"]);
});

test("a changed or new test file runs itself; a removed one runs nothing", () => {
  assert.deepEqual(run([M("test/c.test.js")]).tests, ["test/c.test.js"]);
  const added = select({ changes: [A("test/e.test.js")], map: fixtureMap(), testFiles: [...TESTS, "test/e.test.js"], now: NOW, nodeMajor: 22 });
  assert.deepEqual(added.tests, ["test/e.test.js"]);
  assert.equal(run([D("test/old.test.js")]).mode, "none");
});

test("listings: an added or removed file in a listed folder reaches the lister; an edit there does not", () => {
  assert.deepEqual(run([A("public/js/new.js")]).tests, ["test/b.test.js"]);
  assert.deepEqual(run([D("src/routes/deep/old.js")]).tests, ["test/c.test.js", "test/d.test.js"]); // recursive listing + the copied src
  const edit = run([M("public/js/unread.js")]);
  assert.equal(edit.mode, "all", "an edit nobody reads is not proof of safety outside the safe list");
});

test("listings: a new folder changes its parent's listing too (from git's listedIn, or every ancestor when unknown)", () => {
  assert.deepEqual(run([{ status: "A", path: "public/js/newdir/x.js", listedIn: ["public/js/newdir", "public/js"] }]).tests, ["test/b.test.js"]);
  assert.equal(run([{ status: "A", path: "public/js/olddir/x.js", listedIn: ["public/js/olddir"] }]).mode, "all", "the folder existed: public/js's listing is the same, and nobody reads the file");
  assert.deepEqual(run([A("public/js/newdir/x.js")]).tests, ["test/b.test.js"]);
});

test("a path a test looked for and did not find reaches it once it is added", () => {
  const map = fixtureMap();
  map.tests["test/c.test.js"].absent = ["config.json", "tv-native/src/later"];
  const r = (c) => select({ changes: c, map, testFiles: TESTS, now: NOW, nodeMajor: 22 });
  assert.deepEqual(r([A("config.json")]).tests, ["test/c.test.js"]);
  assert.deepEqual(r([A("tv-native/src/later/x.ts")]).tests, ["test/c.test.js"], "the safe list does not hide a probe");
  assert.equal(r([M("tv-native/src/later.ts")]).mode, "none");
});

test("a test with a node child the tracer cannot see (and no copied folder) runs whenever anything runs", () => {
  const map = fixtureMap();
  map.tests["test/c.test.js"].untracedChild = true;
  map.tests["test/d.test.js"].untracedChild = true; // copies src: covered by that
  const r = (c) => select({ changes: c, map, testFiles: TESTS, now: NOW, nodeMajor: 22 });
  assert.deepEqual(r([M("tv-native/src/screens/WhatsNew.tsx")]).tests, ["test/b.test.js", "test/c.test.js"]);
  assert.equal(r([M("docs/x.png")]).mode, "none");
});

test("images are safe in docs and the apps, not in what the server serves or the tests use", () => {
  assert.equal(run([M("docs/qa/a.png")]).mode, "none");
  assert.equal(run([M("tv-native/src/assets/logo.png")]).mode, "none");
  assert.equal(run([M("public/img/logo.png")]).mode, "all");
  assert.equal(run([M("test/fixtures/frame.png")]).mode, "all");
});

test("only safe-list files that no test reads: nothing runs, and it says why", () => {
  const r = run([M("docs/qa/tv/shot.png"), A("docs/report.md"), M("tv-native/android/app/build.gradle"), M("test/ui/home.test.js"), M("tools/ttff/lib.js"), M("README.md")]);
  assert.equal(r.mode, "none");
  assert.equal(r.tests.length, 0);
  assert.equal(r.safe.length, 6);
});

test("a safe-list file that a test DOES read still runs that test", () => {
  const r = run([M("docs/analytics.md"), M("docs/qa/x.png")]);
  assert.equal(r.mode, "some");
  assert.deepEqual(r.tests, ["test/b.test.js"]);
});

test("run everything: dependencies, the workflow, the selector, shared helpers", () => {
  for (const p of ["package.json", "package-lock.json", ".github/workflows/ci.yml", "tools/ci/select-tests.js", "tools/ci/trace-preload.cjs", "tools/patch-webtorrent.js", "test/helpers.js", "test/fixtures/server.js", ".nvmrc"]) {
    const r = run([M(p), M("src/lib/x.js")]);
    assert.equal(r.mode, "all", p);
    assert.match(r.reason, new RegExp(p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    assert.equal(r.tests.length, TESTS.length);
  }
});

test("a release bump (only package.json's version moved) runs the tests that read package.json, not everything", () => {
  const r = run([{ status: "M", path: "package.json", versionOnly: true }, { status: "M", path: "package-lock.json", versionOnly: true }, M("CHANGELOG.md")]);
  assert.equal(r.mode, "some");
  assert.deepEqual(r.tests, ["test/a.test.js"]);
  assert.ok(r.safe.some((s) => s.path === "package-lock.json"));
});

test("run everything: a file nobody reads outside the safe list, unknown changes, a forced run", () => {
  assert.equal(run([M("server.js")]).mode, "all");
  assert.equal(run([M("scripts/keeper.js")]).mode, "all");
  assert.equal(run(null).mode, "all");
  const f = run([M("docs/x.md")], { force: "[ci full] in a commit message" });
  assert.equal(f.mode, "all");
  assert.equal(f.reason, "[ci full] in a commit message");
});

test("run everything: the map is missing, of another format or Node major, too old or empty", () => {
  const c = [M("src/lib/x.js")];
  assert.match(run(c, { map: null }).reason, /no test map/);
  assert.match(run(c, { map: fixtureMap({ version: 99 }) }).reason, /format 99/);
  assert.match(run(c, { nodeMajor: 20 }).reason, /node 22, this is node 20/);
  assert.match(run(c, { map: fixtureMap({ fullAt: "2026-10-20T00:00:00Z" }) }).reason, /days old/);
  assert.match(run(c, { map: fixtureMap({ fullAt: "nope" }) }).reason, /no full-run date/);
  assert.match(run(c, { map: fixtureMap({ tests: {} }) }).reason, /empty/);
});

test("a test the map has not seen yet runs along whenever anything runs", () => {
  const files = [...TESTS, "test/new.test.js"];
  const r = select({ changes: [M("src/lib/y.js")], map: fixtureMap(), testFiles: files, now: NOW, nodeMajor: 22 });
  assert.deepEqual(r.tests, ["test/b.test.js", "test/d.test.js", "test/new.test.js"]);
  const none = select({ changes: [M("docs/x.png")], map: fixtureMap(), testFiles: files, now: NOW, nodeMajor: 22 });
  assert.equal(none.mode, "none");
});

test("the range widened back to the map's commit: a file in both lists keeps the wider reading", () => {
  const { mergeChanges } = require("../tools/ci/ci-tests");
  const out = mergeChanges(
    [M("src/a.js"), { status: "A", path: "src/new/b.js", listedIn: ["src/new", "src"] }, { status: "M", path: "package.json", versionOnly: true }],
    [{ status: "D", path: "src/a.js", listedIn: ["src"] }, { status: "A", path: "src/new/b.js", listedIn: ["src/new"] }, M("package.json"), M("docs/x.md")],
  );
  const by = Object.fromEntries(out.map((c) => [c.path, c]));
  assert.equal(by["src/a.js"].status, "D");
  assert.deepEqual(by["src/a.js"].listedIn, ["src"]);
  assert.deepEqual(by["src/new/b.js"].listedIn, ["src/new", "src"]);
  assert.equal(by["package.json"].versionOnly, false, "a real package.json change on either side counts");
  assert.ok(by["docs/x.md"]);
});

test("Windows spellings of changed paths are read as forward slashes", () => {
  assert.deepEqual(run([{ status: "M", path: "src\\lib\\x.js" }]).tests, ["test/a.test.js", "test/d.test.js"]);
});

test("map building: repo-relative forward-slash paths, tracked files only, listings and copies kept apart", () => {
  const root = path.join(os.tmpdir(), "aurora-ci-root");
  const tracked = ["package.json", "src/lib/x.js", "src/routes/a.js", "public/js/m.js", "test/a.test.js"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ci-trace-"));
  const abs = (...p) => path.join(root, ...p);
  fs.writeFileSync(path.join(dir, "1-0.log"), [
    "t test/a.test.js",
    `r ${abs("test", "a.test.js")}`,
    `r ${abs("src", "lib", "x.js")}`,
    `r ${abs("data", "cache", "tmp.json")}`, // not tracked: dropped
    `r ${abs("src")}`, // a folder stat: dropped
    `r ${abs("public", "js", "later.js")}`, // looked for, not in git (yet): a probe
    `d ${abs("public", "js")}`,
    `D ${abs("src", "routes")}`,
    `c ${abs("src")}`,
    `c ${abs("package.json")}`,
    "x ffmpeg",
    "e 1234",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "2-0.log"), ["t test/a.test.js", "w test/a.test.js", ""].join("\n")); // its child
  const norm = makeNormaliser(root, tracked);
  const e = entriesFromTraces(readTraces(dir), norm)["test/a.test.js"];
  assert.deepEqual(e, {
    files: ["package.json", "src/lib/x.js", "test/a.test.js"],
    dirs: ["public/js"],
    trees: ["src/routes"],
    contents: ["src"],
    absent: ["public/js/later.js"],
    spawns: ["ffmpeg"],
    ms: 1234,
    untracedChild: true,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("map lifetime: a full run that passed replaces the map; anything else only adds to it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ci-trace-"));
  const root = path.join(os.tmpdir(), "aurora-ci-root");
  fs.writeFileSync(path.join(dir, "1-0.log"), `t test/a.test.js\nr ${path.join(root, "src", "lib", "y.js")}\n`);
  const tracked = ["src/lib/x.js", "src/lib/y.js", "test/a.test.js", "test/b.test.js"];
  const old = { version: 1, node: 22, fullAt: "2026-11-01T00:00:00Z", fullCommit: "old", tests: { "test/a.test.js": entry({ files: ["src/lib/x.js"] }), "test/b.test.js": entry({ files: ["src/lib/x.js"] }), "test/gone.test.js": entry() } };
  const now = new Date(NOW);
  const opts = { traceDir: dir, old, root, tracked, now, commit: "new", nodeMajor: 22 };
  const partial = build({ ...opts });
  assert.deepEqual(partial.tests["test/a.test.js"].files, ["src/lib/x.js", "src/lib/y.js"], "a partial run adds, never forgets");
  assert.deepEqual(partial.tests["test/b.test.js"].files, ["src/lib/x.js"], "tests that did not run keep their entry");
  assert.equal(partial.tests["test/gone.test.js"], undefined, "a deleted test file leaves the map");
  assert.equal(partial.fullAt, old.fullAt);
  const failedFull = build({ ...opts, full: true, passed: false });
  assert.deepEqual(failedFull.tests["test/a.test.js"].files, ["src/lib/x.js", "src/lib/y.js"]);
  const full = build({ ...opts, full: true, passed: true });
  assert.deepEqual(Object.keys(full.tests), ["test/a.test.js"]);
  assert.deepEqual(full.tests["test/a.test.js"].files, ["src/lib/y.js"]);
  assert.equal(full.fullAt, now.toISOString());
  assert.equal(full.fullCommit, "new");
  assert.deepEqual(unite(undefined, entry({ files: ["q"] })).files, ["q"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the tracer records what a test process loads, reads, lists, imports and spawns, without changing it", () => {
  const REPO = path.join(__dirname, "..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ci-tracer-"));
  const traceDir = path.join(work, "trace");
  const sample = path.join(work, "sample.test.js");
  const repo = (...p) => JSON.stringify(path.join(REPO, ...p));
  fs.writeFileSync(sample, `
    const test = require("node:test");
    const fs = require("node:fs");
    const { spawnSync } = require("node:child_process");
    test("sample", async () => {
      require(${repo("src", "lib", "jsonstore.js")});
      fs.readFileSync(${repo("package.json")}, "utf8");
      fs.existsSync(${repo("CHANGELOG.md")});
      fs.readdirSync(${repo("public", "js")});
      await import(require("node:url").pathToFileURL(${repo("public", "js", "subdelay.js")}).href);
      const r = spawnSync(process.execPath, ["-e", "require('fs').readFileSync(" + JSON.stringify(${repo("LICENSE")}) + ")"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      process.stdout.write("sample-ran\\n");
    });
  `);
  const env = { ...process.env, AURORA_TRACE_DIR: traceDir, NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "tools", "ci", "trace-preload.cjs"))}` };
  delete env.AURORA_TRACE_TEST; // (when CI traces this very test, the sample is its own owner)
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", sample], { cwd: REPO, env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /sample-ran/);
  assert.match(r.stdout, /# pass 1/);
  const tracked = ["src/lib/jsonstore.js", "package.json", "CHANGELOG.md", "public/js/subdelay.js", "public/js/x.js", "LICENSE"];
  const tests = entriesFromTraces(readTraces(traceDir), makeNormaliser(REPO, tracked));
  const [owner] = Object.keys(tests);
  assert.ok(owner.endsWith("sample.test.js"), owner);
  const e = tests[owner];
  for (const f of ["src/lib/jsonstore.js", "package.json", "CHANGELOG.md", "public/js/subdelay.js", "LICENSE"]) assert.ok(e.files.includes(f), `${f} in ${e.files}`);
  assert.deepEqual(e.dirs, ["public/js"]);
  assert.ok(e.ms > 0);
  for (const f of e.files) assert.ok(!f.includes("\\"), f);
  fs.rmSync(work, { recursive: true, force: true });
});
