// The keeper: a small supervisor for the one server process.
//
//   node scripts/keeper.js            (what start-aurora.cmd, the Scheduled
//                                      Task and the systemd unit all run)
//
// It starts server.js as a child and then does four things, on Windows and
// on Linux alike, with nothing installed beyond Node:
//
//   RESTARTS IT WHEN IT DIES. What the exit meant is read from its code
//   (lib/supervisor.js EXIT): 75 "restart me now" and 3 "the watchdog is
//   restarting me" come straight back; anything else is a crash.
//
//   RESTARTS IT WHEN IT HANGS. Every `probeEveryMs` it asks the server's own
//   GET /healthz (a request that needs no work). No answer within
//   `probeTimeoutMs`, or an answer saying the event loop has been blocked for
//   more than `maxLoopDelayMs`, is a failed probe; `probeFailures` in a row
//   and the server is killed (with its ffmpeg children) and started again. A
//   server that never says "listening" within `bootGraceMs` is treated the
//   same way.
//
//   DOES NOT LOOP. A crash is followed by a wait that doubles (1 s, 2 s, 4 s
//   … up to `maxDelayMs`, with jitter); staying up for `stableMs` clears it.
//   `giveUpCrashes` crashes inside `giveUpWindowMs` and the keeper stops
//   trying quickly: it says so ONCE (the log, and ntfy / Telegram when they
//   are set up), then tries again only every `parkedRetryMs` — a house whose
//   disk came back an hour later should not stay dark until someone looks.
//
//   KEEPS THE LOG. The child's output goes on being appended to
//   data/server-stdout.log and data/server-stderr.log (where a redirected
//   `node server.js` has always put it), and is echoed to the keeper's own
//   output for journald or a console. A log that passes `logMaxBytes`
//   (50 MB) is set aside as <name>.1 — at a start, and also WHILE the server
//   runs (a server up for weeks used to grow it without bound) — older ones
//   moving to .2 …; `logKeep` set-aside copies are kept, and they and the
//   live file together never pass `logTotalMaxBytes` (the oldest go first,
//   including an oversized copy left from before the keeper).
//
// What it knows is written to data/keeper-state.json after every event; the
// server reads that file for the admin page (lib/supervisor.js info()).
//
// The class takes everything it touches as a dependency (spawn, probe,
// clock, timers, alert), so its decisions are tested without a process.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const EXIT = { OK: 0, FATAL: 1, HEAL: 3, RESTART: 75 }; // lib/supervisor.js EXIT (not required: the keeper loads nothing of the server's)

const DEFAULTS = {
  baseDelayMs: 1000,
  maxDelayMs: 60 * 1000,
  stableMs: 2 * 60 * 1000, // up this long = the crash streak is over
  giveUpCrashes: 5,
  giveUpWindowMs: 10 * 60 * 1000,
  parkedRetryMs: 15 * 60 * 1000, // 0 = never try again once parked
  probeEveryMs: 10 * 1000,
  probeTimeoutMs: 5 * 1000,
  probeFailures: 6, // in a row: a minute of silence
  maxLoopDelayMs: 5 * 1000, // /healthz says the loop was blocked longer than this
  bootGraceMs: 10 * 60 * 1000, // a first scan of a big library on a sleeping disk
  stopTimeoutMs: 12 * 1000, // a child asked to stop gets this long
  exitsKept: 50,
  logMaxBytes: 50 * 1024 * 1024,
  logKeep: 2, // set-aside copies per log: <name>.1 (newest) … <name>.<logKeep>
  logTotalMaxBytes: 150 * 1024 * 1024, // one log, live file + its copies
};

// What an exit means. { code, signal, killedFor } -> reason:
//   stopped   the keeper asked it to stop
//   hang      the keeper killed it for not answering
//   never-up  the keeper killed it for never finishing its start
//   restart   it asked to be restarted (75)
//   heal      its watchdog restarted it (3)
//   exited    it left with 0 unasked
//   crash     everything else
const classify = ({ code, signal, killedFor }) => {
  if (killedFor === "stop") return "stopped";
  if (killedFor === "hang" || killedFor === "never-up") return killedFor;
  if (killedFor === "asked") return "restart"; // `keeper.js --restart`
  if (code === EXIT.RESTART) return "restart";
  if (code === EXIT.HEAL) return "heal";
  if (code === 0 && !signal) return "exited";
  return "crash";
};
const isCrash = (reason) => reason === "crash" || reason === "hang" || reason === "never-up";

// The wait before the next start, without jitter: 0 for a wanted restart, a
// short breath for a clean exit, base × 2^(streak-1) capped for a crash.
const backoffMs = (reason, streak, cfg = DEFAULTS) => {
  if (reason === "restart" || reason === "heal") return 0;
  if (reason === "exited") return cfg.baseDelayMs;
  const n = Math.max(1, streak);
  return Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** Math.min(n - 1, 20));
};
// Full jitter on the top half: [d/2, d]. Never 0 for a crash.
const jittered = (ms, rnd = Math.random) => (ms <= 0 ? 0 : Math.round(ms / 2 + (ms / 2) * rnd()));

// Too many crashes too fast? `crashTimes` are the times of the recent ones.
const shouldGiveUp = (crashTimes, now, cfg = DEFAULTS) =>
  crashTimes.filter((t) => now - t <= cfg.giveUpWindowMs).length >= cfg.giveUpCrashes;

// One /healthz answer -> is this probe a failure? `res` is null for no
// answer, else { status, body }.
const probeVerdict = (res, cfg = DEFAULTS) => {
  if (!res) return { ok: false, why: "no answer" };
  if (res.body && res.body.stopping) return { ok: true, why: "stopping" };
  if (res.status !== 200) return { ok: false, why: `answered ${res.status}` };
  const loop = res.body && res.body.loop;
  if (loop && Number(loop.maxMs) > cfg.maxLoopDelayMs) return { ok: false, why: `event loop blocked ${Math.round(loop.maxMs)} ms` };
  return { ok: true, why: "ok" };
};

// ---------------------------------------------------------------- real deps

const httpProbe = (port, timeoutMs) =>
  new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs, agent: false, headers: { "User-Agent": "aurora-keeper" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (buf.length < 8192) buf += d; });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(buf); } catch {}
        end({ status: res.statusCode, body });
      });
      res.on("error", () => end(null));
    });
    req.on("timeout", () => { req.destroy(); end(null); });
    req.on("error", () => end(null));
    const t = setTimeout(() => { try { req.destroy(); } catch {} end(null); }, timeoutMs + 500);
    t.unref?.();
  });

// End a process and everything it started. Windows: taskkill /T /F (there
// are no process groups). POSIX: the child leads its own group.
const killTree = (pid) =>
  new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    resolve();
  });

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
};

// The command line of a pid ("" when it cannot be read). Before a leftover
// server from a keeper that was killed is ended, the pid is checked to still
// be that server — pids are reused.
const cmdlineOf = (pid) =>
  new Promise((resolve) => {
    if (!pidAlive(pid)) return resolve("");
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
        { windowsHide: true, timeout: 15000 },
        (err, out) => resolve(err ? "" : String(out).trim()),
      );
      return;
    }
    fs.readFile(`/proc/${pid}/cmdline`, "utf8", (err, s) => resolve(err ? "" : s.split("\0").join(" ").trim()));
  });

// Temp file, then rename over the target. On Windows a rename is refused
// (EPERM / EBUSY / EACCES) for the instant another process has the target
// open — the server reading this very file, a virus scanner — so it is tried
// again a few times; the state must not be lost to that.
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const writeJsonAtomic = (file, obj) => {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
  for (let i = 0; i < 12; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      if (!e || !/^(EPERM|EBUSY|EACCES)$/.test(e.code || "")) break;
      sleepSync(15 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  return false;
};

// ------------------------------------------------------------------ Keeper

class Keeper {
  // o: { script, cwd, dataDir, args, env, host, quiet, cfg, deps }
  constructor(o = {}) {
    this.cfg = { ...DEFAULTS, ...(o.cfg || {}) };
    this.script = o.script;
    this.cwd = o.cwd || (o.script ? path.dirname(o.script) : process.cwd());
    this.dataDir = o.dataDir || path.join(this.cwd, "data");
    this.args = o.args || [];
    this.env = o.env || process.env;
    this.host = o.host || (process.env.INVOCATION_ID ? "systemd" : "manual");
    this.quiet = !!o.quiet;
    this.stateFile = o.stateFile || path.join(this.dataDir, "keeper-state.json");
    const d = o.deps || {};
    this.d = {
      now: d.now || (() => Date.now()),
      random: d.random || Math.random,
      setTimeout: d.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: d.clearTimeout || ((t) => clearTimeout(t)),
      spawnChild: d.spawnChild || (() => this._spawnReal()),
      probe: d.probe || ((port) => httpProbe(port, this.cfg.probeTimeoutMs)),
      killTree: d.killTree || killTree,
      alert: d.alert || null, // (title, message) — set by the CLI; null = log only
      log: d.log || ((line) => this._logReal(line)),
      saveState: d.saveState || ((s) => writeJsonAtomic(this.stateFile, s)),
    };
    this.child = null; // { proc, pid, startedAt, port, listening, killedFor, fails }
    this.streak = 0; // crashes in a row (cleared by a stable run)
    this.crashTimes = [];
    this.exits = []; // { at, reason, code, signal, uptimeSec, detail }
    this.state = "starting"; // ok | backing-off | parked | stopping | stopped
    this.parkedAt = 0;
    this.nextStartAt = 0;
    this.starts = 0;
    this.stopping = false;
    this.timers = { start: null, probe: null, stable: null, boot: null, stop: null };
    this.keeperSince = this.d.now();
    this.out = null;
    this.err = null;
    this.onStopped = null;
  }

  // ---- log files (real runs only)
  _logPath(key) { return path.join(this.dataDir, key === "out" ? "server-stdout.log" : "server-stderr.log"); }

  // Set the live log aside as .1 (older copies move up one), then keep the
  // copies within logKeep and logTotalMaxBytes. Never throws.
  _rotate(key) {
    const file = this._logPath(key);
    if (this[key]) { try { this[key].end(); } catch {} this[key] = null; }
    const keep = Math.max(1, this.cfg.logKeep | 0);
    try { fs.rmSync(`${file}.${keep}`, { force: true }); } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      try { if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
    }
    try { fs.renameSync(file, `${file}.1`); } catch {}
    this._capCopies(key);
  }

  // Copies beyond logKeep, and the oldest copies while the whole is over
  // logTotalMaxBytes, are removed. Returns the names removed.
  _capCopies(key) {
    const file = this._logPath(key);
    const keep = Math.max(1, this.cfg.logKeep | 0);
    const removed = [];
    const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
    for (let i = keep + 1; i <= keep + 20; i++) {
      if (sizeOf(`${file}.${i}`) < 0) continue;
      try { fs.rmSync(`${file}.${i}`, { force: true }); removed.push(`${path.basename(file)}.${i}`); } catch {}
    }
    let total = Math.max(0, sizeOf(file));
    for (let i = 1; i <= keep; i++) {
      const n = sizeOf(`${file}.${i}`);
      if (n < 0) continue;
      if (total + n > this.cfg.logTotalMaxBytes) {
        try { fs.rmSync(`${file}.${i}`, { force: true }); removed.push(`${path.basename(file)}.${i}`); } catch {}
      } else total += n;
    }
    return removed;
  }

  // Opened at once (not lazily by path): a log set aside right after must
  // not have its stream open a new file under the old name.
  _openStream(key) {
    try {
      const fd = fs.openSync(this._logPath(key), "a");
      const st = fs.createWriteStream(null, { fd });
      st.on("error", () => {});
      return st;
    } catch { return null; }
  }

  _openLogs() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
    for (const key of ["out", "err"]) {
      const file = this._logPath(key);
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size > this.cfg.logMaxBytes) { this._rotate(key); size = 0; }
      else this._capCopies(key);
      if (!this[key]) this[key] = this._openStream(key);
      this.logBytes = this.logBytes || {};
      this.logBytes[key] = size;
    }
  }

  // One chunk of the server's output (or the keeper's own line) into a log,
  // set aside first when it would pass logMaxBytes.
  _writeLog(key, chunk) {
    if (!this[key]) return;
    this.logBytes = this.logBytes || {};
    const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk && chunk.length) || 0;
    if ((this.logBytes[key] || 0) + n > this.cfg.logMaxBytes && (this.logBytes[key] || 0) > 0) {
      this._rotate(key);
      this[key] = this._openStream(key);
      this.logBytes[key] = 0;
    }
    try { if (this[key]) this[key].write(chunk); } catch {}
    this.logBytes[key] = (this.logBytes[key] || 0) + n;
  }
  _logReal(line) {
    const text = `[keeper] ${line}\n`;
    this._writeLog("out", text);
    if (!this.quiet) { try { process.stdout.write(text); } catch {} }
  }
  log(line) { try { this.d.log(line); } catch {} }

  _spawnReal() {
    this._openLogs();
    const env = {
      ...this.env,
      AURORA_SUPERVISOR: "keeper",
      AURORA_KEEPER_STATE: this.stateFile,
      // libuv's pool serves every streaming read; 4 threads is small for it
      // (ecosystem.config.js has carried the same figure for pm2)
      UV_THREADPOOL_SIZE: this.env.UV_THREADPOOL_SIZE || "6",
    };
    const proc = spawn(process.execPath, [...(this.nodeArgs || []), this.script, ...this.args], {
      cwd: this.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32", // its own process group, so the whole tree can be ended
    });
    const pipe = (stream, key, echo) => {
      if (!stream) return;
      stream.on("data", (chunk) => {
        this._writeLog(key, chunk);
        if (!this.quiet) { try { echo.write(chunk); } catch {} }
      });
    };
    pipe(proc.stdout, "out", process.stdout);
    pipe(proc.stderr, "err", process.stderr);
    return proc;
  }

  snapshot() {
    return {
      v: 1,
      keeperPid: process.pid,
      keeperSince: this.keeperSince,
      host: this.host,
      state: this.state,
      childPid: this.child ? this.child.pid : null,
      childStartedAt: this.child ? this.child.startedAt : null,
      port: this.child ? this.child.port || null : null,
      starts: this.starts,
      streak: this.streak,
      parkedAt: this.parkedAt || null,
      nextStartAt: this.nextStartAt || null,
      exits: this.exits.slice(-this.cfg.exitsKept),
      updatedAt: this.d.now(),
    };
  }
  save() { try { this.d.saveState(this.snapshot()); } catch {} }

  // ---- lifecycle
  start() {
    this.stopping = false;
    this._startChild();
    return this;
  }

  _clear(name) {
    if (this.timers[name]) { this.d.clearTimeout(this.timers[name]); this.timers[name] = null; }
  }

  _startChild() {
    this._clear("start");
    if (this.stopping) return;
    this.nextStartAt = 0;
    let proc;
    try {
      proc = this.d.spawnChild();
    } catch (e) {
      this.log(`could not start the server: ${(e && e.message) || e}`);
      return this._onExit(null, { code: null, signal: null, detail: `spawn failed: ${(e && e.message) || e}` });
    }
    this.starts++;
    const c = { proc, pid: proc.pid, startedAt: this.d.now(), port: null, listening: false, killedFor: null, fails: 0, gone: false };
    this.child = c;
    if (this.state !== "parked") this.state = this.streak ? "backing-off" : "ok";
    this.log(`started the server (pid ${c.pid}${this.starts > 1 ? `, start #${this.starts}` : ""})`);
    proc.on("message", (m) => {
      if (!m || typeof m !== "object" || this.child !== c) return;
      if (m.type === "listening" && Number(m.port) > 0) {
        c.port = Number(m.port);
        c.listening = true;
        this._clear("boot");
        this.save();
        this._scheduleProbe(c);
      }
    });
    proc.on("error", (e) => {
      if (c.gone) return;
      c.gone = true;
      this._onExit(c, { code: null, signal: null, detail: `could not run: ${(e && e.message) || e}` });
    });
    proc.on("exit", (code, signal) => {
      if (c.gone) return;
      c.gone = true;
      this._onExit(c, { code, signal });
    });
    // never came up
    this.timers.boot = this.d.setTimeout(() => {
      if (this.child !== c || c.listening || c.gone) return;
      this.log(`the server did not finish starting in ${Math.round(this.cfg.bootGraceMs / 1000)} s — ending it`);
      c.killedFor = "never-up";
      this.d.killTree(c.pid);
    }, this.cfg.bootGraceMs);
    // stayed up: the streak is over
    this.timers.stable = this.d.setTimeout(() => {
      if (this.child !== c || c.gone) return;
      if (this.streak || this.state !== "ok") {
        const wasParked = this.state === "parked";
        this.streak = 0;
        this.state = "ok";
        this.parkedAt = 0;
        this.log(`the server has stayed up for ${Math.round(this.cfg.stableMs / 1000)} s — back to normal`);
        if (wasParked) this._alert("Aurora: recovered", "The server is running again and has stayed up.");
        this.save();
      }
    }, this.cfg.stableMs);
    this.save();
  }

  _scheduleProbe(c) {
    this._clear("probe");
    this.timers.probe = this.d.setTimeout(async () => {
      if (this.child !== c || c.gone || this.stopping || c.killedFor) return;
      let res = null;
      try { res = await this.d.probe(c.port); } catch { res = null; }
      if (this.child !== c || c.gone || this.stopping || c.killedFor) return;
      const v = probeVerdict(res, this.cfg);
      if (v.ok) {
        if (c.fails) this.log(`the server is answering again after ${c.fails} missed check${c.fails === 1 ? "" : "s"}`);
        c.fails = 0;
      } else {
        c.fails++;
        if (c.fails === 1 || c.fails === this.cfg.probeFailures) this.log(`health check failed (${v.why}) — ${c.fails} of ${this.cfg.probeFailures}`);
        if (c.fails >= this.cfg.probeFailures) {
          this.log(`the server has not answered ${c.fails} checks in a row — ending it (pid ${c.pid}) and starting again`);
          c.killedFor = "hang";
          c.hangWhy = v.why;
          this.d.killTree(c.pid);
          return;
        }
      }
      this._scheduleProbe(c);
    }, this.cfg.probeEveryMs);
  }

  _onExit(c, { code, signal, detail }) {
    this._clear("probe");
    this._clear("stable");
    this._clear("boot");
    this._clear("stop");
    const now = this.d.now();
    const killedFor = this.stopping ? "stop" : c ? c.killedFor : null;
    const reason = c ? classify({ code, signal, killedFor }) : "crash";
    const uptimeSec = c ? Math.max(0, Math.round((now - c.startedAt) / 1000)) : 0;
    const rec = { at: now, reason, code: code == null ? null : code, signal: signal || null, uptimeSec };
    if (detail) rec.detail = String(detail).slice(0, 200);
    if (c && c.hangWhy) rec.detail = c.hangWhy;
    this.exits.push(rec);
    while (this.exits.length > this.cfg.exitsKept) this.exits.shift();
    if (this.child === c) this.child = null;

    if (this.stopping) {
      this.state = "stopped";
      this.log(`the server has stopped (${code != null ? `exit code ${code}` : signal || "ended"})`);
      this.save();
      if (this.onStopped) { const f = this.onStopped; this.onStopped = null; f(); }
      return;
    }

    if (isCrash(reason)) {
      // a crash after a long healthy run starts a new streak
      if (c && now - c.startedAt >= this.cfg.stableMs) this.streak = 0;
      this.streak++;
      this.crashTimes.push(now);
      this.crashTimes = this.crashTimes.filter((t) => now - t <= this.cfg.giveUpWindowMs);
    }
    const said = { crash: `crashed (${code != null ? `exit code ${code}` : signal || "no code"})`, hang: "was not answering", "never-up": "never finished starting", restart: "asked to be restarted", heal: "restarted itself (watchdog)", exited: "stopped by itself (exit code 0)" }[reason] || reason;

    if (this.state === "parked" && isCrash(reason)) {
      // a slow retry failed too: stay parked, try again later
      return this._park(said, false);
    }
    if (isCrash(reason) && shouldGiveUp(this.crashTimes, now, this.cfg)) return this._park(said, true);

    const delay = jittered(backoffMs(reason, this.streak, this.cfg), this.d.random);
    if (isCrash(reason)) this.state = "backing-off";
    this.nextStartAt = now + delay;
    this.log(`the server ${said} after ${uptimeSec} s — starting it again${delay ? ` in ${(delay / 1000).toFixed(1)} s` : " now"}${isCrash(reason) && this.streak > 1 ? ` (crash ${this.streak} in a row)` : ""}`);
    this.save();
    this.timers.start = this.d.setTimeout(() => this._startChild(), delay);
  }

  _park(said, first) {
    const now = this.d.now();
    this.state = "parked";
    if (first) {
      this.parkedAt = now;
      const n = this.crashTimes.length;
      const mins = Math.round(this.cfg.giveUpWindowMs / 60000);
      const again = this.cfg.parkedRetryMs ? `It will be tried again every ${Math.round(this.cfg.parkedRetryMs / 60000)} minutes.` : "It will not be started again until someone restarts the keeper.";
      this.log(`GIVING UP on quick restarts: the server ${said}, ${n} times in ${mins} minutes. ${again}`);
      this._alert("Aurora: URGENT — the server keeps crashing", `Aurora ${said} ${n} times in ${mins} minutes and is DOWN. ${again} The end of data/server-stderr.log says why.`);
    } else {
      this.log(`still failing (the server ${said}) — parked`);
    }
    if (this.cfg.parkedRetryMs) {
      this.nextStartAt = now + this.cfg.parkedRetryMs;
      this.timers.start = this.d.setTimeout(() => this._startChild(), this.cfg.parkedRetryMs);
    } else {
      this.nextStartAt = 0;
    }
    this.save();
  }

  _alert(title, message) {
    if (!this.d.alert) return;
    try { this.d.alert(title, message); } catch {}
  }

  // Restart the server now, cleanly (`keeper.js --restart`): it is asked to
  // stop like any other stop, and started again when it has.
  restartChild(reason = "restart asked through the keeper") {
    const c = this.child;
    if (this.stopping) return false;
    if (!c || c.gone) {
      // nothing running (backing off, or parked): start now
      this._clear("start");
      this._startChild();
      return true;
    }
    if (c.killedFor) return false;
    c.killedFor = "asked";
    this._clear("probe");
    this.log(`${reason} — asking the server to stop, then starting it again`);
    try { if (c.proc.connected) c.proc.send({ type: "shutdown", reason }); } catch {}
    if (process.platform !== "win32") { try { c.proc.kill("SIGTERM"); } catch {} }
    this.timers.stop = this.d.setTimeout(() => {
      if (c.gone) return;
      this.log(`the server did not stop in ${Math.round(this.cfg.stopTimeoutMs / 1000)} s — ending it`);
      this.d.killTree(c.pid);
    }, this.cfg.stopTimeoutMs);
    return true;
  }

  // Stop the server (and stay stopped). Resolves when it is gone.
  stop(reason = "the keeper is stopping") {
    if (this.stopping) return this._stopPromise || Promise.resolve();
    this.stopping = true;
    this._clear("start");
    this._clear("probe");
    this._clear("stable");
    this._clear("boot");
    const c = this.child;
    this._stopPromise = new Promise((resolve) => {
      if (!c || c.gone) {
        this.state = "stopped";
        this.save();
        return resolve();
      }
      this.onStopped = resolve;
      this.state = "stopping";
      this.log(`${reason} — asking the server to stop`);
      // The channel first (the only graceful way on Windows), a signal too
      // where signals exist.
      try { if (c.proc.connected) c.proc.send({ type: "shutdown", reason }); } catch {}
      if (process.platform !== "win32") { try { c.proc.kill("SIGTERM"); } catch {} }
      this.timers.stop = this.d.setTimeout(() => {
        if (c.gone) return;
        this.log(`the server did not stop in ${Math.round(this.cfg.stopTimeoutMs / 1000)} s — ending it`);
        this.d.killTree(c.pid);
      }, this.cfg.stopTimeoutMs);
    });
    return this._stopPromise;
  }
}

// A server left behind by a keeper that was killed (not stopped): it still
// holds the port, so the new one could never bind. Found through the state
// file; ended only if the old keeper is really gone and the pid is still a
// node process. Returns what it did, for the log.
const reapOrphan = async (stateFile, deps = {}) => {
  const alive = deps.pidAlive || pidAlive;
  const cmdline = deps.cmdlineOf || cmdlineOf;
  const kill = deps.killTree || killTree;
  const script = deps.script || "server.js";
  let s = null;
  try { s = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
  if (!s || s.keeperPid === process.pid) return null;
  if (s.keeperPid && alive(s.keeperPid) && /keeper/i.test(await cmdline(s.keeperPid))) {
    return { other: s.keeperPid }; // another keeper is running: the caller must not start a second
  }
  if (!s.childPid || !alive(s.childPid)) return null;
  const cl = await cmdline(s.childPid);
  if (!cl || !cl.includes(path.basename(script))) return null;
  await kill(s.childPid);
  return { reaped: s.childPid };
};

module.exports = { Keeper, DEFAULTS, EXIT, classify, isCrash, backoffMs, jittered, shouldGiveUp, probeVerdict, httpProbe, killTree, pidAlive, cmdlineOf, reapOrphan, writeJsonAtomic };
