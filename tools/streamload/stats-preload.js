// Loaded into the private instance (`node -r`): once a second it writes the
// process's own CPU time, memory, event-loop delay and open handles to the
// file named by STREAMLOAD_STATS, so the rig reads the server from inside
// without touching it over HTTP. Nothing else is changed.
"use strict";
const fs = require("fs");
const { monitorEventLoopDelay } = require("perf_hooks");

const file = process.env.STREAMLOAD_STATS;
if (file) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t = setInterval(() => {
    const cpu = process.cpuUsage();
    const m = process.memoryUsage();
    const out = {
      at: Date.now(),
      cpuUs: cpu.user + cpu.system,
      rss: m.rss, heap: m.heapUsed, ext: m.external, ab: m.arrayBuffers,
      lagP50: h.percentile(50) / 1e6, lagP99: h.percentile(99) / 1e6, lagMax: h.max / 1e6,
      handles: typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null,
    };
    h.reset();
    try { fs.appendFileSync(file, JSON.stringify(out) + "\n"); } catch {}
  }, 1000);
  t.unref();
}
