// The real server under its keeper, end to end: a private instance (the UI
// tests' harness — a temp folder, a free port, outbound network refused)
// started through scripts/keeper.js, then restarted from the admin API.
//
// What must hold: the restart is refused nowhere and loses nothing (a store
// saved a moment before is on disk afterwards), every live connection is told
// and closed with 1012, the server is back within seconds as a new process,
// and the admin's health data says who supervises it and why it last exited.
//
// The instance's library is made with ffmpeg; without ffmpeg this is skipped
// (the keeper itself is covered by keeper.test.js and
// keeper-integration.test.js, which need nothing).
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { spawnSync } = require("child_process");
const WebSocket = require("ws");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};

const call = (srv, method, url, body) =>
  new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${srv.url}${url}`, { method, agent: false, timeout: 4000, headers: { "X-Admin-Password": srv.adminPassword, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: json }); });
      res.on("error", () => resolve({ status: 0, body: null }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end(data || undefined);
  });

const until = async (what, fn, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

test("under the keeper: Restart Aurora comes back by itself, loses nothing, and tells every connection", { timeout: 300000 }, async (t) => {
  if (!haveFfmpeg()) return t.skip("no ffmpeg on this machine (the private instance builds its library with it)");
  const { start } = require("../scripts/ui-test-server");
  const srv = await start({ keeper: { set: { probeEveryMs: 500, baseDelayMs: 200 } }, waitForLibrary: false });
  try {
    // what an outside probe sees
    const hz = await call(srv, "GET", "/healthz");
    assert.equal(hz.status, 200);
    assert.equal(typeof hz.body.loop.maxMs, "number");

    // the admin's view: supervised, by the keeper
    const before = await call(srv, "GET", "/api/admin/health");
    assert.equal(before.body.pm2, true, "the old flag still means 'something restarts it'");
    assert.equal(before.body.supervisor.supervised, true);
    assert.equal(before.body.supervisor.by, "keeper");
    const alerts = await call(srv, "GET", "/api/admin/alerts");
    assert.equal(alerts.body.supervisor.by, "keeper", "/api/admin/alerts carries it too");

    // a live connection, and a store written a moment before the restart
    const ws = new WebSocket(srv.url.replace("http", "ws"));
    const seen = { messages: [], closeCode: null };
    ws.on("message", (raw) => { try { seen.messages.push(JSON.parse(raw)); } catch {} });
    ws.on("close", (code) => { seen.closeCode = code; });
    ws.on("error", () => {});
    await until("the socket to open", () => seen.messages.some((m) => m.type === "welcome"));
    const ban = await call(srv, "POST", "/api/admin/ban", { ip: "203.0.113.9", reason: "written just before the restart" });
    assert.equal(ban.status, 200);

    const t0 = Date.now();
    const r = await call(srv, "POST", "/api/admin/update/restart");
    assert.equal(r.status, 200);
    assert.equal(r.body.by, "keeper");

    await until("the socket to be told and closed", () => seen.closeCode !== null);
    assert.equal(seen.closeCode, 1012, "closed as 'service restart'");
    const said = seen.messages.find((m) => m.type === "server_restarting");
    assert.ok(said, "told before the close");
    assert.equal(said.restart, true);

    // back, as a new process, by itself
    const after = await until("the server to answer again", async () => {
      const h = await call(srv, "GET", "/api/admin/health");
      return h.status === 200 && h.body.supervisor && h.body.supervisor.lastExit ? h : null;
    });
    const tookMs = Date.now() - t0;
    assert.equal(after.body.supervisor.lastExit.reason, "restart");
    assert.equal(after.body.supervisor.lastExit.code, 75);
    assert.equal(after.body.supervisor.restartsLastDay, 1);
    assert.equal(after.body.supervisor.crashesLastDay, 0, "a wanted restart is not a crash");
    assert.ok(after.body.now.uptimeSec < 60, "a fresh process");
    assert.ok(tookMs < 60000, `back in ${tookMs} ms`);

    // nothing was lost: the ban saved 1.5 s-debounced just before the exit is there
    const bans = await call(srv, "GET", "/api/admin/bans");
    assert.ok(JSON.stringify(bans.body).includes("203.0.113.9"), "the store was flushed on the way out");

    // the healer's check agrees
    const healer = await call(srv, "POST", "/api/admin/healer/run");
    const report = healer.body && (healer.body.last || healer.body);
    const sup = ((report && report.checks) || []).find((c) => c.id === "supervisor");
    assert.ok(sup, "the healer has a supervisor check");
    assert.equal(sup.status, "ok");
    assert.match(sup.summary, /supervised by Aurora's keeper/);
  } finally {
    await srv.stop();
  }
});

test("not supervised: Restart Aurora is refused in a sentence and the server stays up", { timeout: 300000 }, async (t) => {
  if (!haveFfmpeg()) return t.skip("no ffmpeg on this machine (the private instance builds its library with it)");
  const { start } = require("../scripts/ui-test-server");
  const srv = await start({ waitForLibrary: false });
  try {
    const h = await call(srv, "GET", "/api/admin/health");
    assert.equal(h.body.supervisor.supervised, false);
    const r = await call(srv, "POST", "/api/admin/update/restart");
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not running under a supervisor/);
    const a = await call(srv, "POST", "/api/admin/actions/restart/run");
    const run = await until("the action to finish", async () => {
      const x = await call(srv, "GET", `/api/admin/actions/runs/${a.body.run.id}`);
      return x.body && x.body.status !== "running" ? x.body : null;
    });
    assert.equal(run.status, "failed");
    assert.match(run.output, /Nothing was stopped/);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await call(srv, "GET", "/healthz")).status, 200, "still up");
  } finally {
    await srv.stop();
  }
});
