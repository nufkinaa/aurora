#!/usr/bin/env node
// LIBRARY SCAN: what one rescan costs (the server runs one every 10 minutes,
// synchronously, on the event loop), and what a scan sets off afterwards.
//
//   node tools/backend-perf/scan.js [--weak] [--runs 7] [--ref <commit>] [--label before] [--aftermath] [--cold N]
//   -> docs/qa/backend-efficiency/results/scan[-weak][-label].json
//
//   walk alone      scanner.scan() with the "scanned" listeners detached
//   scan + listeners  the same with everything that hangs off "scanned" (title
//                   history fold, recommender note, metadata pass…) — the
//                   synchronous part, which is how long the loop is held
//   aftermath       CPU the process burns in the 60 s after one scan, above idle
//   --cold N        a FIRST scan of N never-probed files: how long every
//                   request waits while ffprobe runs (one blocking call per file)
const path = require("path");
const { start } = require("./instance");
const dataset = require("./dataset");
const { round, saveJson, arg, table, sleep } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const runs = +arg("runs", 7);
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak };
  const bench = path.join(__dirname, "inproc", "scan-bench.js");
  let srv = await start({ weak, ref, loop: false, probe: "light", config: { scanIntervalMinutes: 24 * 60 } });
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    out.walk = await srv.exec(bench, { runs, quiet: true });
    out.withListeners = await srv.exec(bench, { runs, after: true });
    if (!arg("aftermath")) throw Object.assign(new Error("skip"), { skip: true });
    await sleep(45000);
    // aftermath: idle CPU over 60 s, then one scan and the 60 s after it
    await srv.reset(); await sleep(60000);
    const idle = await srv.snap();
    await srv.reset();
    const one = await srv.exec(bench, { runs: 1 });
    await sleep(60000);
    const after = await srv.snap();
    const cpu = (s) => (s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000;
    out.aftermath = { idleCpuMsPer60s: round(cpu(idle), 0), scanCpuMs: one.cpuMs, cpuMsIn60sAfterScan: round(cpu(after), 0), aboveIdleMs: round(cpu(after) - cpu(idle) - one.cpuMs, 0),
      timers: after.timers.filter((t) => t.fires && t.ms > 1).map((t) => ({ site: t.site, delay: t.delay, fires: t.fires, ms: t.ms })).sort((a, b) => b.ms - a.ms).slice(0, 12),
      spawns: after.spawns, fsTop: after.syncFs.filter((r) => / @ /.test(r.key)).slice(0, 12) };
  } catch (e) { if (!e.skip) throw e; } finally { await srv.stop(); }

  const cold = arg("cold") === true ? 300 : +arg("cold", 0);
  if (cold) {
    const ds = dataset.build({ films: cold, shows: 0, episodes: 0, profiles: 2, rows: 50, usageMb: 0.05 });
    srv = await start({ weak, ref, ds, cold: true, config: { scanIntervalMinutes: 24 * 60 }, bootTimeoutMs: 15 * 60 * 1000 });
    try {
      const t0 = Date.now();
      // /healthz asked five times a second on its own connection: what everyone else waits
      const lags = [];
      let done = false;
      const probeLoop = (async () => { while (!done) { const t = Date.now(); try { await fetch(`${srv.url}/healthz`, { signal: AbortSignal.timeout(60000) }); } catch {} lags.push(Date.now() - t); await sleep(200); } })();
      for (;;) {
        const w = await srv.exec(path.join(__dirname, "inproc", "warm-state.js"));
        if (w.enriched) break;
        await sleep(1000);
      }
      done = true; await probeLoop;
      const s = await srv.snap();
      const probes = s.spawns.filter((r) => /ffprobe probe/.test(r.key));
      lags.sort((a, b) => a - b);
      out.cold = { files: cold, secondsUntilProbed: round((Date.now() - srv.spawnedAt) / 1000, 1), listeningMs: round(s.marks.listeningAt, 0),
        probes: probes.reduce((a, r) => a + r.n, 0), blockedMsInProbes: round(probes.reduce((a, r) => a + r.ms, 0), 0), msPerProbe: round(probes.reduce((a, r) => a + r.ms, 0) / Math.max(1, probes.reduce((a, r) => a + r.n, 0)), 1),
        healthzLagMs: { p50: lags[Math.floor(lags.length / 2)], p90: lags[Math.floor(lags.length * 0.9)], max: lags[lags.length - 1], samples: lags.length }, sinceMs: Date.now() - t0 };
    } finally { await srv.stop(); }
  }
  const f = saveJson(`scan${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table([{ what: "walk alone", ...out.walk }, { what: "scan + listeners", ...out.withListeners }], [["", "what"], ["wall ms", "wallMs"], ["CPU ms", "cpuMs"], ["blocking fs calls", "fsCallsTotal"], ["readdir", (r) => r.fsCalls.readdirSync], ["stat", (r) => r.fsCalls.statSync]]));
  if (out.withListeners.afterScan) {
    console.log(`
right after a scan, the first call against the next (ms) — total paid again per scan: ${out.withListeners.afterScanTaxMs} ms
`);
    console.log(table(out.withListeners.afterScan, [["", "what"], ["first after a scan", "firstMs"], ["again", "againMs"]]));
  }
  if (out.aftermath) console.log(`\naftermath of one scan: ${JSON.stringify({ ...out.aftermath, timers: undefined, spawns: undefined, fsTop: undefined })}`);
  if (out.cold) console.log(`\ncold scan: ${JSON.stringify(out.cold)}`);
  console.log(`\n${path.relative(process.cwd(), f)}`);
})().catch((e) => { console.error(e); process.exit(1); });
