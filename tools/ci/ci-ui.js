#!/usr/bin/env node
// The browser-test run on GitHub (.github/workflows/ui.yml) for a branch or a
// commit, per shard, from the public API (no sign-in, no gh). See tools/ci-ui.sh.
//
//   node tools/ci/ci-ui.js <branch> [--sha <commit>] [--wait] [--every 120]
//
// --wait polls until the run is complete and exits 0 (green) / 1 (red).
// Without a token GitHub allows 60 calls an hour per address: a poll costs
// 2 calls, plus 1 per failed shard at the end. GITHUB_TOKEN, if set, is sent
// (5000 an hour); it is never printed.
const REPO = process.env.AURORA_REPO || "nufkinaa/aurora";
const API = `https://api.github.com/repos/${REPO}`;
const WORKFLOW = "ui.yml";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const branch = args.find((a, i) => !a.startsWith("--") && !["--sha", "--every"].includes(args[i - 1]));
const sha = opt("--sha");
const wait = args.includes("--wait");
const every = Math.max(30, Number(opt("--every", 120)) || 120);

const get = async (url) => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "aurora-ci-ui" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  const left = res.headers.get("x-ratelimit-remaining");
  if (!res.ok) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(`${res.status} from ${url}${left === "0" && reset ? ` (rate limit: free again at ${new Date(reset * 1000).toLocaleTimeString()})` : ""}`);
  }
  return { body: await res.json(), left };
};

const mins = (a, b) => (a && b ? `${Math.round((new Date(b) - new Date(a)) / 6000) / 10} min` : "");

const once = async () => {
  const q = new URLSearchParams({ per_page: "10", ...(branch ? { branch } : {}), ...(sha ? { head_sha: sha } : {}) });
  const { body: runs, left } = await get(`${API}/actions/workflows/${WORKFLOW}/runs?${q}`);
  const run = (runs.workflow_runs || [])[0];
  if (!run) { console.log(`no UI run yet for ${branch || ""}${sha ? ` @ ${sha}` : ""}`); return { done: false, ok: false }; }
  const { body: jobs } = await get(`${API}/actions/runs/${run.id}/jobs?per_page=50`);
  const done = run.status === "completed";
  const wall = mins(run.run_started_at || run.created_at, done ? run.updated_at : new Date().toISOString());
  console.log(`UI run ${run.id} · ${run.head_branch} @ ${run.head_sha.slice(0, 8)} · ${run.event} · ${done ? run.conclusion : run.status} · ${wall} wall · ${run.html_url}`);
  const shards = (jobs.jobs || []).filter((j) => j.name !== "plan").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const j of shards) {
    const state = j.status === "completed" ? j.conclusion : j.status;
    console.log(`  ${j.name.padEnd(10)} ${String(state).padEnd(11)} ${mins(j.started_at, j.completed_at || (j.started_at ? new Date().toISOString() : null))}`);
  }
  if (done) {
    for (const j of shards.filter((j) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped")) {
      try {
        const { body: notes } = await get(`https://api.github.com/repos/${REPO}/check-runs/${j.id}/annotations?per_page=50`);
        for (const n of notes.filter((n) => n.annotation_level !== "notice" || /Skipped/.test(n.title || ""))) {
          console.log(`  [${j.name}] ${n.annotation_level}: ${n.title ? n.title + ": " : ""}${n.message}`);
        }
      } catch (e) { console.log(`  [${j.name}] annotations: ${e.message}`); }
    }
  }
  if (left != null) console.log(`  (API calls left this hour: ${left})`);
  return { done, ok: done && run.conclusion === "success" };
};

(async () => {
  if (!branch && !sha) { console.error("usage: tools/ci-ui.sh <branch> [--sha <commit>] [--wait] [--every <seconds>]"); process.exit(2); }
  for (;;) {
    let r;
    try { r = await once(); } catch (e) { console.error(e.message); if (!wait) process.exit(2); r = { done: false }; }
    if (!wait) process.exit(r.done ? (r.ok ? 0 : 1) : 3);
    if (r.done) process.exit(r.ok ? 0 : 1);
    await new Promise((res) => setTimeout(res, every * 1000));
  }
})();
