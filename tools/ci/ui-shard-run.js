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
//   $UI_OUT/<file>.log     each run's whole output (what the job log shows)
//   $UI_OUT/hung/          the log and TAP of a file that had to be stopped
//                          (the workflow uploads this folder on its own)
//   $GITHUB_STEP_SUMMARY   a table; ::error / ::warning annotations with each
//                          failing test's error, which the public API serves
//                          without signing in (the job log needs a sign-in)
// Exit code 1 when any file failed (both times, with the retry), hung, or
// was not reached before the shard's own time limit.
//
// Time limits (both end with the file's whole process tree killed — see
// killTree — and an annotation that names the file and its last lines):
//   UI_FILE_LIMIT_MS   one file, 8 min by default; a file that hit it is not
//                      retried (it would only hang again)
//   UI_SHARD_LIMIT_MS  the whole shard, 28 min by default: below the step's
//                      and the job's own limits in ui.yml, so the summary, the
//                      timings and the uploads still happen
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const OUT = process.env.UI_OUT || path.join(process.cwd(), "test", "ui", "artifacts", "ci");
const RETRY = process.env.UI_RETRY !== "0";
const FILE_LIMIT_MS = Number(process.env.UI_FILE_LIMIT_MS) || 8 * 60 * 1000;
const SHARD_LIMIT_MS = Number(process.env.UI_SHARD_LIMIT_MS) || 28 * 60 * 1000;
const T0 = Date.now();
fs.mkdirSync(OUT, { recursive: true });

// The failing tests of a TAP file, each with its error text and the first
// stack line in a test file; and the skipped ones with their reason.
const parseTap = (tap) => {
  let lines = [];
  try { lines = fs.readFileSync(tap, "utf8").split(/\r?\n/); } catch {}
  const fails = [];
  const skipped = [];
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const done = /^\s*(?:not )?ok \d+ - (.*)$/.exec(l);
    if (done) last = done[1].trim();
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
  return { fails, skipped, last };
};
// (an annotation is one line: newlines and % are encoded)
const esc = (t) => String(t).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");

// ---------- the whole tree of a file's processes ----------
// Killing `node --test`'s own process group is not enough: the private
// server (scripts/ui-test-server.js) and Chrome (playwright) are each started
// in a process group of their own, so they — and the server's ffmpeg —
// outlived a stopped file and kept a CPU busy under the next files. Every
// process a file starts inherits UI_SHARD_TAG in its environment (the server
// passes the caller's environment on, and so do playwright and the server's
// own spawns), so they are found even after their parent is gone, by the
// tag in /proc/<pid>/environ, besides the plain parent → child walk.
const procs = () => {
  if (process.platform === "win32") return [];
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" });
  return String(r.stdout || "").split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
    .map(([pid, ppid, pgid, ...comm]) => ({ pid: +pid, ppid: +ppid, pgid: +pgid, comm: comm.join(" ") }));
};
const hasTag = (pid, tag) => {
  try { return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`UI_SHARD_TAG=${tag}`); } catch { return false; }
};
// The processes of a file: the root's descendants plus every tagged one.
const treeOf = (rootPid, tag) => {
  const all = procs();
  const found = new Map();
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const walk = (pid) => { for (const c of kids.get(pid) || []) if (!found.has(c.pid)) { found.set(c.pid, c); walk(c.pid); } };
  // (by parent id only while the root is still running: a pid that has ended
  // can be reused by a process that is not ours)
  if (rootPid) {
    const root = all.find((p) => p.pid === rootPid);
    if (root) found.set(root.pid, root);
    walk(rootPid);
  }
  for (const p of all) if (p.pid !== process.pid && !found.has(p.pid) && hasTag(p.pid, tag)) { found.set(p.pid, p); walk(p.pid); }
  found.delete(process.pid);
  return [...found.values()];
};
const killTree = (rootPid, tag) => {
  if (process.platform === "win32") {
    if (!rootPid) return [];
    // (the tree by parent ids only: no tag scan on Windows, where this runs only by hand)
    const r = spawnSync("taskkill", ["/pid", String(rootPid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    return String(r.stdout || "").split(/\r?\n/).filter((l) => /^SUCCESS/.test(l)).map((l) => ({ pid: 0, comm: "process" }));
  }
  // Two rounds: a process can start a child between the listing and the kill.
  const killed = new Map();
  const own = (procs().find((p) => p.pid === process.pid) || {}).pgid;
  for (let round = 0; round < 2; round++) {
    const tree = treeOf(rootPid, tag);
    for (const p of tree) {
      killed.set(p.pid, p);
      // (a whole group at once, never this runner's own)
      if (p.pgid > 1 && p.pgid !== own) { try { process.kill(-p.pgid, "SIGKILL"); } catch {} }
      try { process.kill(p.pid, "SIGKILL"); } catch {}
    }
    if (!tree.length) break;
  }
  return [...killed.values()];
};
const names = (ps) => {
  const n = {};
  for (const p of ps) n[p.comm] = (n[p.comm] || 0) + 1;
  return Object.entries(n).map(([c, k]) => (k > 1 ? `${c} ×${k}` : c)).join(", ");
};

const tail = (file, n) => {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !/^::(end)?group::/.test(l)).slice(-n).join("\n"); } catch { return ""; }
};

const runFile = (file, attempt, budgetMs) => new Promise((resolve) => {
  const name = path.basename(file, ".test.js");
  const base = `${name}${attempt > 1 ? `.try${attempt}` : ""}`;
  const tap = path.join(OUT, `${base}.tap`);
  const logFile = path.join(OUT, `${base}.log`);
  const log = fs.createWriteStream(logFile);
  const tag = `${process.pid}-${base}-${Date.now()}`;
  const t0 = Date.now();
  console.log(`\n::group::${name}${attempt > 1 ? ` (try ${attempt})` : ""}`);
  const child = spawn(process.execPath, [
    "--test", "--test-concurrency=1",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", `--test-reporter-destination=${tap}`,
    file,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, UI_SHARD_TAG: tag },
  });
  // (the output goes to the job log as before, and to the file's own log)
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { process.stdout.write(c); log.write(c); });
  // A file that never ends (a handle left open, a hook that hangs, a test
  // with no time limit of its own) must not hold the shard: its whole tree goes.
  const limit = Math.min(FILE_LIMIT_MS, budgetMs);
  const why = limit < FILE_LIMIT_MS ? `the shard's time limit (${Math.round(SHARD_LIMIT_MS / 60000)} min) came` : `still running after ${Math.round(FILE_LIMIT_MS / 6000) / 10} min`;
  let hung = false, killed = [], settled = false;
  const timer = setTimeout(() => {
    hung = true;
    const msg = `\n[ui-shard] ${name}: ${why} — stopping it and every process it started`;
    console.log(msg); log.write(msg + "\n");
    killed = killTree(child.pid, tag);
    const m2 = `[ui-shard] ${name}: killed ${killed.length} process(es)${killed.length ? `: ${names(killed)}` : ""}`;
    console.log(m2); log.write(m2 + "\n");
    // (SIGKILL ends a process at once; should 'exit' still not come, the shard goes on)
    stuck = setTimeout(() => finish(null, "SIGKILL"), 30000);
  }, limit);
  let stuck = null, drain = null;
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(stuck); clearTimeout(drain);
    // Whatever the file left running (a server or a Chrome it did not close)
    // is stopped before the next file, and said.
    const left = hung ? [] : killTree(null, tag);
    if (left.length) {
      const m = `[ui-shard] ${name}: left ${left.length} process(es) running after it ended — killed: ${names(left)}`;
      console.log(m); log.write(m + "\n");
    }
    console.log("::endgroup::");
    log.end();
    const secs = (Date.now() - t0) / 1000;
    const parsed = parseTap(tap);
    // (the file's own describe() fails along with any test in it: not a test name)
    const fails = parsed.fails.filter((f) => f.name !== name);
    if (hung) {
      // its partial log and TAP, kept apart for the workflow's "Upload a hung file's log"
      const dir = path.join(OUT, "hung");
      fs.mkdirSync(dir, { recursive: true });
      for (const f of [logFile, tap]) { try { fs.copyFileSync(f, path.join(dir, path.basename(f))); } catch {} }
      fails.push({
        name: `(the file was stopped: ${why})`,
        error: `last test that ended: ${parsed.last || "none"}\nkilled: ${names(killed) || "nothing left"}\nits last lines:\n${tail(logFile, 25)}`,
        at: "",
      });
    }
    resolve({ name, ok: code === 0 && !hung, code: hung ? "timeout" : code == null ? signal : code, secs, failed: [...new Set(fails.map((f) => f.name))], fails, skipped: parsed.skipped, hung });
  };
  // 'close' comes once the process has ended and its pipes are drained. A
  // pipe held open by something it started must not hold the shard: 3 s after
  // 'exit' it goes on regardless (finish kills whatever is left). Both timers
  // keep the event loop alive on purpose — with unref'd ones the runner once
  // ended with code 0 and no summary at all.
  child.on("close", (code, signal) => finish(code, signal));
  child.on("exit", (code, signal) => { drain = setTimeout(() => finish(code, signal), 3000); });
  child.on("error", (e) => { console.log(`[ui-shard] ${name}: ${e.message}`); finish(null, "error"); });
});

// (never a quiet end: an exit before the summary is a failure, and says so)
let summarised = false;
process.on("exit", (code) => {
  if (!summarised && code === 0) { console.log("::error title=UI shard runner::the runner ended before its summary"); process.exitCode = 1; }
});

const describeFails = (fails) => fails.slice(0, 6).map((f) => {
  const err = f.error.split("\n").filter((x) => !/^artifacts:/.test(x)).slice(0, 40).join("\n  ");
  return `- ${f.name}\n  ${err}${f.at ? `\n  at ${f.at}` : ""}`;
}).join("\n");

(async () => {
  if (process.argv.includes("--parse")) { console.log(JSON.stringify(parseTap(process.argv[process.argv.indexOf("--parse") + 1]), null, 1)); process.exit(0); }
  const files = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
  if (!files.length) { console.error("usage: ui-shard-run.js <test/ui files…>"); process.exit(2); }
  const rows = [];
  const timings = {};
  const left = () => SHARD_LIMIT_MS - (Date.now() - T0);
  for (const file of files) {
    const name = path.basename(file, ".test.js");
    // (a file is not started with less than a minute of the shard's time left)
    if (left() < 60000) {
      rows.push({ name, ok: false, notRun: true, code: "not run", secs: 0, failed: [], fails: [], skipped: [], flaky: false });
      continue;
    }
    let r = await runFile(file, 1, left());
    timings[r.name] = Math.round(r.secs);
    let flaky = false;
    // (no second try for a file that hung: it would only hang again)
    if (!r.ok && RETRY && r.code !== "timeout" && left() >= 60000) {
      const first = r;
      r = await runFile(file, 2, left());
      if (r.ok) { flaky = true; r.failed = first.failed; r.fails = first.fails; }
    }
    rows.push({ ...r, flaky });
    if (flaky) {
      console.log(`::warning title=Flaky UI file: ${r.name}::${esc(`${r.name} failed, then passed when run again alone. First try:\n${describeFails(r.fails) || "exit " + r.code}`.slice(0, 6000))}`);
    } else if (r.hung) {
      console.log(`::error title=UI file stopped: ${r.name}::${esc(`${r.name}: ${describeFails(r.fails.filter((f) => /^\(the file was stopped/.test(f.name)))}\n(the whole log: the ui-hung-<shard> artifact)`.slice(0, 6000))}`);
      const rest = r.fails.filter((f) => !/^\(the file was stopped/.test(f.name));
      if (rest.length) console.log(`::error title=UI file failed: ${r.name}::${esc(`${r.name}, before it was stopped:\n${describeFails(rest)}`.slice(0, 6000))}`);
    } else if (!r.ok) {
      console.log(`::error title=UI file failed: ${r.name}::${esc(`${r.name} failed${RETRY ? " twice" : ""} (exit ${r.code})\n${describeFails(r.fails) || "see the log"}`.slice(0, 6000))}`);
    }
    for (const s of r.skipped) console.log(`::notice title=Skipped UI test::${esc(`${r.name}: ${s}`)}`);
  }
  const notRun = rows.filter((r) => r.notRun).map((r) => r.name);
  if (notRun.length) console.log(`::error title=UI shard out of time::${esc(`the shard's ${Math.round(SHARD_LIMIT_MS / 60000)} min ran out; not run: ${notRun.join(", ")}`)}`);
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(timings, null, 1));
  // (the seconds as a notice too: readable without signing in, for
  // `tools/ci/ui-shards.js --update` — save the JSON to a file first)
  console.log(`::notice title=UI shard timings::${JSON.stringify(timings)}`);
  const total = rows.reduce((a, r) => a + r.secs, 0);
  const lines = [
    `### UI shard: ${rows.filter((r) => r.ok).length}/${rows.length} files green, ${Math.round(total / 6) / 10} min`,
    "",
    "| file | result | seconds | failing tests |",
    "|---|---|---:|---|",
    ...rows.map((r) => `| ${r.name} | ${r.ok ? (r.flaky ? "flaky (passed on retry)" : "pass") : r.notRun ? "NOT RUN (shard out of time)" : r.hung ? "STOPPED (hung)" : "FAIL"} | ${Math.round(r.secs)} | ${r.failed.join("<br>")} |`),
  ];
  console.log("\n" + lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  summarised = true;
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
})();
