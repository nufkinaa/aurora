#!/usr/bin/env node
// Run Aurora under its keeper:  node scripts/keeper.js
//
// The keeper starts server.js, restarts it when it crashes or hangs, backs
// off when it keeps crashing, and keeps the log (src/lib/keeper.js has the
// whole story; docs/operations.md the install steps for Windows and Linux).
//
//   --host task|systemd|manual   who started the keeper (shown on the admin
//                                page; the install scripts pass it)
//   --quiet                      do not echo the server's output (the log
//                                files in data/ still get everything)
//   --script <file>              run this instead of server.js   } for the
//   --data <dir>                 state + log files go here        } tests
//   --node-arg <arg>             an argument for node itself (repeatable) } for the tests
//   --no-alert                   never send a notification
//   --set key=ms                 override one timing (keeper.js DEFAULTS)
//   --status                     print what the running keeper last wrote, and exit
//   --stop                       ask the running keeper to stop Aurora cleanly, and exit
//   --restart                    ask the running keeper to restart the server cleanly
//
// Stop Aurora by stopping the keeper: CTRL-C here, "End" on the Scheduled
// Task, or `systemctl stop aurora`. The server is asked to stop cleanly
// first (stores saved, viewers told) and ended if it does not.
"use strict";
const fs = require("fs");
const path = require("path");
const { Keeper, DEFAULTS, reapOrphan } = require("../src/lib/keeper");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(`--${name}`);

// An argument this script does not know must never start a second Aurora:
// `keeper.js --help` once did exactly that, beside the running server, and
// its crash loop raised a real alert. Unknown: say what exists, and leave.
{
  const VALUE = new Set(["--host", "--script", "--data", "--node-arg", "--set"]);
  const BARE = new Set(["--quiet", "--no-alert", "--status", "--stop", "--restart"]);
  for (let i = 0; i < argv.length; i++) {
    if (VALUE.has(argv[i])) { i++; continue; }
    if (BARE.has(argv[i])) continue;
    const asked = argv[i] === "--help" || argv[i] === "-h";
    const text = fs.readFileSync(__filename, "utf8").split(/\r?\n/).slice(1, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
    if (asked) console.log(text);
    else console.error("keeper: unknown argument " + argv[i] + "\n\n" + text);
    process.exit(asked ? 0 : 2);
  }
}

const script = path.resolve(opt("script") || path.join(ROOT, "server.js"));
const cwd = opt("script") ? path.dirname(script) : ROOT;
const dataDir = path.resolve(opt("data") || path.join(cwd, "data"));
const stateFile = path.join(dataDir, "keeper-state.json");

if (flag("status")) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const last = (s.exits || []).slice(-5).map((x) => `  ${new Date(x.at).toISOString()}  ${x.reason}${x.code != null ? ` (code ${x.code})` : ""} after ${x.uptimeSec} s`);
    console.log(`keeper pid ${s.keeperPid} (${s.host}), state: ${s.state}, server pid ${s.childPid || "—"}, port ${s.port || "—"}, starts ${s.starts}`);
    console.log(last.length ? `last exits:\n${last.join("\n")}` : "no exits recorded");
  } catch {
    console.log("no keeper has run here yet (data/keeper-state.json is missing)");
  }
  process.exit(0);
}

// --stop / --restart: a note left for the running keeper, which looks for it
// every two seconds (Windows has no signal one process can send another).
const controlFile = path.join(dataDir, "keeper-control.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
const ask = async (cmd) => {
  const { pidAlive } = require("../src/lib/keeper");
  const before = readState();
  if (!before || !before.keeperPid || !pidAlive(before.keeperPid)) {
    console.log("no keeper is running here");
    return 1;
  }
  fs.writeFileSync(controlFile, JSON.stringify({ cmd, at: Date.now() }));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 500));
    const s = readState();
    if (cmd === "stop" && (!pidAlive(before.keeperPid) || (s && s.state === "stopped"))) { console.log("Aurora has stopped."); return 0; }
    if (cmd === "restart" && s && s.childPid && s.childPid !== before.childPid) { console.log(`Aurora was restarted (server pid ${s.childPid}).`); return 0; }
  }
  console.log(`the keeper (pid ${before.keeperPid}) did not ${cmd} within 30 s`);
  return 1;
};
if (flag("stop") || flag("restart")) {
  ask(flag("stop") ? "stop" : "restart").then((code) => process.exit(code));
  return;
}

const cfg = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue;
  const m = /^([A-Za-z]+)=(\d+)$/.exec(argv[i + 1] || "");
  if (m && m[1] in DEFAULTS) cfg[m[1]] = Number(m[2]);
}

// A notification when the keeper gives up, through the server's own channels
// (ntfy / Telegram in config.json). Loaded only at that moment and fenced: a
// broken config must not take the keeper down with the server.
const alert = flag("no-alert")
  ? null
  : (title, message) => {
      try {
        const notify = require("../src/lib/notify");
        if (notify.channels().length) notify.send(title, message, { priority: "urgent", tags: "rotating_light" });
      } catch {}
    };

(async () => {
  const k = new Keeper({ script, cwd, dataDir, stateFile, host: opt("host") || undefined, quiet: flag("quiet"), cfg, deps: { alert } });
  k.nodeArgs = argv.map((a, i) => (argv[i - 1] === "--node-arg" ? a : null)).filter((a) => a !== null);
  k._openLogs();

  const found = await reapOrphan(stateFile, { script }).catch(() => null);
  if (found && found.other) {
    k.log(`another keeper is already running here (pid ${found.other}) — this one is leaving`);
    process.exit(0);
  }
  if (found && found.reaped) k.log(`ended a server left behind by an earlier keeper (pid ${found.reaped})`);

  let stopping = false;
  const stop = (why) => async () => {
    if (stopping) return;
    stopping = true;
    await k.stop(why);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, stop(`received ${sig}`)); } catch {}
  }
  // the keeper itself must not die of a stray error: it is the last line
  process.on("uncaughtException", (e) => k.log(`keeper error (carrying on): ${(e && e.stack) || e}`));
  process.on("unhandledRejection", (e) => k.log(`keeper error (carrying on): ${(e && e.message) || e}`));

  try { fs.rmSync(controlFile, { force: true }); } catch {}
  const control = setInterval(() => {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(controlFile, "utf8")); } catch { return; }
    try { fs.rmSync(controlFile, { force: true }); } catch {}
    if (!c || !(c.at >= k.keeperSince)) return;
    if (c.cmd === "stop") stop("asked to stop (keeper.js --stop)")();
    else if (c.cmd === "restart") k.restartChild("asked to restart (keeper.js --restart)");
  }, 2000);
  control.unref?.();

  k.log(`keeping ${path.basename(script)} alive (keeper pid ${process.pid}, ${k.host}); logs in ${dataDir}`);
  k.start();
})();
