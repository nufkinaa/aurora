#!/usr/bin/env node
// THE SMALL THINGS: what one call of the functions on every request path
// costs, measured inside the server (inproc/micro.js) — before and after.
//
//   node tools/backend-perf/micro.js [--weak] --before 68e946a [--after <commit>] [--label x]
//   -> docs/qa/backend-efficiency/results/micro[-weak][-label].json and a table (CPU microseconds per call)
const path = require("path");
const { start } = require("./instance");
const { saveJson, arg, table } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const label = arg("label") === true ? undefined : arg("label");
  const run = async (ref) => {
    const srv = await start({ weak, ref, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } });
    try {
      await srv.waitWarm(); await srv.waitQuiet();
      return await srv.exec(path.join(__dirname, "inproc", "micro.js"), { sid: srv.ds.sessions[0].sid });
    } finally { await srv.stop(); }
  };
  const a = before ? await run(before) : null;
  const b = await run(after);
  const rows = b.calls.map((c) => { const x = a && a.calls.find((y) => y.what === c.what); return { what: c.what, before: x ? x.cpuUs : null, after: c.cpuUs }; });
  const f = saveJson(`micro${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, { at: new Date().toISOString(), before: before || null, after: after || "working tree", weak, profiles: b.profiles, films: b.films, rows });
  console.log(table(rows, [["one call of", "what"], ...(a ? [["before, µs", "before"]] : []), [a ? "after, µs" : "µs", "after"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
