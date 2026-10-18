#!/usr/bin/env node
// A private Aurora instance for the efficiency runs: this worktree's code (or
// any commit's, `ref`), a throwaway data folder holding the dataset.js
// household, its own port, the probe (probe.js) preloaded. The same fences as
// the UI tests' harness (scripts/ui-test-server.js), whose folder layout and
// clean-up it reuses: nothing of the owner's is read, the live server is never
// contacted, every outbound connection is refused, aria2c is never started.
//
//   const { start } = require("./instance");
//   const srv = await start({ weak: true });            // 2 cores + 512 MB heap
//   srv.url, srv.pid, srv.session(i) -> headers, srv.snap(), srv.reset(), srv.exec(file, arg), srv.stop()
//
//   node tools/backend-perf/instance.js [--weak] [--ref <commit>] [--films N --shows N]
//       the same by hand: prints the address, CTRL-C tears it down
//
// opts:
//   ds       a dataset (dataset.build()); default: the default one
//   ref      a git commit / branch: server.js + src/ come from it instead of the working tree
//   weak     pin to two physical cores and cap the heap at 512 MB (lib.WEAK)
//   probe    "full" (default) | "light" | "off"        loop: false -> no event-loop delay timer
//   cold     start WITHOUT the probe cache, so the server ffprobes every file
//   noBlur   start WITHOUT the blur-up placeholders (the first-run state)
//   mode     sign-in mode, default "closed" (the wall up: what nufurora.com runs)
//   config   extra config.json keys          nodeArgs   extra node flags
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { REPO, WEAK, pin, sleep, arg } = require("./lib");
const ui = require(path.join(REPO, "scripts", "ui-test-server"));
const dataset = require("./dataset");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const killTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
};
const live = new Set();
let hooked = false;
const hook = () => {
  if (hooked) return;
  hooked = true;
  const all = () => { for (const i of [...live]) i.stopSync(); };
  process.on("exit", all);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { all(); process.exit(130); });
};

const startOnce = async (opts = {}) => {
  hook();
  ui.sweepStale();
  const ds = opts.ds || dataset.build();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ui.PREFIX));
  fs.writeFileSync(path.join(root, ".owner-pid"), String(process.pid));
  const inst = { root, child: null, stopped: false };
  live.add(inst);
  inst.stopSync = () => {
    if (inst.stopped) return;
    inst.stopped = true;
    live.delete(inst);
    killTree(inst.child);
    if (opts.keepRoot) return;
    // the link goes first, by itself: removing a link never removes what it points at
    if (inst.blurLink) { try { fs.rmdirSync(inst.blurLink); } catch { try { fs.unlinkSync(inst.blurLink); } catch {} } }
    try { if (!ui.removeRoot(root)) process.stderr.write(`[eff] could not remove ${root}\n`); } catch (e) { process.stderr.write(`[eff] could not remove ${root}: ${e.message}\n`); }
  };
  try {
    // the code: the working tree, or a commit
    if (opts.ref) {
      const tar = path.join(root, "code.tar");
      execFileSync("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, opts.ref, "server.js", "src", "package.json", "CHANGELOG.md"], { stdio: "ignore" });
      execFileSync("tar", ["-xf", "code.tar"], { cwd: root, stdio: "ignore" });
      fs.rmSync(tar);
      fs.renameSync(path.join(root, "server.js"), path.join(root, "ui-instance.js"));
    } else {
      for (const f of ["package.json", "CHANGELOG.md"]) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
      fs.copyFileSync(path.join(REPO, "server.js"), path.join(root, "ui-instance.js"));
      fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
    }
    fs.copyFileSync(path.join(REPO, "test", "ui", "support", "server-preload.js"), path.join(root, "ui-preload.js"));
    fs.copyFileSync(path.join(__dirname, "probe.js"), path.join(root, "eff-probe.js"));
    if (opts.script) fs.copyFileSync(opts.script, path.join(root, "eff-script.js"));
    fs.cpSync(path.join(REPO, "public"), path.join(root, "public"), { recursive: true, filter: (src) => !/\.apk$/i.test(src) });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
    fs.cpSync(ds.seedDir, path.join(root, "data"), { recursive: true });
    fs.rmSync(path.join(root, "data", ".dataset.json"), { force: true });
    if (opts.cold) fs.rmSync(path.join(root, "data", "metadata-cache.json"), { force: true });
    // the blur-up placeholders of a settled server (dataset.js): a link to the shared folder
    if (ds.blurDir && !opts.noBlur && !opts.cold) {
      fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
      inst.blurLink = path.join(root, "data", "cache", "blur");
      fs.symlinkSync(ds.blurDir, inst.blurLink, "junction");
    }
    for (const [relPath, value] of Object.entries(opts.seed || {})) {
      const file = path.join(root, "data", relPath);
      if (value == null) { fs.rmSync(file, { force: true }); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    }
    const mode = opts.mode || "closed";
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ authMode: mode }));
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });

    const port = await freePort();
    const probePort = await freePort();
    const adminPassword = `eff-${crypto.randomBytes(9).toString("hex")}`;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      port, adminName: "Test Admin", adminPassword,
      libraries: { movies: [ds.library.movies], shows: [ds.library.shows] },
      // everything below is the PRODUCTION default unless a run says otherwise:
      // the 10-minute rescan, intro detection, the healer, backups… all on.
      autoOcrSubtitles: false, // (needs python + tesseract; the live server has neither)
      prewarmStreams: false,
      authMode: mode,
      aria2Port: await freePort(),
      notifications: {},
      ...(opts.config || {}),
    }, null, 2));

    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(TMDB_|OPENROUTER_|GOOGLE_|AURORA_|VAPID_|TELEGRAM_|NTFY_|pm_|PM2_)/i.test(k) || k === "NODE_OPTIONS" || k === "NODE_TEST_CONTEXT") delete env[k];
    }
    Object.assign(env, {
      AURORA_UI_PARENT_PID: String(process.pid), EFF_PROBE_PORT: String(probePort), EFF_PROBE: opts.probe === "light" ? "light" : "full",
      ...(opts.loop === false ? { EFF_PROBE_LOOP: "0" } : {}),
      TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"),
      ...(opts.env || {}),
    });
    const nodeArgs = [...(opts.weak ? [`--max-old-space-size=${WEAK.heapMb}`] : []), "--expose-gc", ...(opts.nodeArgs || []),
      "-r", "./ui-preload.js", ...(opts.probe === "off" ? [] : ["-r", "./eff-probe.js"]), opts.script ? "eff-script.js" : "ui-instance.js"];
    const log = [];
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, nodeArgs, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    inst.child = child;
    const pinned = opts.weak ? pin(child.pid, WEAK.mask) : false;
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) log.push(line);
      if (log.length > 8000) log.splice(0, log.length - 8000);
      if (opts.verbose) process.stdout.write(chunk);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("exit", (code, signal) => { if (!inst.stopped) keep(`[eff] THE SERVER EXITED BY ITSELF (code ${code}, signal ${signal})`); });

    const url = `http://127.0.0.1:${port}`;
    const probeUrl = `http://127.0.0.1:${probePort}`;
    const deadline = Date.now() + (opts.bootTimeoutMs || 180000);
    // opts.script: not the server but a measurement script, run in the same
    // folder with the same fences (memory.js); resolves with what it printed.
    if (opts.script) {
      const code = await new Promise((resolve) => child.on("exit", resolve));
      const outLog = log.slice();
      inst.stopSync();
      return { code, log: outLog, root };
    }
    let pingAt = 0;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the instance exited (${child.exitCode}) before it was up:\n${log.slice(-30).join("\n")}`);
      if (Date.now() > deadline) throw new Error(`the instance did not come up:\n${log.slice(-30).join("\n")}`);
      try { const r = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(3000) }); if (r.status === 200) { pingAt = Date.now(); break; } } catch {}
      await sleep(25);
    }
    const probeGet = async (p) => (await fetch(probeUrl + p)).json();
    // The probe's port is chosen before the server starts, and on a busy machine
    // something in the server (or another instance) can take it first: then
    // every measurement call reaches the wrong listener (ECONNRESET). Checked
    // once here; the caller starts the instance again.
    if (opts.probe !== "off") {
      try { await (await fetch(probeUrl + "/snap", { signal: AbortSignal.timeout(15000) })).json(); } catch (e) { throw Object.assign(new Error(`the probe did not answer (${e.message}): its port was taken`), { retry: true }); }
    }
    const session = (i = 0) => ({ "X-Session": ds.sessions[i % ds.sessions.length].sid });
    return {
      url, port, root, pid: child.pid, adminPassword, ds, pinned, weak: !!opts.weak, mode,
      spawnedAt, pingMs: pingAt - spawnedAt,
      session, profile: (i = 0) => ds.sessions[i % ds.sessions.length].profileId,
      log: () => log.slice(),
      snap: () => probeGet("/snap"), reset: () => probeGet("/reset"), gc: () => probeGet("/gc"), probe: probeGet,
      exec: async (file, a) => {
        const r = await (await fetch(`${probeUrl}/exec`, { method: "POST", body: JSON.stringify({ file: path.resolve(file), arg: a }) })).json();
        if (r.error) throw new Error(r.error);
        return r.result;
      },
      // "warm": the library scanned and probed, the recommender and the search index built
      waitWarm: async (ms = 240000) => {
        const end = Date.now() + ms;
        let resets = 0;
        for (;;) {
          let w;
          try {
            w = await (await fetch(`${probeUrl}/exec`, { method: "POST", body: JSON.stringify({ file: path.join(__dirname, "inproc", "warm-state.js") }) })).json();
          } catch (e) {
            if (/ECONNRESET|socket/i.test(String((e.cause && e.cause.code) || e.message)) && child.exitCode === null && ++resets <= 5) { await sleep(500); continue; }
            // say what the instance said last: a crash, a probe that lost its port
            throw new Error(`waitWarm: ${e.message} (child exit ${child.exitCode}, signal ${child.signalCode})\n${log.slice(-25).join("\n")}`);
          }
          if (w.result && w.result.warm) return w.result;
          if (Date.now() > end) throw new Error(`not warm after ${ms} ms: ${JSON.stringify(w.result || w)}`);
          await sleep(500);
        }
      },
      // "quiet": two consecutive 5 s windows under 4 % of one core — the boot-time
      // background work (intro pass, tone-map timing, index builds) is over
      waitQuiet: async (ms = 300000) => {
        const end = Date.now() + ms;
        let calm = 0;
        while (Date.now() < end) {
          const a = await probeGet("/snap");
          await sleep(5000);
          const b = await probeGet("/snap");
          const used = (b.cpuTotal.user + b.cpuTotal.system - a.cpuTotal.user - a.cpuTotal.system) / 1000;
          calm = used / (b.uptimeMs - a.uptimeMs) < 0.04 ? calm + 1 : 0;
          if (calm >= 2) return true;
        }
        return false;
      },
      stop: async () => { inst.stopSync(); },
    };
  } catch (err) {
    inst.stopSync();
    throw err;
  }
};

const start = async (opts = {}) => {
  for (let i = 0; ; i++) {
    try { return await startOnce(opts); } catch (e) {
      if (!e.retry || i >= 3) throw e;
      process.stderr.write(`[eff] ${e.message} — starting the instance again
`);
    }
  }
};

module.exports = { start };

if (require.main === module) {
  const ds = dataset.build({ films: arg("films"), shows: arg("shows"), episodes: arg("episodes"), profiles: arg("profiles"), rows: arg("rows") });
  start({ ds, weak: !!arg("weak"), ref: arg("ref") === true ? undefined : arg("ref"), cold: !!arg("cold"), verbose: !!arg("verbose"), mode: arg("mode") === true ? undefined : arg("mode") })
    .then((srv) => {
      console.log(`\n  Private Aurora instance (efficiency)\n\n    App      ${srv.url}\n    pid      ${srv.pid}${srv.weak ? `   (weak profile: affinity ${WEAK.mask}, heap ${WEAK.heapMb} MB${srv.pinned ? "" : " — PIN FAILED"})` : ""}\n    Admin    ${srv.url}/admin  (password in ${path.join(srv.root, "config.json")})\n    session  X-Session: ${srv.ds.sessions[0].sid.slice(0, 8)}… (profile ${srv.profile(0)})\n    up in    ${srv.pingMs} ms\n\n  CTRL-C stops it and removes the folder.\n`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
