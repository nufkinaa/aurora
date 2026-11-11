#!/usr/bin/env node
// Splits the browser tests (test/ui/*.test.js) into shards of about the same
// length, for the GitHub workflow .github/workflows/ui.yml (docs/ci.md).
//
//   node tools/ci/ui-shards.js                      # 8 shards of every file, as JSON
//   node tools/ci/ui-shards.js --shards 6
//   node tools/ci/ui-shards.js --files "party, wall test/ui/admin.test.js"
//   node tools/ci/ui-shards.js --github             # also writes matrix=… to $GITHUB_OUTPUT
//   node tools/ci/ui-shards.js --update t1.json t2.json …
//                                                   # fold measured seconds ({file: s}, as
//                                                   # ui-shard-run.js writes them) into
//                                                   # test/ui/durations.json
//
// Balancing: longest file first onto the shard with the least time so far
// (the classic LPT rule). Seconds come from test/ui/durations.json; a file
// it does not know yet counts as the median.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const UI = path.join(ROOT, "test", "ui");
const DURATIONS = path.join(UI, "durations.json");

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);

const readDurations = () => {
  try { return JSON.parse(fs.readFileSync(DURATIONS, "utf8")); } catch { return { seconds: {} }; }
};
const short = (f) => path.basename(String(f).trim()).replace(/\.test\.js$/, "");
const allFiles = () => fs.readdirSync(UI).filter((f) => f.endsWith(".test.js")).map(short).sort();

const plan = ({ shards = 8, files = null } = {}) => {
  const known = readDurations().seconds || {};
  const all = allFiles();
  let pick = all;
  if (files && files.length) {
    const want = [...new Set(files.map(short).filter(Boolean))];
    const missing = want.filter((f) => !all.includes(f));
    if (missing.length) throw new Error(`no such test/ui file: ${missing.join(", ")}`);
    pick = want;
  }
  const vals = Object.values(known).filter((n) => n > 0).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 30;
  const est = (f) => (known[f] > 0 ? known[f] : median);
  const n = Math.max(1, Math.min(shards, pick.length));
  const bins = Array.from({ length: n }, (_, i) => ({ shard: i + 1, est: 0, files: [] }));
  for (const f of [...pick].sort((a, b) => est(b) - est(a) || a.localeCompare(b))) {
    const bin = bins.reduce((m, b) => (b.est < m.est ? b : m));
    bin.files.push(f);
    bin.est += est(f);
  }
  return bins.map((b) => ({
    shard: b.shard,
    of: n,
    est: Math.round(b.est),
    files: b.files.sort().map((f) => `test/ui/${f}.test.js`).join(" "),
  }));
};

const update = (timingFiles) => {
  const d = readDurations();
  d.seconds = d.seconds || {};
  let n = 0;
  for (const tf of timingFiles) {
    const t = JSON.parse(fs.readFileSync(tf, "utf8"));
    for (const [f, s] of Object.entries(t)) { if (s > 0) { d.seconds[short(f)] = Math.round(s); n++; } }
  }
  d.seconds = Object.fromEntries(Object.entries(d.seconds).sort(([a], [b]) => a.localeCompare(b)));
  d.measured = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DURATIONS, JSON.stringify(d, null, 1) + "\n");
  console.error(`[ui-shards] ${n} durations folded into ${path.relative(ROOT, DURATIONS)}`);
};

module.exports = { plan };

if (require.main === module) {
  if (has("--update")) {
    update(process.argv.slice(process.argv.indexOf("--update") + 1));
    process.exit(0);
  }
  const files = (arg("--files", "") || "").split(/[\s,]+/).filter(Boolean);
  const out = plan({ shards: Number(arg("--shards", 8)) || 8, files });
  const json = JSON.stringify(out);
  console.log(has("--pretty") ? JSON.stringify(out, null, 1) : json);
  for (const s of out) console.error(`[ui-shards] shard ${s.shard}/${s.of}: ~${Math.round(s.est / 60 * 10) / 10} min, ${s.files.split(" ").length} files`);
  if (has("--github") && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
}
