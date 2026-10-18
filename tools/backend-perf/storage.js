#!/usr/bin/env node
// THE STORES UNDER VIEWERS, before against after (server round 2026-10-18,
// STORAGE workstream; docs/qa/server-round/STORAGE.md).
//
//   node tools/backend-perf/storage.js [--viewers 1,5,20] [--minutes 4] [--rows 1500|today]
//                                      [--ref <commit>] [--label before] [--idle 10] [--weak] [--hog]
// (--hog: a second process writes 16 MB + fsync flat out on the same disk meanwhile)
//   -> docs/qa/backend-efficiency/results/storage[-today][-label].json and tables
//
// Each simulated viewer does what the players do (public/js/screens/player.js,
// tv-native Player.tsx): a WebSocket with `hello`, then every 5 s one progress
// POST and one `activity` message, every 20 s a usage batch; once every
// 3 minutes it SEEKS (the position jumps 10 minutes), and at the end of the
// window it STOPS (activity "Browsing", then a last progress save, as the
// player's clean-up does). Viewers are out of step with each other.
//
// --idle N: also N minutes with nobody (what an idle server writes).
//
// Reported per run (whole server, the window scaled to an hour):
//   bytes written per hour (all files, and per file), whole-file rewrites,
//   fsyncs per hour (fsyncSync calls), store save time on the loop (the timers
//   of lib/jsonstore.js and lib/hotstore.js: stringify + write + fsync),
//   event-loop delay p50/p99/max, CPU seconds.
const path = require("path");
const http = require("http");
const { start } = require("./instance");
const dataset = require("./dataset");
const { REPO, round, saveJson, arg, table, sleep } = require("./lib");
const WebSocket = require(path.join(REPO, "node_modules", "ws"));

const post = (srv, i, p, body) => new Promise((resolve) => {
  const s = JSON.stringify(body);
  const req = http.request(srv.url + p, { method: "POST", headers: { ...srv.session(i), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", () => resolve(0));
  req.end(s);
});

const viewer = (srv, i, stopAt) => new Promise((resolve) => {
  const ds = srv.ds;
  const profile = srv.profile(i);
  const item = ds.sample.films[(i * 17) % ds.sample.films.length];
  const ws = new WebSocket(srv.url.replace("http", "ws"), { headers: srv.session(i) });
  let pos = 300 + i * 40;
  let ok = 0, bad = 0, beats = 0;
  const timers = [];
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", profile: `Viewer ${i + 1}`, profileId: profile }));
    const beat = async () => {
      beats++;
      pos += 5;
      if (beats % 36 === 0) pos += 600; // a seek every 3 minutes
      const st = await post(srv, i, `/api/profiles/${profile}/progress`, { itemId: item, position: pos, duration: 7200 });
      if (st === 200) ok++; else bad++;
      try { ws.send(JSON.stringify({ type: "activity", action: "Watching", details: `Efficiency Film ${i + 1}`, position: pos, duration: 7200 })); } catch {}
    };
    const usage = () => post(srv, i, "/api/usage", { profile, sid: `sim${i}xx`, device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "/watch/:id", ms: 80 } }, { n: "feat", t: Date.now(), p: { f: "player_seek" } }] });
    timers.push(setTimeout(() => { beat(); timers.push(setInterval(beat, 5000)); }, (i * 1300) % 5000));
    timers.push(setTimeout(() => { usage(); timers.push(setInterval(usage, 20000)); }, 3000 + ((i * 3700) % 20000)));
  });
  ws.on("error", () => {});
  const end = setInterval(async () => {
    if (Date.now() < stopAt) return;
    clearInterval(end);
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    // the player closing: "Browsing", and its last save
    try { ws.send(JSON.stringify({ type: "activity", action: "Browsing" })); } catch {}
    await post(srv, i, `/api/profiles/${profile}/progress`, { itemId: item, position: pos + 2, duration: 7200 });
    try { ws.close(); } catch {}
    resolve({ ok, bad, profile, item, pos: pos + 2 });
  }, 250);
});

const fs = require("fs");
const { spawn } = require("child_process");
const HOG = `
const fs = require("fs"), path = require("path");
const dir = process.argv[1]; const buf = Buffer.alloc(16 * 1024 * 1024, 7);
let i = 0;
for (;;) { const f = path.join(dir, "hog-" + (i++ % 4)); const fd = fs.openSync(f, "w"); fs.writeSync(fd, buf); fs.fsyncSync(fd); fs.closeSync(fd); }
`;
const SAVE_SITE = /(jsonstore|hotstore)\.js/;
const summarise = (s, minutes) => {
  const h = minutes / 60;
  const saves = s.timers.filter((t) => SAVE_SITE.test(t.site));
  const saveMs = saves.reduce((a, t) => a + t.ms, 0);
  const saveFires = saves.reduce((a, t) => a + t.fires, 0);
  const saveMax = saves.reduce((a, t) => Math.max(a, t.maxMs), 0);
  const fsync = s.syncFs.find((r) => r.key === "fsyncSync") || { n: 0 };
  const fsyncOff = ((s.asyncFs || []).find((r) => r.key === "fsync") || { n: 0 }).n;
  // blocking file calls of the stores' writes, on the loop: count, total and longest ms
  const blocking = s.syncFs.filter((r) => / @ .*(jsonstore|hotstore|watchjournal|tel[\/])/.test(r.key) && /^(openSync|writeSync|fsyncSync|closeSync|renameSync|writeFileSync)/.test(r.key));
  const cpuS = (s.cpuSinceReset.user + s.cpuSinceReset.system) / 1e6;
  return {
    mbPerHour: round(s.writes.reduce((a, w) => a + w.bytes, 0) / 1048576 / h, 2),
    rewritesPerHour: round(s.writes.reduce((a, w) => a + w.n, 0) / h, 0),
    fsyncsPerHour: round((fsync.n + fsyncOff) / h, 0),
    fsyncsOnLoopPerHour: round(fsync.n / h, 0),
    storeSyncCallsPerHour: round(blocking.reduce((a, r) => a + r.n, 0) / h, 0),
    storeSyncMsPerHour: round(blocking.reduce((a, r) => a + r.ms, 0) / h, 1),
    saveFiresPerHour: round(saveFires / h, 0),
    saveLoopSecPerHour: round(saveMs / 1000 / h, 3),
    saveMsEach: saveFires ? round(saveMs / saveFires, 2) : 0,
    longestSaveMs: round(saveMax, 1),
    loopBlockedBySavesPct: round((saveMs / (minutes * 60000)) * 100, 3),
    loopP50Ms: s.loopDelay ? round(s.loopDelay.p50, 1) : null,
    loopP99Ms: s.loopDelay ? round(s.loopDelay.p99, 1) : null,
    loopMaxMs: s.loopDelay ? round(s.loopDelay.max, 1) : null,
    cpuSecPerHour: round(cpuS / h, 1),
    files: s.writes.map((w) => ({ file: w.key, rewritesPerHour: round(w.n / h, 0), mbPerHour: round(w.bytes / 1048576 / h, 3), bytesEach: Math.round(w.bytes / Math.max(1, w.n)) })),
  };
};

const COLS = [["MB / h", "mbPerHour"], ["rewrites / h", "rewritesPerHour"], ["fsyncs / h", "fsyncsPerHour"], ["of them on the loop", "fsyncsOnLoopPerHour"], ["store fs ms on loop / h", "storeSyncMsPerHour"], ["saves / h", "saveFiresPerHour"], ["save loop s / h", "saveLoopSecPerHour"], ["ms / save", "saveMsEach"], ["longest save ms", "longestSaveMs"], ["loop p99 ms", "loopP99Ms"], ["loop max ms", "loopMaxMs"], ["CPU s / h", "cpuSecPerHour"]];

(async () => {
  const weak = !!arg("weak");
  const minutes = +arg("minutes", 4);
  const idle = arg("idle") ? +arg("idle") : 0;
  const counts = String(arg("viewers", "1,5,20")).split(",").filter(Boolean).map(Number).filter((n) => n > 0);
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const today = arg("rows") === "today";
  const hog = !!arg("hog");
  let hogProc = null, hogDir = null;
  const ds = today ? dataset.build({ rows: 40, profiles: 5 }) : dataset.build();
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, minutes, hog, household: today ? "today (5 profiles, about 40 rows each)" : "grown (8 profiles, up to 1,500 rows)", runs: [], idle: null };
  const srv = await start({ weak, ref, ds, config: { scanIntervalMinutes: 24 * 60 } });
  try {
    await srv.waitWarm(15 * 60 * 1000); // (a machine busy with other work warms slowly)
    await srv.waitQuiet();
    // the subtitle background jobs (audio resync, language detection) finish first
    for (let i = 0; i < 240; i++) {
      const r = await srv.exec(path.join(__dirname, "inproc", "subs-idle.js"));
      if (r.idle) break;
      await sleep(5000);
    }
    await srv.waitQuiet();
    // --hog: a second process writes 16 MB + fsync flat out on the same disk (a download landing, a backup)
    if (hog) {
      const dir = path.join(require("./lib").WORK, `hog-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      hogProc = spawn(process.execPath, ["-e", HOG, dir], { stdio: "ignore", windowsHide: true });
      hogDir = dir;
      await sleep(2000);
    }
    if (idle) {
      await srv.reset();
      await sleep(idle * 60000);
      out.idle = { minutes: idle, ...summarise(await srv.snap(), idle) };
      console.log(`\nidle, ${idle} min\n`);
      console.log(table([out.idle], COLS));
      console.log(table(out.idle.files, [["file", "file"], ["rewrites / h", "rewritesPerHour"], ["MB / h", "mbPerHour"]]));
    }
    for (const n of counts) {
      await sleep(3000);
      await srv.reset();
      const stopAt = Date.now() + minutes * 60 * 1000;
      const res = await Promise.all(Array.from({ length: n }, (_, i) => viewer(srv, i, stopAt)));
      await sleep(2500); // the last debounced saves land
      const s = await srv.snap();
      const run = { viewers: n, progressOk: res.reduce((a, r) => a + r.ok, 0), progressFailed: res.reduce((a, r) => a + r.bad, 0), ...summarise(s, minutes) };
      // what a second device sees right after the stop: the resume point
      const seen = [];
      for (const r of res.slice(0, 3)) {
        try {
          const j = await (await fetch(`${srv.url}/api/profiles/${r.profile}/state`, { headers: srv.session(res.indexOf(r)) })).json();
          const row = (j.progress || j)[r.item];
          seen.push({ sent: r.pos, seen: row ? row.position : null });
        } catch { seen.push({ sent: r.pos, seen: "error" }); }
      }
      run.resumeSeenByAnotherDevice = seen;
      out.runs.push(run);
      console.log(`\n${n} viewer(s), ${minutes} min, household: ${out.household}\n`);
      console.log(table([run], COLS));
      console.log(table(run.files, [["file", "file"], ["rewrites / h", "rewritesPerHour"], ["MB / h", "mbPerHour"], ["bytes each", "bytesEach"]]));
      console.log("resume seen by another device:", JSON.stringify(seen));
    }
  } finally {
    await srv.stop();
    if (hogProc) { try { hogProc.kill("SIGKILL"); } catch {} await sleep(500); try { fs.rmSync(hogDir, { recursive: true, force: true }); } catch {} }
  }
  const f = saveJson(`storage${weak ? "-weak" : ""}${today ? "-today" : ""}${hog ? "-hog" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
