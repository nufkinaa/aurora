#!/usr/bin/env node
// BLUR-UP, FIRST USE: what the first visit of a client that asks for
// placeholders (X-Blur: 1) sets the server doing — on a server that has none
// made yet (a new install, a cleared cache, a library that just grew).
//
//   node tools/backend-perf/blurfirst.js --before <commit> [--after <commit>] [--weak] [--runs 3] [--window 90]
//   -> <results>/blurfirst[-weak][-label].json and a table
//
// Per run, one private instance WITHOUT the placeholders (instance.js noBlur),
// warm and quiet; then the library list and Home are asked for once, as the
// web app asks (signed in, br/gzip, X-Blur: 1), and the next --window seconds
// are counted: ffmpeg processes started (placeholders, stills), the server
// process's CPU, event-loop busy share and delay (p50 / p99 / max). Before
// and after take turns (A B A B …), so both see the same minutes.
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const runs = +arg("runs", 3);
  const windowS = +arg("window", 90);
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const label = arg("label") === true ? undefined : arg("label");
  if (!before) throw new Error("--before <commit> is required");
  const out = { at: new Date().toISOString(), before, after: after || "working tree", weak, windowS, runs: [] };
  const one = async (which, ref) => {
    const srv = await start({ weak, ref, noBlur: true, probe: "full", config: { scanIntervalMinutes: 24 * 60 } });
    try {
      await srv.waitWarm();
      await srv.waitQuiet();
      await srv.reset();
      const h = { ...srv.session(0), "Accept-Encoding": "gzip, deflate, br", "X-Blur": "1" };
      const t0 = Date.now();
      const lib = await fetch(`${srv.url}/api/library`, { headers: h });
      await lib.arrayBuffer();
      const home = await fetch(`${srv.url}/api/home?profile=${srv.profile(0)}`, { headers: h });
      await home.arrayBuffer();
      await sleep(windowS * 1000 - (Date.now() - t0));
      const s = await srv.snap();
      const ff = s.spawns.filter((r) => /ffmpeg/i.test(r.key));
      const row = {
        which, ref: ref || "working tree",
        ffmpegStarts: ff.reduce((a, r) => a + r.n, 0),
        ffmpegBy: ff.map((r) => `${r.key} x${r.n}`).slice(0, 6),
        cpuMs: round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000, 0),
        loopBusyPct: round(s.elu.utilization * 100, 1),
        loopDelayMs: s.loopDelay ? { p50: round(s.loopDelay.p50, 1), p99: round(s.loopDelay.p99, 1), max: round(s.loopDelay.max, 1) } : null,
        syncFs: s.syncFs.filter((r) => !/ @ /.test(r.key)).reduce((a, r) => a + r.n, 0),
      };
      process.stderr.write(`[blurfirst] ${which}: ${JSON.stringify(row)}\n`);
      return row;
    } finally { await srv.stop(); }
  };
  for (let r = 0; r < runs; r++) {
    const order = r % 2 ? [["after", after], ["before", before]] : [["before", before], ["after", after]];
    for (const [which, ref] of order) out.runs.push(await one(which, ref));
  }
  const sum = (which) => {
    const rs = out.runs.filter((r) => r.which === which);
    return { which, runs: rs.length, ffmpegStarts: median(rs.map((r) => r.ffmpegStarts)), cpuMs: median(rs.map((r) => r.cpuMs)), loopBusyPct: median(rs.map((r) => r.loopBusyPct)),
      p50: median(rs.map((r) => r.loopDelayMs && r.loopDelayMs.p50)), p99: median(rs.map((r) => r.loopDelayMs && r.loopDelayMs.p99)), max: median(rs.map((r) => r.loopDelayMs && r.loopDelayMs.max)), syncFs: median(rs.map((r) => r.syncFs)) };
  };
  out.summary = [sum("before"), sum("after")];
  const f = saveJson(`blurfirst${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.summary, [["", "which"], ["runs", "runs"], [`ffmpeg starts in ${windowS} s`, "ffmpegStarts"], ["CPU ms", "cpuMs"], ["loop busy %", "loopBusyPct"], ["delay p50 ms", "p50"], ["p99", "p99"], ["max", "max"], ["blocking fs", "syncFs"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
