#!/usr/bin/env node
// IDLE: what the server does when nobody is using it. A settled library (every
// file probed, intros analysed, daily jobs done), no client connected.
//
//   node tools/backend-perf/idle.js [--weak] [--minutes 20] [--settle 320] [--ref <commit>] [--label before] [--profile]
//   -> docs/qa/backend-efficiency/results/idle[-weak][-label].json and tables
//
// The window starts --settle seconds after boot (the last one-shot boot timer,
// the tone-map re-timing, fires at 300 s) and lasts --minutes (default 20: two
// library rescans, twenty healer and health rounds, four of the healer's
// five-minute checks). Reported per hour:
//   CPU seconds            the process's own user + system time
//   wake-ups               timer callbacks run (every setInterval/setTimeout created from src/)
//   per timer              fires, time spent in the callback's synchronous part
//   blocking fs calls      per call site
//   bytes written          per file — what keeps a disk from sleeping
//   child processes        started
//   outbound connections   attempted (refused by the fence; each is one the real server makes)
//   memory                 RSS and heap after a forced collection, at both ends
//   --profile              instead of the counters: a V8 CPU profile of the whole window
//                          (light probe, nothing wrapped) — which functions the idle CPU goes to
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const minutes = +arg("minutes", 20);
  const settle = +arg("settle", 320);
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const profile = !!arg("profile");
  const srv = await start({ weak, ref, loop: false, probe: profile ? "light" : "full" });
  try {
    await srv.waitWarm();
    for (;;) { const s = await srv.snap(); if (s.uptimeMs >= settle * 1000) break; await sleep(5000); }
    const m0 = (await srv.gc()).mem;
    await srv.reset();
    if (profile) await srv.probe("/cpu/start?us=500");
    const t0 = Date.now();
    process.stderr.write(`[idle] window open (${minutes} min)\n`);
    await sleep(minutes * 60 * 1000);
    const prof = profile ? await srv.probe("/cpu/stop?top=60") : null;
    const s = await srv.snap();
    const m1 = (await srv.gc()).mem;
    const hours = s.sinceResetMs / 3600e3;
    const perH = (v) => round(v / hours, 1);
    const cpuS = (s.cpuSinceReset.user + s.cpuSinceReset.system) / 1e6;
    const timers = s.timers.filter((t) => t.fires > 0).map((t) => ({ timer: `${t.kind === "setInterval" ? "every" : "after"} ${t.delay >= 1000 ? `${round(t.delay / 1000, 1)} s` : `${t.delay} ms`}`, site: t.site, firesPerHour: perH(t.fires), msPerHour: perH(t.ms), maxMs: t.maxMs }))
      .sort((a, b) => b.msPerHour - a.msPerHour);
    const fsSites = s.syncFs.filter((r) => / @ /.test(r.key)).map((r) => ({ site: r.key, callsPerHour: perH(r.n), msPerHour: perH(r.ms) })).sort((a, b) => b.callsPerHour - a.callsPerHour);
    const writes = s.writes.map((w) => ({ file: w.key, writesPerHour: perH(w.n), mbPerHour: round(w.bytes / 1048576 / hours, 2), bytesEach: Math.round(w.bytes / w.n) }));
    const out = {
      at: new Date().toISOString(), ref: ref || "working tree", weak, minutes: round(s.sinceResetMs / 60000, 2), startedAt: t0,
      cpuSecondsPerHour: round(cpuS / hours, 2), cpuPercentOfOneCore: round((cpuS / (s.sinceResetMs / 1000)) * 100, 3),
      loopActivePercent: round(s.elu.utilization * 100, 3),
      wakeUpsPerMinute: round(s.timers.reduce((a, t) => a + t.fires, 0) / (s.sinceResetMs / 60000), 1),
      syncFsCallsPerHour: perH(s.syncFs.filter((r) => !/ @ /.test(r.key)).reduce((a, r) => a + r.n, 0)),
      mbWrittenPerHour: round(s.writes.reduce((a, w) => a + w.bytes, 0) / 1048576 / hours, 2), fileWritesPerHour: perH(s.writes.reduce((a, w) => a + w.n, 0)),
      spawnsPerHour: perH(s.spawns.reduce((a, r) => a + r.n, 0)), outboundPerHour: perH(s.outbound.reduce((a, r) => a + r.n, 0)),
      gc: Object.fromEntries(Object.entries(s.gc).map(([k, g]) => [k, { perHour: perH(g.n), msPerHour: perH(g.ms), maxMs: round(g.maxMs, 1) }])),
      memory: { rssStartMb: round(m0.rss / 1048576, 1), rssEndMb: round(m1.rss / 1048576, 1), heapStartMb: round(m0.heapUsed / 1048576, 1), heapEndMb: round(m1.heapUsed / 1048576, 1), externalMb: round(m1.external / 1048576, 1) },
      timers, fsSites: fsSites.slice(0, 40), writes, spawns: s.spawns.map((r) => ({ what: r.key, perHour: perH(r.n) })), outbound: s.outbound.map((r) => ({ what: r.key, perHour: perH(r.n) })),
      allTimers: s.timers.map((t) => ({ kind: t.kind, delay: t.delay, site: t.site, created: t.created, fires: t.fires })),
    };
    if (prof) {
      const perHour = (ms) => round(ms / hours / 1000, 2);
      out.profile = {
        busySecondsPerHour: perHour(prof.busyMs),
        functions: prof.functions.filter((x) => !x.name.startsWith("(idle)") && !x.name.startsWith("(program)")).slice(0, 40).map((x) => ({ name: x.name, secondsPerHour: perHour(x.ms) })),
        files: prof.files.slice(0, 25).map((x) => ({ name: x.name, secondsPerHour: perHour(x.ms) })),
      };
      const f2 = saveJson(`idle-profile${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, { at: out.at, ref: out.ref, weak, minutes: out.minutes, cpuSecondsPerHour: out.cpuSecondsPerHour, ...out.profile });
      console.log(`
idle CPU profile, ${out.minutes} min: ${out.cpuSecondsPerHour} CPU s/hour (process), ${out.profile.busySecondsPerHour} s/hour on the main thread
`);
      console.log(table(out.profile.functions.slice(0, 30), [["function", "name"], ["s/hour", "secondsPerHour"]]));
      console.log("");
      console.log(table(out.profile.files.slice(0, 18), [["file", "name"], ["s/hour", "secondsPerHour"]]));
      console.log(`
${path.relative(process.cwd(), f2)}`);
      return;
    }
    const f = saveJson(`idle${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
    console.log(`\nidle, ${weak ? "weak" : "normal"} profile, ${out.minutes} min window\n`);
    console.log(table([out], [["CPU s/hour", "cpuSecondsPerHour"], ["% of one core", "cpuPercentOfOneCore"], ["wake-ups/min", "wakeUpsPerMinute"], ["blocking fs calls/hour", "syncFsCallsPerHour"], ["MB written/hour", "mbWrittenPerHour"], ["file writes/hour", "fileWritesPerHour"], ["children/hour", "spawnsPerHour"], ["outbound tries/hour", "outboundPerHour"]]));
    console.log(`\nmemory (after a forced collection): RSS ${out.memory.rssStartMb} -> ${out.memory.rssEndMb} MB, heap ${out.memory.heapStartMb} -> ${out.memory.heapEndMb} MB\n`);
    console.log(table(timers.slice(0, 25), [["timer", "timer"], ["where", "site"], ["fires/hour", "firesPerHour"], ["callback ms/hour", "msPerHour"], ["longest ms", "maxMs"]]));
    console.log("");
    console.log(table(writes, [["file", "file"], ["writes/hour", "writesPerHour"], ["MB/hour", "mbPerHour"], ["bytes each", "bytesEach"]]));
    console.log("");
    console.log(table(fsSites.slice(0, 20), [["blocking fs call", "site"], ["calls/hour", "callsPerHour"], ["ms/hour", "msPerHour"]]));
    console.log(`\n${path.relative(process.cwd(), f)}`);
  } finally { await srv.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
