#!/usr/bin/env node
// BOOT: what happens between `node server.js` and "listening", and between
// that and "fully warm" (library indexed and probed, recommender vectors and
// search index built). Medians over --runs boots, for the normal profile and
// the weak-PC one (2 cores, 512 MB heap).
//
//   node tools/backend-perf/boot.js [--runs 5] [--only weak|normal] [--ref <commit>] [--label before]
//   -> docs/qa/backend-efficiency/results/boot[-label].json and a table on stdout
//
// Wall time on a busy machine is whatever was left over; CPU time (user +
// system, from the process's own accounting) is the figure to compare.
const path = require("path");
const { start } = require("./instance");
const { median, round, saveJson, arg, table } = require("./lib");

const runOnce = async (weak, ref) => {
  const srv = await start({ weak, ref, loop: false });
  try {
    const atPing = await srv.snap();
    const warm = await srv.waitWarm();
    const s = await srv.snap();
    const cpu = (c) => (c.user + c.system) / 1000;
    const bySite = (list, re) => list.filter((r) => re.test(r.key));
    const sum = (list, k = "ms") => list.reduce((a, r) => a + (r[k] || 0), 0);
    const boot = atPing; // counters up to the first answered request
    const syncSpawns = boot.spawns.filter((r) => r.sync);
    return {
      listeningMs: s.marks.listeningAt, preloadMs: s.marks.preloadAt, pingMs: srv.pingMs,
      cpuAtListeningMs: cpu(s.marks.cpuAtListening), rssAtListeningMb: s.marks.rssAtListening / 1048576,
      warmMs: warm.uptimeMs, cpuAtWarmMs: cpu(s.cpuTotal), rssWarmMb: s.mem.rss / 1048576, heapWarmMb: s.mem.heapUsed / 1048576,
      requireMs: sum(boot.modules, "self"), modules: boot.modules.length,
      syncSpawnMs: sum(syncSpawns), syncSpawns: syncSpawns.length,
      storeReadMs: sum(bySite(boot.syncFs, /readFileSync @ src\/lib\/jsonstore/)),
      usageReplayMs: sum(bySite(boot.syncFs, /@ src\/lib\/usage\.js/)),
      scanMs: sum(bySite(boot.syncFs, /@ src\/media\/scanner\.js/)), scanCalls: sum(bySite(boot.syncFs, /@ src\/media\/scanner\.js/), "n"),
      moduleSelf: Object.fromEntries(boot.modules.map((m) => [m.id, m.self])), moduleIncl: Object.fromEntries(boot.modules.map((m) => [m.id, m.ms])),
      spawns: s.spawns.map((r) => ({ key: r.key, n: r.n, ms: r.ms, sync: r.sync })),
      syncFsTop: boot.syncFs.filter((r) => / @ /.test(r.key)).slice(0, 25),
      timers: s.timers.map((t) => ({ kind: t.kind, delay: t.delay, site: t.site, created: t.created })),
      gc: s.gc,
    };
  } finally { await srv.stop(); }
};

(async () => {
  const runs = +arg("runs", 5);
  const only = arg("only");
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const out = { at: new Date().toISOString(), ref: ref || "working tree", runs, profiles: {} };
  for (const weak of [false, true]) {
    const name = weak ? "weak" : "normal";
    if (only && only !== name) continue;
    const all = [];
    for (let i = 0; i < runs; i++) {
      const r = await runOnce(weak, ref);
      all.push(r);
      process.stderr.write(`[boot] ${name} ${i + 1}/${runs}: listening ${Math.round(r.listeningMs)} ms (cpu ${Math.round(r.cpuAtListeningMs)} ms), warm ${Math.round(r.warmMs)} ms (cpu ${Math.round(r.cpuAtWarmMs)} ms)\n`);
    }
    const med = (k) => round(median(all.map((r) => r[k])), 1);
    const ids = Object.keys(all[0].moduleSelf);
    const mods = ids.map((id) => ({ id, self: round(median(all.map((r) => r.moduleSelf[id])), 1), incl: round(median(all.map((r) => r.moduleIncl[id])), 1) }));
    out.profiles[name] = {
      median: Object.fromEntries(["listeningMs", "cpuAtListeningMs", "pingMs", "warmMs", "cpuAtWarmMs", "rssAtListeningMb", "rssWarmMb", "heapWarmMb", "requireMs", "modules", "syncSpawnMs", "syncSpawns", "storeReadMs", "usageReplayMs", "scanMs", "scanCalls"].map((k) => [k, med(k)])),
      topModulesSelf: mods.slice().sort((a, b) => b.self - a.self).slice(0, 30),
      topModulesInclusive: mods.filter((m) => /^src\//.test(m.id) || /^node_modules\/[^/]+\/(index|lib\/[^/]+)\.js$/.test(m.id)).sort((a, b) => b.incl - a.incl).slice(0, 40),
      spawns: all[0].spawns, syncFsTop: all[0].syncFsTop, timers: all[0].timers, runs: all.map(({ moduleSelf, moduleIncl, spawns, syncFsTop, timers, ...r }) => r),
    };
  }
  const f = saveJson(`boot${label ? `-${label}` : ""}.json`, out);
  for (const [name, p] of Object.entries(out.profiles)) {
    console.log(`\n${name} profile — medians of ${runs}\n`);
    console.log(table(Object.entries(p.median).map(([k, v]) => ({ k, v })), [["measure", "k"], ["value", "v"]]));
    console.log(`\ntop modules by self time (ms)\n`);
    console.log(table(p.topModulesSelf.slice(0, 15), [["module", "id"], ["self", "self"], ["inclusive", "incl"]]));
  }
  console.log(`\n${path.relative(process.cwd(), f)}`);
})().catch((e) => { console.error(e); process.exit(1); });
