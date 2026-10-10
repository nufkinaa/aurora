#!/usr/bin/env node
// A long run of the household mix against a private instance, watching the
// server process for anything that only shows with time: memory that keeps
// climbing, handles (file descriptors, sockets) that are not given back,
// event-loop lag that grows.
//
//   node tools/capacity/soak.js [--minutes 30] [--devices 20] [--think 8000] [--churn 60]
//
// Every `churn` seconds a fifth of the devices leave and new ones arrive
// (sockets close, players stop mid-stream, transcodes are abandoned): leaks
// live in the endings. Sampled every 10 s; the verdict is the slope of
// resident memory and of the handle count over the second half of the run
// (the first half is caches filling), and the same numbers a while after
// every device has gone.
const { Stats, Device, procSampler, lagProbe, sleep } = require("./sim");
const { start } = require("./instance");
const { round, saveJson } = require("./lib");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const MIN = +arg("minutes", 30), D = +arg("devices", 20), THINK = +arg("think", 8000), CHURN = +arg("churn", 60);
const KINDS = ["direct", "direct", "direct", "remux", "transcode", "browse", "browse", "browse", "browse", "browse", "browse", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle"];

const slope = (pts) => { // least squares, y per hour
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? (num / den) * 3600000 : null;
};

const main = async () => {
  const srv = await start({ films: 150, shows: 30, profiles: 40 });
  const samp = procSampler(srv.pid, 10000);
  const stats = new Stats();
  const lag = lagProbe(srv.url, 500);
  const health = async () => { try { return (await (await fetch(`${srv.url}/api/admin/health`, { headers: { "X-Admin-Password": srv.adminPassword } })).json()).now; } catch { return null; } };
  let seq = 0;
  const mk = (kind) => { const d = new Device(srv, seq++, kind, stats, { thinkMs: THINK, v: "h264-720", titles: 3 }); d.run().catch(() => {}); return d; };
  let devices = Array.from({ length: D }, (_, i) => mk(KINDS[i % KINDS.length]));
  const t0 = Date.now();
  const series = [];
  console.log(`soak: ${D} devices for ${MIN} min on ${srv.url} (pid ${srv.pid})`);
  console.log("min  rssMb  heapMb  handles  threads  ffmpeg  cores  lagP99  req/s  errors");
  let lastCpu = null, lastChurn = Date.now(), lastN = 0, lastErr = 0;
  while (Date.now() - t0 < MIN * 60000) {
    await sleep(30000);
    if (Date.now() - lastChurn >= CHURN * 1000) {
      lastChurn = Date.now();
      const leaving = devices.splice(0, Math.max(1, Math.round(D / 5)));
      leaving.forEach((d) => d.stop());
      for (const d of leaving) devices.push(mk(d.kind));
    }
    const s = samp.last(), h = await health(), l = lag.cut(), tot = stats.total();
    if (!s) continue;
    const cores = lastCpu ? (s.cpu - lastCpu.cpu) / ((s.t - lastCpu.t) / 1000) : null;
    lastCpu = s;
    const row = { min: round((Date.now() - t0) / 60000, 1), rssMb: Math.round(s.rss / 1048576), heapMb: h ? Math.round(h.heapUsed / 1048576) : null, handles: s.handles, threads: s.threads, ffmpeg: h ? h.ffmpeg : null, cores: round(cores, 2), lagP99: l.p99, lagMax: l.max, rps: round((tot.n - lastN) / 30, 1), errors: tot.err - lastErr, t: s.t };
    lastN = tot.n; lastErr = tot.err;
    series.push(row);
    console.log(`${String(row.min).padEnd(4)} ${String(row.rssMb).padEnd(6)} ${String(row.heapMb).padEnd(7)} ${String(row.handles).padEnd(8)} ${String(row.threads).padEnd(8)} ${String(row.ffmpeg).padEnd(7)} ${String(row.cores).padEnd(6)} ${String(row.lagP99).padEnd(7)} ${String(row.rps).padEnd(6)} ${row.errors}`);
  }
  const half = series.filter((r) => r.min >= MIN / 2);
  const verdict = {
    rssMbPerHour: round(slope(half.map((r) => [r.t, r.rssMb])), 1),
    heapMbPerHour: round(slope(half.filter((r) => r.heapMb != null).map((r) => [r.t, r.heapMb])), 1),
    handlesPerHour: round(slope(half.map((r) => [r.t, r.handles])), 1),
    rssStartMb: series[0] && series[0].rssMb, rssEndMb: series[series.length - 1] && series[series.length - 1].rssMb,
    requests: stats.total().n, errors: stats.total().err,
  };
  devices.forEach((d) => d.stop());
  console.log("all devices gone — waiting 200 s for the idle reapers (150 s)…");
  await sleep(200000);
  const s = samp.last(), h = await health();
  verdict.afterEveryoneLeft = { rssMb: Math.round(s.rss / 1048576), heapMb: h ? Math.round(h.heapUsed / 1048576) : null, handles: s.handles, threads: s.threads, ffmpeg: h ? h.ffmpeg : null };
  console.log(JSON.stringify(verdict, null, 2));
  const errorsByEndpoint = stats.rows().filter((r) => r.err).map((r) => ({ name: r.name, err: r.err, codes: r.codes }));
  const logTail = srv.log().filter((l) => /error|uncaught|unhandled|watchdog|failed/i.test(l)).slice(-30);
  lag.stop(); samp.stop();
  await srv.stop();
  console.log("saved", saveJson("soak.json", { when: new Date().toISOString(), minutes: MIN, devices: D, thinkMs: THINK, churnSec: CHURN, verdict, errorsByEndpoint, perEndpoint: stats.rows(), series, logTail }));
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
