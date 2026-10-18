#!/usr/bin/env node
// TITLE-PAGE METADATA UPSTREAM: how often the server asks Cinemeta about the
// titles it has, before against after, the two instances side by side over
// the same window.
//
//   node tools/backend-perf/upstream.js --before <commit> [--after <commit>] [--minutes 25] [--scan 5] [--label x]
//   -> <results>/upstream[-label].json and a table
//
// The household's meta.json is aged 13 hours (older than the 12-hour fresh
// window, as it is every morning on a server that has been up a while), and
// a tenth of the library is missing from it (titles Cinemeta does not answer:
// the instance's network fence refuses every outbound connection, so every
// request fails, the way a title Cinemeta has no page for fails). Both
// instances are started, the window opens once both are listening, and every
// outbound connection attempt to Cinemeta is counted (probe.js "outbound").
// --scan: the rescan interval in minutes (default 5: two scans in ten minutes
// show the per-scan behaviour twice as often as the real 10).
// Also asked, once per minute per instance: one title page of a stale title
// (GET /api/discover/meta/<type>/<id>) — the answer's wall time is reported.
const fs = require("fs");
const path = require("path");
const { start } = require("./instance");
const dataset = require("./dataset");
const { round, saveJson, arg, table, sleep, median } = require("./lib");

(async () => {
  const minutes = +arg("minutes", 25);
  const scan = +arg("scan", 5);
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const label = arg("label") === true ? undefined : arg("label");
  if (!before) throw new Error("--before <commit> is required");
  const ds = dataset.build();
  const meta = JSON.parse(fs.readFileSync(path.join(ds.seedDir, "cache", "meta.json"), "utf8"));
  const aged = {};
  let i = 0;
  const staleAt = Date.now() - 13 * 3600e3;
  for (const [k, v] of Object.entries(meta)) {
    if (i++ % 10 === 0) continue; // missing: asked about, and failing
    aged[k] = { ...v, at: staleAt };
  }
  const cfg = { probe: "full", loop: false, config: { scanIntervalMinutes: scan }, seed: { "cache/meta.json": aged } };
  const A = await start({ ...cfg, ref: before });
  const B = await start({ ...cfg, ref: after });
  const out = { at: new Date().toISOString(), before, after: after || "working tree", minutes, scanMinutes: scan, titlesInMeta: Object.keys(aged).length, missing: Object.keys(meta).length - Object.keys(aged).length, rows: [] };
  try {
    await Promise.all([A.reset(), B.reset()]);
    const t0 = Date.now();
    const page = { a: [], b: [] };
    const film = { imdbId: Object.keys(aged).find((k) => k.startsWith("movie|")).split("|")[1] };
    while (Date.now() - t0 < minutes * 60e3) {
      for (const [k, s] of [["a", A], ["b", B]]) {
        const t = Date.now();
        try {
          const r = await fetch(`${s.url}/api/discover/meta/movie/${film.imdbId}`, { headers: s.session(0), signal: AbortSignal.timeout(30000) });
          await r.arrayBuffer();
          page[k].push({ ms: Date.now() - t, status: r.status });
        } catch { page[k].push({ ms: Date.now() - t, status: 0 }); }
      }
      await sleep(60e3);
    }
    const hours = (Date.now() - t0) / 3600e3;
    for (const [which, s, k] of [["before", A, "a"], ["after", B, "b"]]) {
      const snap = await s.snap();
      const cin = snap.outbound.filter((r) => /cinemeta/i.test(r.key)).reduce((a, r) => a + r.n, 0);
      const all = snap.outbound.reduce((a, r) => a + r.n, 0);
      out.rows.push({ which, cinemetaPerHour: round(cin / hours, 0), allOutboundPerHour: round(all / hours, 0), cinemetaPerDayAtThisRate: round((cin / hours) * 24, 0),
        titlePageMs: median(page[k].map((p) => p.ms)), titlePageStatus: [...new Set(page[k].map((p) => p.status))].join("/"), hosts: snap.outbound.slice(0, 8) });
    }
  } finally { await A.stop(); await B.stop(); }
  const f = saveJson(`upstream${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows, [["", "which"], ["Cinemeta tries / hour", "cinemetaPerHour"], ["per day", "cinemetaPerDayAtThisRate"], ["all outbound / hour", "allOutboundPerHour"], ["title page ms (median)", "titlePageMs"], ["status", "titlePageStatus"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
