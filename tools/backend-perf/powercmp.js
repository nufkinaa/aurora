#!/usr/bin/env node
// THE LOW-POWER PROFILE (lib/power.js): one commit, started twice side by
// side — "powerProfile": "normal" and "low" — on the weak profile. Both warm
// and quiet; then every profile asks Home and a few searches (so the
// recommender and the search index are built); memory after a forced
// collection; then --minutes of nobody, CPU and wake-ups per hour.
//
//   node tools/backend-perf/powercmp.js [--ref <commit>] [--minutes 10] [--label x]
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep } = require("./lib");

(async () => {
  const ref = arg("ref") === true ? undefined : arg("ref");
  const minutes = +arg("minutes", 10);
  const label = arg("label") === true ? undefined : arg("label");
  const make = (p) => start({ weak: true, ref, probe: "full", config: { powerProfile: p } });
  const N = await make("normal");
  const L = await make("low");
  const out = { at: new Date().toISOString(), ref: ref || "working tree", minutes, rows: [] };
  try {
    for (const s of [N, L]) await s.waitWarm();
    for (const s of [N, L]) await s.waitQuiet();
    for (const s of [N, L]) {
      for (let i = 0; i < s.ds.sessions.length; i++) {
        const h = { ...s.session(i), "Accept-Encoding": "gzip" };
        await (await fetch(`${s.url}/api/home?profile=${s.profile(i)}`, { headers: h })).arrayBuffer();
        for (const q of ["si", "gol", "mid"]) await (await fetch(`${s.url}/api/search/suggest?v=2&q=${q}`, { headers: h })).arrayBuffer();
      }
    }
    await sleep(20000);
    const mem = {};
    for (const [k, s] of [["normal", N], ["low", L]]) mem[k] = (await s.gc()).mem;
    await Promise.all([N.reset(), L.reset()]);
    await sleep(minutes * 60e3);
    for (const [k, s] of [["normal", N], ["low", L]]) {
      const x = await s.snap();
      const hours = x.sinceResetMs / 3600e3;
      const h = await (await fetch(`${s.url}/api/admin/health`, { headers: { "X-Admin-Password": s.adminPassword } })).json().catch(() => ({}));
      out.rows.push({
        profile: k, said: h.load && h.load.power ? `${h.load.power.profile} (${h.load.power.why})` : "?",
        budget: h.load && h.load.cpu ? h.load.cpu.backgroundBudget : null,
        rssMb: round(mem[k].rss / 1048576, 1), heapMb: round(mem[k].heapUsed / 1048576, 1),
        idleCpuSecPerHour: round((x.cpuSinceReset.user + x.cpuSinceReset.system) / 1e6 / hours, 1),
        wakeUpsPerMin: round(x.timers.reduce((a, t) => a + t.fires, 0) / (x.sinceResetMs / 60000), 1),
        syncFsPerHour: round(x.syncFs.filter((r) => !/ @ /.test(r.key)).reduce((a, r) => a + r.n, 0) / hours, 0),
      });
    }
  } finally { await N.stop(); await L.stop(); }
  const f = saveJson(`powercmp${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows, [["", "profile"], ["server says", "said"], ["background budget", "budget"], ["RSS MB", "rssMb"], ["heap MB", "heapMb"], ["idle CPU s/h", "idleCpuSecPerHour"], ["wake-ups/min", "wakeUpsPerMin"], ["blocking fs/h", "syncFsPerHour"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
