#!/usr/bin/env node
// THE STORES UNDER VIEWERS: what watching writes to disk, and what it blocks.
//
//   node tools/backend-perf/viewers.js [--weak] [--viewers 1,5] [--minutes 5] [--rows 1500|today] [--ref <commit>] [--label before] [--home]
//   -> docs/qa/backend-efficiency/results/viewers[-weak][-label].json and tables
//
// Each simulated viewer does what the web player does (public/js/player.js,
// usage.js): a WebSocket with `hello`, then every 5 s one progress POST and one
// `activity` message over the socket, and every 20 s a usage batch. Viewers
// are out of step with each other, as real ones are. No video bytes are pulled
// (direct play is measured in the capacity study); this is the bookkeeping.
//
// Reported per viewer-hour (the window scaled to an hour, divided by viewers):
//   bytes written per file, and how many whole-file rewrites
//   event-loop time blocked in the store's save callback (JSON.stringify + writeFileSync)
//   CPU seconds, event-loop delay p99 / max
//
// --rows today  uses a household the size of the live one today (62 KB of
// profiles); the default is "a year or two on" (dataset.js).
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
  let ok = 0, bad = 0;
  const timers = [];
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", profile: `Viewer ${i + 1}`, profileId: profile }));
    const beat = async () => {
      pos += 5;
      const st = await post(srv, i, `/api/profiles/${profile}/progress`, { itemId: item, position: pos, duration: 6000 });
      if (st === 200) ok++; else bad++;
      try { ws.send(JSON.stringify({ type: "activity", action: "Watching", details: `Efficiency Film ${i + 1}`, position: pos, duration: 6000 })); } catch {}
    };
    const usage = () => post(srv, i, "/api/usage", { profile, sid: `sim${i}xx`, device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "/watch/:id", ms: 80 } }, { n: "feat", t: Date.now(), p: { f: "player_seek" } }] });
    // out of step with the others
    timers.push(setTimeout(() => { beat(); timers.push(setInterval(beat, 5000)); }, (i * 1300) % 5000));
    timers.push(setTimeout(() => { usage(); timers.push(setInterval(usage, 20000)); }, 3000 + ((i * 3700) % 20000)));
  });
  ws.on("error", () => {});
  const end = setInterval(() => {
    if (Date.now() < stopAt) return;
    clearInterval(end);
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    try { ws.close(); } catch {}
    resolve({ ok, bad });
  }, 250);
});

(async () => {
  const weak = !!arg("weak");
  const minutes = +arg("minutes", 5);
  const counts = String(arg("viewers", "1,5")).split(",").map(Number);
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const today = arg("rows") === "today";
  const ds = today ? dataset.build({ rows: 40, profiles: 5 }) : dataset.build();
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, minutes, household: today ? "today (5 profiles, about 40 rows each)" : "grown (8 profiles, up to 1,500 rows)", storeSizes: {}, runs: [] };
  for (const f of ["profiles.json", "watch-sessions.json", "telemetry-hours.json", "sessions.json", "watch-history.json"]) out.storeSizes[f] = ds.sizes[f];
  for (const n of counts) {
    const srv = await start({ weak, ref, ds, config: { scanIntervalMinutes: 24 * 60 } });
    try {
      await srv.waitWarm();
      await srv.waitQuiet();
      await srv.reset();
      const stopAt = Date.now() + minutes * 60 * 1000;
      // --home: meanwhile one more device opens Home every 4 s (as the apps ask for it): how long it waits
      const homeMs = [];
      const homer = arg("home") ? (async () => {
        const who = n % srv.ds.sessions.length;
        while (Date.now() < stopAt) {
          const t0 = process.hrtime.bigint();
          try { await (await fetch(`${srv.url}/api/home?profile=${srv.profile(who)}`, { headers: { ...srv.session(who), "X-Blur": "1", "Accept-Encoding": "gzip, deflate, br" } })).arrayBuffer(); homeMs.push(Number(process.hrtime.bigint() - t0) / 1e6); } catch {}
          await sleep(4000);
        }
      })() : null;
      const res = await Promise.all(Array.from({ length: n }, (_, i) => viewer(srv, i, stopAt)));
      if (homer) await homer;
      await sleep(2500); // the last debounced saves land
      const s = await srv.snap();
      const hours = (minutes / 60) * n; // viewer-hours in the window
      const store = s.timers.find((t) => /jsonstore\.js/.test(t.site)) || { fires: 0, ms: 0, maxMs: 0 };
      const cpuS = (s.cpuSinceReset.user + s.cpuSinceReset.system) / 1e6;
      const run = {
        viewers: n, progressOk: res.reduce((a, r) => a + r.ok, 0), progressFailed: res.reduce((a, r) => a + r.bad, 0),
        perViewerHour: {
          mbWritten: round(s.writes.reduce((a, w) => a + w.bytes, 0) / 1048576 / hours, 1),
          fileRewrites: round(s.writes.reduce((a, w) => a + w.n, 0) / hours, 0),
          storeSaveBlockedSec: round(store.ms / 1000 / hours, 2),
          cpuSeconds: round(cpuS / hours, 2),
        },
        wholeServer: {
          storeSavesPerHour: round(store.fires / (minutes / 60), 0), storeSaveBlockedSecPerHour: round(store.ms / 1000 / (minutes / 60), 2), longestSaveMs: store.maxMs,
          loopBlockedPercent: round((store.ms / (minutes * 60000)) * 100, 2),
          loopDelayP99Ms: s.loopDelay ? round(s.loopDelay.p99, 1) : null, loopDelayMaxMs: s.loopDelay ? round(s.loopDelay.max, 1) : null,
          cpuPercentOfOneCore: round((cpuS / (s.sinceResetMs / 1000)) * 100, 2),
        },
        ...(homeMs.length ? { home: (() => { const h = homeMs.slice(2).sort((a, b) => a - b); return { requests: h.length, p50Ms: round(h[Math.floor(h.length / 2)], 0), p90Ms: round(h[Math.floor(h.length * 0.9)], 0), maxMs: round(h[h.length - 1], 0) }; })() } : {}),
        files: s.writes.map((w) => ({ file: w.key, rewritesPerViewerHour: round(w.n / hours, 0), mbPerViewerHour: round(w.bytes / 1048576 / hours, 1), bytesEach: Math.round(w.bytes / w.n) })),
      };
      out.runs.push(run);
      console.log(`\n${n} viewer(s), ${minutes} min, ${weak ? "weak" : "normal"} profile, household: ${out.household}\n`);
      console.log(table([{ ...run.perViewerHour, ...run.wholeServer }], [["MB written / viewer-hour", "mbWritten"], ["rewrites / viewer-hour", "fileRewrites"], ["loop blocked by saves, s / viewer-hour", "storeSaveBlockedSec"], ["CPU s / viewer-hour", "cpuSeconds"], ["longest save ms", "longestSaveMs"], ["loop blocked %", "loopBlockedPercent"], ["loop delay p99 ms", "loopDelayP99Ms"]]));
      if (run.home) console.log(`
Home, asked every 4 s meanwhile (${run.home.requests} times): p50 ${run.home.p50Ms} ms, p90 ${run.home.p90Ms} ms, longest ${run.home.maxMs} ms`);
      console.log("");
      console.log(table(run.files, [["file", "file"], ["rewrites / viewer-hour", "rewritesPerViewerHour"], ["MB / viewer-hour", "mbPerViewerHour"], ["bytes each", "bytesEach"]]));
    } finally { await srv.stop(); }
  }
  const f = saveJson(`viewers${weak ? "-weak" : ""}${today ? "-today" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
