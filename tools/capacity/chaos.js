#!/usr/bin/env node
// Things going wrong, on a private instance: what the server does about each.
//
//   node tools/capacity/chaos.js <test|all>
//
//   corrupt     boot with a truncated profiles.json and an empty sessions.json
//   hardkill    kill a process 40 times while it is saving a store: is the file ever unreadable?
//   ffmpegkill  kill the encoder under a viewer: does the next segment come?
//   wsbig       one WebSocket message of 32 MB from a device that is not signed in
//   adminguess  how fast can admin passwords be guessed, and is anything slowing it?
//   flood       requests without a session against the sign-in wall; a signed-in device hammering Home
//
// Results: stdout and docs/qa/capacity/results/chaos.json (merged per test).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { Client, Stats, procSampler, lagProbe, sleep, WebSocket } = require("./sim");
const { start } = require("./instance");
const { REPO, WORK, RESULTS, round, pct } = require("./lib");

const out = {};
const say = (test, row) => { (out[test] = out[test] || []).push(row); console.log(`[${test}]`, JSON.stringify(row)); };
const SMALL = { films: 10, shows: 1, profiles: 3 };

const corrupt = async () => {
  const good = JSON.stringify({ profiles: [{ id: "real1", name: "Real Person", color: "#fff", avatar: "x" }], state: { real1: { progress: { abc: { position: 100, duration: 200 } } } }, pending: [], access: {} });
  const srv = await start({ ...SMALL, mode: "open", seed: { "profiles.json": good.slice(0, Math.floor(good.length * 0.6)), "sessions.json": "" } });
  const profiles = await (await fetch(`${srv.url}/api/profiles`)).json();
  const files = fs.readdirSync(srv.dataDir).filter((f) => /corrupt|profiles|sessions/.test(f));
  const lines = srv.log().filter((l) => /corrupt/i.test(l));
  say("corrupt", { what: "profiles.json cut off at 60%, sessions.json empty (0 bytes)", serverStarted: true, profilesNow: (profiles.profiles || profiles).map((p) => p.name), filesInData: files, logged: lines.map((l) => l.replace(srv.dataDir, "<data>")) });
  // …and what happens to the set-aside copy once the server saves again
  await fetch(`${srv.url}/api/profiles/default/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: "x1", position: 5, duration: 100 }) });
  await sleep(2500);
  const after = JSON.parse(fs.readFileSync(path.join(srv.dataDir, "profiles.json"), "utf8"));
  say("corrupt", { what: "after the first save", profilesJsonNowHolds: after.profiles.map((p) => p.name), theBrokenCopySurvives: fs.readdirSync(srv.dataDir).some((f) => /profiles\.json\.corrupt-/.test(f)), alertRaised: srv.log().some((l) => /\[health\] ALERT|\[healer\].*corrupt|unreadable/i.test(l)) });
  const h = await (await fetch(`${srv.url}/api/admin/healer`, { headers: { "X-Admin-Password": srv.adminPassword } })).json().catch(() => null);
  await srv.stop();
};

const hardkill = async () => {
  const dir = path.join(WORK, "hardkill");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "store.json");
  const child = path.join(dir, "writer.js");
  fs.writeFileSync(child, `
    const { JsonStore } = require(${JSON.stringify(path.join(REPO, "src/lib/jsonstore"))});
    const s = new JsonStore(${JSON.stringify(file)}, () => ({ n: 0, rows: {} }));
    if (!s.data.rows) { console.log("STARTED-FROM-DEFAULTS"); s.data = { n: 0, rows: {} }; }
    for (let i = 0; i < 20000; i++) s.data.rows["k" + i] = { position: i, duration: 5400, updatedAt: Date.now() };
    console.log("READY " + s.data.n);
    const loop = () => { s.data.n++; s.flush(); setImmediate(loop); }; // save as fast as it can
    loop();
  `);
  let unreadable = 0, defaults = 0, wentBack = 0, last = -1, tmpLeft = 0, corruptCopies = 0;
  const kills = 40;
  for (let k = 0; k < kills; k++) {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      p.stdout.on("data", (d) => {
        const s = String(d);
        if (s.includes("STARTED-FROM-DEFAULTS")) defaults++;
        if (s.includes("READY")) setTimeout(() => { try { process.kill(p.pid, "SIGKILL"); } catch {} }, 30 + Math.random() * 400);
      });
      p.on("close", resolve);
    });
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d.n < last) wentBack++;
      last = d.n;
    } catch { unreadable++; }
    if (fs.existsSync(file + ".tmp")) tmpLeft++;
  }
  corruptCopies = fs.readdirSync(dir).filter((f) => /corrupt-/.test(f)).length;
  say("hardkill", { what: `process killed ${kills} times mid-save (1.3 MB store, saving flat out)`, platform: `${process.platform} ${os.release()}`, fileUnreadableAfterKill: unreadable, bootsThatFellBackToDefaults: defaults, savesLostBackwards: wentBack, leftoverTmpFiles: tmpLeft, corruptCopiesMade: corruptCopies, finalCounter: last });
  fs.rmSync(dir, { recursive: true, force: true });
};

const childrenOf = (pid) => {
  try {
    if (process.platform === "win32") {
      const o = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId),$($_.Name)" }`], { encoding: "utf8" });
      return o.split(/\r?\n/).filter(Boolean).map((l) => { const [id, name] = l.split(","); return { pid: +id, name }; });
    }
    return execFileSync("pgrep", ["-P", String(pid), "-l"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => { const [id, name] = l.split(" "); return { pid: +id, name }; });
  } catch { return []; }
};

const ffmpegkill = async () => {
  const srv = await start({ ...SMALL });
  const c = new Client(srv.url, { sid: srv.sessions[0].sid });
  const base = `/stream/transcode/${srv.vid(srv.titles.hevc[0])}/jit`;
  const seg = (k) => c.get(`${base}/seg${String(k).padStart(5, "0")}.ts?v=h264`, { compressed: false });
  const r0 = await seg(0);
  const kids = childrenOf(srv.pid).filter((k) => /ffmpeg/i.test(k.name));
  for (const k of kids) { try { process.kill(k.pid, "SIGKILL"); } catch {} }
  await sleep(300);
  // the last segment of the clip: far past whatever was already written
  const pl = await c.text(`${base}/index.m3u8?v=h264`);
  const n = (pl.text.match(/#EXTINF/g) || []).length;
  const r1 = await seg(n - 1);
  const r2 = await seg(1);
  say("ffmpegkill", { what: "encoder killed under a viewer", firstSegment: `${r0.status} in ${round(r0.ms, 0)} ms`, encodersKilled: kids.length, lastSegmentAfterKill: `${r1.status} in ${round(r1.ms, 0)} ms`, earlierSegmentAfterKill: `${r2.status} in ${round(r2.ms, 0)} ms`, log: srv.log().filter((l) => /\[jit\]/.test(l)).slice(-6) });
  // does the server leave encoders behind when it is killed itself?
  await seg(2);
  const before = childrenOf(srv.pid).filter((k) => /ffmpeg/i.test(k.name)).map((k) => k.pid);
  await srv.stop();
  say("ffmpegkill", { what: "(the harness kills the whole process tree on stop, so orphaned encoders after a server crash are judged by reading, not here)", encodersRunningAtStop: before.length });
};

const wsbig = async () => {
  const srv = await start({ ...SMALL });
  const samp = procSampler(srv.pid, 500);
  await sleep(1500);
  const before = samp.last();
  const lag = lagProbe(srv.url, 50);
  const res = await new Promise((resolve) => {
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/"); // no session: this device is not signed in
    const t0 = Date.now();
    ws.on("open", () => {
      const big = `{"type":"activity","details":"${"a".repeat(32 * 1024 * 1024)}"}`;
      ws.send(big, (err) => { setTimeout(() => { ws.terminate(); resolve({ sent: !err, ms: Date.now() - t0 }); }, 3000); });
    });
    ws.on("close", (code) => resolve({ closedBy: code, ms: Date.now() - t0 }));
    ws.on("error", (e) => resolve({ error: e.message }));
  });
  await sleep(1500);
  const l = lag.cut(); lag.stop();
  const after = samp.last();
  say("wsbig", { what: "32 MB WebSocket message from a socket with no session (sign-in wall closed)", result: res, eventLoopStalledMs: l.max, rssBeforeMb: Math.round(before.rss / 1048576), rssAfterMb: Math.round(after.rss / 1048576), wsMaxPayloadConfigured: false });
  // and many sockets from one address
  const socks = [];
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) { const w = new WebSocket(srv.url.replace("http", "ws") + "/"); w.on("error", () => {}); socks.push(w); if (i % 200 === 199) await sleep(100); }
  await sleep(4000);
  const open = socks.filter((w) => w.readyState === 1).length;
  const s2 = samp.last();
  say("wsbig", { what: "3000 WebSockets opened from one address, none signed in", accepted: open, secs: round((Date.now() - t0) / 1000, 1), rssMb: Math.round(s2.rss / 1048576), handles: s2.handles });
  socks.forEach((w) => { try { w.terminate(); } catch {} });
  samp.stop();
  await srv.stop();
};

const adminguess = async () => {
  const srv = await start({ ...SMALL });
  const c = new Client(srv.url, { maxSockets: 32 });
  const stats = new Stats();
  const until = Date.now() + 6000;
  let i = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (Date.now() < until) stats.add("guess", await c.get("/api/admin/health", { headers: { "X-Admin-Password": `wrong-${i++}` }, compressed: false }));
  }));
  const r = stats.row("guess", 6);
  const right = await c.get("/api/admin/health", { headers: { "X-Admin-Password": srv.adminPassword } });
  say("adminguess", { what: "wrong admin passwords, 32 connections, 6 s", guessesPerSec: r.rps, answers: r.codes, afterwardsTheRightPasswordStillWorks: right.status === 200, lockoutOrDelaySeen: !(right.status === 200) || Object.keys(r.codes).some((k) => k === "429") });
  c.close();
  await srv.stop();
};

const flood = async () => {
  const srv = await start({ films: 150, shows: 30, profiles: 5 });
  const samp = procSampler(srv.pid, 500);
  for (const [name, sid, p, conns] of [
    ["no session, /api/home (the wall answers 401)", null, "/api/home", 64],
    ["no session, /api/ping (open by design)", null, "/api/ping", 64],
    ["ONE signed-in device, /api/home on 64 connections", srv.sessions[0].sid, `/api/home?profile=${srv.sessions[0].profileId}`, 64],
  ]) {
    const c = new Client(srv.url, { sid, maxSockets: conns });
    const stats = new Stats();
    const lag = lagProbe(srv.url, 100);
    const t0 = Date.now();
    const until = t0 + 6000;
    await Promise.all(Array.from({ length: conns }, async () => { while (Date.now() < until) stats.add("x", await c.get(p)); }));
    const t1 = Date.now();
    await sleep(700);
    const cpu = samp.cpuBetween(t0, t1 + 500);
    const l = lag.cut(); lag.stop(); c.close();
    const r = stats.row("x", (t1 - t0) / 1000);
    say("flood", { what: name, rps: r.rps, codes: r.codes, p99: r.p99, otherUsersWaitP50: l.p50, otherUsersWaitP99: l.p99, otherUsersWaitMax: l.max, srvCores: cpu ? round(cpu.cpuSec / cpu.wallSec, 2) : null, rateLimited: !!r.codes[429] });
  }
  samp.stop();
  await srv.stop();
};

const tests = { corrupt, hardkill, ffmpegkill, wsbig, adminguess, flood };
(async () => {
  const which = process.argv[2];
  const run = which === "all" ? Object.keys(tests) : [which];
  if (!run.every((k) => tests[k])) { console.log(`usage: node tools/capacity/chaos.js <${Object.keys(tests).join("|")}|all>`); process.exit(1); }
  const file = path.join(RESULTS, "chaos.json");
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  for (const k of run) { try { await tests[k](); } catch (e) { say(k, { error: e.message }); } }
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...out, when: new Date().toISOString() }, null, 2));
  process.exit(0);
})();
