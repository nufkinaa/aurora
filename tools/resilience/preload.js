// Preloaded (node -r) into a PRIVATE Aurora instance by tools/resilience/faultinject.js.
//
//   1. The outside world is a fake: every fetch() to a provider host is sent
//      to the local fake upstream (AURORA_FAKE_UPSTREAM=http://127.0.0.1:N)
//      instead, with the real host as the first path word. The server's own
//      code still sees the real address (breakers, caches, logs are keyed by
//      it); only the bytes come from the fake.
//   2. A side door for the measurements (AURORA_PROBE=1): CPU time, event
//      loop delay (p50/p99/max since the last read), memory, open handles —
//      the same on any version of the server, so before and after compare.
// Nothing here is used by the app or shipped with it.
"use strict";
const http = require("http");
const { monitorEventLoopDelay } = require("perf_hooks");

const FAKE = process.env.AURORA_FAKE_UPSTREAM || "";
const PROVIDERS = /(^|\.)(themoviedb\.org|tmdb\.org|strem\.io|tvmaze\.com|wikipedia\.org|wikimedia\.org|wikidata\.org|metahub\.space|opensubtitles|wizdom|apple\.com|itunes\.apple\.com|torrentio|theintrodb|skipdb)/i;
if (FAKE && typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    try {
      const u = new URL(typeof input === "string" ? input : input.url || String(input));
      if (PROVIDERS.test(u.hostname)) return realFetch(`${FAKE}/${u.hostname}${u.pathname}${u.search}`, init);
    } catch {}
    return realFetch(input, init);
  };
}

// (the port is the OS's pick, written to ./probe-port in the instance's folder)
if (process.env.AURORA_PROBE === "1") {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let cpu0 = process.cpuUsage();
  const srv = http.createServer((req, res) => {
    const cpu = process.cpuUsage(cpu0);
    const m = process.memoryUsage();
    const out = {
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      loop: { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, min: h.min / 1e6 },
      rss: m.rss, heapUsed: m.heapUsed, external: m.external,
      handles: process._getActiveHandles ? process._getActiveHandles().length : null,
    };
    if (req.url.startsWith("/reset")) { h.reset(); cpu0 = process.cpuUsage(); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  });
  srv.listen(0, "127.0.0.1", () => { try { require("fs").writeFileSync("probe-port", String(srv.address().port)); } catch {} });
  srv.unref();
}
