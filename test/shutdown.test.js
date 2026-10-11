// Stopping well (src/lib/shutdown.js) and who restarts the server
// (src/lib/supervisor.js): the order of the shutdown, the deadline, the exit
// codes, and what "supervised" means — with a real HTTP server on a free
// port and stand-ins for everything else. Nothing here exits the process.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const shutdown = require("../src/lib/shutdown");
const supervisor = require("../src/lib/supervisor");
const { judgeSupervisor } = require("../src/lib/healer-checks/system")._internals;

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const get = (port, path = "/") =>
  new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
      res.on("error", () => resolve({ error: true, partial: buf }));
    });
    req.on("error", () => resolve({ error: true }));
  });

// stand-ins that write down the order things happened in
const rig = () => {
  const order = [];
  let flushed = 0;
  return {
    order,
    flushes: () => flushed,
    deps: {
      log: () => {},
      flushAll: () => { flushed++; order.push("flush"); },
      realtime: { closeAll: (msg, code) => { order.push(`sockets:${msg.type}:${code}:${msg.restart ? "restart" : "stop"}`); return 3; } },
      children: { killAll: () => { order.push("children"); return 2; } },
      exit: (code) => { order.push(`exit:${code}`); },
    },
  };
};

test("the sequence: stores first, sockets told, answers in flight finish, helpers ended, stores again, exit code kept", async () => {
  shutdown._internals._reset();
  let release;
  const server = await listen((req, res) => {
    if (req.url === "/slow") { release = () => res.end("finished"); return; }
    res.end("quick");
  });
  const port = server.address().port;
  const slow = get(port, "/slow");
  await new Promise((r) => setTimeout(r, 100)); // the request is in flight
  const r = rig();
  let hookRan = false;
  shutdown.register("test hook", async () => { hookRan = true; r.order.push("hook"); });
  const done = shutdown.run({ reason: "unit test", code: supervisor.EXIT.RESTART, graceMs: 3000, hardMs: 8000, deps: { ...r.deps, server } });
  assert.equal(shutdown.stopping(), true);
  // new connections are refused while the old answer is still being written
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal((await get(port, "/")).error, true, "not accepting any more");
  assert.ok(!r.order.includes("children"), "helpers are not ended before the answers had their chance");
  release();
  const answer = await slow;
  assert.equal(answer.body, "finished", "the answer in flight was allowed to finish");
  await done;
  assert.equal(hookRan, true);
  assert.deepEqual(r.order.filter((s) => s !== "hook"), ["flush", "sockets:server_restarting:1012:restart", "children", "flush", "exit:75"]);
  assert.ok(r.order.indexOf("hook") > r.order.indexOf("sockets:server_restarting:1012:restart"));
  assert.equal(r.flushes(), 2, "flushed at the start and at the end");
  shutdown._internals._reset();
});

test("an answer that never finishes does not hold the exit: the grace period ends it", async () => {
  shutdown._internals._reset();
  const server = await listen((req, res) => { res.write("some"); /* never ends */ });
  const port = server.address().port;
  const stuck = get(port, "/");
  await new Promise((r) => setTimeout(r, 100));
  const r = rig();
  const t0 = Date.now();
  await shutdown.run({ reason: "unit test", code: 0, graceMs: 300, hardMs: 5000, deps: { ...r.deps, server } });
  assert.ok(Date.now() - t0 < 3000, "left after the grace period");
  assert.equal(r.order[r.order.length - 1], "exit:0");
  assert.match(r.order[1], /^sockets:server_restarting:1012:stop$/, "a plain stop is not announced as a restart");
  const a = await stuck;
  assert.ok(a.error || a.partial !== undefined, "the stuck connection was closed");
  shutdown._internals._reset();
});

test("a hook that hangs is cut off by the hard deadline, and the stores are still flushed", async () => {
  shutdown._internals._reset();
  const r = rig();
  shutdown.register("stuck", () => new Promise(() => {}));
  // no server, so only the hook is waited for; grace longer than the hard line
  const p = shutdown.run({ reason: "unit test", code: 3, graceMs: 60000, hardMs: 250, deps: { ...r.deps, server: null } });
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(r.order.includes("exit:3"), "gone at the hard deadline");
  assert.equal(r.order.filter((s) => s === "flush").length, 2);
  void p;
  shutdown._internals._reset();
});

test("asked twice: the second request (force) leaves at once; without force it is ignored", async () => {
  shutdown._internals._reset();
  const r = rig();
  shutdown.register("slow", () => new Promise((res) => setTimeout(res, 400)));
  const p = shutdown.run({ reason: "first", code: 0, graceMs: 2000, hardMs: 5000, deps: { ...r.deps, server: null } });
  await shutdown.run({ reason: "second", code: 0, deps: r.deps }); // ignored
  assert.ok(!r.order.some((s) => s.startsWith("exit")));
  await shutdown.run({ reason: "third", code: 0, force: true, deps: r.deps });
  assert.ok(r.order.includes("exit:0"), "a second CTRL-C does not wait");
  await p;
  shutdown._internals._reset();
});

test("while stopping, answers close their connection (the middleware)", () => {
  shutdown._internals._reset();
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  let nexts = 0;
  shutdown.middleware({}, res, () => nexts++);
  assert.deepEqual(headers, {});
  shutdown._internals.state.stopping = true;
  shutdown.middleware({}, res, () => nexts++);
  assert.equal(headers.Connection, "close");
  assert.equal(nexts, 2);
  shutdown._internals._reset();
});

// ---------------------------------------------------------------- supervisor

test("supervised by what: read from the environment alone", () => {
  assert.equal(supervisor.detect({}), null);
  assert.equal(supervisor.detect({ AURORA_SUPERVISOR: "keeper" }), "keeper");
  assert.equal(supervisor.detect({ pm_id: "0" }), "pm2");
  assert.equal(supervisor.detect({ PM2_HOME: "/x" }), "pm2");
  assert.equal(supervisor.detect({ INVOCATION_ID: "abc" }), "systemd");
  assert.equal(supervisor.detect({ AURORA_SUPERVISED: "1" }), "external");
  assert.equal(supervisor.detect({ AURORA_SUPERVISED: "0" }), null);
  assert.equal(supervisor.detect({ AURORA_SUPERVISOR: "keeper", INVOCATION_ID: "abc" }), "keeper", "the keeper under systemd is still the keeper");
});

test("the exit codes: restart is 75, the watchdog's is 3, and they differ from a clean stop and a crash", () => {
  const E = supervisor.EXIT;
  assert.deepEqual(E, { OK: 0, FATAL: 1, HEAL: 3, RESTART: 75 });
  assert.equal(new Set(Object.values(E)).size, 4);
});

test("Restart is refused, in a sentence, when nothing would bring the server back — and nothing is stopped", () => {
  let ran = null;
  const fake = { run: (o) => { ran = o; } };
  const no = supervisor.requestRestart("test", { env: {}, shutdown: fake });
  assert.equal(no.ok, false);
  assert.match(no.error, /not running under a supervisor/);
  assert.match(no.error, /Nothing was stopped/);
  assert.equal(ran, null);
  const yes = supervisor.requestRestart("test", { env: { AURORA_SUPERVISOR: "keeper" }, shutdown: fake });
  assert.deepEqual(yes, { ok: true, by: "keeper" });
  assert.equal(ran.code, 75);
  assert.equal(ran.notice, "restart");
});

test("info: what the admin page shows for each arrangement", () => {
  const now = 1e12;
  const bare = supervisor.info({ env: {}, now });
  assert.equal(bare.supervised, false);
  assert.match(bare.byWords, /nothing/);
  const H = 3600 * 1000;
  const state = { host: "task", state: "ok", keeperPid: 7, keeperSince: now - 50 * H, exits: [
    { at: now - 30 * H, reason: "crash", code: 1, uptimeSec: 5 }, // older than a day
    { at: now - 5 * H, reason: "hang", code: null, uptimeSec: 900 },
    { at: now - 2 * H, reason: "restart", code: 75, uptimeSec: 60 },
    { at: now - 1 * H, reason: "stopped", code: 0, uptimeSec: 60 },
  ] };
  const k = supervisor.info({ env: { AURORA_SUPERVISOR: "keeper" }, now, state });
  assert.equal(k.supervised, true);
  assert.equal(k.survivesReboot, true);
  assert.match(k.byWords, /keeper \(a Scheduled Task\)/);
  assert.equal(k.restartsLastDay, 2, "the hang and the wanted restart; not the stop, not yesterday's crash");
  assert.equal(k.crashesLastDay, 1);
  assert.equal(k.lastExit.reason, "stopped");
  const noFile = supervisor.info({ env: { AURORA_SUPERVISOR: "keeper" }, now, state: null });
  assert.equal(noFile.supervised, true);
  assert.equal(noFile.restartsLastDay, null, "unknown is not zero");
  const pm2 = supervisor.info({ env: { pm_id: "0" }, now, boots: [now - 30 * H, now - 3 * H, now - 2 * H, now - 1000] });
  assert.equal(pm2.by, "pm2");
  assert.equal(pm2.restartsLastDay, 2, "three boots in the day = two restarts");
});

test("the healer's verdict: unsupervised is a finding, a parked keeper a failure, a few crashes a warning", () => {
  const bare = judgeSupervisor({ supervised: false });
  assert.equal(bare.status, "warn");
  assert.match(bare.findings[0].title, /Nothing restarts Aurora/);
  assert.match(bare.findings[0].setting, /docs\/operations\.md/);
  const fine = judgeSupervisor({ supervised: true, by: "keeper", byWords: "Aurora's keeper (systemd)", restartsLastDay: 1, crashesLastDay: 0, lastExitWords: "restarted on request", state: "ok", survivesReboot: true });
  assert.equal(fine.status, "ok");
  assert.equal(fine.findings.length, 0);
  assert.match(fine.summary, /supervised by Aurora's keeper \(systemd\) · 1 restart in the last day · last: restarted on request/);
  const loop = judgeSupervisor({ supervised: true, by: "keeper", state: "parked", crashesLastDay: 9, lastExitWords: "crashed (exit code 1)", survivesReboot: true });
  assert.equal(loop.status, "fail");
  assert.match(loop.findings[0].title, /keeps crashing/);
  const some = judgeSupervisor({ supervised: true, by: "keeper", state: "ok", crashesLastDay: 3, restartsLastDay: 3, lastExitWords: "stopped answering and was killed", survivesReboot: true });
  assert.equal(some.status, "warn");
  assert.match(some.findings[0].text, /3 times in the last day/);
  const byHand = judgeSupervisor({ supervised: true, by: "keeper", state: "ok", crashesLastDay: 0, restartsLastDay: 0, survivesReboot: false });
  assert.equal(byHand.status, "ok");
  assert.equal(byHand.findings[0].level, "info");
  assert.match(byHand.findings[0].title, /started by hand/);
});
