"use strict";
// Which root test files (test/*.test.js) can a change reach? Pure logic, no git, no I/O:
// tools/ci/ci-tests.js feeds it the changed files, the test map (build-test-map.js) and
// the list of test files, and test/ci-select.test.js pins its rules.
//
// The answer is one of
//   { mode: "all",  reason }                  run the whole suite (any doubt ends here);
//   { mode: "some", tests, why }              run these, `why[test]` = the changes that reach it;
//   { mode: "none", reason }                  nothing a test reads changed (docs, screenshots).

// A change here can reach every test, or the selection itself: run everything.
const RUN_ALL = [
  // (unless only the "version" field moved: a release bump. ci-tests.js checks that
  // and marks the change `versionOnly`; the tests that read the file still run.)
  { re: /^package(-lock)?\.json$/, why: "dependencies or npm scripts", versionBumpOk: true },
  { re: /^(\.npmrc|\.nvmrc|\.node-version)$/, why: "npm/node setup" },
  { re: /^\.github\//, why: "the CI workflow" },
  { re: /^tools\/ci\//, why: "the test selector or tracer" },
  { re: /^tools\/patch-webtorrent\.js$/, why: "postinstall patch of node_modules" },
  { re: /^test\/(?!ui\/)(?:.*\/)?[^/]+\.(c|m)?js$/, unless: /\.test\.js$/, why: "a shared test helper" },
];

// Never read by `npm test`: when no map entry names one of these, nothing needs to run.
// (When a test DOES read one, the map wins and that test runs.)
const SAFE = [
  { re: /^docs\//, why: "docs" },
  { re: /\.md$/i, why: "a Markdown file" },
  // (not in what the server serves or the tests use: there an untraced reader is possible)
  { re: /^(?!(src|public|scripts|test)\/)[^]*\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mov|pdf)$/i, why: "an image or video" },
  { re: /^test\/ui\//, why: "browser tests (not run by CI)" },
  { re: /^tv-native\//, why: "TV/phone app code no root test reads" },
  { re: /^tools\//, why: "a hand-run dev rig no test loads" }, // (tools/ci/** is in RUN_ALL, checked first)
  { re: /^LICENSE$/, why: "the licence" },
  { re: /^\.gitignore$/, why: "git's ignore list" },
];

const DEFAULTS = { maxAgeDays: 7, mapVersion: 1 };
const isRootTest = (p) => /^test\/[^/]+\.test\.js$/.test(p);
const parentDir = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "." : p.slice(0, i); };
const under = (p, dir) => dir === "." || p.startsWith(dir + "/");
const ancestors = (p) => { const out = []; let d = p; do { d = parentDir(d); out.push(d); } while (d !== "."); return out; };

function matchRule(rules, p) {
  for (const r of rules) if (r.re.test(p) && !(r.unless && r.unless.test(p))) return r;
  return null;
}

// Index the map once: file -> tests, dir -> tests, ...
function indexMap(map) {
  const files = new Map(), dirs = new Map(), trees = new Map(), contents = new Map(), absent = new Map();
  const add = (m, k, t) => { let s = m.get(k); if (!s) m.set(k, (s = new Set())); s.add(t); };
  for (const [t, e] of Object.entries(map.tests || {})) {
    for (const f of e.files || []) add(files, f, t);
    for (const d of e.dirs || []) add(dirs, d, t);
    for (const d of e.trees || []) add(trees, d, t);
    for (const d of e.contents || []) add(contents, d, t);
    for (const a of e.absent || []) add(absent, a, t);
  }
  return { files, dirs, trees, contents, absent };
}

// Tests a single change reaches, from the map alone.
// `change.listedIn`: the folders whose listing this add/remove changes (its parent, plus
// the parents of any folder it creates or empties). ci-tests.js works that out from git;
// without it, every ancestor is assumed.
function reach(idx, change) {
  const out = new Set();
  const p = change.path;
  const addAll = (s) => { if (s) for (const t of s) out.add(t); };
  addAll(idx.files.get(p)); // read, loaded, stat'ed or copied: any change counts
  for (const [d, s] of idx.contents) if (under(p, d)) addAll(s); // a folder copied whole
  if (change.status !== "M") { // an added or removed file changes a listing
    for (const d of change.listedIn || ancestors(p)) addAll(idx.dirs.get(d));
    for (const [d, s] of idx.trees) if (under(p, d)) addAll(s);
    for (const [a, s] of idx.absent) if (p === a || p.startsWith(a + "/")) addAll(s); // looked for, now there
  }
  return out;
}

function mapProblem(map, { now, nodeMajor, maxAgeDays, mapVersion }) {
  if (!map) return "no test map yet (the first run, or the cache expired)";
  if (map.version !== mapVersion) return `the test map has format ${map.version}, this selector reads ${mapVersion}`;
  if (nodeMajor != null && map.node !== nodeMajor) return `the test map was traced on node ${map.node}, this is node ${nodeMajor}`;
  const at = Date.parse(map.fullAt);
  if (!Number.isFinite(at)) return "the test map has no full-run date";
  const age = (now - at) / 86400000;
  if (age > maxAgeDays) return `the test map's last full run is ${age.toFixed(1)} days old (limit ${maxAgeDays})`;
  if (!map.tests || !Object.keys(map.tests).length) return "the test map is empty";
  return null;
}

/**
 * @param {object} a
 * @param {Array<{status:string,path:string}>|null} a.changes  git diff --name-status --no-renames (A/M/D/T...); null = unknown
 * @param {object|null} a.map        test-map.json
 * @param {string[]} a.testFiles     every test/*.test.js in this checkout
 * @param {string} [a.force]         a reason to run everything (nightly, tag, [ci full]...)
 * @param {number} [a.now]           ms epoch
 * @param {number} [a.nodeMajor]
 */
function select(a) {
  const opts = { ...DEFAULTS, now: Date.now(), ...a };
  const all = (reason) => ({ mode: "all", reason, tests: [...opts.testFiles].sort() });
  if (opts.force) return all(opts.force);
  if (!Array.isArray(opts.changes)) return all("the changed files could not be worked out");
  const problem = mapProblem(opts.map, opts);
  if (problem) return all(problem);

  const changes = opts.changes.filter((c) => c && c.path)
    .map((c) => ({ status: (c.status || "M")[0], path: c.path.replace(/\\/g, "/"), versionOnly: !!c.versionOnly, listedIn: c.listedIn }));
  if (!changes.length) return { mode: "none", reason: "no files changed", tests: [], why: {}, safe: [] };

  const testSet = new Set(opts.testFiles);
  const idx = indexMap(opts.map);
  const why = {};
  const pick = (t, p) => { if (!testSet.has(t)) return; (why[t] || (why[t] = [])).push(p); };
  const safe = [];

  for (const c of changes) {
    const rule = matchRule(RUN_ALL, c.path);
    if (rule && !(rule.versionBumpOk && c.versionOnly)) return all(`${c.path} changed (${rule.why})`);
  }
  for (const c of changes) {
    let hit = false;
    if (isRootTest(c.path) && c.status !== "D") { pick(c.path, c.path); hit = true; }
    for (const t of reach(idx, c)) { pick(t, c.path); hit = true; }
    if (hit) continue;
    if (isRootTest(c.path)) continue; // a removed test: nothing to run for it
    if (c.versionOnly) { safe.push({ path: c.path, why: "only the version number changed" }); continue; }
    const s = matchRule(SAFE, c.path);
    if (s) { safe.push({ path: c.path, why: s.why }); continue; }
    return all(`${c.path} changed and no test in the map reads it (it may be read in a way the tracer cannot see)`);
  }
  // Whenever anything runs, these run too: a test file the map has never seen, and a test
  // that starts a node child the tracer cannot see into without copying a folder for it
  // (a copied folder is recorded as "depends on all of it"; anything else is unknown).
  if (Object.keys(why).length) {
    for (const t of opts.testFiles) {
      const e = opts.map.tests[t];
      if (why[t]) continue;
      if (!e) why[t] = ["(not in the test map yet)"];
      else if (e.untracedChild && !(e.contents && e.contents.length)) why[t] = ["(starts a child the tracer cannot see)"];
    }
  }
  const sorted = Object.keys(why).sort();
  if (!sorted.length) return { mode: "none", reason: "only files no test reads changed", tests: [], why: {}, safe };
  return { mode: "some", reason: `${sorted.length} of ${opts.testFiles.length} test files read something that changed`, tests: sorted, why, safe };
}

module.exports = { select, RUN_ALL, SAFE, DEFAULTS, matchRule, indexMap, reach };
