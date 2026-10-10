// Who brings the server back when it stops — and how the server talks to it.
//
// The server is one process. Three things can restart it:
//
//   the keeper   scripts/keeper.js (src/lib/keeper.js): Aurora's own small
//                supervisor. It starts server.js as a child, restarts it when
//                it dies or hangs, backs off when it keeps dying, and writes
//                what happened to data/keeper-state.json. A Scheduled Task
//                (Windows) or a systemd unit (Linux) starts the keeper at
//                boot — docs/operations.md has the steps.
//   pm2          the older arrangement (ecosystem.config.js). Still works.
//   systemd      running `node server.js` straight from a unit with Restart=.
//
// Bare `node server.js` is NOT supervised: a crash or a hang then lasts until
// somebody notices. Everything that used to say "under pm2" asks info() here.
//
// THE EXIT CODES are the contract between the server and its supervisor:
//
//   0   stopped on request (a signal, the keeper asking)
//   1   fatal (could not bind its port, …)            → a crash: back-off
//   3   the watchdog restarting itself (memory, lag)   → restart at once, counted
//   75  "restart me now" (the admin's Restart button,  → restart at once, never
//       Update and restart)                              counted as a crash
//
// pm2 and systemd restart on any of them; the keeper reads them (keeper.js
// classify()).
"use strict";
const fs = require("fs");
const path = require("path");

const EXIT = { OK: 0, FATAL: 1, HEAL: 3, RESTART: 75 };
const DAY = 24 * 3600 * 1000;

// What is supervising THIS process, from its environment alone:
//   AURORA_SUPERVISOR=keeper   set by the keeper on its child
//   pm_id / PM2_HOME           pm2
//   INVOCATION_ID              a systemd unit running the server itself
//   AURORA_SUPERVISED=1        "something restarts me" said by hand (Docker's
//                              restart policy, NSSM, a loop of one's own)
const detect = (env = process.env) => {
  if (env.AURORA_SUPERVISOR === "keeper") return "keeper";
  if (env.pm_id || env.PM2_HOME) return "pm2";
  if (env.INVOCATION_ID) return "systemd";
  if (/^(1|true|yes)$/i.test(String(env.AURORA_SUPERVISED || ""))) return "external";
  return null;
};

const stateFile = (env = process.env) => {
  if (env.AURORA_KEEPER_STATE) return env.AURORA_KEEPER_STATE;
  try { return path.join(require("../config").DATA_DIR, "keeper-state.json"); } catch { return null; }
};

// The keeper's own record (it rewrites the file on every event). Null when
// there is none or it cannot be read — never a throw.
const readState = (file = stateFile()) => {
  if (!file) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
};

const HOSTS = { systemd: "systemd", task: "a Scheduled Task", manual: "started by hand" };
const WORDS = {
  keeper: "Aurora's keeper",
  pm2: "pm2",
  systemd: "systemd",
  external: "an outside supervisor (AURORA_SUPERVISED)",
};

// One sentence for a recorded exit: { reason, code, signal, at, uptimeSec }.
const exitSentence = (x) => {
  if (!x) return null;
  const why = {
    crash: `crashed${x.code != null ? ` (exit code ${x.code})` : x.signal ? ` (${x.signal})` : ""}`,
    hang: "stopped answering and was killed",
    "never-up": "never finished starting and was killed",
    restart: "restarted on request",
    heal: "restarted itself (memory or a stuck loop)",
    exited: "stopped by itself (exit code 0)",
    stopped: "was stopped",
  }[x.reason] || String(x.reason || "stopped");
  return why;
};

// For the admin page and /api/admin/health: is it supervised, by what, for
// how long, how many restarts in the last day, and why the last one.
const info = (o = {}) => {
  const env = o.env || process.env;
  const now = o.now || Date.now();
  const by = detect(env);
  const out = {
    supervised: !!by,
    by,
    byWords: by ? WORDS[by] : "nothing — a crash or a hang lasts until somebody starts it again",
    host: null,
    survivesReboot: by === "pm2" || by === "external" ? null : by === "systemd",
    uptimeSec: Math.floor(process.uptime()),
    restartsLastDay: null,
    crashesLastDay: null,
    lastExit: null,
    lastExitWords: null,
    state: null, // "ok" | "backing-off" | "parked" (the keeper's own view)
    keeperPid: null,
    keeperSince: null,
  };
  if (by === "keeper") {
    const s = o.state !== undefined ? o.state : readState(stateFile(env));
    if (s) {
      const exits = Array.isArray(s.exits) ? s.exits : [];
      const day = exits.filter((x) => x && now - x.at < DAY);
      out.host = s.host || "manual";
      out.survivesReboot = s.host === "systemd" || s.host === "task";
      out.byWords = `${WORDS.keeper} (${HOSTS[out.host] || out.host})`;
      out.restartsLastDay = day.filter((x) => x.reason !== "stopped").length;
      out.crashesLastDay = day.filter((x) => x.reason === "crash" || x.reason === "hang" || x.reason === "never-up").length;
      out.lastExit = exits.length ? exits[exits.length - 1] : null;
      out.lastExitWords = exitSentence(out.lastExit);
      out.state = s.state || "ok";
      out.keeperPid = s.keeperPid || null;
      out.keeperSince = s.keeperSince || null;
    }
  } else if (by && Array.isArray(o.boots)) {
    // pm2 / systemd keep their own books; the nearest thing here is how many
    // times this server has started (lib/health.js counts every boot).
    out.restartsLastDay = Math.max(0, o.boots.filter((b) => now - b < DAY).length - 1);
  }
  return out;
};

const NOT_SUPERVISED =
  "Aurora is not running under a supervisor, so nothing would start it again. Nothing was stopped. " +
  "Start it through the keeper (start-aurora.cmd, or the steps in docs/operations.md) and this button restarts it; until then restart it by hand.";

// "Restart now": a clean shutdown, then exit with the code the supervisor
// reads as "start me again at once". Refused — plainly — when nothing would
// bring the server back. `deps` is for tests.
const requestRestart = (reason, deps = {}) => {
  const by = detect(deps.env || process.env);
  if (!by) return { ok: false, error: NOT_SUPERVISED };
  const shutdown = deps.shutdown || require("./shutdown");
  shutdown.run({ reason: reason || "restart requested", code: EXIT.RESTART, notice: "restart" });
  return { ok: true, by };
};

// Tell the keeper something over the channel it opened (a no-op elsewhere).
const tell = (msg) => {
  try {
    if (typeof process.send === "function" && process.connected) process.send(msg);
  } catch {}
};

module.exports = { EXIT, detect, info, readState, stateFile, requestRestart, tell, exitSentence, NOT_SUPERVISED };
