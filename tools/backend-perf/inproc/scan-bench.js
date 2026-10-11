// Runs INSIDE the private instance (probe /exec): the cost of library rescans.
//   arg.runs    how many scans to time (default 5)
//   arg.quiet   true: time the walk alone (listeners of "scanned" detached for the run)
//   arg.after   true: also time the FIRST call of everything that keys its memory on
//               the scan (identity stamps, title-history fold, the search index) right
//               after a scan, against the second call — what a rescan that found
//               nothing new makes the next requests pay again.
// Returns per-scan medians: wall ms, CPU ms (user + system), blocking fs calls
// (counted in one extra run, with plain counters, so the timed runs carry no wrapper).
module.exports = async (arg = {}, ctx) => {
  const fs = require("fs");
  const scanner = ctx.req("src/media/scanner");
  const runs = arg.runs || 5;
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const r1 = (x) => Math.round(x * 10) / 10;
  let saved = null;
  if (arg.quiet) { saved = scanner.events.listeners("scanned"); scanner.events.removeAllListeners("scanned"); }
  const wall = [], cpu = [];
  const fsCalls = {};
  try {
    for (let i = 0; i < runs; i++) {
      const c0 = process.cpuUsage();
      const t0 = ctx.now();
      scanner.scan();
      wall.push(ctx.now() - t0);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
      await new Promise((r) => setTimeout(r, 300));
    }
    // one more, counted
    const names = ["readdirSync", "statSync", "existsSync", "readFileSync", "openSync"];
    const real = {};
    for (const n of names) { real[n] = fs[n]; fsCalls[n] = 0; fs[n] = function (...a) { fsCalls[n]++; return real[n].apply(this, a); }; }
    try { scanner.scan(); } finally { for (const n of names) fs[n] = real[n]; }
  } finally {
    if (saved) for (const l of saved) scanner.events.on("scanned", l);
  }
  const out = {
    runs, quiet: !!arg.quiet, films: scanner.index.movies.length, shows: scanner.index.shows.length,
    wallMs: r1(med(wall)), cpuMs: r1(med(cpu)),
    fsCalls: Object.fromEntries(Object.entries(fsCalls).filter(([, n]) => n)), fsCallsTotal: Object.values(fsCalls).reduce((a, b) => a + b, 0),
    wallRuns: wall.map((x) => Math.round(x)), cpuRuns: cpu.map((x) => Math.round(x)),
  };
  if (arg.after) {
    const identity = ctx.req("src/media/identity");
    const profiles = ctx.req("src/profiles");
    const search = ctx.req("src/media/search");
    const p0 = profiles.list()[0].id;
    const things = {
      "identity stamps (ensureStamped)": () => identity.ensureStamped(),
      "title-history fold (getProgressView)": () => profiles.getProgressView(p0),
      "search index (first suggest)": () => search.suggest("sil", { limit: 8 }),
      "continue watching": () => profiles.continueWatching(p0),
    };
    const first = {}, second = {};
    const rounds = 5;
    for (const k of Object.keys(things)) { first[k] = []; second[k] = []; }
    for (let i = 0; i < rounds; i++) {
      // detach the listeners so nothing warms these behind our back
      const ls = scanner.events.listeners("scanned");
      scanner.events.removeAllListeners("scanned");
      try { scanner.scan(); } finally { for (const l of ls) scanner.events.on("scanned", l); }
      for (const [k, fn] of Object.entries(things)) {
        let t0 = ctx.now(); fn(); first[k].push(ctx.now() - t0);
        t0 = ctx.now(); fn(); second[k].push(ctx.now() - t0);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    out.afterScan = Object.keys(things).map((k) => ({ what: k, firstMs: r1(med(first[k])), againMs: r1(med(second[k])) }));
    out.afterScanTaxMs = r1(out.afterScan.reduce((a, r) => a + Math.max(0, r.firstMs - r.againMs), 0));
  }
  return out;
};
