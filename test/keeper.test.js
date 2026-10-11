// The keeper's decisions (src/lib/keeper.js), with no process started: what
// an exit means, how long to wait, when to give up, when a silent server is
// killed — driven with a fake clock, a fake child and a fake /healthz.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const K = require("../src/lib/keeper");
const { Keeper, classify, backoffMs, jittered, shouldGiveUp, probeVerdict, isCrash, DEFAULTS, EXIT } = K;

// ---- a hand-driven world
const world = (cfg = {}) => {
  const w = { now: 1e12, timers: [], children: [], logs: [], alerts: [], saved: [], killed: [], probes: [], probeAnswer: () => ({ status: 200, body: { ok: true, loop: { maxMs: 3 } } }) };
  const deps = {
    now: () => w.now,
    random: () => 1, // jitter at its top: delay == the un-jittered figure
    setTimeout: (fn, ms) => { const t = { at: w.now + ms, fn, live: true }; w.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    spawnChild: () => {
      const c = new EventEmitter();
      c.pid = 1000 + w.children.length;
      c.connected = true;
      c.sent = [];
      c.send = (m) => c.sent.push(m);
      c.kill = () => {};
      w.children.push(c);
      return c;
    },
    probe: async (port) => { w.probes.push(port); return w.probeAnswer(); },
    killTree: (pid) => { w.killed.push(pid); const c = w.children.find((x) => x.pid === pid); if (c) setImmediate(() => c.emit("exit", null, "SIGKILL")); return Promise.resolve(); },
    alert: (title, message) => w.alerts.push({ title, message }),
    log: (line) => w.logs.push(line),
    saveState: (s) => w.saved.push(JSON.parse(JSON.stringify(s))),
  };
  w.keeper = new Keeper({ script: "server.js", cwd: os.tmpdir(), host: "manual", cfg, deps });
  // run every timer due within `ms`, in order, letting promises settle between
  w.advance = async (ms) => {
    const end = w.now + ms;
    for (;;) {
      const due = w.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      w.now = Math.max(w.now, due.at);
      due.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    w.now = end;
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  w.last = () => w.children[w.children.length - 1];
  w.state = () => w.saved[w.saved.length - 1];
  return w;
};

test("what an exit means: the codes are the contract", () => {
  assert.equal(classify({ code: 0 }), "exited");
  assert.equal(classify({ code: 1 }), "crash");
  assert.equal(classify({ code: null, signal: "SIGKILL" }), "crash");
  assert.equal(classify({ code: EXIT.RESTART }), "restart");
  assert.equal(classify({ code: EXIT.HEAL }), "heal");
  assert.equal(classify({ code: 1, killedFor: "hang" }), "hang");
  assert.equal(classify({ code: null, signal: "SIGKILL", killedFor: "never-up" }), "never-up");
  assert.equal(classify({ code: 0, killedFor: "stop" }), "stopped");
  assert.equal(classify({ code: 0, killedFor: "asked" }), "restart");
  assert.equal(EXIT.RESTART, require("../src/lib/supervisor").EXIT.RESTART, "the keeper and the server agree on the code");
  assert.equal(EXIT.HEAL, require("../src/lib/supervisor").EXIT.HEAL);
  assert.ok(isCrash("crash") && isCrash("hang") && isCrash("never-up"));
  assert.ok(!isCrash("restart") && !isCrash("heal") && !isCrash("exited") && !isCrash("stopped"));
});

test("back-off: a wanted restart waits nothing, a crash doubles up to the cap, jitter never reaches zero", () => {
  assert.equal(backoffMs("restart", 0), 0);
  assert.equal(backoffMs("heal", 3), 0);
  assert.equal(backoffMs("exited", 0), DEFAULTS.baseDelayMs);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs("crash", n)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(backoffMs("hang", 40), DEFAULTS.maxDelayMs, "a long streak does not overflow");
  assert.equal(jittered(0), 0);
  assert.equal(jittered(8000, () => 0), 4000);
  assert.equal(jittered(8000, () => 1), 8000);
  for (let i = 0; i < 50; i++) { const j = jittered(1000); assert.ok(j >= 500 && j <= 1000); }
});

test("giving up: N crashes inside the window, and only those inside it", () => {
  const now = 1e12;
  const cfg = { ...DEFAULTS, giveUpCrashes: 3, giveUpWindowMs: 60000 };
  assert.equal(shouldGiveUp([now - 1000, now - 500], now, cfg), false);
  assert.equal(shouldGiveUp([now - 50000, now - 1000, now - 500], now, cfg), true);
  assert.equal(shouldGiveUp([now - 90000, now - 1000, now - 500], now, cfg), false, "an old crash does not count");
});

test("a probe: no answer and a long-blocked loop fail it; a stopping server and a busy-but-turning one do not", () => {
  assert.equal(probeVerdict(null).ok, false);
  assert.equal(probeVerdict({ status: 500, body: null }).ok, false);
  assert.equal(probeVerdict({ status: 200, body: { ok: true, loop: { maxMs: 12 } } }).ok, true);
  assert.equal(probeVerdict({ status: 200, body: { ok: true, loop: { maxMs: 4999 } } }).ok, true);
  const blocked = probeVerdict({ status: 200, body: { ok: true, loop: { maxMs: 9000 } } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.why, /event loop blocked 9000 ms/);
  assert.equal(probeVerdict({ status: 503, body: { stopping: true } }).ok, true);
  assert.equal(probeVerdict({ status: 200, body: { ok: true } }).ok, true, "an older server with no loop figure is judged on answering alone");
});

test("a crash is restarted with a doubling wait, and a stable run clears the streak", async () => {
  const w = world({ stableMs: 120000 });
  w.keeper.start();
  assert.equal(w.children.length, 1);
  w.last().emit("exit", 1, null);
  assert.equal(w.state().state, "backing-off");
  await w.advance(999);
  assert.equal(w.children.length, 1, "not before the first wait is over");
  await w.advance(2);
  assert.equal(w.children.length, 2);
  w.last().emit("exit", 1, null);
  await w.advance(1999);
  assert.equal(w.children.length, 2);
  await w.advance(2);
  assert.equal(w.children.length, 3, "second crash waited twice as long");
  assert.equal(w.keeper.streak, 2);
  // it stays up: back to normal, and the next crash starts from the bottom
  await w.advance(120000);
  assert.equal(w.keeper.streak, 0);
  assert.equal(w.state().state, "ok");
  w.last().emit("exit", 1, null);
  await w.advance(1001);
  assert.equal(w.children.length, 4);
  assert.deepEqual(w.state().exits.map((x) => x.reason), ["crash", "crash", "crash"]);
  assert.equal(w.alerts.length, 0);
});

test("exit code 75 (Restart from the admin page) and 3 (the watchdog) come straight back and are not crashes", async () => {
  const w = world();
  w.keeper.start();
  w.last().emit("exit", EXIT.RESTART, null);
  await w.advance(0);
  assert.equal(w.children.length, 2, "restarted at once");
  w.last().emit("exit", EXIT.HEAL, null);
  await w.advance(0);
  assert.equal(w.children.length, 3);
  assert.equal(w.keeper.streak, 0);
  assert.equal(w.keeper.crashTimes.length, 0);
  assert.deepEqual(w.state().exits.map((x) => x.reason), ["restart", "heal"]);
  // ten of them in a row never park the keeper
  for (let i = 0; i < 10; i++) { w.last().emit("exit", EXIT.RESTART, null); await w.advance(0); }
  assert.equal(w.children.length, 13);
  assert.notEqual(w.state().state, "parked");
});

test("a restart loop: after N crashes in the window the keeper says so ONCE, parks, and tries slowly", async () => {
  const w = world({ giveUpCrashes: 3, giveUpWindowMs: 600000, parkedRetryMs: 900000, stableMs: 120000 });
  w.keeper.start();
  w.last().emit("exit", 1, null); await w.advance(1001);
  w.last().emit("exit", 1, null); await w.advance(2001);
  assert.equal(w.children.length, 3);
  w.last().emit("exit", 1, null);
  assert.equal(w.state().state, "parked");
  assert.equal(w.alerts.length, 1, "one alert");
  assert.match(w.alerts[0].title, /keeps crashing/);
  assert.match(w.alerts[0].message, /3 times in 10 minutes/);
  await w.advance(60000);
  assert.equal(w.children.length, 3, "no quick restart while parked");
  // the slow retry fails as well: still parked, nobody is told again
  await w.advance(900000);
  assert.equal(w.children.length, 4);
  w.last().emit("exit", 1, null);
  assert.equal(w.state().state, "parked");
  assert.equal(w.alerts.length, 1);
  // the next slow retry holds: recovered, said once
  await w.advance(900000);
  assert.equal(w.children.length, 5);
  await w.advance(120000);
  assert.equal(w.state().state, "ok");
  assert.equal(w.alerts.length, 2);
  assert.match(w.alerts[1].title, /recovered/);
});

test("parkedRetryMs 0: a parked keeper does not start the server again", async () => {
  const w = world({ giveUpCrashes: 2, parkedRetryMs: 0 });
  w.keeper.start();
  w.last().emit("exit", 1, null); await w.advance(1001);
  w.last().emit("exit", 1, null);
  assert.equal(w.state().state, "parked");
  await w.advance(24 * 3600 * 1000);
  assert.equal(w.children.length, 2);
});

test("a hang: N missed checks in a row and the server is killed and started again; fewer are forgiven", async () => {
  const w = world({ probeEveryMs: 10000, probeFailures: 3 });
  w.keeper.start();
  const first = w.last();
  first.emit("message", { type: "listening", port: 4123 });
  await w.advance(10000);
  assert.deepEqual(w.probes, [4123], "probing the port the server said it listens on");
  // two misses, then an answer: forgiven
  w.probeAnswer = () => null;
  await w.advance(20000);
  assert.equal(w.killed.length, 0);
  w.probeAnswer = () => ({ status: 200, body: { ok: true, loop: { maxMs: 1 } } });
  await w.advance(10000);
  assert.ok(w.logs.some((l) => /answering again after 2 missed checks/.test(l)));
  // three in a row: killed, counted as a hang, restarted after the back-off
  w.probeAnswer = () => ({ status: 200, body: { ok: true, loop: { maxMs: 60000 } } });
  await w.advance(30000);
  assert.deepEqual(w.killed, [first.pid]);
  await w.advance(1001);
  assert.equal(w.children.length, 2);
  const ex = w.state().exits;
  assert.equal(ex[ex.length - 1].reason, "hang");
  assert.match(ex[ex.length - 1].detail, /event loop blocked/);
});

test("a server that never says it is listening is ended after the boot grace", async () => {
  const w = world({ bootGraceMs: 60000 });
  w.keeper.start();
  await w.advance(59999);
  assert.equal(w.killed.length, 0);
  await w.advance(2);
  assert.equal(w.killed.length, 1);
  assert.equal(w.state().exits[0].reason, "never-up");
  assert.equal(w.probes.length, 0, "nothing is probed before the port is known");
});

test("stop: the server is asked first (the channel), killed only if it does not go, and never restarted", async () => {
  const w = world({ stopTimeoutMs: 12000 });
  w.keeper.start();
  const c = w.last();
  const stopped = w.keeper.stop("test");
  assert.deepEqual(c.sent, [{ type: "shutdown", reason: "test" }]);
  await w.advance(11999);
  assert.equal(w.killed.length, 0);
  await w.advance(2);
  assert.deepEqual(w.killed, [c.pid], "ended after the timeout");
  await stopped;
  assert.equal(w.state().state, "stopped");
  assert.equal(w.state().exits[0].reason, "stopped");
  await w.advance(3600000);
  assert.equal(w.children.length, 1, "stopped means stopped");
});

test("restartChild: a clean stop, then a start at once, not counted as a crash", async () => {
  const w = world();
  w.keeper.start();
  const c = w.last();
  assert.equal(w.keeper.restartChild("asked"), true);
  assert.equal(c.sent[0].type, "shutdown");
  c.emit("exit", 0, null);
  await w.advance(0);
  assert.equal(w.children.length, 2);
  assert.equal(w.state().exits[0].reason, "restart");
  assert.equal(w.keeper.streak, 0);
});

test("the state file says what the admin page shows", async () => {
  const w = world();
  w.keeper.start();
  w.last().emit("message", { type: "listening", port: 4000 });
  const s = w.state();
  assert.equal(s.keeperPid, process.pid);
  assert.equal(s.host, "manual");
  assert.equal(s.port, 4000);
  assert.equal(s.childPid, w.last().pid);
  assert.equal(s.state, "ok");
  // and lib/supervisor.js reads it
  const sup = require("../src/lib/supervisor");
  w.last().emit("exit", 1, null);
  const info = sup.info({ env: { AURORA_SUPERVISOR: "keeper" }, state: w.state(), now: w.now });
  assert.equal(info.supervised, true);
  assert.equal(info.by, "keeper");
  assert.equal(info.restartsLastDay, 1);
  assert.equal(info.crashesLastDay, 1);
  assert.match(info.lastExitWords, /crashed \(exit code 1\)/);
  assert.equal(info.survivesReboot, false, "started by hand");
});

test("a leftover server from a killed keeper is ended; a live keeper is respected; a reused pid is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-keeper-"));
  const file = path.join(dir, "keeper-state.json");
  try {
    const killed = [];
    const deps = (alive, cmd) => ({ pidAlive: (p) => alive.includes(p), cmdlineOf: async (p) => cmd[p] || "", killTree: async (p) => { killed.push(p); }, script: "server.js" });
    assert.equal(await K.reapOrphan(file, deps([], {})), null, "no state file");
    fs.writeFileSync(file, JSON.stringify({ keeperPid: 11, childPid: 22 }));
    // old keeper gone, its server still there
    assert.deepEqual(await K.reapOrphan(file, deps([22], { 22: "node C:\\aurora\\server.js" })), { reaped: 22 });
    assert.deepEqual(killed, [22]);
    // the pid now belongs to something else: untouched
    killed.length = 0;
    assert.equal(await K.reapOrphan(file, deps([22], { 22: "chrome.exe --type=renderer" })), null);
    assert.deepEqual(killed, []);
    // another keeper is alive: this one must leave
    assert.deepEqual(await K.reapOrphan(file, deps([11, 22], { 11: "node scripts/keeper.js --host task", 22: "node server.js" })), { other: 11 });
    assert.deepEqual(killed, []);
    // both gone
    assert.equal(await K.reapOrphan(file, deps([], {})), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
