#!/usr/bin/env node
// Runs a shard of the browser tests, one file after another (as
// `npm run test:ui` does with --test-concurrency=1), for .github/workflows/ui.yml.
//
//   node tools/ci/ui-shard-run.js test/ui/a.test.js test/ui/b.test.js …
//
// Per file: its own `node --test`, its seconds, pass/fail. A file that fails
// is run once more on its own (COMMON-RULES: UI files can flake under load);
// a pass on that second try is reported as FLAKY, never silently. Writes:
//   $UI_OUT/timings.json   { file: seconds } (tools/ci/ui-shards.js --update)
//   $UI_OUT/<file>.tap     each run's TAP (the failing tests' names come from it)
//   $GITHUB_STEP_SUMMARY   a table; ::error / ::warning annotations, which the
//                          public API serves without signing in
// Exit code 1 when any file failed both times.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const OUT = process.env.UI_OUT || path.join(process.cwd(), "test", "ui", "artifacts", "ci");
const RETRY = process.env.UI_RETRY !== "0";
fs.mkdirSync(OUT, { recursive: true });

const runFile = (file, attempt) => new Promise((resolve) => {
  const name = path.basename(file, ".test.js");
  const tap = path.join(OUT, `${name}${attempt > 1 ? `.try${attempt}` : ""}.tap`);
  const t0 = Date.now();
  console.log(`\n::group::${name}${attempt > 1 ? ` (try ${attempt})` : ""}`);
  const child = spawn(process.execPath, [
    "--test", "--test-concurrency=1",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", `--test-reporter-destination=${tap}`,
    file,
  ], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.log("::endgroup::");
    const secs = (Date.now() - t0) / 1000;
    let failed = [];
    try {
      failed = fs.readFileSync(tap, "utf8").split(/\r?\n/)
        .filter((l) => /^\s*not ok \d+ - /.test(l) && !/# (TODO|SKIP)/.test(l))
        .map((l) => l.replace(/^\s*not ok \d+ - /, "").trim());
    } catch {}
    let skipped = [];
    try {
      skipped = fs.readFileSync(tap, "utf8").split(/\r?\n/)
        .filter((l) => /^\s*ok \d+ - .*# SKIP/.test(l))
        .map((l) => l.replace(/^\s*ok \d+ - /, "").trim());
    } catch {}
    // (the file's own describe() fails along with any test in it: not a test name)
    resolve({ name, ok: code === 0, code: code == null ? signal : code, secs, failed: [...new Set(failed)].filter((f) => f !== name), skipped });
  });
});

(async () => {
  const files = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
  if (!files.length) { console.error("usage: ui-shard-run.js <test/ui files…>"); process.exit(2); }
  const rows = [];
  const timings = {};
  for (const file of files) {
    let r = await runFile(file, 1);
    timings[r.name] = Math.round(r.secs);
    let flaky = false;
    if (!r.ok && RETRY) {
      const first = r;
      r = await runFile(file, 2);
      if (r.ok) { flaky = true; r.failed = first.failed; }
    }
    rows.push({ ...r, flaky });
    if (flaky) console.log(`::warning title=Flaky UI file::${r.name} failed, then passed when run again alone (first try: ${r.failed.join(" | ") || "exit " + r.code})`);
    else if (!r.ok) {
      console.log(`::error title=UI file failed::${r.name} failed${RETRY ? " twice" : ""} (exit ${r.code}): ${r.failed.slice(0, 5).join(" | ") || "see the log"}`);
    }
    for (const s of r.skipped) console.log(`::notice title=Skipped UI test::${r.name}: ${s}`);
  }
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(timings, null, 1));
  const total = rows.reduce((a, r) => a + r.secs, 0);
  const lines = [
    `### UI shard: ${rows.filter((r) => r.ok).length}/${rows.length} files green, ${Math.round(total / 6) / 10} min`,
    "",
    "| file | result | seconds | failing tests |",
    "|---|---|---:|---|",
    ...rows.map((r) => `| ${r.name} | ${r.ok ? (r.flaky ? "flaky (passed on retry)" : "pass") : "FAIL"} | ${Math.round(r.secs)} | ${r.failed.join("<br>")} |`),
  ];
  console.log("\n" + lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
})();
