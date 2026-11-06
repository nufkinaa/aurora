// scripts/nufurora/update.sh: the auto-updater for nufurora.com.
//
// Each case builds a throw-away git setup in the temp folder — a bare
// "GitHub", a "dev" clone that makes releases, and the "server" clone the
// script updates — and runs the real script with bash against its own fake
// Aurora served from this process: /healthz answers with the version the
// server folder had at its last restart, /api/admin/overview with the
// watching numbers the case sets, and RESTART_CMD posts to /__restart.
// Nothing here touches a real server, systemd, sudo or pm2 (stubs stand in).
// The cases run side by side (each has its own folders and fake): bash and
// git start slowly on Windows.
"use strict";
const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFile, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const fwd = (p) => String(p).replace(/\\/g, "/");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const FAKE_PW = "pw-Zq7-never-printed";

// bash: on Windows only Git Bash, never System32\bash.exe (that is WSL)
const findBash = () => {
  if (process.platform !== "win32") {
    try { execFileSync("bash", ["-c", "true"], { stdio: "ignore" }); return "bash"; } catch { return null; }
  }
  const found = [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"), "C:\\Program Files\\Git\\bin\\bash.exe"];
  try {
    const ep = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(); // …/mingw64/libexec/git-core
    found.push(path.join(ep, "..", "..", "..", "bin", "bash.exe"));
  } catch {}
  return found.find((p) => !/system32/i.test(p) && fs.existsSync(p)) || null;
};
const BASH = findBash();
let hasGit = false;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); hasGit = true; } catch {}
const skip = !BASH ? "no bash found (Git Bash on Windows)" : !hasGit ? "git is not installed" : false;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-upd-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
const gitCfg = path.join(TMP, "gitconfig");
fs.writeFileSync(gitCfg, "");
// the user's own git settings (autocrlf, signing, hooks) stay out of it
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: fwd(gitCfg), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd, ...args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true }, (err, out, errOut) =>
      err ? reject(new Error(`git ${args.join(" ")}: ${errOut || err.message}`)) : resolve(String(out).trim()));
  });

// ---- stand-ins for systemctl, sudo and pm2 ----
const STUBS = path.join(TMP, "stubs");
fs.mkdirSync(STUBS);
const stub = (name, body) => {
  const p = path.join(STUBS, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return fwd(p);
};
const SYSTEMCTL = stub("systemctl", 'if [ "$1" = is-active ] && [ "${FAKE_SYSTEMD_ACTIVE:-}" = 1 ]; then exit 0; fi\nexit 3');
const SUDO = stub("sudo", "exit 1");
const PM2 = stub("pm2", `if [ "$1" = jlist ] && [ "\${FAKE_PM2:-}" = 1 ]; then echo '[{"pid":1,"name":"aurora"}]'; exit 0; fi\necho '[]'`);
const RESTART_JS = path.join(TMP, "restart.js");
fs.writeFileSync(RESTART_JS, [
  'const http = require("http");',
  'const req = http.request({ host: "127.0.0.1", port: Number(process.argv[2]), path: "/__restart", method: "POST" }, (res) => {',
  "  res.resume();",
  '  res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1));',
  "});",
  'req.on("error", () => process.exit(1));',
  "req.end();",
].join("\n"));

// ---- a fake Aurora for one case ----
const readVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
const startFake = async (srv) => {
  const fake = { version: "1.0.0", startedAt: Date.now() - 10000 * 1000, broken: false, stopping: false, watching: 0, paused: 0, restarts: 0 };
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/__restart" && req.method === "POST") {
      fake.restarts++;
      fake.version = readVersion(srv);
      fake.broken = fs.existsSync(path.join(srv, "BROKEN"));
      fake.stopping = false;
      fake.startedAt = Date.now();
      return json(200, { ok: true });
    }
    if (req.url === "/healthz") {
      if (fake.stopping) return json(503, { ok: false, stopping: true, version: fake.version });
      if (fake.broken) return json(500, { error: "broken" });
      return json(200, { ok: true, uptime: Math.floor((Date.now() - fake.startedAt) / 1000), version: fake.version, loop: null });
    }
    if (req.url === "/api/admin/overview") {
      if (req.headers["x-admin-password"] !== FAKE_PW) return json(403, { error: "Admin access required" });
      return json(200, { watchingNow: fake.watching, pausedNow: fake.paused, currentClients: fake.watching + fake.paused });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.port = server.address().port;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
};

// ---- a fresh "GitHub" + dev clone + server clone, at 1.0.0 (tagged) ----
const UPDATE_SH = fs.readFileSync(path.join(ROOT, "scripts", "nufurora", "update.sh"), "utf8").replace(/\r\n/g, "\n");
const PROBE_JS = fs.readFileSync(path.join(ROOT, "scripts", "nufurora", "probe.js"), "utf8").replace(/\r\n/g, "\n");
const writeFiles = (dir, files) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
};
const pkg = (v) => JSON.stringify({ name: "aurora", version: v, private: true }, null, 2) + "\n";
const lock = (v) => JSON.stringify({ name: "aurora", version: v, lockfileVersion: 3, packages: { "": { name: "aurora", version: v } } }, null, 2) + "\n";

// Built once, then copied per case (git is slow to start on Windows). The
// remotes are relative ("../remote.git"), so a copy works as it is.
let templateReady = null;
const template = () =>
  (templateReady ||= (async () => {
    const dir = path.join(TMP, "template");
    fs.mkdirSync(dir);
    await buildTemplate(dir);
    return dir;
  })());
const buildTemplate = async (dir) => {
  const dev = path.join(dir, "dev");
  const srv = path.join(dir, "srv");
  await git(dir, "init", "-q", "--bare", "-b", "master", "remote.git");
  await git(dir, "init", "-q", "-b", "master", "dev");
  writeFiles(dev, {
    "package.json": pkg("1.0.0"),
    "package-lock.json": lock("1.0.0"),
    ".gitignore": "data/\n",
    "README.md": "aurora\n",
    "scripts/keeper.js": "// keeper 1\n",
    "scripts/nufurora/update.sh": UPDATE_SH,
    "scripts/nufurora/probe.js": PROBE_JS,
  });
  await git(dev, "add", "-A");
  await git(dev, "commit", "-q", "-m", "1.0.0");
  await git(dev, "tag", "server-1.0.0-stable");
  await git(dev, "remote", "add", "origin", "../remote.git");
  await git(dev, "push", "-q", "origin", "master", "--tags");
  await git(dir, "clone", "-q", "remote.git", "srv");
  await git(srv, "remote", "set-url", "origin", "../remote.git");
};

const fixture = async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, "case-"));
  fs.cpSync(await template(), dir, { recursive: true });
  const dev = path.join(dir, "dev");
  const srv = path.join(dir, "srv");
  const fx = { dir, dev, srv, npmLog: path.join(dir, "npm.log"), alerts: path.join(dir, "alerts.txt"), pm2home: path.join(dir, "pm2home") };
  fs.mkdirSync(fx.pm2home);
  fx.fake = await startFake(srv);
  t.after(() => fx.fake.close());
  return fx;
};

// A new commit in dev, pushed; tagged server-<v>-stable unless tag: false.
const release = async (fx, v, { tag = true, lockChange = false, files = {}, remove = [] } = {}) => {
  writeFiles(fx.dev, { "package.json": pkg(v), ...files });
  if (lockChange) writeFiles(fx.dev, { "package-lock.json": lock(v) });
  for (const f of remove) await git(fx.dev, "rm", "-q", f);
  await git(fx.dev, "add", "-A");
  await git(fx.dev, "commit", "-q", "--allow-empty", "-m", v);
  if (tag) await git(fx.dev, "tag", `server-${v}-stable`);
  await git(fx.dev, "push", "-q", "origin", "master", "--tags");
  return git(fx.dev, "rev-parse", "HEAD");
};

const head = (fx) => git(fx.srv, "rev-parse", "HEAD");
const logOf = (fx) => { try { return fs.readFileSync(path.join(fx.srv, "data", "auto-update.log"), "utf8"); } catch { return ""; } };
const stateOf = (fx) => { try { return fs.readFileSync(path.join(fx.srv, "data", "auto-update.state"), "utf8"); } catch { return ""; } };
const npmRuns = (fx) => { try { return fs.readFileSync(fx.npmLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const count = (s, re) => (s.match(new RegExp(re.source, "g")) || []).length;

const CONF_KEYS = "AURORA_DIR MODE REMOTE BRANCH PORT HEALTH_TIMEOUT RESTART_CMD NPM_CI_CMD COUNT_PAUSED WATCH_CHECK MIN_SERVER_UPTIME LOG_FILE STATE_FILE ALERT_CMD DRY_RUN NODE_BIN SYSTEMD_UNIT PM2_NAME SYSTEMCTL_BIN SUDO_BIN PM2_BIN".split(" ");

// Run the server clone's own update.sh. conf → the settings file; env → the
// child's environment (null removes a key).
const run = (fx, conf = {}, env = {}) =>
  new Promise((resolve, reject) => {
    const settings = {
      HEALTH_TIMEOUT: 4,
      MIN_SERVER_UPTIME: 0,
      NODE_BIN: fwd(process.execPath),
      RESTART_CMD: `${q(fwd(process.execPath))} ${q(fwd(RESTART_JS))} ${fx.fake.port}`,
      NPM_CI_CMD: `echo ci >> ${q(fwd(fx.npmLog))}`,
      ALERT_CMD: `echo "$1" >> ${q(fwd(fx.alerts))}`,
      SYSTEMCTL_BIN: SYSTEMCTL, SUDO_BIN: SUDO, PM2_BIN: PM2,
      ...conf,
    };
    const confFile = path.join(fx.dir, "update.conf");
    fs.writeFileSync(confFile, Object.entries(settings).map(([k, v]) => `${k}=${q(v)}`).join("\n") + "\n");
    const childEnv = { ...GIT_ENV };
    for (const k of Object.keys(childEnv)) if (CONF_KEYS.includes(k.toUpperCase()) || /^AURORA_/i.test(k) || /^FAKE_/i.test(k)) delete childEnv[k];
    Object.assign(childEnv, {
      AURORA_UPDATE_CONF: fwd(confFile),
      AURORA_URL: `http://127.0.0.1:${fx.fake.port}`,
      AURORA_ADMIN_PASSWORD: FAKE_PW,
      PM2_HOME: fwd(fx.pm2home),
    });
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete childEnv[k];
      else childEnv[k] = String(v);
    }
    const p = spawn(BASH, [fwd(path.join(fx.srv, "scripts", "nufurora", "update.sh"))], { cwd: fx.srv, env: childEnv, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      const log = logOf(fx);
      try {
        // the admin password is never written anywhere
        assert.ok(!out.includes(FAKE_PW), "the password appeared on stdout");
        assert.ok(!log.includes(FAKE_PW), "the password appeared in the log");
        assert.ok(!stateOf(fx).includes(FAKE_PW), "the password appeared in the state file");
      } catch (e) { return reject(e); }
      resolve({ code, out, log });
    });
  });

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("nufurora auto-update (scripts/nufurora/update.sh)", { concurrency: true, skip }, () => {
  it("up to date: nothing happens, and it is said once", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    let r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /up to date/);
    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(count(r.log, /up to date/), 1, "the up-to-date line is not repeated every run");
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
    assert.equal(npmRuns(fx), 0);
  });

  it("a newer stable tag: fast-forward on master, restart, healthy", async (t) => {
    const fx = await fixture(t);
    const sha = await release(fx, "1.1.0");
    const r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
    assert.equal(await git(fx.srv, "symbolic-ref", "--short", "HEAD"), "master", "still on the branch, not detached");
    assert.equal(await git(fx.srv, "rev-parse", "--abbrev-ref", "master@{upstream}"), "origin/master");
    assert.equal(await git(fx.srv, "status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(fx.fake.restarts, 1);
    assert.equal(fx.fake.version, "1.1.0");
    assert.match(r.log, /UPDATED to server-1\.1\.0-stable/);
    assert.match(r.log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /m, "lines carry an ISO time");
    assert.equal(npmRuns(fx), 0, "the lockfile did not change: no npm ci");
    const again = await run(fx);
    assert.equal(again.code, 0);
    assert.equal(fx.fake.restarts, 1);
  });

  it("stable mode ignores an untagged commit; MODE=master takes it (same version: a fresh process proves the restart)", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    const sha = await release(fx, "1.0.0", { tag: false, files: { "notes.txt": "x\n" } });
    let r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
    r = await run(fx, { MODE: "master" });
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
    assert.equal(fx.fake.restarts, 1);
    assert.match(r.log, /UPDATED to origin\/master/);
  });

  it("someone watching: put off, nothing changed; goes ahead once nobody is", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    const sha = await release(fx, "1.1.0");
    fx.fake.watching = 2;
    let r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /2 watching or paused; trying again next run/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
    fx.fake.watching = 0;
    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
  });

  it("a paused player counts only with COUNT_PAUSED=yes", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    const sha = await release(fx, "1.1.0");
    fx.fake.paused = 1;
    let r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /1 watching or paused/);
    assert.equal(await head(fx), before);
    r = await run(fx, { COUNT_PAUSED: "no" });
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
    assert.equal(fx.fake.restarts, 1);
  });

  it("npm ci runs only when package-lock.json changed, once", async (t) => {
    const fx = await fixture(t);
    await release(fx, "1.1.0");
    let r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(npmRuns(fx), 0);
    await release(fx, "1.2.0", { lockChange: true });
    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(npmRuns(fx), 1);
    assert.equal(fx.fake.version, "1.2.0");
  });

  it("an unhealthy release is rolled back, remembered and skipped; a newer one is tried", async (t) => {
    const fx = await fixture(t);
    const old = await head(fx);
    const bad = await release(fx, "1.1.0", { lockChange: true, files: { BROKEN: "1\n" } });
    let r = await run(fx, { HEALTH_TIMEOUT: 3 });
    assert.equal(r.code, 2, r.out);
    assert.equal(await head(fx), old, "back on the old commit");
    assert.equal(await git(fx.srv, "symbolic-ref", "--short", "HEAD"), "master");
    assert.equal(fx.fake.restarts, 2, "restarted on the new version, then on the old one");
    assert.equal(fx.fake.version, "1.0.0");
    assert.equal(fx.fake.broken, false);
    assert.equal(npmRuns(fx), 2, "npm ci for the new lockfile, and again for the old one");
    assert.match(r.log, /ROLLED BACK/);
    assert.match(stateOf(fx), new RegExp(`^bad_target=${bad}$`, "m"));
    const alerts = fs.readFileSync(fx.alerts, "utf8").trim().split("\n");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /server-1\.1\.0-stable.*rolled back/);

    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /skipping server-1\.1\.0-stable/);
    r = await run(fx);
    assert.equal(count(r.log, /skipping server-1\.1\.0-stable/), 1, "said once");
    assert.equal(fx.fake.restarts, 2);
    assert.equal(await head(fx), old);

    const good = await release(fx, "1.2.0", { remove: ["BROKEN"] });
    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), good);
    assert.equal(fx.fake.version, "1.2.0");
  });

  it("files changed by hand: refused; an untracked file alone does not block", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    const sha = await release(fx, "1.1.0");
    fs.writeFileSync(path.join(fx.srv, "README.md"), "changed by hand\n");
    let r = await run(fx);
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /files changed by hand/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
    await git(fx.srv, "checkout", "--", "README.md");
    fs.writeFileSync(path.join(fx.srv, "my-notes.txt"), "untracked\n");
    r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
  });

  it("local commits (diverged): refused, nothing changed", async (t) => {
    const fx = await fixture(t);
    fs.writeFileSync(path.join(fx.srv, "local.txt"), "local\n");
    await git(fx.srv, "add", "local.txt");
    await git(fx.srv, "commit", "-q", "-m", "a local commit");
    const local = await head(fx);
    await release(fx, "1.1.0");
    const r = await run(fx);
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /diverged/);
    assert.equal(await head(fx), local);
    assert.equal(fx.fake.restarts, 0);
  });

  it("a detached HEAD: refused, nothing changed", async (t) => {
    const fx = await fixture(t);
    await git(fx.srv, "checkout", "-q", "--detach");
    const before = await head(fx);
    await release(fx, "1.1.0");
    const r = await run(fx);
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /not on the branch master/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
  });

  it("DRY_RUN=1 (from the environment, over the file) decides and changes nothing", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    await release(fx, "1.1.0", { lockChange: true });
    const r = await run(fx, { DRY_RUN: "0" }, { DRY_RUN: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /DRY RUN: would update to server-1\.1\.0-stable: .*\(1\.0\.0\) -> .*\(1\.1\.0\); npm ci: yes; restart via custom/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
    assert.equal(npmRuns(fx), 0);
    assert.doesNotMatch(stateOf(fx), /pending=/);
  });

  it("the watching count cannot be read: WATCH_CHECK=required refuses; .env is read; skip goes ahead", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    const sha = await release(fx, "1.1.0");
    let r = await run(fx, {}, { AURORA_ADMIN_PASSWORD: null });
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /could not read how many are watching \(no admin password found/);
    assert.equal(await head(fx), before);
    r = await run(fx, {}, { AURORA_ADMIN_PASSWORD: "wrong" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /refused the admin password \(403\)/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);

    // the same password in the Aurora folder's .env (read as src/config.js reads it)
    fs.writeFileSync(path.join(fx.srv, ".env"), `# secrets\nAURORA_ADMIN_PASSWORD="${FAKE_PW}"\n`);
    fx.fake.watching = 1;
    r = await run(fx, {}, { AURORA_ADMIN_PASSWORD: null });
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /1 watching or paused/);
    fs.rmSync(path.join(fx.srv, ".env"));

    r = await run(fx, { WATCH_CHECK: "skip" }, { AURORA_ADMIN_PASSWORD: null });
    assert.equal(r.code, 0, r.out);
    assert.equal(await head(fx), sha);
  });

  it("a server that does not answer: nobody can be watching, the update goes ahead", async (t) => {
    const fx = await fixture(t);
    const sha = await release(fx, "1.1.0");
    fx.fake.stopping = true; // 503 until the restart
    const r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /does not answer \/healthz/);
    assert.equal(await head(fx), sha);
    assert.equal(fx.fake.version, "1.1.0");
  });

  it("a server that has just started is given time for the viewers to reconnect", async (t) => {
    const fx = await fixture(t);
    const before = await head(fx);
    await release(fx, "1.1.0");
    fx.fake.startedAt = Date.now();
    const r = await run(fx, { MIN_SERVER_UPTIME: 120 });
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /the server started \d+ s ago/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
  });

  it("restart detection: keeper, keeper under systemd, pm2, nothing", async (t) => {
    const fx = await fixture(t);
    const dataDir = path.join(fx.srv, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const keeperState = (pid) => fs.writeFileSync(path.join(dataDir, "keeper-state.json"), JSON.stringify({ keeperPid: pid, childPid: 1, state: "ok" }));
    await release(fx, "1.1.0");
    const auto = { RESTART_CMD: "auto" };
    const dry = { DRY_RUN: "1" };

    keeperState(process.pid); // a live pid
    let r = await run(fx, auto, dry);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /restart via keeper \(the keeper \(pid \d+\)\)/);

    // the keeper's own code changes and the unit is active
    await release(fx, "1.2.0", { files: { "scripts/keeper.js": "// keeper 2\n" } });
    r = await run(fx, auto, { ...dry, FAKE_SYSTEMD_ACTIVE: "1" });
    assert.equal(r.code, 0, r.out);
    if (isRoot) assert.match(r.log, /restart via systemd/);
    else assert.match(r.log, /restart via keeper .*may not run 'systemctl restart aurora'/);

    // no keeper; systemd active but not allowed (not root, sudo refuses)
    keeperState(2147483646);
    r = await run(fx, auto, { ...dry, FAKE_SYSTEMD_ACTIVE: "1" });
    if (isRoot) assert.match(r.log, /restart via systemd/);
    else {
      assert.equal(r.code, 1, r.out);
      assert.match(r.log, /may not restart it/);
    }

    // pm2 running and knowing "aurora"
    fs.writeFileSync(path.join(fx.pm2home, "rpc.sock"), "");
    r = await run(fx, auto, { ...dry, FAKE_PM2: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /restart via pm2/);

    // nothing at all: refused, nothing changed
    fs.rmSync(path.join(fx.pm2home, "rpc.sock"));
    const before = await head(fx);
    r = await run(fx, auto);
    assert.equal(r.code, 1, r.out);
    assert.match(r.log, /no way to restart Aurora was found/);
    assert.equal(await head(fx), before);
    assert.equal(fx.fake.restarts, 0);
  });

  it("an update stopped half-way (after the move, before the restart) is finished by the next run", async (t) => {
    const fx = await fixture(t);
    const old = await head(fx);
    const sha = await release(fx, "1.1.0");
    await git(fx.srv, "fetch", "-q", "origin");
    await git(fx.srv, "merge", "-q", "--ff-only", sha);
    fs.mkdirSync(path.join(fx.srv, "data"), { recursive: true });
    fs.writeFileSync(path.join(fx.srv, "data", "auto-update.state"), `pending=${old} ${sha}\n`);
    const r = await run(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /finishing an interrupted update/);
    assert.match(r.log, /UPDATED/);
    assert.equal(fx.fake.restarts, 1);
    assert.equal(fx.fake.version, "1.1.0");
    assert.doesNotMatch(stateOf(fx), /pending=/);
  });

  it("a stale lock left by a dead run does not block", async (t) => {
    const fx = await fixture(t);
    const lockDir = path.join(fx.srv, "data", "auto-update.state.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), "999999\n");
    const sha = await release(fx, "1.1.0");
    // the mkdir lock (used where flock is missing, as in Git Bash), on every OS
    const r = await run(fx, {}, { AURORA_UPDATE_NO_FLOCK: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, /removing a stale lock/);
    assert.equal(await head(fx), sha);
    assert.ok(!fs.existsSync(lockDir), "the lock is gone after the run");
  });
});
