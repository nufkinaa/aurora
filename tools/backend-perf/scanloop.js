#!/usr/bin/env node
// THE TEN-MINUTE RESCAN, AS A VIEWER FEELS IT: before against after, taking
// turns (A B A B …) on two private instances in the same minutes.
//
//   node tools/backend-perf/scanloop.js --before <commit> [--after <commit>] [--weak] [--rounds 3]
//   -> <results>/scanloop[-weak][-label].json and a table
//
// Each round, on each instance: the event-loop counters are zeroed, a client
// starts asking GET /api/ping every 10 ms on its own connection, and the
// rescan runs as server.js's timer runs it (inproc/rescan.js: scanAsync() +
// enrich() where the code has it, scan() + enrich() before). Measured over
// the rescan plus 2 s after it:
//   ping ms        what that client waited: median, 99th percentile, worst
//   loop active ms event-loop busy time (all of it: the rescan and the pings)
//   loop delay     the probe's event-loop delay histogram: p50 / p99 / max
//   main fs        blocking filesystem calls made ON THE MAIN THREAD
//   cpu ms         the whole process (a worker's walk included)
// Two kinds of round: "unchanged" (nothing on disk moved — what 143 of 144
// rescans a day are) and "changed" (a film folder appears or disappears
// before each of the first instance's turns, so every scan of both sees a
// change).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median, pct } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const rounds = +arg("rounds", 3);
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const label = arg("label") === true ? undefined : arg("label");
  if (!before) throw new Error("--before <commit> is required");
  const cfg = { weak, probe: "full", config: { scanIntervalMinutes: 24 * 60 } };
  const A = await start({ ...cfg, ref: before });
  const B = await start({ ...cfg, ref: after });
  const bench = path.join(__dirname, "inproc", "rescan.js");
  const extra = path.join(A.ds.library.movies, "Zz Scanloop Probe (2024)", "Zz Scanloop Probe (2024).mkv");
  fs.rmSync(path.dirname(extra), { recursive: true, force: true });
  const out = { at: new Date().toISOString(), before, after: after || "working tree", weak, rounds, runs: [] };
  const one = async (srv, which, kind, op) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const pings = [];
    let stop = false;
    const pinger = (async () => {
      while (!stop) {
        const t = process.hrtime.bigint();
        await new Promise((resolve) => {
          const req = http.get(`${srv.url}/api/ping`, { agent }, (res) => { res.resume(); res.on("end", resolve); });
          req.on("error", resolve);
        });
        pings.push(Number(process.hrtime.bigint() - t) / 1e6);
        await sleep(10);
      }
    })();
    await sleep(300);
    await srv.reset();
    const r = await srv.exec(bench, op);
    await sleep(2000);
    const s = await srv.snap();
    stop = true;
    await pinger;
    agent.destroy();
    const mainFs = s.syncFs.filter((x) => !/ @ /.test(x.key)).reduce((a, x) => a + x.n, 0);
    const row = {
      which, kind, mode: r.mode, rescanMs: r.wallMs,
      pingP50: round(median(pings), 1), pingP99: round(pct(pings, 99), 1), pingMax: round(Math.max(...pings), 1),
      loopActiveMs: round(s.elu.activeMs, 0),
      delayP50: s.loopDelay ? round(s.loopDelay.p50, 1) : null, delayP99: s.loopDelay ? round(s.loopDelay.p99, 1) : null, delayMax: s.loopDelay ? round(s.loopDelay.max, 1) : null,
      mainFs, cpuMs: round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000, 0), changed: r.changed,
    };
    process.stderr.write(`[scanloop] ${which} ${kind}: ${JSON.stringify(row)}\n`);
    return row;
  };
  try {
    for (const s of [A, B]) await s.waitWarm();
    for (const s of [A, B]) await s.waitQuiet();
    // one rescan each first: the worker started, the first-walk work done
    for (const s of [A, B]) await s.exec(bench, {});
    let present = false;
    for (const kind of ["unchanged", "changed"]) {
      for (let r = 0; r < rounds; r++) {
        const pairs = r % 2 ? [[B, "after"], [A, "before"]] : [[A, "before"], [B, "after"]];
        if (kind === "changed") {
          present = !present;
          if (present) { fs.mkdirSync(path.dirname(extra), { recursive: true }); fs.copyFileSync(path.join(A.ds.library.movies, "..", "..", "small.mkv"), extra); }
          else fs.rmSync(path.dirname(extra), { recursive: true, force: true });
        }
        for (const [srv, which] of pairs) out.runs.push(await one(srv, which, kind, {}));
      }
    }
  } finally {
    fs.rmSync(path.dirname(extra), { recursive: true, force: true });
    await A.stop(); await B.stop();
  }
  const sum = (which, kind) => {
    const rs = out.runs.filter((r) => r.which === which && r.kind === kind);
    const m = (k) => median(rs.map((r) => r[k]));
    return { which, kind, runs: rs.length, rescanMs: m("rescanMs"), pingP50: m("pingP50"), pingP99: m("pingP99"), pingMax: m("pingMax"), loopActiveMs: m("loopActiveMs"), delayP99: m("delayP99"), delayMax: m("delayMax"), mainFs: m("mainFs"), cpuMs: m("cpuMs") };
  };
  out.summary = ["unchanged", "changed"].flatMap((k) => [sum("before", k), sum("after", k)]);
  const f = saveJson(`scanloop${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.summary, [["", "which"], ["rescan", "kind"], ["runs", "runs"], ["rescan ms", "rescanMs"], ["ping p50", "pingP50"], ["ping p99", "pingP99"], ["ping max", "pingMax"], ["loop active ms", "loopActiveMs"], ["delay p99", "delayP99"], ["delay max", "delayMax"], ["main-thread fs", "mainFs"], ["CPU ms", "cpuMs"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
