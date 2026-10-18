// lib/ratelimit.js — per-client token buckets on the public endpoints that
// cost something. "log" mode (the default) refuses nothing and counts what it
// would have refused; "enforce" answers 429 + Retry-After. A signed-in device
// is its own client; an address is only believed from X-Forwarded-For when the
// socket is the proxy on this machine. And the limits never touch the paths
// they are not for (video, Home, admin sign-in).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const config = require("../src/config");
const ratelimit = require("../src/lib/ratelimit");
const { _internals } = ratelimit;

let now = 1_000_000;
test.beforeEach(() => { _internals._reset(); now = 1_000_000; _internals.setClock(() => now); });
test.after(() => { _internals.setClock(null); config.RATE_LIMITS = undefined; });

const req = (path, { ip = "203.0.113.9", xff, method = "GET", headers = {} } = {}) => ({
  method, path, headers: { ...(xff ? { "x-forwarded-for": xff } : {}), ...headers }, socket: { remoteAddress: ip },
});

test("which requests are limited: costly public endpoints only", () => {
  assert.equal(ratelimit.groupOf("GET", "/api/search"), "search");
  assert.equal(ratelimit.groupOf("GET", "/api/search/suggest"), "suggest");
  assert.equal(ratelimit.groupOf("GET", "/api/discover/meta/movie/tt1"), null, "a title page is never limited");
  assert.equal(ratelimit.groupOf("GET", "/api/catalog"), "catalogue");
  assert.equal(ratelimit.groupOf("GET", "/api/person/tmdb:1"), "person");
  assert.equal(ratelimit.groupOf("POST", "/api/subtitles/resync"), "resync");
  assert.equal(ratelimit.groupOf("POST", "/api/subtitles/resync/status"), null, "the status poll is never limited");
  for (const p of ["/api/home", "/api/library", "/api/item/abc", "/api/watchlist", "/stream/abc", "/api/auth/login", "/api/admin/metrics", "/img/abc", "/img/meta/x.jpg", "/api/profiles/abc/progress"]) {
    assert.equal(ratelimit.groupOf("GET", p), null, p);
    assert.equal(ratelimit.groupOf("POST", p), null, p);
  }
});

test("enforce is the default (owner, 2026-10-18)", () => {
  config.RATE_LIMITS = undefined;
  assert.equal(ratelimit.status().mode, "enforce");
  const { burst } = ratelimit.GROUPS.person;
  for (let i = 0; i < burst; i++) assert.equal(ratelimit.take("person", req("/api/person/x")).ok, true);
  assert.equal(ratelimit.take("person", req("/api/person/x")).ok, false);
});

test("log mode (the off-switch): nothing is refused, what would be is counted", () => {
  config.RATE_LIMITS = "log";
  const burst = ratelimit.GROUPS.person.burst;
  for (let i = 0; i < burst + 10; i++) assert.equal(ratelimit.take("person", req("/api/person/x")).ok, true);
  const g = ratelimit.status().groups.find((x) => x.group === "person");
  assert.equal(ratelimit.status().mode, "log");
  assert.equal(g.wouldRefuse, 10);
  assert.equal(g.refused, 0);
});

test("enforce: past the burst the answer is no, and the bucket refills at its rate", () => {
  config.RATE_LIMITS = "enforce";
  const { burst, rate } = ratelimit.GROUPS.person;
  for (let i = 0; i < burst; i++) assert.equal(ratelimit.take("person", req("/api/person/x")).ok, true);
  const r = ratelimit.take("person", req("/api/person/x"));
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterSec >= 1);
  now += Math.ceil(1000 / rate) + 1;
  assert.equal(ratelimit.take("person", req("/api/person/x")).ok, true, "one more after 1/rate s");
  assert.equal(ratelimit.status().groups.find((x) => x.group === "person").refused, 1);
});

test("per-group overrides: a group can be enforced, logged or off on its own", () => {
  config.RATE_LIMITS = { mode: "log", groups: { person: { mode: "enforce", burst: 2, rate: 1 }, search: { mode: "off" } } };
  assert.equal(ratelimit.take("person", req("/a")).ok, true);
  assert.equal(ratelimit.take("person", req("/a")).ok, true);
  assert.equal(ratelimit.take("person", req("/a")).ok, false);
  for (let i = 0; i < 500; i++) assert.equal(ratelimit.take("search", req("/a")).mode, "off");
  assert.equal(ratelimit.take("xray", req("/a")).mode, "log");
});

test("one client's flood does not touch another client's allowance", () => {
  config.RATE_LIMITS = "enforce";
  const { burst } = ratelimit.GROUPS.person;
  for (let i = 0; i < burst + 5; i++) ratelimit.take("person", req("/a", { ip: "198.51.100.1" }));
  assert.equal(ratelimit.take("person", req("/a", { ip: "198.51.100.1" })).ok, false);
  assert.equal(ratelimit.take("person", req("/a", { ip: "198.51.100.2" })).ok, true);
});

test("a LAN address gets more; X-Forwarded-For is believed only from the proxy on this machine", () => {
  config.RATE_LIMITS = "enforce";
  const { burst } = ratelimit.GROUPS.person;
  // a LAN device: four times the allowance
  for (let i = 0; i < burst * 4; i++) assert.equal(ratelimit.take("person", req("/a", { ip: "192.168.1.20" })).ok, true);
  assert.equal(ratelimit.take("person", req("/a", { ip: "192.168.1.20" })).ok, false);
  // a LAN device cannot pretend to be someone else
  assert.equal(_internals.addressOf(req("/a", { ip: "192.168.1.20", xff: "203.0.113.50" })), "192.168.1.20");
  // the reverse proxy on this machine: its header is the client
  // (the right-most hop is the one the proxy itself saw; what is left of it the client wrote)
  assert.equal(_internals.addressOf(req("/a", { ip: "127.0.0.1", xff: "203.0.113.50, 10.0.0.1" })), "10.0.0.1");
  assert.equal(_internals.addressOf(req("/a", { ip: "127.0.0.1", xff: "203.0.113.50" })), "203.0.113.50");
  assert.equal(_internals.addressOf(req("/a", { ip: "::ffff:127.0.0.1", xff: "203.0.113.51" })), "203.0.113.51");
});

test("trustProxy: a proxy elsewhere is named in config; X-Forwarded-For is read from the right", () => {
  const addr = _internals.addressOf;
  // the client sent its own header through the local proxy: the proxy's hop wins
  assert.equal(addr(req("/a", { ip: "127.0.0.1", xff: "9.9.9.9, 203.0.113.60" })), "203.0.113.60");
  // a Docker bridge in front: not believed until configured
  assert.equal(addr(req("/a", { ip: "172.17.0.1", xff: "203.0.113.61" })), "172.17.0.1");
  config.TRUST_PROXY = ["172.17.0.0/16"];
  try {
    assert.equal(addr(req("/a", { ip: "172.17.0.1", xff: "203.0.113.61" })), "203.0.113.61");
    assert.equal(addr(req("/a", { ip: "172.17.0.1", xff: "203.0.113.62, 172.17.0.5" })), "203.0.113.62", "trusted hops are skipped");
    assert.equal(addr(req("/a", { ip: "172.18.0.1", xff: "203.0.113.63" })), "172.18.0.1", "outside the range: not believed");
  } finally {
    config.TRUST_PROXY = [];
  }
  // the admission lane keys clients the same way
  assert.equal(require("../src/lib/admission").heavy.clientKey(req("/a", { ip: "192.168.1.9", xff: "203.0.113.64" })), "a:192.168.1.9");
});

test("a made-up session header is an address, not a fresh allowance", () => {
  config.RATE_LIMITS = "enforce";
  const { burst } = ratelimit.GROUPS.person;
  for (let i = 0; i < burst; i++) ratelimit.take("person", req("/a", { headers: { "x-session": `fake-${i}` } }));
  assert.equal(ratelimit.take("person", req("/a", { headers: { "x-session": "fake-new" } })).ok, false);
});

test("idle buckets are forgotten; the table is bounded", () => {
  for (let i = 0; i < 300; i++) ratelimit.take("search", req("/a", { ip: `198.51.100.${i % 250}` }));
  assert.ok(_internals.buckets.size > 0);
  now += 10 * 60 * 1000;
  _internals.sweep(now);
  assert.equal(_internals.buckets.size, 0);
});

test("through Express: 429 with Retry-After in enforce mode, the route untouched in log mode", async () => {
  const app = express();
  app.use(ratelimit.middleware);
  app.get("/api/person/:id", (q, r) => r.json({ ok: true }));
  app.get("/api/home", (q, r) => r.json({ home: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    _internals.setClock(null);
    config.RATE_LIMITS = { mode: "enforce", groups: { person: { burst: 3, rate: 0.5 } } };
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/person/1`, { headers: { "x-forwarded-for": "203.0.113.7" } })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    const r = await fetch(`${base}/api/person/1`, { headers: { "x-forwarded-for": "203.0.113.7" } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await r.json()).limit, "person");
    for (let i = 0; i < 50; i++) assert.equal((await fetch(`${base}/api/home`)).status, 200, "Home is never limited");
    _internals._reset();
    config.RATE_LIMITS = { mode: "log", groups: { person: { burst: 3, rate: 0.5 } } };
    for (let i = 0; i < 6; i++) assert.equal((await fetch(`${base}/api/person/1`, { headers: { "x-forwarded-for": "203.0.113.7" } })).status, 200);
    assert.equal(ratelimit.status().groups.find((x) => x.group === "person").wouldRefuse, 3);
  } finally {
    server.close();
  }
});
