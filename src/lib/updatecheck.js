// Update check + the two actions the admin's Server tab hangs off it.
// The CHECK stays read-only and fails silent when offline (the pill just
// doesn't show). pull() and the restart route in admin.js only ever run
// when an admin presses their buttons — nothing here acts by itself.
//
// "Different sha" is NOT enough: this server routinely runs commits that
// haven't been pushed yet (elia's local-until-approved workflow), so HEAD
// being ahead of origin must not read as "update available". The remote sha
// counts as an update only when it is NOT an ancestor of local HEAD.
const { execFile } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CACHE_MS = 60 * 60 * 1000;

let cache = { at: 0, result: null };

// The sha this PROCESS was started from. Captured once at boot (server.js
// calls captureBoot() from its listen callback). After a pull, HEAD on disk
// moves but this does not — that difference is exactly what the admin's
// "restart to apply" state reports. Before, the check compared disk to
// GitHub only, so a pulled-but-not-restarted server read as "up to date"
// while running week-old code (elia's complaint).
let runningSha = null;
const captureBoot = () =>
  git(["rev-parse", "HEAD"]).then((sha) => {
    if (sha) runningSha = sha;
  });

// Never let git open a credential prompt: with nothing cached, ls-remote
// would pop a GUI dialog on the server's desktop and hang the request until
// somebody dismisses it (the timeout kills git.exe but the prompt's stdio
// keeps the callback waiting). Fail fast instead — failure is the silent
// "offline" path anyway.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

const git = (args, timeout = 5000) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, timeout, env: GIT_ENV }, (err, out) =>
      resolve(err ? null : String(out).trim()),
    );
  });

// exit 0 → ancestor (we already have it); anything else → we don't
const isAncestor = (sha) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["merge-base", "--is-ancestor", sha, "HEAD"],
      { cwd: ROOT, timeout: 5000, env: GIT_ENV },
      (err) => resolve(!err),
    );
  });

const check = async (force = false) => {
  if (!force && cache.result && Date.now() - cache.at < CACHE_MS) return cache.result;
  const result = {
    checkedAt: Date.now(),
    available: false,
    local: null,
    remote: null,
    running: null,
    restartNeeded: false,
    error: null,
  };
  try {
    result.local = await git(["rev-parse", "HEAD"]);
    // ls-remote lists the remote's refs without fetching a single object,
    // and it rides the machine's own git credentials — so it works while
    // the repo is still private (the anonymous GitHub API 404s there) and
    // has no API rate limits.
    const out = await git(["ls-remote", "origin", "refs/heads/master"], 10000);
    const m = out && out.match(/^([0-9a-f]{40})/);
    if (!m) throw new Error("no remote ref");
    result.remote = m[1];
    if (result.local && result.remote && result.local !== result.remote) {
      result.available = !(await isAncestor(result.remote));
    }
  } catch {
    result.error = "offline"; // silent per spec — the UI shows nothing scary
  }
  // Running-vs-disk is a purely local fact — it must survive the offline
  // path above, or the one state that matters most ("you pulled but the old
  // code is still serving") would vanish exactly when GitHub is unreachable.
  result.running = runningSha;
  if (!result.local) result.local = await git(["rev-parse", "HEAD"]);
  result.restartNeeded = !!(runningSha && result.local && runningSha !== result.local);
  cache = { at: Date.now(), result };
  return result;
};

// The Pull button. --ff-only on purpose: a merge or rebase can leave a
// conflicted half-applied tree on an unattended server — if the histories
// diverged, fail loudly and let a human untangle it at a real terminal.
const pull = () =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["pull", "--ff-only", "origin", "master"],
      { cwd: ROOT, timeout: 120000, env: GIT_ENV },
      (err, out, errOut) => {
        cache = { at: 0, result: null }; // whatever happened, re-check fresh
        const output = [String(out || "").trim(), String(errOut || "").trim()]
          .filter(Boolean)
          .join("\n");
        resolve({ ok: !err, output: output.slice(0, 4000) });
      },
    );
  });



module.exports = { check, pull, captureBoot, _internals: { git, isAncestor } };
