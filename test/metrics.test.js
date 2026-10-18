// lib/metrics.js — the admin's view of why the server is slow.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const metrics = require("../src/lib/metrics");

const withApp = async (setup, fn) => {
  const app = express();
  app.use(metrics.middleware);
  app.use(require("../src/lib/servertiming").middleware);
  setup(app);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections?.(); server.close(); }
};

test("route groups are request SHAPES: an id or a name never becomes a group", () => {
  const g = (path) => metrics.groupOf({ path });
  assert.equal(g("/api/item/abc123"), "/api/item/:id");
  assert.equal(g("/api/person/Tom%20Hanks"), "/api/person/:id");
  assert.equal(g("/img/0d9f8e?w=300"), "/img/:id");
  assert.equal(g("/stream/hls/xyz/seg12.ts"), "/stream/hls/:id/:file.ts");
  assert.equal(g("/js/screens/home.js"), "static");
  assert.equal(g("/"), "page /");
});

test("requests are counted per group with a first-byte histogram; a slow one is one log line with its steps", async () => {
  metrics._internals._reset();
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    await withApp((app) => {
      app.get("/api/item/:id", (req, res) => res.json({ ok: true }));
      app.get("/api/home", async (req, res) => {
        res.timing("compose", 1100, "made");
        await new Promise((r) => setTimeout(r, 1100));
        res.json({ home: true });
      });
      app.get("/api/library", (req, res) => res.status(503).json({}));
    }, async (base) => {
      for (let i = 0; i < 5; i++) await (await fetch(`${base}/api/item/x${i}`)).json();
      await (await fetch(`${base}/api/home`)).json();
      await fetch(`${base}/api/library`);
    });
  } finally {
    console.warn = orig;
  }
  const s = metrics.snapshot();
  const item = s.requests.find((r) => r.group === "/api/item/:id");
  assert.equal(item.n, 5);
  assert.equal(item.s2, 5);
  assert.equal(item.inflight, 0);
  assert.ok(item.p50Ms <= 100);
  const home = s.requests.find((r) => r.group === "/api/home");
  assert.equal(home.slow, 1);
  assert.ok(home.p50Ms >= 1000);
  assert.equal(s.requests.find((r) => r.group === "/api/library").s5, 1);
  const slow = warned.filter((w) => w.startsWith("[slow]"));
  assert.equal(slow.length, 1);
  assert.match(slow[0], /GET \/api\/home 200 first byte after \d+ ms — compose 1100 \(made\)/);
  // the rest of the snapshot is there
  for (const k of ["eventLoop", "memory", "work", "upstream", "rateLimits", "ws", "checks"]) assert.ok(k in s, k);
  assert.ok(s.memory.rss > 0);
});

test("a flood of slow requests is one line per group per 10 s, with a count of the rest", async () => {
  metrics._internals._reset();
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    await withApp((app) => {
      app.get("/api/search", (req, res) => { const t = Date.now(); while (Date.now() - t < 1010); res.json({}); });
    }, async (base) => {
      for (let i = 0; i < 3; i++) await fetch(`${base}/api/search`);
    });
  } finally {
    console.warn = orig;
  }
  assert.equal(warned.filter((w) => w.startsWith("[slow]")).length, 1);
  assert.equal(metrics.snapshot().requests.find((r) => r.group === "/api/search").slow, 3);
});

test("a stream the viewer leaves is counted as aborted, its time is the first byte", async () => {
  metrics._internals._reset();
  await withApp((app) => {
    app.get("/stream/abc", (req, res) => { res.writeHead(200); const iv = setInterval(() => res.write("x".repeat(1000)), 10); res.on("close", () => clearInterval(iv)); });
  }, async (base) => {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/stream/abc`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    await reader.read();
    ctrl.abort();
    await new Promise((res) => setTimeout(res, 100));
  });
  const st = metrics.snapshot().requests.find((r) => r.group === "/stream/:id");
  assert.equal(st.aborted, 1);
  assert.equal(st.inflight, 0);
  assert.ok(st.p50Ms <= 100, "time to first byte, not the stream's length");
});

test("Prometheus text: counters, a histogram, gauges", async () => {
  metrics._internals._reset();
  await withApp((app) => app.get("/api/item/:id", (q, r) => r.json({})), async (base) => { await fetch(`${base}/api/item/1`); });
  const t = metrics.prom();
  assert.match(t, /aurora_http_requests_total\{group="\/api\/item\/:id",result="s2"\} 1/);
  assert.match(t, /aurora_http_first_byte_ms_bucket\{group="\/api\/item\/:id",le="\+Inf"\} 1/);
  assert.match(t, /aurora_memory_bytes\{kind="rss"\} \d+/);
});

