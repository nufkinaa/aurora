#!/usr/bin/env node
"use strict";
// CI's test chooser. Works out what changed since the last green CI run, asks
// select-tests.js which test files that can reach, and says so in the log, in the
// job summary and as a notice annotation.
//
//   node tools/ci/ci-tests.js select [--map f] [--base sha] [--head sha] [--out list.txt]
//        In GitHub Actions everything comes from the environment (see `fromActions`);
//        locally, --base/--head pick the range (default HEAD^..HEAD).
//   node tools/ci/ci-tests.js changed --match tv-native/ [--match …] [--base sha] [--head sha]
//        Says (run=true|false in $GITHUB_OUTPUT) whether anything under those paths
//        changed in the same range; any doubt says run=true. Gates the tv-native job.
//   node tools/ci/ci-tests.js simulate [--map f] [--count 30] [--full-ms 130000]
//        Replays the last N first-parent commits through the selector.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { select } = require("./select-tests");

const ROOT = path.resolve(__dirname, "..", "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const gitOk = (...args) => spawnSync("git", args, { cwd: ROOT, stdio: "ignore" }).status === 0;
const short = (s) => (s ? String(s).slice(0, 8) : "?");
const ZERO = /^0+$/;

function testFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.js")).map((f) => `test/${f}`).sort();
}

function readMap(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function changedFiles(base, head) {
  const out = git("diff", "--name-status", "--no-renames", "-z", base, head);
  const parts = out.split("\0").filter((s) => s !== "");
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i][0], path: parts[i + 1] });
  for (const c of changes) if (c.status === "M" && /^package(-lock)?\.json$/.test(c.path)) c.versionOnly = versionOnly(base, head, c.path);
  // Which folder listings an add/remove changes: its parent, and, when it creates (or
  // empties) a folder, that folder's parent too, and so on up.
  const has = new Map();
  const exists = (rev, dir) => {
    if (dir === ".") return true;
    const k = `${rev}:${dir}`;
    if (!has.has(k)) has.set(k, gitOk("cat-file", "-e", k));
    return has.get(k);
  };
  for (const c of changes) {
    if (c.status === "M") continue;
    const other = c.status === "D" ? head : base; // where the folder may not exist
    const listed = [];
    let d = c.path;
    do {
      d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : ".";
      listed.push(d);
    } while (d !== "." && !exists(other, d));
    c.listedIn = listed;
  }
  return changes;
}

// A release bump touches only "version" in package.json (and the lockfile's two copies
// of it). Dependencies and scripts unchanged = no reason to run everything.
function versionOnly(base, head, file) {
  try {
    const strip = (text) => {
      const j = JSON.parse(text);
      delete j.version;
      if (j.packages && j.packages[""]) delete j.packages[""].version;
      return JSON.stringify(j);
    };
    return strip(git("show", `${base}:${file}`)) === strip(git("show", `${head}:${file}`));
  } catch { return false; }
}

// The map knows what each test read as of the commit it was last updated at (M). The
// range must start no later than M: a dependency added after M came with a change to a
// file the test already read, and that change must be in the range. So the base becomes
// merge-base(base, M). If M is not in HEAD's history (a PR restoring master's newer map),
// the files changed between their common ancestor and M are added as well.
function widenForMap(base, head, map) {
  const m = map.updatedCommit || map.fullCommit;
  if (!m) return { force: "the test map does not say which commit it describes" };
  if (!gitOk("cat-file", "-e", `${m}^{commit}`)) return { force: `the test map describes ${short(m)}, which this clone does not have` };
  try {
    const wide = git("merge-base", base, m);
    let extra = [];
    if (!gitOk("merge-base", "--is-ancestor", m, head)) extra = changedFiles(git("merge-base", m, head), m);
    return { base: wide === git("rev-parse", base) ? base : wide, extra };
  } catch (e) {
    return { force: `the test map's commit ${short(m)} could not be compared (${e.message.split("\n")[0]})` };
  }
}

function mergeChanges(a, b) {
  const seen = new Map();
  for (const c of [...a, ...b]) {
    const prev = seen.get(c.path);
    if (!prev) { seen.set(c.path, { ...c }); continue; }
    // In both lists: keep the wider reading (an add/remove reaches listings too; an edit doesn't).
    if (prev.status === "M" && c.status !== "M") { prev.status = c.status; prev.listedIn = c.listedIn; }
    else if (prev.status !== "M" && c.status !== "M") {
      prev.listedIn = prev.listedIn && c.listedIn ? [...new Set([...prev.listedIn, ...c.listedIn])] : undefined;
    }
    prev.versionOnly = !!(prev.versionOnly && c.versionOnly);
  }
  return [...seen.values()];
}

const messages = (base, head) => git("log", "--format=%B%x00", `${base}..${head}`);
const wantsFull = (text) => /\[ci full\]/i.test(text || "");

// The last commit CI passed on, so a cancelled or red run never hides a change: its
// commits are still in the next run's range. Needs `actions: read`; any doubt = null.
async function lastGreen(env) {
  const repo = env.GITHUB_REPOSITORY, token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const wf = (env.GITHUB_WORKFLOW_REF || "").split("@")[0].split("/").pop() || "ci.yml";
  const branch = (env.GITHUB_REF || "").replace(/^refs\/heads\//, "");
  if (!repo || !branch) return { sha: null, note: "no repository or branch in the environment" };
  const url = `${api}/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs?branch=${encodeURIComponent(branch)}&status=success&exclude_pull_requests=true&per_page=50`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) return { sha: null, note: `the runs API answered ${res.status}` };
    const body = await res.json();
    for (const run of body.workflow_runs || []) {
      if (!["push", "schedule", "workflow_dispatch"].includes(run.event)) continue;
      if (String(run.id) === String(env.GITHUB_RUN_ID)) continue;
      if (!run.head_sha || !gitOk("cat-file", "-e", `${run.head_sha}^{commit}`)) continue;
      if (!gitOk("merge-base", "--is-ancestor", run.head_sha, "HEAD")) continue;
      return { sha: run.head_sha, note: `last green run ${run.run_number || run.id} (${run.event})`, url: run.html_url };
    }
    return { sha: null, note: "no earlier green run of this workflow on this branch" };
  } catch (e) {
    return { sha: null, note: `the runs API failed (${e.message})` };
  }
}

async function fromActions(env) {
  const ev = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF || "";
  if (ev === "schedule") return { force: "the nightly full run" };
  if (ev === "workflow_dispatch") return { force: "a run started by hand" };
  if (ref.startsWith("refs/tags/")) return { force: `the release tag ${ref.slice(10)}` };
  if (Number(env.GITHUB_RUN_ATTEMPT || 1) > 1) return { force: `a re-run (attempt ${env.GITHUB_RUN_ATTEMPT})` };
  if (ev === "pull_request") {
    // actions/checkout puts the PR's merge commit at HEAD: its first parent is the base.
    let base = null;
    try {
      const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
      if (parents.length === 3) base = parents[1];
      else if (env.PR_BASE_SHA) base = git("merge-base", env.PR_BASE_SHA, "HEAD");
    } catch { base = null; }
    return base ? { base, head: "HEAD", note: "the pull request's base" } : { force: "the pull request's base could not be found" };
  }
  if (ev === "push") {
    const g = await lastGreen(env);
    if (g.sha) return { base: g.sha, head: "HEAD", note: g.note, url: g.url };
    return { force: `${g.note}: no safe base to compare with` };
  }
  return { force: `the ${ev || "unknown"} event` };
}

function estimate(map, tests, all) {
  if (!map || !map.tests) return null;
  const ms = (t) => (map.tests[t] && map.tests[t].ms) || 0;
  const total = all.reduce((s, t) => s + ms(t), 0);
  if (!total) return null;
  return tests.reduce((s, t) => s + ms(t), 0) / total;
}

function report(result, ctx) {
  const all = ctx.testFiles;
  const share = result.mode === "all" ? 1 : result.mode === "none" ? 0 : estimate(ctx.map, result.tests, all);
  const pct = share == null ? "" : ` (about ${Math.round(share * 100)}% of the suite's test time)`;
  const head = result.mode === "all" ? `Running ALL ${all.length} test files: ${result.reason}`
    : result.mode === "none" ? `No affected tests: ${result.reason}. Nothing to run.`
      : `Running ${result.tests.length} of ${all.length} test files${pct}: only those that read something that changed`;
  const range = ctx.base ? `Compared ${short(ctx.base)}..${short(ctx.headSha)} (${ctx.note || "given range"}), ${ctx.changes ? ctx.changes.length : "?"} changed files.` : "";
  const mapLine = ctx.map ? `Test map: node ${ctx.map.node}, last full trace ${String(ctx.map.fullAt || "?").slice(0, 16)} at ${short(ctx.map.fullCommit)}, ${Object.keys(ctx.map.tests || {}).length} test files.` : "Test map: none.";

  const log = [head, range, mapLine].filter(Boolean);
  if (result.mode === "some") for (const t of result.tests) log.push(`  ${t}  <-  ${result.why[t].slice(0, 4).join(", ")}${result.why[t].length > 4 ? ` +${result.why[t].length - 4}` : ""}`);
  if (result.safe && result.safe.length) log.push(`Changes no test reads: ${result.safe.map((s) => s.path).slice(0, 20).join(", ")}${result.safe.length > 20 ? ` +${result.safe.length - 20}` : ""}`);

  const md = [`### ${head}`, "", range, "", mapLine, ""];
  if (result.mode === "some") {
    md.push("| test file | runs because of |", "|---|---|");
    for (const t of result.tests) md.push(`| \`${t}\` | ${result.why[t].slice(0, 6).map((p) => `\`${p}\``).join(", ")}${result.why[t].length > 6 ? ` +${result.why[t].length - 6}` : ""} |`);
    md.push("");
  }
  if (ctx.changes && ctx.changes.length) {
    md.push(`<details><summary>${ctx.changes.length} changed files</summary>`, "");
    for (const c of ctx.changes.slice(0, 300)) md.push(`- ${c.status} \`${c.path}\``);
    if (ctx.changes.length > 300) md.push(`- … ${ctx.changes.length - 300} more`);
    md.push("", "</details>", "");
  }
  md.push("Put `[ci full]` in a commit message to run everything; the nightly run and `server-*-stable` tags always do.");
  return { log: log.join("\n"), md: md.join("\n"), head };
}

const arg = (args, n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

async function cmdSelect(args, env) {
  const mapFile = arg(args, "--map", env.TEST_MAP || null);
  const outFile = arg(args, "--out", env.SELECTION_OUT || null);
  const map = readMap(mapFile);
  const files = testFiles();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let ctx;
  if (arg(args, "--base") || !env.GITHUB_ACTIONS) {
    ctx = { base: arg(args, "--base", "HEAD^"), head: arg(args, "--head", "HEAD"), note: "given range" };
  } else {
    ctx = await fromActions(env);
  }
  let changes = null, force = ctx.force || null;
  if (!force && map) {
    const w = widenForMap(ctx.base, ctx.head, map);
    if (w.force) force = w.force;
    else { if (w.base !== ctx.base) ctx.note = `${ctx.note}; widened to ${short(w.base)}, where the test map was last updated`; ctx.base = w.base; ctx.extra = w.extra; }
  }
  if (!force) {
    try {
      changes = mergeChanges(changedFiles(ctx.base, ctx.head), ctx.extra || []);
      if (wantsFull(messages(ctx.base, ctx.head))) force = "[ci full] in a commit message";
    } catch (e) { force = `git could not compare ${short(ctx.base)}..${ctx.head} (${e.message.split("\n")[0]})`; }
  }
  const result = select({ changes, map, testFiles: files, force, nodeMajor });
  let headSha = null;
  try { headSha = git("rev-parse", ctx.head || "HEAD"); } catch { /* ignore */ }
  const rep = report(result, { ...ctx, headSha, changes, map, testFiles: files });

  console.log(rep.log);
  if (outFile) fs.writeFileSync(outFile, result.mode === "none" ? "" : result.tests.join("\n") + "\n");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\ncount=${result.mode === "none" ? 0 : result.tests.length}\ntotal=${files.length}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, rep.md + "\n");
  if (env.GITHUB_ACTIONS) console.log(`::notice title=Tests chosen (node ${nodeMajor})::${rep.head.replace(/[\r\n]+/g, " ")}`);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 1));
  return result;
}

// Does this run need a job that only cares about some paths (the tv-native job:
// `--match tv-native/ --match .github/workflows/`)? The same range as the root
// tests: the last green run on a push, the base on a pull request. The nightly
// run compares with the last green run as well (it would otherwise rerun an
// unchanged app every night). A tag, a run by hand, a re-run, or any doubt
// (no green base, git failing) runs the job.
const matchesAny = (p, prefixes) => prefixes.some((m) => (m.endsWith("/") ? p.startsWith(m) : p === m || p.startsWith(`${m}/`)));

async function decideChanged({ prefixes, env, base, head }) {
  let ctx;
  if (base || !env.GITHUB_ACTIONS) ctx = { base: base || "HEAD^", head: head || "HEAD", note: "given range" };
  else if (env.GITHUB_EVENT_NAME === "schedule") {
    const g = await lastGreen(env);
    ctx = g.sha ? { base: g.sha, head: "HEAD", note: g.note } : { force: `${g.note}: no safe base to compare with` };
  } else ctx = await fromActions(env);
  if (ctx.force) return { run: true, reason: ctx.force, matched: [] };
  let changes;
  try { changes = changedFiles(ctx.base, ctx.head); } catch (e) {
    return { run: true, reason: `git could not compare ${short(ctx.base)}..${ctx.head} (${e.message.split("\n")[0]})`, matched: [] };
  }
  const matched = changes.map((c) => c.path).filter((p) => matchesAny(p, prefixes));
  const sha = (r) => { try { return short(git("rev-parse", r)); } catch { return short(r); } };
  const range = `${sha(ctx.base)}..${sha(ctx.head)} (${ctx.note})`;
  const what = prefixes.length > 3 ? `${prefixes.slice(0, 2).join(" or ")} or ${prefixes.length - 2} more watched paths` : prefixes.join(" or ");
  return matched.length
    ? { run: true, reason: `${matched.length} changed file(s) under ${what} in ${range}`, matched }
    : { run: false, reason: `nothing under ${what} changed in ${range}`, matched };
}

async function cmdChanged(args, env) {
  const prefixes = args.map((a, i) => (args[i - 1] === "--match" ? a : null)).filter(Boolean);
  if (!prefixes.length) throw new Error("changed: give at least one --match <path prefix>");
  const r = await decideChanged({ prefixes, env, base: arg(args, "--base"), head: arg(args, "--head") });
  const line = `${r.run ? "Running" : "Skipping"}: ${r.reason}`;
  console.log(line);
  for (const p of r.matched.slice(0, 20)) console.log(`  ${p}`);
  if (r.matched.length > 20) console.log(`  … ${r.matched.length - 20} more`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `run=${r.run}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
  if (env.GITHUB_ACTIONS) console.log(`::notice title=${r.run ? "Running" : "Skipped"}::${r.reason.replace(/[\r\n]+/g, " ")}`);
  return r;
}

function cmdSimulate(args) {
  const map = readMap(arg(args, "--map"));
  const count = Number(arg(args, "--count", "30"));
  const fullMs = Number(arg(args, "--full-ms", "0"));
  const files = testFiles();
  const nodeMajor = map ? map.node : null;
  const commits = git("log", "--first-parent", `-${count}`, "--format=%H").split("\n").filter(Boolean);
  const rows = [];
  for (const sha of commits) {
    let changes, msg;
    try { changes = changedFiles(`${sha}^`, sha); msg = git("log", "-1", "--format=%B", sha); } catch { changes = null; msg = ""; }
    const r = select({ changes, map, testFiles: files, nodeMajor, force: wantsFull(msg) ? "[ci full]" : null, now: map ? Date.parse(map.fullAt) : Date.now() });
    const n = r.mode === "none" ? 0 : r.tests.length;
    const share = r.mode === "all" ? 1 : r.mode === "none" ? 0 : estimate(map, r.tests, files);
    rows.push({ sha: short(sha), subject: git("log", "-1", "--format=%s", sha).slice(0, 70), files: changes ? changes.length : "?", mode: r.mode, tests: n, share, reason: r.reason, list: r.mode === "some" ? r.tests : [] });
  }
  return { rows, total: files.length, fullMs };
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "select") {
    // A bug in the chooser must never skip tests: fall back on the whole suite.
    cmdSelect(args, process.env).catch((e) => {
      console.error(e);
      const env = process.env, files = testFiles();
      const out = arg(args, "--out", env.SELECTION_OUT || null);
      if (out) fs.writeFileSync(out, files.join("\n") + "\n");
      if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `mode=all\ncount=${files.length}\ntotal=${files.length}\n`);
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Running ALL ${files.length} test files: the test chooser failed (${String(e && e.message).split("\n")[0]})\n`);
      if (env.GITHUB_ACTIONS) console.log(`::warning title=Test chooser failed::running everything (${String(e && e.message).split("\n")[0]})`);
    });
  } else if (cmd === "changed") {
    // A bug here must never skip the job: any error runs it.
    cmdChanged(args, process.env).catch((e) => {
      console.error(e);
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "run=true\n");
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Change check failed::running the job (${String(e && e.message).split("\n")[0]})`);
    });
  } else if (cmd === "simulate") {
    const { rows, total, fullMs } = cmdSimulate(args);
    let sumTests = 0, sumShare = 0;
    for (const r of rows) {
      sumTests += r.tests; sumShare += r.share == null ? 1 : r.share;
      const t = fullMs ? ` ~${((r.share == null ? 1 : r.share) * fullMs / 60000).toFixed(1)} min` : "";
      console.log(`${r.sha} ${String(r.mode).padEnd(4)} ${String(r.tests).padStart(3)}/${total}${t}  files:${String(r.files).padStart(4)}  ${r.subject}\n           ${r.reason}`);
      if (args.includes("--list") && r.list.length) console.log(`           ${r.list.join(" ")}`);
    }
    console.log(`\n${rows.length} commits: ${sumTests} test-file runs instead of ${rows.length * total} (${Math.round((100 * sumTests) / (rows.length * total))}%), about ${Math.round((100 * sumShare) / rows.length)}% of the test time${fullMs ? ` (~${(sumShare * fullMs / 60000).toFixed(1)} min instead of ${(rows.length * fullMs / 60000).toFixed(1)} per Node version)` : ""}`);
  } else {
    console.error("usage: ci-tests.js select|changed|simulate [options]");
    process.exit(2);
  }
}

module.exports = { mergeChanges, widenForMap, versionOnly, changedFiles, fromActions, lastGreen, report, testFiles, cmdSimulate, wantsFull, matchesAny, decideChanged };
