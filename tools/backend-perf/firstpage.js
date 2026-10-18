#!/usr/bin/env node
// THE FIRST PAGE LOAD AFTER A START: the app shell (GET /) and its modules as
// the first visitor after a restart asks for them, before against after,
// taking turns (each run a fresh instance).
//
//   node tools/backend-perf/firstpage.js --before <commit> [--after <commit>] [--runs 3] [--weak] [--settle 30]
//
// Each run: a fresh instance, --settle seconds after it listens (what a
// restart's first visitor finds), then GET / and every module of its import
// map, one after another, as a browser's first visit does. Measured: the
// wall time of the shell and of all of it, the server's event-loop busy
// time and its longest delay over those requests, blocking fs calls.
const path = require("path");
const { start } = require("./instance");
const { saveJson, arg, median, round, table, sleep } = require("./lib");

(async () => {
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const runs = +arg("runs", 3);
  const weak = !!arg("weak");
  const settle = +arg("settle", 30);
  const out = { at: new Date().toISOString(), before, after: after || "working tree", runs: [] };
  const one = async (which, ref) => {
    const srv = await start({ weak, ref, probe: "full", config: { scanIntervalMinutes: 24 * 60 } });
    try {
      await sleep(settle * 1000);
      await srv.reset();
      const t0 = Date.now();
      const r = await fetch(`${srv.url}/`, { headers: { "Accept-Encoding": "gzip, br" } });
      const html = await r.text();
      const shellMs = Date.now() - t0;
      const urls = [...new Set([...html.matchAll(/"(\/js\/[^"?]+\.js\?v=[a-f0-9]+)"/g)].map((m) => m[1]))];
      for (const u of urls) await (await fetch(srv.url + u, { headers: { "Accept-Encoding": "gzip, br" } })).arrayBuffer();
      const allMs = Date.now() - t0;
      const s = await srv.snap();
      const row = { which, shellMs, allMs, modules: urls.length, loopActiveMs: round(s.elu.activeMs, 0), delayMaxMs: s.loopDelay ? round(s.loopDelay.max, 0) : null, syncFs: s.syncFs.filter((x) => !/ @ /.test(x.key)).reduce((a, x) => a + x.n, 0) };
      process.stderr.write(`[firstpage] ${JSON.stringify(row)}\n`);
      return row;
    } finally { await srv.stop(); }
  };
  for (let r = 0; r < runs; r++) {
    const order = r % 2 ? [["after", after], ["before", before]] : [["before", before], ["after", after]];
    for (const [k, ref] of order) out.runs.push(await one(k, ref));
  }
  out.summary = ["before", "after"].map((k) => {
    const rs = out.runs.filter((x) => x.which === k);
    const m = (f) => median(rs.map((x) => x[f]));
    return { which: k, shellMs: m("shellMs"), allMs: m("allMs"), modules: m("modules"), loopActiveMs: m("loopActiveMs"), delayMaxMs: m("delayMaxMs"), syncFs: m("syncFs") };
  });
  const f = saveJson(`firstpage${weak ? "-weak" : ""}.json`, out);
  console.log(table(out.summary, [["", "which"], ["shell ms", "shellMs"], ["shell + modules ms", "allMs"], ["modules", "modules"], ["loop active ms", "loopActiveMs"], ["delay max ms", "delayMaxMs"], ["blocking fs", "syncFs"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
