// lib/httplimits.js — a client that drips its headers or its body a byte at
// a time is cut off (408) at the limit, checked every 2 s; an idle keep-alive
// connection is NOT cut by the header limit (the laggy-TV fix of 2026-10-08);
// a long ANSWER is never limited. Limits shrunk to seconds for the test.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const http = require("http");
const { createServer, settings } = require("../src/lib/httplimits");

const start = async (handler, cfg) => {
  const server = createServer(handler, cfg);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
};
const echo = (req, res) => { req.resume(); req.on("end", () => res.end(`ok ${req.url}`)); };

test("the defaults: keep-alive 75 s, headers 20 s, whole request 120 s", () => {
  const s = settings({});
  assert.equal(s.keepAliveTimeout, 75000);
  assert.equal(s.headersTimeout, 20000);
  assert.equal(s.requestTimeout, 120000);
  // nonsense in config is ignored
  assert.equal(settings({ headersTimeoutSec: "soon", requestTimeoutSec: -1 }).headersTimeout, 20000);
});

test("headers dripped a byte at a time: 408 and closed at the limit", async () => {
  const { server, port } = await start(echo, { headersTimeoutSec: 2, requestTimeoutSec: 5 });
  try {
    const t0 = Date.now();
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d));
    s.on("error", () => {});
    const line = "GET /x HTTP/1.1\r\nHost: x\r\nX-A: " + "a".repeat(200);
    let i = 0;
    const iv = setInterval(() => { try { s.write(line[i++] || "a"); } catch {} }, 200);
    const closedAt = await new Promise((r) => s.on("close", () => r(Date.now() - t0)));
    clearInterval(iv);
    assert.match(got, /^HTTP\/1\.1 408/);
    assert.ok(closedAt >= 1900 && closedAt < 5500, `closed after ${closedAt} ms`);
  } finally { server.close(); }
});

test("a body dripped a byte at a time: 408 at the whole-request limit", async () => {
  const { server, port } = await start(echo, { headersTimeoutSec: 2, requestTimeoutSec: 4 });
  try {
    const t0 = Date.now();
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d));
    s.on("error", () => {});
    s.write("POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 10000\r\n\r\n");
    const iv = setInterval(() => { try { s.write("x"); } catch {} }, 200);
    const closedAt = await new Promise((r) => s.on("close", () => r(Date.now() - t0)));
    clearInterval(iv);
    assert.match(got, /^HTTP\/1\.1 408/);
    assert.ok(closedAt >= 3900 && closedAt < 7500, `closed after ${closedAt} ms`);
  } finally { server.close(); }
});

test("an idle keep-alive connection outlives the header limit and is reused", async () => {
  const { server, port } = await start(echo, { headersTimeoutSec: 2, requestTimeoutSec: 3, keepAliveTimeoutSec: 20 });
  try {
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    let closed = false;
    s.on("data", (d) => (got += d));
    s.on("close", () => (closed = true));
    s.write("GET /first HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((r) => setTimeout(r, 5000)); // idle past both limits
    assert.equal(closed, false);
    s.write("GET /second HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((r) => setTimeout(r, 300));
    assert.match(got, /ok \/second/);
    s.destroy();
  } finally { server.close(); }
});

test("a long answer is never cut by the request limits", async () => {
  const { server, port } = await start((req, res) => {
    let n = 0;
    res.writeHead(200);
    const iv = setInterval(() => { res.write("x"); if (++n === 6) { clearInterval(iv); res.end(); } }, 1000);
  }, { headersTimeoutSec: 2, requestTimeoutSec: 3 });
  try {
    const bytes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => { let b = 0; res.on("data", (d) => (b += d.length)); res.on("end", () => resolve(b)); res.on("error", reject); }).on("error", reject);
    });
    assert.equal(bytes, 6);
  } finally { server.close(); }
});
