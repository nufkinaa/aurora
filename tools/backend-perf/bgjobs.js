#!/usr/bin/env node
// THE SERVER'S OWN BACKGROUND JOBS (perf-server, 2026-11-10): each one run
// alone in a settled private instance (inproc/bgjobs.js), with how long it
// held the event loop (its longest single delay is what a request arriving
// meanwhile would have waited).
//
//   node tools/backend-perf/bgjobs.js [--ref <commit>] [--label x]
//   -> <results>/bgjobs[-label].json
const path = require("path");
const { start } = require("./instance");
const { saveJson, arg, table, sleep } = require("./lib");

(async () => {
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const srv = await start({ ref, probe: "full", config: { scanIntervalMinutes: 24 * 60 } });
  const out = { at: new Date().toISOString(), ref: ref || "working tree" };
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    { const s = await srv.snap(); if (s.uptimeMs < 80000) await sleep(80000 - s.uptimeMs); } // past the torrent code preload
    out.alone = await srv.exec(path.join(__dirname, "inproc", "bgjobs.js"), {});
  } finally { await srv.stop(); }
  saveJson(`bgjobs${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.alone, [["job", "name"], ["wall ms", "wallMs"], ["loop active ms", "loopActiveMs"], ["loop max delay ms", "loopMaxMs"], ["cpu ms", "cpuMs"], ["blocking fs", "syncFs"], ["error", "error"]]));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
