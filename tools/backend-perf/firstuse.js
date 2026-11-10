#!/usr/bin/env node
// THE FIRST VISITOR AFTER A START (perf-server, 2026-11-10): once the server
// is "warm" by every measure the rig has (library probed, recommender and
// search index built, the boot's own work over), the first request of each
// kind still loads code and data on first use. This asks each data request
// the apps make once, in the order a first visitor's devices would, and says
// per request: wall time, the server's time, the event loop's longest delay
// around it, the modules required during it and the blocking file reads
// (call site, files' time).
//
//   node tools/backend-perf/firstuse.js [--ref <commit>] [--settle 0] [--label x] [--runs 1]
//   -> <results>/firstuse[-label].json
const path = require("path");
const { start } = require("./instance");
const { routesFor, ask, prepare } = require("./routes");
const { saveJson, arg, round, sleep, median } = require("./lib");

(async () => {
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const settle = +arg("settle", 0);
  const runs = +arg("runs", 1);
  const wantProfile = !!arg("profile"); // a CPU profile of each first request (shown for those over 100 ms)
  const out = { at: new Date().toISOString(), ref: ref || "working tree", runs: [] };
  for (let k = 0; k < runs; k++) {
    const srv = await start({ ref, probe: "full", config: { scanIntervalMinutes: 24 * 60 } });
    const rows = [];
    try {
      await srv.waitWarm();
      await srv.waitQuiet();
      if (settle) await sleep(settle * 1000);
      const base = await srv.snap();
      const known = new Set(base.modules.map((m) => m.id));
      const list = (await prepare(srv, routesFor(srv))).filter((r) => !r.img && !r.method);
      for (const r of list) {
        await srv.reset();
        if (wantProfile) await srv.probe("/cpu/start?us=250");
        const p = typeof r.path === "function" ? r.path(0) : r.path;
        const x = await ask(srv, p, { headers: { "Accept-Encoding": "gzip, deflate, br", ...(r.blur ? { "X-Blur": "1" } : {}) }, si: r.si || 0 });
        const prof = wantProfile ? await srv.probe("/cpu/stop?top=30") : null;
        const s = await srv.snap();
        const fresh = s.modules.filter((m) => !known.has(m.id));
        for (const m of fresh) known.add(m.id);
        const fsSites = s.syncFs.filter((f) => / @ /.test(f.key)).sort((a, b) => b.ms - a.ms);
        rows.push({
          name: r.name, status: x.status, wallMs: round(x.ms, 1), serverMs: x.serverMs, loopMaxMs: s.loopDelay ? round(s.loopDelay.max, 1) : null, loopActiveMs: round(s.elu.activeMs, 1),
          modules: fresh.length, moduleMs: round(fresh.reduce((a, m) => a + m.self, 0), 1), moduleList: fresh.slice(0, 12).map((m) => `${m.id} ${round(m.self, 1)}`),
          syncFsMs: round(fsSites.reduce((a, f) => a + f.ms, 0), 1), syncFs: fsSites.slice(0, 6).map((f) => `${f.key} x${f.n} ${round(f.ms, 1)} ms`),
          ...(prof && x.ms > 100 ? { profile: prof.functions.filter((f) => !/^[(](idle|program)[)]/.test(f.name)).slice(0, 15).map((f) => `${f.ms} ms ${f.name}`) } : {}),
        });
        process.stderr.write(`[firstuse] ${r.name}: ${x.status} ${round(x.ms, 0)} ms (server ${x.serverMs}) loop max ${rows.at(-1).loopMaxMs} · ${fresh.length} modules ${rows.at(-1).moduleMs} ms · sync fs ${rows.at(-1).syncFsMs} ms\n`);
      }
    } finally { await srv.stop(); }
    out.runs.push(rows);
  }
  out.rows = out.runs[0].map((r, i) => ({ ...r, wallMs: median(out.runs.map((rs) => rs[i].wallMs)), serverMs: median(out.runs.map((rs) => rs[i].serverMs || 0)), loopMaxMs: median(out.runs.map((rs) => rs[i].loopMaxMs || 0)) }));
  const f = saveJson(`firstuse${label ? `-${label}` : ""}.json`, out);
  for (const r of out.rows) console.log(`${r.name.padEnd(26)} ${String(r.status).padEnd(4)} wall ${String(r.wallMs).padStart(7)}  server ${String(r.serverMs).padStart(7)}  loopmax ${String(r.loopMaxMs).padStart(7)}  modules ${r.modules} (${r.moduleMs} ms)  syncfs ${r.syncFsMs} ms\n    ${[...r.moduleList, ...r.syncFs, ...(r.profile || [])].join("\n    ")}`);
  console.log(`\n${f}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
