// Stopping well, so that a restart is cheap and safe.
//
// On SIGTERM / SIGINT (and, on Windows, CTRL-BREAK, a closing console, or the
// keeper asking over its channel — Windows has no SIGTERM to catch) the
// server:
//
//   1. flushes every JSON store with a pending write (first, so it is done
//      whatever happens next),
//   2. tells every WebSocket client "restarting — come back in a moment" and
//      closes the sockets with code 1012 (service restart): the clients
//      reconnect with a random delay instead of all at once,
//   3. stops accepting connections and lets the answers in flight finish,
//      for a few seconds at most (a film being streamed cannot "finish"; its
//      player asks again with a Range and carries on),
//   4. runs the registered hooks (the download engine's tidy stop, …) and
//      ends the helper processes it owns (ffmpeg, OCR): none is left behind,
//   5. flushes the stores again, for anything saved meanwhile, and exits with
//      the code its supervisor reads (lib/supervisor.js EXIT).
//
// A hard deadline stands over all of it: whatever is stuck, the process is
// gone within HARD_MS, stores flushed. A second signal skips the waiting.
//
// Nothing here runs at require time. server.js calls install({ server }).
"use strict";

const GRACE_MS = 4000; // answers in flight get this long
const HARD_MS = 9000; // and the whole sequence this long
const state = {
  installed: false,
  stopping: false,
  reason: null,
  startedAt: 0,
  server: null,
  hooks: [], // [{ name, fn }]
  steps: [], // what was done, for the log and the tests
};

const stopping = () => state.stopping;

// Something to do while stopping: fn() may return a promise; it gets the
// grace period, never more. Returns an "unregister".
const register = (name, fn) => {
  const h = { name, fn };
  state.hooks.push(h);
  return () => { state.hooks = state.hooks.filter((x) => x !== h); };
};

const NOTICE = {
  restart: "Aurora is restarting — back in a few seconds.",
  stop: "Aurora is shutting down.",
};

// The sequence. Everything it touches can be handed in (tests do); by default
// it reaches for the real modules. Resolves just before exit() is called.
const run = async (o = {}) => {
  const d = o.deps || {};
  const log = d.log || ((m) => console.log(`[shutdown] ${m}`));
  const exit = d.exit || ((code) => process.exit(code));
  const flush = d.flushAll || (() => { try { require("./jsonstore").flushAll(); } catch (e) { log(`stores: ${e.message}`); } });
  const code = Number.isInteger(o.code) ? o.code : 0;
  if (state.stopping) {
    // asked twice: stop waiting
    if (o.force) { flush(); exit(code); }
    return;
  }
  state.stopping = true;
  state.reason = o.reason || "stop";
  state.startedAt = Date.now();
  state.steps = [];
  const did = (s) => { state.steps.push(s); };
  const graceMs = o.graceMs == null ? GRACE_MS : o.graceMs;
  const hardMs = o.hardMs == null ? HARD_MS : o.hardMs;
  log(`${state.reason} — stopping (exit code ${code})`);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(hard);
    try { flush(); did("flush-last"); } catch {}
    log(`stopped in ${Date.now() - state.startedAt} ms`);
    exit(code);
  };
  const hard = setTimeout(() => { log(`still busy after ${hardMs} ms — leaving anyway`); finish(); }, hardMs);

  // 1. what must not be lost
  try { flush(); did("flush-first"); } catch {}

  // 2. the sockets
  try {
    const realtime = d.realtime || require("../realtime");
    const kind = o.notice === "restart" || code !== 0 ? "restart" : "stop";
    const n = realtime.closeAll({ type: "server_restarting", restart: kind === "restart", message: NOTICE[kind], retryInMs: 2000 }, 1012);
    did("sockets");
    if (n) log(`${n} live connection${n === 1 ? "" : "s"} told to come back`);
  } catch (e) {
    log(`sockets: ${e.message}`);
  }

  // 3. no new connections; answers in flight may finish
  const server = d.server !== undefined ? d.server : state.server;
  const closed = new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    try {
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    } catch {
      resolve();
    }
  });
  did("listener");

  // 4. hooks, alongside the wait for the answers
  const hooks = Promise.all(
    state.hooks.map(async (h) => {
      try { await h.fn({ reason: state.reason, code }); did(`hook:${h.name}`); } catch (e) { log(`${h.name}: ${(e && e.message) || e}`); }
    }),
  );
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([Promise.all([closed, hooks]), wait(graceMs)]);
  try {
    if (server && typeof server.closeAllConnections === "function") server.closeAllConnections();
  } catch {}
  did("connections");

  try {
    const children = d.children || require("./children");
    const n = children.killAll();
    did("children");
    if (n) log(`${n} helper process${n === 1 ? "" : "es"} ended`);
  } catch (e) {
    log(`children: ${e.message}`);
  }

  // 5. out
  finish();
};

// Wire the signals. `server` is the http.Server. Idempotent.
const install = ({ server } = {}) => {
  if (server) state.server = server;
  if (state.installed) return;
  state.installed = true;
  // the stores' own "flush and exit at once" handlers stand down: this
  // sequence flushes them, twice
  try { require("./jsonstore").ownSignals(false); } catch {}
  let asked = 0;
  const onSignal = (sig) => () => {
    asked++;
    run({ reason: `received ${sig}`, code: 0, force: asked > 1 }).catch(() => process.exit(0));
  };
  // SIGHUP on Windows is "the console window is closing" (about 10 s are
  // left); SIGBREAK is CTRL-BREAK. Neither exists as a real signal there.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, onSignal(sig)); } catch {}
  }
  // The keeper's channel: its "stop" (Windows cannot deliver SIGTERM to a
  // child), and its going away — a server whose keeper died stops too, so
  // that whatever restarts the keeper finds the port free.
  if (typeof process.send === "function") {
    process.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "shutdown") run({ reason: `the keeper asked (${String(m.reason || "stop").slice(0, 80)})`, code: 0 }).catch(() => process.exit(0));
    });
    process.on("disconnect", () => {
      run({ reason: "the keeper went away", code: 0 }).catch(() => process.exit(0));
    });
  }
};

// Express middleware: while stopping, answers say "this connection is over"
// so a keep-alive client opens its next one against the new process.
const middleware = (req, res, next) => {
  if (state.stopping) res.setHeader("Connection", "close");
  next();
};

const _reset = () => {
  state.stopping = false;
  state.reason = null;
  state.hooks = [];
  state.steps = [];
  state.server = null;
};

module.exports = { install, run, register, stopping, middleware, GRACE_MS, HARD_MS, _internals: { state, _reset } };
