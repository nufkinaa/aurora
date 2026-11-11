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
//   $UI_OUT/<file>.tap     each run's TAP (the failing tests come from it)
//   $GITHUB_STEP_SUMMARY   a table; ::error / ::warning annotations with each
//                          failing test's error, which the public API serves
//                          without signing in (the job log needs a sign-in)
// Exit code 1 when any file failed (both times, with the retry).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const OUT = process.env.UI_OUT || path.join(process.cwd(), "test", "ui", "artifacts", "ci");
const RETRY = process.env.UI_RETRY !== "0";
fs.mkdirSync(OUT, { recursive: true });

// The failing tests of a TAP file, each with its error text and the first
// stack line in a test file; and the skipped ones with their reason.
const parseTap = (tap) => {
  let lines = [];
  try { lines = fs.readFileSync(tap, "utf8").split(/\r?\n/); } catch {}
  const fails = [];
  const skipped = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sk = /^\s*ok \d+ - (.*?)\s*# SKIP\s*(.*)$/.exec(l);
    if (sk) { skipped.push(sk[2] ? `${sk[1]} (${sk[2]})` : sk[1]); continue; }
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(l);
    if (!m || /# (TODO|SKIP)/.test(l)) continue;
    const f = { name: m[2].trim(), error: "", at: "" };
    const keyAt = new RegExp(`^ {${m[1].length + 2}}[a-zA-Z_]+:`);
    let j = i + 1, inErr = false, inStack = false;
    for (; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
      const x = lines[j];
      if (keyAt.test(x)) {
        inErr = /^\s*error:/.test(x);
        inStack = /^\s*stack:/.test(x);
        if (inErr && !/\|-?\s*$/.test(x)) f.error = x.replace(/^\s*error:\s*/, "");
        continue;
      }
      if (inErr) f.error += (f.error ? "\n" : "") + x.trim();
      if (inStack && !f.at && /test[\\/]ui[\\/][^\\/]+\.test\.js/.test(x)) f.at = x.trim();
    }
    i = j;
    fails.push(f);
  }
  return { fails, skipped };
};
// (an annotation is one line: newlines and % are encoded)
const esc = (t) => String(t).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");

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
    const parsed = parseTap(tap);
    // (the file's own describe() fails along with any test in it: not a test name)
    const fails = parsed.fails.filter((f) => f.name !== name);
    resolve({ name, ok: code === 0, code: code == null ? signal : code, secs, failed: [...new Set(fails.map((f) => f.name))], fails, skipped: parsed.skipped });
  });
});

const describeFails = (fails) => fails.slice(0, 6).map((f) => {
  const err = f.error.split("\n").filter((x) => !/^artifacts:/.test(x)).slice(0, 8).join("\n  ");
  return `- ${f.name}\n  ${err}${f.at ? `\n  at ${f.at}` : ""}`;
}).join("\n");

(async () => {
  const files = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
  if (!files.length) { console.error("usage: ui-shard-run.js <test/ui files…>"); process.exit(2); }
  if (process.argv.includes("--parse")) { console.log(JSON.stringify(parseTap(process.argv[process.argv.indexOf("--parse") + 1]), null, 1)); process.exit(0); }
  const rows = [];
  const timings = {};
  for (const file of files) {
    let r = await runFile(file, 1);
    timings[r.name] = Math.round(r.secs);
    let flaky = false;
    if (!r.ok && RETRY) {
      const first = r;
      r = await runFile(file, 2);
      if (r.ok) { flaky = true; r.failed = first.failed; r.fails = first.fails; }
    }
    rows.push({ ...r, flaky });
    if (flaky) {
      console.log(`::warning title=Flaky UI file: ${r.name}::${esc(`${r.name} failed, then passed when run again alone. First try:\n${describeFails(r.fails) || "exit " + r.code}`.slice(0, 6000))}`);
    } else if (!r.ok) {
      console.log(`::error title=UI file failed: ${r.name}::${esc(`${r.name} failed${RETRY ? " twice" : ""} (exit ${r.code})\n${describeFails(r.fails) || "see the log"}`.slice(0, 6000))}`);
    }
    for (const s of r.skipped) console.log(`::notice title=Skipped UI test::${esc(`${r.name}: ${s}`)}`);
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
