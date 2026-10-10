// The keeper for real: scripts/keeper.js started as a process, keeping a tiny
// stand-in server (not Aurora) alive in a temp folder on a free port. The
// stand-in is crashed, hung (its event loop blocked for good), asked to
// restart, and finally stopped — and each time the keeper must do the right
// thing and write it down. No ffmpeg, nothing platform-specific: this runs on
// Windows and on Linux CI alike. The waits are long on purpose (a loaded
// machine); a healthy run takes a few seconds.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const KEEPER = path.join(__dirname, "..", "scripts", "keeper.js");

const FAKE_SERVER = `
const http = require("http");
const fs = require("fs");
const path = require("path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "starts.log"), process.pid + " " + (process.env.AURORA_SUPERVISOR || "-") + "\\n");
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ok: true, pid: process.pid, loop: { maxMs: 1 } })); }
  if (req.url === "/crash") { res.end("bye"); return setTimeout(() => process.exit(1), 20); }
  if (req.url === "/restart") { res.end("bye"); return setTimeout(() => process.exit(75), 20); }
  if (req.url === "/hang") { res.end("stuck"); return setTimeout(() => { for (;;) {} }, 20); }
  res.statusCode = 404; res.end();
});
const stop = (why) => { try { fs.appendFileSync(path.join(dir, "stops.log"), process.pid + " " + why + "\\n"); } catch {} process.exit(0); };
process.on("message", (m) => { if (m && m.type === "shutdown") stop("asked"); });
process.on("disconnect", () => stop("keeper-gone"));
process.on("SIGTERM", () => stop("asked"));
server.listen(0, "127.0.0.1", () => process.send({ type: "listening", port: server.address().port, pid: process.pid }));
`;

const get = (port, url, timeoutMs = 1500) =>
  new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: url, timeout: timeoutMs, agent: false }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });

const until = async (what, fn, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
};

test("the keeper brings a server back after a crash, a hang and a restart request, and stops it cleanly", { timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-keeper-it-"));
  const script = path.join(dir, "fake-server.js");
  const data = path.join(dir, "data");
  fs.writeFileSync(script, FAKE_SERVER);
  const stateFile = path.join(data, "keeper-state.json");
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
  const args = [KEEPER, "--script", script, "--data", data, "--no-alert", "--quiet",
    "--set", "probeEveryMs=250", "--set", "probeTimeoutMs=2000", "--set", "probeFailures=3",
    "--set", "baseDelayMs=100", "--set", "stopTimeoutMs=5000", "--set", "stableMs=600000"];
  const env = { ...process.env };
  delete env.AURORA_SUPERVISOR; delete env.AURORA_KEEPER_STATE;
  const keeper = spawn(process.execPath, args, { cwd: dir, env, stdio: "ignore", windowsHide: true });
  let keeperExit = null;
  keeper.on("exit", (code) => { keeperExit = code; });
  const pids = new Set();
  try {
    // a server that answers, started through the keeper
    const up = async (notPid) => {
      const s = await until("a listening server", () => { const x = state(); return x && x.port && x.childPid && x.childPid !== notPid ? x : null; });
      await until("an answer on /healthz", async () => { const r = await get(s.port, "/healthz"); return r && r.pid === s.childPid; });
      pids.add(s.childPid);
      return s;
    };
    let s = await up(null);
    assert.equal(s.state, "ok");
    assert.match(fs.readFileSync(path.join(dir, "starts.log"), "utf8"), /keeper/, "the server is told it is supervised");
    assert.ok(fs.existsSync(path.join(data, "server-stdout.log")), "the log file is where it has always been");

    // (each step looks at the exits recorded since it began: on a loaded
    // machine an extra restart in between must not fail the test)
    let seen = s.exits.length;
    const fresh = (x) => { const out = x.exits.slice(seen); seen = x.exits.length; return out; };

    // 1. it crashes
    const first = s.childPid;
    await get(s.port, "/crash");
    s = await up(first);
    const crash = fresh(s).find((x) => x.reason === "crash");
    assert.ok(crash, "recorded as a crash");
    assert.equal(crash.code, 1);

    // 2. it hangs: the loop is blocked for good, /healthz goes silent, the keeper kills it
    const second = s.childPid;
    await get(s.port, "/hang");
    s = await up(second);
    assert.ok(fresh(s).some((x) => x.reason === "hang"), "recorded as a hang");
    await until("the hung process to be gone", () => !pidAlive(second));

    // 3. it asks to be restarted (exit code 75): back at once, not a crash
    const third = s.childPid;
    await get(s.port, "/restart");
    s = await up(third);
    const asked = fresh(s).find((x) => x.reason === "restart");
    assert.ok(asked, "recorded as a wanted restart");
    assert.equal(asked.code, 75);

    // 4. `keeper.js --restart`: a clean stop and a new start
    const fourth = s.childPid;
    const r = spawnSync(process.execPath, [KEEPER, "--script", script, "--data", data, "--restart"], { cwd: dir, env, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    s = await up(fourth);
    assert.ok(fresh(s).some((x) => x.reason === "restart"));
    assert.match(fs.readFileSync(path.join(dir, "stops.log"), "utf8"), new RegExp(`${fourth} asked`), "it was asked, not killed");

    // 5. `keeper.js --stop`: the server is asked to stop, the keeper leaves, nothing is left
    const fifth = s.childPid;
    const st = spawnSync(process.execPath, [KEEPER, "--script", script, "--data", data, "--stop"], { cwd: dir, env, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(st.status, 0, st.stdout + st.stderr);
    await until("the keeper to exit", () => keeperExit !== null);
    assert.equal(keeperExit, 0);
    await until("the server to be gone", () => !pidAlive(fifth));
    assert.match(fs.readFileSync(path.join(dir, "stops.log"), "utf8"), new RegExp(`${fifth} asked`));
    await until("the keeper's last word", () => { const x = state(); return x && x.state === "stopped"; });
    assert.equal((await get(s.port, "/healthz", 500)), null, "nothing answers on the port any more");
  } finally {
    if (keeperExit === null) killTree(keeper.pid);
    for (const p of pids) if (pidAlive(p)) killTree(p);
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});

test("a keeper that is killed takes its server with it (the channel closes), so the port is free for the next one", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-keeper-it-"));
  const script = path.join(dir, "fake-server.js");
  const data = path.join(dir, "data");
  fs.writeFileSync(script, FAKE_SERVER);
  const stateFile = path.join(data, "keeper-state.json");
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
  const env = { ...process.env };
  delete env.AURORA_SUPERVISOR; delete env.AURORA_KEEPER_STATE;
  const keeper = spawn(process.execPath, [KEEPER, "--script", script, "--data", data, "--no-alert", "--quiet"], { cwd: dir, env, stdio: "ignore", windowsHide: true });
  let child = null;
  try {
    const s = await until("a listening server", () => { const x = state(); return x && x.port && x.childPid ? x : null; });
    child = s.childPid;
    await until("an answer", async () => { const r = await get(s.port, "/healthz"); return r && r.pid === child; });
    // the keeper dies without a word (End Task, kill -9)
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(keeper.pid), "/F"], { windowsHide: true });
    else process.kill(keeper.pid, "SIGKILL");
    await until("the server to notice and stop", () => !pidAlive(child));
    // On Linux the server sees its channel close and stops itself cleanly. On
    // Windows it never gets the chance: libuv keeps a child in a job object
    // that dies with its parent — abrupt, but equally nothing is left behind.
    if (process.platform !== "win32") assert.match(fs.readFileSync(path.join(dir, "stops.log"), "utf8"), new RegExp(`${child} keeper-gone`));
    assert.equal(await get(s.port, "/healthz", 500), null, "the port is free");
  } finally {
    killTree(keeper.pid);
    if (child && pidAlive(child)) killTree(child);
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
