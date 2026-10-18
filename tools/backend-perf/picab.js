#!/usr/bin/env node
// PICTURES ON A BUSY BOX, before against after: a picture-heavy browse (each
// client asks for a page of 10 posters at a time, as a grid scrolls) of
// posters whose variants are NOT made yet, so every page queues encodes
// behind the two encoders. Two private instances side by side, in windows
// that take turns; each window asks a width no earlier window asked
// (240, 256, 352, 360, 448, 480, 640, 800…), so every window is a first sight.
//
//   node tools/backend-perf/picab.js --before <commit> [--after <commit>] [--clients 6] [--window 1] [--rounds 3] [--weak] [--label x]
//   -> <results>/picab[-label].json
//
// Reported per side: picture wall time p50 / p95 / p99 / max, pictures per
// minute, how many answers were "shed" (Cache-Control max-age=60: the
// original or a nearer size, sent at once), the server's CPU.
const http = require("http");
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median, pct } = require("./lib");

const WIDTHS = [240, 256, 352, 360, 448, 480, 640, 800, 960, 1280];

(async () => {
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const clients = +arg("clients", 6);
  const windowMin = +arg("window", 1);
  const rounds = Math.min(+arg("rounds", 3), WIDTHS.length / 2);
  const weak = !!arg("weak");
  const label = arg("label") === true ? undefined : arg("label");
  if (!before) throw new Error("--before <commit> is required");
  const cfg = { weak, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } };
  const sides = { before: { srv: await start({ ...cfg, ref: before }) }, after: { srv: await start({ ...cfg, ref: after }) } };
  const out = { at: new Date().toISOString(), before, after: after || "working tree", clients, windowMin, rounds, weak, windows: [], summary: [] };
  try {
    for (const s of Object.values(sides)) await s.srv.waitWarm();
    for (const s of Object.values(sides)) await s.srv.waitQuiet();
    for (const s of Object.values(sides)) {
      const lib = await (await fetch(`${s.srv.url}/api/library`, { headers: s.srv.session(0) })).json();
      s.covers = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).map((m) => m.cover);
      s.times = []; s.shed = 0; s.n = 0; s.cpuS = 0; s.secs = 0;
    }
    let wi = 0;
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 ? ["after", "before"] : ["before", "after"];
      for (const k of order) {
        const s = sides[k];
        const width = WIDTHS[wi++ % WIDTHS.length];
        const agents = Array.from({ length: clients }, () => new http.Agent({ keepAlive: true, maxSockets: 6 }));
        const get = (c, p) => new Promise((resolve) => {
          const t = Date.now();
          const req = http.get(s.srv.url + p, { agent: agents[c], headers: { ...s.srv.session(c), "Accept-Encoding": "gzip, br" } }, (res) => {
            res.resume();
            res.on("end", () => resolve({ ms: Date.now() - t, status: res.statusCode, shed: /max-age=60\b/.test(String(res.headers["cache-control"] || "")) }));
          });
          req.on("error", () => resolve({ ms: Date.now() - t, status: 0, shed: false }));
          req.setTimeout(120000, () => { req.destroy(); });
        });
        await s.srv.reset();
        const t0 = Date.now();
        const end = t0 + windowMin * 60e3;
        const w = { side: k, width, times: [], shed: 0 };
        await Promise.all(Array.from({ length: clients }, async (_, c) => {
          let page = 0;
          while (Date.now() < end) {
            const base = (c * 997 + page * 10 + wi * 131) % s.covers.length;
            const rs = await Promise.all(Array.from({ length: 10 }, (_, j) => get(c, `${s.covers[(base + j) % s.covers.length]}?w=${width}`)));
            for (const x of rs) { w.times.push(x.ms); if (x.shed) w.shed++; }
            page++;
            await sleep(400); // a person scrolling
          }
        }));
        const x = await s.srv.snap();
        const secs = (Date.now() - t0) / 1000;
        s.times.push(...w.times); s.shed += w.shed; s.n += w.times.length;
        s.cpuS += (x.cpuSinceReset.user + x.cpuSinceReset.system) / 1e6; s.secs += secs;
        agents.forEach((a) => a.destroy());
        const row = { side: k, round: r, width, pictures: w.times.length, p50: median(w.times), p95: pct(w.times, 95), max: Math.max(...w.times), shed: w.shed };
        out.windows.push(row);
        process.stderr.write(`[picab] ${JSON.stringify(row)}\n`);
        // let the background encodes of this window drain before the next one
        await sleep(15000);
      }
    }
    for (const [k, s] of Object.entries(sides)) {
      out.summary.push({ side: k, pictures: s.n, perMin: round(s.n / (s.secs / 60), 0), p50: median(s.times), p95: pct(s.times, 95), p99: pct(s.times, 99), max: Math.max(...s.times), shedPct: round((s.shed / Math.max(1, s.n)) * 100, 1), cpuCores: round(s.cpuS / s.secs, 3) });
    }
  } finally { for (const s of Object.values(sides)) await s.srv.stop(); }
  const f = saveJson(`picab${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.summary, [["", "side"], ["pictures", "pictures"], ["per min", "perMin"], ["p50 ms", "p50"], ["p95 ms", "p95"], ["p99 ms", "p99"], ["max ms", "max"], ["shed %", "shedPct"], ["CPU cores", "cpuCores"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
