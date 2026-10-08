// The admin page's Actions tab (elia, 2026-10-08): the things whoever runs the
// server otherwise needs a terminal for — update, install dependencies, run
// the tests, back up, clear a cache, run a maintenance script — as buttons.
//
// THE RULE: this is a fixed list. Every action is named here with the exact
// program and arguments it runs, or the exact function it calls. Nothing the
// browser sends is ever turned into a command, a path or an argument — a
// request names an action id and that is all. An admin password is already a
// lot of power; it is deliberately NOT a remote shell.
//
// Each run keeps its output (capped) so the page can show it while it runs
// and afterwards. One COMMAND runs at a time — two `npm install`s or a pull
// under a running test would only break each other; the quick in-process
// actions are not queued behind it.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");

const ROOT = config.ROOT;
const WIN = process.platform === "win32";
const MAX_OUTPUT = 200 * 1024;
const KEEP_RUNS = 30;

// npm is a .cmd shim on Windows, which Node will only start through a shell.
// The command line is a constant from this file, never built from input.
const npm = (...args) => (WIN ? { cmd: `npm ${args.join(" ")}`, args: [], shell: true } : { cmd: "npm", args });
const node = (...args) => ({ cmd: process.execPath, args });
const git = (...args) => ({ cmd: "git", args });
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const runs = []; // newest last: { id, action, title, startedAt, endedAt, status, output, code }
let seq = 0;
let busy = null; // the command run in flight, if any

const newRun = (a) => {
  const run = { id: `${Date.now().toString(36)}-${++seq}`, action: a.id, title: a.title, startedAt: Date.now(), endedAt: null, status: "running", output: "", code: null };
  runs.push(run);
  while (runs.length > KEEP_RUNS) runs.shift();
  return run;
};
const append = (run, text) => {
  if (!text) return;
  run.output += String(text);
  if (run.output.length > MAX_OUTPUT) run.output = "… (earlier output dropped)\n" + run.output.slice(-MAX_OUTPUT + 2000);
};
const finish = (run, ok, code = null) => {
  run.endedAt = Date.now();
  run.status = ok ? "ok" : "failed";
  run.code = code;
};

// One fixed command, its output streamed into the run. Resolves true/false.
const exec = (run, spec, { timeoutMs = 10 * 60000, env } = {}) =>
  new Promise((resolve) => {
    append(run, `$ ${[path.basename(spec.cmd), ...spec.args].join(" ")}\n`);
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { cwd: ROOT, env: env || process.env, shell: !!spec.shell, windowsHide: true });
    } catch (e) {
      append(run, `could not start: ${e.message}\n`);
      return resolve(false);
    }
    const timer = setTimeout(() => {
      append(run, `\n(stopped: still running after ${Math.round(timeoutMs / 60000)} minutes)\n`);
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => append(run, d));
    child.stderr.on("data", (d) => append(run, d));
    child.on("error", (e) => {
      clearTimeout(timer);
      append(run, `could not start: ${e.message}\n`);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      run.code = code;
      resolve(code === 0);
    });
  });

// Empty a cache folder of FILES (one level of sub-folders too). Returns [files, bytes].
const emptyDir = (dir) => {
  let n = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2) walk(p, depth + 1);
        continue;
      }
      try {
        bytes += fs.statSync(p).size;
        fs.unlinkSync(p);
        n++;
      } catch {}
    }
  };
  walk(dir, 0);
  return [n, bytes];
};
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

const restartSoon = () => {
  setTimeout(() => {
    try { require("./jsonstore").flushAll(); } catch {}
    process.exit(0);
  }, 600);
};

// ---------------------------------------------------------------- the list
// kind "command": `steps` — fixed commands, run in order, stopping at the
//                 first that fails.
// kind "task":    `run(log)` — in-process; returns a sentence or throws.
// `confirm` is the question the page asks first; `danger` paints the button.
const ACTIONS = [
  // ---- update ----
  {
    id: "update-all", group: "Update", title: "Update and restart",
    about: "Pull the new version from GitHub, install dependencies if they changed, then restart. The page reconnects by itself.",
    confirm: "Pull the latest version and restart Aurora? Anyone watching is interrupted for a few seconds.",
    kind: "task", exclusive: true,
    run: async (log, run) => {
      const before = await capture(git("rev-parse", "HEAD"));
      if (!(await exec(run, git("pull", "--ff-only", "origin", "master"), { timeoutMs: 120000, env: GIT_ENV }))) throw new Error("git pull failed — nothing was restarted");
      const after = await capture(git("rev-parse", "HEAD"));
      if (before && before === after) return "Already up to date — not restarted.";
      const changed = await capture(git("diff", "--name-only", before, after));
      if (/^package(-lock)?\.json$/m.test(changed)) {
        log("\nDependencies changed:\n");
        if (!(await exec(run, npm("install", "--omit=dev", "--no-audit", "--no-fund"), { timeoutMs: 15 * 60000 }))) throw new Error("npm install failed — not restarted; the old code is still running");
      } else log("\nDependencies unchanged — npm install skipped.\n");
      restartSoon();
      return "Updated. Restarting now…";
    },
  },
  {
    id: "git-status", group: "Update", title: "What version is this?",
    about: "The commit the server's folder is on, the last five commits, and any file changed by hand.",
    kind: "command", steps: [git("log", "-5", "--pretty=format:%h %ad %s", "--date=short"), git("status", "--short", "--branch")],
  },
  {
    id: "git-pull", group: "Update", title: "Pull from GitHub",
    about: "Fetch the new code only (fast-forward). Nothing changes until a restart.",
    kind: "command", steps: [git("pull", "--ff-only", "origin", "master")], env: GIT_ENV, timeoutMs: 120000,
  },
  {
    id: "npm-install", group: "Update", title: "Install dependencies (npm install)",
    about: "Needed after an update that changed package.json. Skips developer-only packages.",
    kind: "command", steps: [npm("install", "--omit=dev", "--no-audit", "--no-fund")], timeoutMs: 15 * 60000,
  },
  {
    id: "restart", group: "Update", title: "Restart Aurora",
    about: "Save everything and exit; pm2 starts it again on the current code. Outside pm2 this only stops the server.",
    confirm: "Restart Aurora now? Anyone watching is interrupted for a few seconds.",
    danger: true, kind: "task",
    run: async () => {
      restartSoon();
      return "Restarting…";
    },
  },

  // ---- checks ----
  {
    id: "self-test", group: "Checks", title: "Run the test suite (npm test)",
    about: "Every unit test, about a minute. Read-only: it does not touch the library or anyone's progress.",
    kind: "command", steps: [node("--test", "--test-reporter=spec", "test/*.test.js")], timeoutMs: 10 * 60000,
  },
  {
    id: "stream-test", group: "Checks", title: "Test streaming on this machine",
    about: "The transcoder's and the quality ladder's tests against this machine's ffmpeg — run it after moving to a new host or updating ffmpeg.",
    kind: "command", steps: [node("--test", "--test-reporter=spec", "test/jit.test.js", "test/jit-exact.test.js", "test/ladder.test.js")], timeoutMs: 5 * 60000,
  },
  {
    id: "versions", group: "Checks", title: "Tool versions",
    about: "Node, npm, git and ffmpeg as this server sees them.",
    kind: "task",
    run: async (log, run) => {
      log(`node ${process.version}  (${process.platform} ${process.arch})\n`);
      await exec(run, npm("--version"), { timeoutMs: 30000 });
      await exec(run, git("--version"), { timeoutMs: 30000 });
      if (config.FFMPEG) await exec(run, { cmd: config.FFMPEG, args: ["-hide_banner", "-version"] }, { timeoutMs: 30000 });
      else log("ffmpeg: NOT FOUND — nothing can be transcoded\n");
      return "Done.";
    },
  },
  {
    id: "health-run", group: "Checks", title: "Run the health checks now",
    about: "Disk space, ffmpeg, the download engine, backups, restarts — the same round that raises alerts.",
    kind: "task",
    run: async (log) => {
      const health = require("./health");
      await health.run();
      const s = health.status();
      for (const c of s.checks || []) log(`${String(c.level || "ok").toUpperCase().padEnd(8)} ${c.name || c.id}: ${c.message || ""}\n`);
      return "Checked.";
    },
  },
  {
    id: "healer-run", group: "Checks", title: "Run the healer now",
    about: "The once-a-minute round that fixes what it safely can: stalled downloads, temp files, encode slots.",
    kind: "task",
    run: async (log) => {
      const healer = require("./healer");
      await healer.run();
      const last = healer.status().last || {};
      for (const c of last.checks || []) log(`${String(c.status || "ok").toUpperCase().padEnd(8)} ${c.name || c.id}: ${c.summary || ""}
`);
      return "Round finished.";
    },
  },
  {
    id: "notify-test", group: "Checks", title: "Send a test alert",
    about: "A message through ntfy and/or Telegram, to prove alerts reach your phone.",
    kind: "task",
    run: async () => {
      const notify = require("./notify");
      const ch = notify.channels();
      if (!ch.length) throw new Error('No alert channel is set up. Add "notifications" (ntfy or Telegram) to config.json.');
      notify.send("Aurora test alert", "This is a test from the admin page. Alerts are reaching you.");
      return `Sent through ${ch.join(" and ")}. If nothing arrives within a minute, check the Logs tab for "[notify]".`;
    },
  },

  // ---- library and data ----
  {
    id: "backup-now", group: "Library and data", title: "Back up now",
    about: "Write a snapshot of profiles, progress, settings and configuration, and apply the keep rules.",
    kind: "task",
    run: async (log) => {
      const backup = require("./backup");
      const made = await backup.createNow({ prune: true });
      const s = await backup.status();
      log(`folder: ${s.dir || config.BACKUP_DIR}\n`);
      if (s.sameDiskAsData && s.advice) log(`NOTE: ${s.advice}\n`);
      return `Made ${(made && (made.name || (made.file && path.basename(made.file)))) || "a snapshot"}.`;
    },
  },
  {
    id: "backup-verify", group: "Library and data", title: "Verify the backups",
    about: "Open every snapshot and check each file inside against its checksum.",
    kind: "task",
    run: async (log) => {
      const list = await require("./backup").listVerified();
      if (!list.length) throw new Error("There are no backups yet.");
      let bad = 0;
      for (const b of list) {
        if (!b.verified) bad++;
        log(`${b.verified ? "OK    " : "BROKEN"} ${b.name}  ${mb(b.size || 0)}${b.verified ? `  ${b.files || 0} files` : `  — ${b.error || "failed its check"}`}\n`);
      }
      if (bad) throw new Error(`${bad} of ${list.length} snapshots failed their check.`);
      return `All ${list.length} snapshots are intact.`;
    },
  },
  {
    id: "rescan", group: "Library and data", title: "Rescan the library",
    about: "Look at the library folders again — for files added, moved or removed by hand.",
    kind: "task",
    run: async () => {
      const scanner = require("../media/scanner");
      scanner.scan();
      scanner.enrich();
      require("../realtime").broadcastAll({ type: "library_updated" });
      return `Scanned. ${((scanner.index && scanner.index.items) || []).length || ""} items in the library.`.replace("  ", " ");
    },
  },
  {
    id: "daily-now", group: "Library and data", title: "Run the daily refresh now",
    about: "The once-a-day round: library metadata, skip-intro timestamps, the backup — without waiting for tonight.",
    kind: "task",
    run: async () => {
      await require("./daily").tick(true);
      return "The daily round ran.";
    },
  },
  {
    id: "ratings-refresh", group: "Library and data", title: "Refresh age ratings",
    about: "Ask again for the age rating of every title — what kids profiles are filtered by. Needs a TMDB key.",
    kind: "task",
    run: async () => {
      require("../media/discover").refreshCertificates();
      return "Started in the background; ratings fill in over the next minutes.";
    },
  },
  {
    id: "subs-backfill-dry", group: "Library and data", title: "Missing subtitles: what would be fetched",
    about: "A dry run of the subtitle backfill: lists the library titles with no Hebrew or English subtitles. Changes nothing.",
    kind: "command", steps: [node("tools/backfill-subtitles.js", "--dry-run")], timeoutMs: 20 * 60000,
  },
  {
    id: "subs-backfill", group: "Library and data", title: "Fetch missing subtitles",
    about: "Download Hebrew and English subtitles for library titles that have none, as a download would have. Can take a long while on a big library.",
    confirm: "Fetch subtitles for every library title that has none? This can run for many minutes.",
    kind: "command", steps: [node("tools/backfill-subtitles.js")], timeoutMs: 60 * 60000,
  },

  // ---- caches ----
  {
    id: "clear-meta", group: "Caches", title: "Clear metadata and subtitle caches",
    about: "Forget stored title details and converted subtitles; they rebuild on demand (first loads are slower).",
    kind: "task",
    run: async () => {
      require("../media/metadata").clearCache();
      require("../media/subtitles").clearCache();
      return "Cleared.";
    },
  },
  {
    id: "clear-images", group: "Caches", title: "Clear resized pictures",
    about: "Delete the resized posters, blur previews and resume frames. Originals are untouched; they are remade as pages ask for them.",
    kind: "task",
    run: async (log) => {
      let files = 0;
      let bytes = 0;
      for (const d of ["blur", "img-variants", "stills"]) {
        const [n, b] = emptyDir(path.join(config.CACHE_DIR, d));
        log(`${d}: ${n} files, ${mb(b)}\n`);
        files += n;
        bytes += b;
      }
      return `Removed ${files} files, ${mb(bytes)}.`;
    },
  },
  {
    id: "sweep-streams", group: "Caches", title: "Tidy stream leftovers",
    about: "Stop transcodes nobody is watching and delete their temporary segments. Streams in use are left alone.",
    kind: "task",
    run: async (log) => {
      for (const [name, mod] of [["library streams", "../media/remux"], ["torrent streams", "../media/torrent-transcode"]]) {
        try {
          const m = require(mod);
          if (typeof m.sweepIdle === "function") m.sweepIdle();
          if (typeof m.sweepStale === "function") await m.sweepStale();
          log(`${name}: swept\n`);
        } catch (e) {
          log(`${name}: ${e.message}\n`);
        }
      }
      try {
        const r = require("./watchdog").softHeal("asked from the admin page");
        if (r) log(`${Array.isArray(r) ? r.join(", ") : r}\n`);
      } catch {}
      return "Tidied.";
    },
  },
  {
    id: "jit-forget", group: "Caches", title: "Retry files marked unplayable on the fast path",
    about: "A damaged file is remembered and sent down the slower stream. This forgets the list, so each is tried again — use after replacing a file.",
    kind: "task",
    run: async () => {
      const f = path.join(config.CACHE_DIR, "jit-declined.json");
      let n = 0;
      try { n = Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).keys || {}).length; } catch {}
      try { fs.unlinkSync(f); } catch {}
      try { require("../media/jit")._internals.setDeclinedFile(f); } catch {}
      return n ? `Forgot ${n} entr${n === 1 ? "y" : "ies"}.` : "The list was already empty.";
    },
  },

  // ---- repair ----
  {
    id: "patch-webtorrent", group: "Repair", title: "Re-apply the download engine patch",
    about: "The small fix Aurora applies to its torrent library after every install. Harmless to run again.",
    kind: "command", steps: [node("tools/patch-webtorrent.js")], timeoutMs: 60000,
  },
];

// A command's whole output as a string ("" on failure) — for the composite task.
const capture = (spec) =>
  new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { cwd: ROOT, env: GIT_ENV, shell: !!spec.shell, windowsHide: true });
    } catch {
      return resolve("");
    }
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });

const byId = new Map(ACTIONS.map((a) => [a.id, a]));
const isExclusive = (a) => a.kind === "command" || !!a.exclusive;

const publicAction = (a) => ({
  id: a.id, group: a.group, title: a.title, about: a.about,
  confirm: a.confirm || null, danger: !!a.danger, long: isExclusive(a),
  // what it runs, in words a person can check against this file
  runs: a.kind === "command" ? a.steps.map((s) => [path.basename(s.cmd), ...s.args].join(" ")) : null,
});
const publicRun = (r, full) => ({
  id: r.id, action: r.action, title: r.title, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, code: r.code,
  output: full ? r.output : r.output.slice(-600),
});

const list = () => ({
  actions: ACTIONS.map(publicAction),
  busy: busy ? busy.id : null,
  runs: runs.slice(-12).reverse().map((r) => publicRun(r, false)),
});
const getRun = (id) => {
  const r = runs.find((x) => x.id === id);
  return r ? publicRun(r, true) : null;
};

// Start an action by id. Returns { run } at once; the work carries on.
const start = (id) => {
  const a = byId.get(String(id));
  if (!a) return { status: 404, error: "No such action." };
  if (isExclusive(a) && busy) return { status: 409, error: `"${busy.title}" is still running — wait for it to finish.`, run: publicRun(busy, false) };
  const run = newRun(a);
  if (isExclusive(a)) busy = run;
  const done = (ok) => {
    if (busy === run) busy = null;
    finish(run, ok, run.code);
  };
  (async () => {
    try {
      if (a.kind === "command") {
        let ok = true;
        for (const step of a.steps) {
          ok = await exec(run, step, { timeoutMs: a.timeoutMs, env: a.env });
          if (!ok) break;
          append(run, "\n");
        }
        append(run, ok ? "Finished.\n" : `Failed${run.code != null ? ` (exit code ${run.code})` : ""}.\n`);
        return done(ok);
      }
      const said = await a.run((t) => append(run, t), run);
      if (said) append(run, `${run.output && !run.output.endsWith("\n") ? "\n" : ""}${said}\n`);
      done(true);
    } catch (e) {
      append(run, `${run.output && !run.output.endsWith("\n") ? "\n" : ""}${(e && e.message) || e}\n`);
      done(false);
    }
  })();
  return { run: publicRun(run, false) };
};

module.exports = { list, start, getRun, _internals: { ACTIONS, emptyDir, runs, exec, isExclusive } };
