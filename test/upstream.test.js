// lib/upstream.js — the one way out to the outside world. A tiny local fake
// upstream answers 200 / 404 / 500 / 503-then-ok, hangs, drips its body a
// byte at a time, and counts how many calls it has in hand at once. Nothing
// here leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const upstream = require("../src/lib/upstream");
const { HOSTS, _internals } = upstream;

let server;
let base;
let host;
let inHand = 0;
let maxInHand = 0;
let hits = {};
let flaky = 0;
let answer = { v: 1 };
const hit = (k) => { hits[k] = (hits[k] || 0) + 1; };

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hit(u.pathname);
    inHand++;
    maxInHand = Math.max(maxInHand, inHand);
    const done = () => { inHand--; };
    res.on("close", done);
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    switch (u.pathname) {
      case "/ok": return json(200, answer);
      case "/404": return json(404, { error: "no" });
      case "/500": return json(500, { error: "boom" });
      case "/flaky": if (flaky-- > 0) return json(503, { error: "later" }); return json(200, { ok: true });
      case "/hang": return; // never answers
      case "/slow": return setTimeout(() => json(200, answer), Number(u.searchParams.get("ms")) || 200);
      case "/drip": {
        res.writeHead(200, { "Content-Type": "application/json" });
        const iv = setInterval(() => { try { res.write(" "); } catch {} }, 50);
        res.on("close", () => clearInterval(iv));
        return;
      }
      case "/big": res.writeHead(200); return res.end(Buffer.alloc(64 * 1024, 0x61));
      default: return json(200, {});
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});
test.after(() => { server.closeAllConnections?.(); server.close(); });
test.beforeEach(() => {
  _internals._reset();
  hits = {};
  maxInHand = 0;
  answer = { v: 1 };
  HOSTS[host] = { timeoutMs: 400, concurrency: 2, queue: 4, queueWaitMs: 300, failThreshold: 3, cooldownMs: 150, cooldownMaxMs: 1000, retries: 1, retryBaseMs: 10, retryMaxMs: 40 };
});

const state = () => upstream.status().hosts.find((h) => h.host === host);

test("an answer comes back as a real Response, body read", async () => {
  const res = await upstream.fetch(`${base}/ok`);
  assert.equal(res.status, 200);
  assert.ok(res.ok);
  assert.deepEqual(await res.json(), { v: 1 });
  assert.equal(state().ok, 1);
});

test("a host that never answers is cut off at the timeout", async () => {
  const t0 = Date.now();
  await assert.rejects(upstream.fetch(`${base}/hang`, { retries: 0 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 1000, "timed out in time");
  assert.equal(state().timeouts, 1);
});

test("a body that drips a byte at a time is cut off at the timeout too", async () => {
  const t0 = Date.now();
  await assert.rejects(upstream.fetch(`${base}/drip`), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 1000);
});

test("a body over maxBytes is refused", async () => {
  await assert.rejects(upstream.fetch(`${base}/big`, { maxBytes: 1024 }), (e) => e.code === "too-large");
});

test("the breaker opens after failures in a row, then fails fast, then lets one trial through", async () => {
  for (let i = 0; i < 3; i++) {
    const r = await upstream.fetch(`${base}/500`, { retries: 0 });
    assert.equal(r.status, 500); // an answer that is not ok is handed to the caller
  }
  assert.equal(state().breaker, "open");
  const before = hits["/500"];
  const t0 = performance.now();
  await assert.rejects(upstream.fetch(`${base}/500`), (e) => e.code === "open" && e.status === 503);
  assert.ok(performance.now() - t0 < 20, "refused without waiting");
  assert.equal(hits["/500"], before, "the host was not called");
  assert.equal(state().refusedOpen, 1);
  // after the cooldown: one trial; it fails, the breaker opens again (longer)
  await new Promise((r) => setTimeout(r, 170));
  assert.equal(state().breaker, "half-open");
  const trial = upstream.fetch(`${base}/500`, { retries: 0 });
  await assert.rejects(upstream.fetch(`${base}/500`), (e) => e.code === "open", "only ONE trial at a time");
  assert.equal((await trial).status, 500);
  assert.equal(state().breaker, "open");
  assert.ok(state().reopensInMs > 150, "the cooldown doubled");
});

test("a good trial closes the breaker", async () => {
  for (let i = 0; i < 3; i++) await upstream.fetch(`${base}/500`, { retries: 0 });
  assert.equal(state().breaker, "open");
  await new Promise((r) => setTimeout(r, 170));
  const r = await upstream.fetch(`${base}/ok`);
  assert.equal(r.status, 200);
  assert.equal(state().breaker, "closed");
  assert.equal(state().failsInARow, 0);
});

test("404 is an answer, not a failure: it never opens the breaker", async () => {
  for (let i = 0; i < 6; i++) assert.equal((await upstream.fetch(`${base}/404`)).status, 404);
  assert.equal(state().breaker, "closed");
  assert.equal(state().notFound, 6);
});

test("at most `concurrency` calls are in hand at once; the queue is bounded", async () => {
  const calls = [];
  for (let i = 0; i < 6; i++) calls.push(upstream.fetch(`${base}/slow?ms=120`).then((r) => r.status, (e) => e.code));
  const out = await Promise.all(calls);
  assert.ok(maxInHand <= 2, `in hand at once: ${maxInHand}`);
  assert.deepEqual(out.filter((x) => x === 200).length >= 4, true, out.join(","));
  // a burst past concurrency + queue is told "busy" at once
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(upstream.fetch(`${base}/slow?ms=100`).then((r) => r.status, (e) => e.code));
  const b = await Promise.all(burst);
  assert.ok(b.includes("busy"), b.join(","));
  assert.ok(maxInHand <= 2);
});

test("a GET is tried again after a 503 (with jitter); a POST never is", async () => {
  flaky = 1;
  const r = await upstream.fetch(`${base}/flaky`);
  assert.equal(r.status, 200);
  assert.equal(state().retries, 1);
  flaky = 1;
  hits = {};
  const p = await upstream.fetch(`${base}/flaky`, { method: "POST", body: "{}" });
  assert.equal(p.status, 503);
  assert.equal(hits["/flaky"], 1, "posted once");
});

test("json: kept answers come from memory, each caller with its own copy", async () => {
  const a = await upstream.json(`${base}/ok`, { ttlMs: 60000 });
  a.v = 99; // a caller changing its copy
  const b = await upstream.json(`${base}/ok`, { ttlMs: 60000 });
  assert.deepEqual(b, { v: 1 });
  assert.equal(hits["/ok"], 1);
  assert.equal(state().cacheFresh, 1);
});

test("json: many callers at once make one call", async () => {
  const all = await Promise.all(Array.from({ length: 8 }, () => upstream.json(`${base}/slow?ms=50`, { ttlMs: 60000 })));
  assert.equal(all.length, 8);
  assert.equal(hits["/slow"], 1);
});

test("json: a stale answer is answered at once and refreshed behind it", async () => {
  await upstream.json(`${base}/ok`, { ttlMs: 30 });
  await new Promise((r) => setTimeout(r, 50));
  answer = { v: 2 };
  const stale = await upstream.json(`${base}/ok`, { ttlMs: 30 });
  assert.deepEqual(stale, { v: 1 });
  await new Promise((r) => setTimeout(r, 50));
  const fresh = await upstream.json(`${base}/ok`, { ttlMs: 60000 });
  assert.deepEqual(fresh, { v: 2 });
  assert.ok(state().cacheStale >= 1);
});

test("json: when the host fails, the kept answer covers it", async () => {
  const key = `${base}/ok`;
  await upstream.json(key, { ttlMs: 30 });
  // the same key now points at a host that answers 500 (a dead provider)
  for (let i = 0; i < 3; i++) await upstream.fetch(`${base}/500`, { retries: 0 });
  assert.equal(state().breaker, "open");
  await new Promise((r) => setTimeout(r, 40));
  const v = await upstream.json(key, { ttlMs: 30 });
  assert.deepEqual(v, { v: 1 }, "served stale while the breaker is open");
});

test("json: a 404 is remembered (negative cache)", async () => {
  await assert.rejects(upstream.json(`${base}/404`, { ttlMs: 60000 }), (e) => e.status === 404);
  await assert.rejects(upstream.json(`${base}/404`, { ttlMs: 60000 }), (e) => e.status === 404);
  assert.equal(hits["/404"], 1);
  assert.equal(state().cacheNegative, 1);
});

test("json: past the deadline the caller is told at once, the call finishes and is kept (late fill)", async () => {
  const t0 = Date.now();
  await assert.rejects(upstream.asPage(() => upstream.json(`${base}/slow?ms=200`, { ttlMs: 60000, deadlineMs: 50 })), (e) => e.code === "deadline");
  assert.ok(Date.now() - t0 < 150, "the caller did not wait for the host");
  await new Promise((r) => setTimeout(r, 250));
  const t1 = performance.now();
  const v = await upstream.asPage(() => upstream.json(`${base}/slow?ms=200`, { ttlMs: 60000, deadlineMs: 50 }));
  assert.ok(performance.now() - t1 < 20, "the next ask is answered from memory");
  assert.deepEqual(v, { v: 1 });
  assert.equal(hits["/slow"], 1);
  assert.equal(state().lateFills, 1);
  assert.equal(state().deadlines, 1);
});

test("fetch with a deadline: the caller waits no longer than it", async () => {
  const t0 = Date.now();
  await assert.rejects(upstream.asPage(() => upstream.fetch(`${base}/hang`, { deadlineMs: 60 })), (e) => e.code === "deadline");
  assert.ok(Date.now() - t0 < 200);
});

test("the deadline is a PAGE's: background work (no request being answered) waits for the full answer", async () => {
  const v = await upstream.json(`${base}/slow?ms=150`, { deadlineMs: 50 });
  assert.deepEqual(v, { v: 1 });
  assert.equal(state().deadlines, 0);
  // …and inside a request (the middleware), the same call is held to it
  await new Promise((resolve, reject) => upstream.pageMiddleware({}, {}, () => {
    upstream.json(`${base}/slow?ms=150&x=2`, { deadlineMs: 50 }).then(() => reject(new Error("waited")), (e) => (e.code === "deadline" ? resolve() : reject(e)));
  }));
});

test("a caller's own abort is not a failure of the host", async () => {
  const ctrl = new AbortController();
  const p = upstream.fetch(`${base}/hang`, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, (e) => e.code === "aborted");
  assert.equal(state().failsInARow, 0);
});

test("a stubbed global fetch is still used (tests elsewhere rely on it)", async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stub: true }) });
  try {
    const r = await upstream.fetch("https://stub.example/x");
    assert.deepEqual(await r.json(), { stub: true });
  } finally {
    global.fetch = real;
  }
});

test("status() never shows a key or an address beyond the host", async () => {
  await upstream.fetch(`${base}/404?api_key=SECRET123`);
  assert.ok(!JSON.stringify(upstream.status()).includes("SECRET123"));
});
