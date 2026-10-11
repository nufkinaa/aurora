#!/usr/bin/env node
// INLINE require(): how many times one request calls require() for a module
// that is already loaded, from where, and what each call costs.
//
//   node tools/backend-perf/requires.js [--weak] [--ref <commit>] [--label before]
//   -> docs/qa/backend-efficiency/results/requires[-weak][-label].json and a table
//
// Why it matters: a require() written inside a function (the usual way round
// a circular import) is not free on Node 22. Node remembers "this folder asked
// for this string" only when that call LOADED the module; when the module was
// first loaded from somewhere else, every later call resolves the path again
// — 40-60 µs each on a two-core box instead of 1 µs (measured here, per call,
// inside the server). A handler that does it in a loop pays for it per row.
const path = require("path");
const { start } = require("./instance");
const { endpoints, prepare } = require("./endpoints");
const { round, saveJson, arg, table } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const srv = await start({ weak, ref, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } });
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, rows: [] };
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    const list = await prepare(srv, endpoints(srv));
    for (const e of list) {
      if ((e.method || "GET") !== "GET") continue;
      const p = typeof e.path === "function" ? e.path(1) : e.path;
      const headers = { ...srv.session(0), ...(typeof e.headers === "function" ? e.headers(1) : e.headers || {}) };
      const r = await srv.exec(path.join(__dirname, "inproc", "require-count.js"), { path: p, headers, repeat: 3 });
      out.rows.push({ name: e.name, status: r.status, requires: r.perRequest, usEach: r.cpuMicrosecondsPerRequire, ms: round((r.perRequest * r.cpuMicrosecondsPerRequire) / 1000, 2), top: r.top.filter((t) => t.perRequest >= 1).slice(0, 8) });
    }
  } finally { await srv.stop(); }
  const f = saveJson(`requires${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows, [["request", "name"], ["require() calls", "requires"], ["µs each", "usEach"], ["ms per request", "ms"], ["from", (r) => r.top.slice(0, 3).map((t) => `${t.site} ×${t.perRequest}`).join("; ")]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
})().catch((e) => { console.error(e); process.exit(1); });
