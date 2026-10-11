// Stopping the stampede, piece by piece:
//   - one "the library changed" message per burst of changes (realtime.js)
//   - a finished answer kept while nothing it was built from changes, with a
//     strong validator and 304s (lib/answermemo.js)
//   - one heavy request per turn of the event loop, a fair share per client,
//     429 + Retry-After beyond it (lib/admission.js)
//   - a bounded queue for picture variants (lib/imgvariant.js)
// The real /api/home with its invalidation matrix is in home-memo.test.js.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { EventEmitter } = require("node:events");

// ------------------------------------------------- the coalesced broadcast

test("library_updated: a burst of changes is ONE message after a quiet moment, and never later than the maximum", () => {
  const realtime = require("../src/realtime");
  const R = realtime._internals;
  const saved = { ...R.clock };
  const sent = [];
  const timers = [];
  let now = 1e12;
  R.clock.now = () => now;
  R.clock.setTimeout = (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; };
  R.clock.clearTimeout = (t) => { if (t) t.live = false; };
  R.clock.send = (data) => sent.push({ at: now, type: data.type });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      now = due.at;
      due.fn();
    }
    now = end;
  };
  try {
    const t0 = now;
    // what one admin rescan used to send: the route, the scan, the probes finishing
    realtime.libraryUpdated();
    realtime.libraryUpdated();
    advance(300);
    realtime.libraryUpdated();
    assert.equal(sent.length, 0, "nothing goes out while changes are still arriving");
    advance(R.QUIET_MS - 1);
    assert.equal(sent.length, 0);
    advance(1);
    assert.deepEqual(sent, [{ at: t0 + 300 + R.QUIET_MS, type: "library_updated" }], "one message, a quiet moment after the last change");
    advance(60000);
    assert.equal(sent.length, 1, "and no echo");

    // changes that never stop for a quiet moment still get through: at the maximum
    sent.length = 0;
    const t1 = now;
    for (let i = 0; i < 40; i++) { realtime.libraryUpdated(); advance(400); }
    assert.ok(sent.length >= 2, "a steady stream is several messages, not none");
    assert.equal(sent[0].at, t1 + R.MAX_MS, "the first no later than the maximum after the first change");
    assert.ok(sent.length <= 5, `sixteen seconds of changes, ${sent.length} messages (it was forty)`);
    advance(60000);

    // another kind of message is collected on its own
    sent.length = 0;
    realtime.broadcastSoon({ type: "library_updated" });
    realtime.broadcastSoon({ type: "something_else", n: 1 });
    realtime.broadcastSoon({ type: "something_else", n: 2 });
    advance(R.QUIET_MS);
    assert.deepEqual(sent.map((m) => m.type).sort(), ["library_updated", "something_else"]);
  } finally {
    Object.assign(R.clock, saved);
    R.soon.clear();
  }
});

test("no code path sends library_updated without the collector", () => {
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.join(__dirname, "..");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const bad = [];
  for (const f of [...walk(path.join(ROOT, "src")), path.join(ROOT, "server.js")]) {
    if (f.endsWith(path.join("src", "realtime.js"))) continue;
    const src = fs.readFileSync(f, "utf8");
    if (/broadcastAll\(\s*\{\s*type:\s*["']library_updated["']/.test(src)) bad.push(path.relative(ROOT, f));
  }
  assert.deepEqual(bad, [], "use realtime.libraryUpdated()");
});

// ------------------------------------------------------- the kept answer

const fakeReq = (headers = {}, method = "GET") => ({ method, headers });
const fakeRes = () => {
  const res = {
    statusCode: 200, headers: {}, body: null, ended: false, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(b) { this.body = b === undefined ? null : b; this.ended = true; this.headersSent = true; },
    send(b) { this.sentThroughExpress = b; this.end(b); },
    status(c) { this.statusCode = c; return this; },
  };
  return res;
};

test("a kept answer: the same key and stamp is served from memory; the bytes are exactly what the route sent", () => {
  const memo = require("../src/lib/answermemo");
  memo.clear();
  const body = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, title: `Row ${i}` })) });
  // first: nothing kept — the route runs and sends
  const r1 = fakeRes();
  assert.equal(memo.begin(fakeReq(), r1, { key: "home|a", stamp: "1" }), false);
  r1.send(body);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.toString("utf8"), body);
  assert.equal(r1.sentThroughExpress, undefined, "delivered by the memo, validator and all");
  // second: from memory, without the route
  const r2 = fakeRes();
  assert.equal(memo.begin(fakeReq(), r2, { key: "home|a", stamp: "1" }), true);
  assert.equal(r2.body.toString("utf8"), body);
  assert.equal(r2.headers.etag, r1.headers.etag);
  assert.match(r1.headers.etag, /^"[A-Za-z0-9_-]{22}"$/, "a strong validator (no W/), a hash of the bytes");
  assert.equal(r1.headers["cache-control"], "private, no-cache");
  assert.equal(r1.headers["content-type"], "application/json; charset=utf-8");
});

test("If-None-Match: the client already has it → 304 and no body; a different answer → 200", () => {
  const memo = require("../src/lib/answermemo");
  memo.clear();
  const r1 = fakeRes();
  memo.begin(fakeReq(), r1, { key: "k", stamp: "s" });
  r1.send(JSON.stringify({ a: "x".repeat(3000) }));
  const etag = r1.headers.etag;
  for (const inm of [etag, `W/${etag}`, `"something-else", ${etag}`, etag.replace(/"$/, '-br"'), "*"]) {
    const r = fakeRes();
    assert.equal(memo.begin(fakeReq({ "if-none-match": inm }), r, { key: "k", stamp: "s" }), true);
    assert.equal(r.statusCode, 304, inm);
    assert.equal(r.body, null, "no body");
    assert.ok(r.headers.etag);
  }
  const other = fakeRes();
  memo.begin(fakeReq({ "if-none-match": '"not-this-one"' }), other, { key: "k", stamp: "s" });
  assert.equal(other.statusCode, 200);
  assert.ok(other.body.length > 3000);
  // a route answering for the first time also honours it (the bytes it composed are the client's)
  memo.clear();
  const again = fakeRes();
  memo.begin(fakeReq({ "if-none-match": etag }), again, { key: "k", stamp: "s2" });
  again.send(JSON.stringify({ a: "x".repeat(3000) }));
  assert.equal(again.statusCode, 304, "same bytes, same validator, even though they were just rebuilt");
});

test("compressed forms: br or gzip as the client accepts, each with its own strong validator, decoding to the same bytes", () => {
  const memo = require("../src/lib/answermemo");
  memo.clear();
  const body = JSON.stringify({ rows: "abcdefgh".repeat(2000) });
  const plain = fakeRes();
  memo.begin(fakeReq(), plain, { key: "k", stamp: "s" });
  plain.send(body);
  assert.equal(plain.headers["content-encoding"], undefined);
  const br = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "gzip, deflate, br" }), br, { key: "k", stamp: "s" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(zlib.brotliDecompressSync(br.body).toString("utf8"), body);
  assert.ok(br.body.length < body.length / 10);
  assert.equal(br.headers["content-length"], br.body.length);
  const gz = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "gzip" }), gz, { key: "k", stamp: "s" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(gz.body).toString("utf8"), body);
  const tags = new Set([plain.headers.etag, br.headers.etag, gz.headers.etag]);
  assert.equal(tags.size, 3, "three representations, three validators");
  assert.equal(br.headers.vary, "Accept-Encoding");
  // "br;q=0" means no
  const no = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br;q=0, gzip;q=0.5" }), no, { key: "k", stamp: "s" });
  assert.equal(no.headers["content-encoding"], "gzip");
  // a tiny answer is not worth compressing
  const tiny = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br" }), tiny, { key: "t", stamp: "s" });
  tiny.send("{}");
  assert.equal(tiny.headers["content-encoding"], undefined);
});

test("what ends a kept answer: a changed stamp, thirty seconds, another key — and only a 200 is ever kept", () => {
  const memo = require("../src/lib/answermemo");
  const M = memo._internals;
  memo.clear();
  const prime = (key, stamp, body = '{"v":1}') => { const r = fakeRes(); memo.begin(fakeReq(), r, { key, stamp }); r.send(body); };
  const kept = (key, stamp) => memo.begin(fakeReq(), fakeRes(), { key, stamp });
  prime("home|ann", "7");
  assert.equal(kept("home|ann", "7"), true);
  assert.equal(kept("home|ann", "8"), false, "anything it was built from changed");
  prime("home|ann", "8");
  assert.equal(kept("home|bob", "8"), false, "another profile's answer is never shared");
  assert.equal(kept("home|ann|kid:7", "8"), false, "a kids limit is its own key");
  // age
  M.entries.get("home|ann").at = Date.now() - memo.MAX_AGE_MS - 1;
  assert.equal(kept("home|ann", "8"), false, "nothing is kept longer than the window");
  // errors are not kept
  const err = fakeRes();
  memo.begin(fakeReq(), err, { key: "home|err", stamp: "1" });
  err.status(500).send('{"error":"x"}');
  assert.equal(err.sentThroughExpress, '{"error":"x"}', "an error goes out the ordinary way");
  assert.equal(kept("home|err", "1"), false);
  // bounded
  memo.clear();
  for (let i = 0; i < memo.MAX_ENTRIES + 20; i++) prime(`k${i}`, "1");
  assert.equal(M.entries.size, memo.MAX_ENTRIES);
  assert.equal(kept("k0", "1"), false, "the oldest were dropped");
  assert.equal(kept(`k${memo.MAX_ENTRIES + 19}`, "1"), true);
  memo.clear();
});

// ----------------------------------------------------------- the lane

const laneRig = (opts = {}) => {
  const { createLane } = require("../src/lib/admission");
  const immediates = [];
  let now = 1e12;
  // (the once-a-second look at the waiting ones is run as a turn too)
  // (the slice clock moves 10 ms every time it is read: every request "costs" more than a quiet turn allows, so it is one per turn)
  let fine = 0;
  const lane = createLane({ ...opts, setImmediate: (fn) => immediates.push(fn), setTimeout: (fn) => immediates.push(fn), now: () => now, clock: () => (fine += 10) });
  const turn = () => { const fn = immediates.shift(); if (fn) fn(); return !!fn; };
  const turns = (n = 100) => { let i = 0; while (i++ < n && turn()); };
  return { lane, turn, turns, tick: (ms) => { now += ms; }, immediates };
};

test("one heavy request per turn of the event loop: the rest wait for the next turn, so small requests get in between", () => {
  const { lane, turn } = laneRig();
  const ran = [];
  const releases = [];
  const ask = (client, name) => lane.enter(client, (release) => { ran.push(name); releases.push(release); }, () => ran.push(`refused:${name}`));
  assert.equal(ask("a", "a1"), "run");
  assert.equal(ask("b", "b1"), "queued", "a second one in the same turn waits, whoever it is from");
  assert.equal(ask("c", "c1"), "queued");
  assert.deepEqual(ran, ["a1"]);
  turn();
  assert.deepEqual(ran, ["a1", "b1"], "one more per turn");
  turn();
  assert.deepEqual(ran, ["a1", "b1", "c1"]);
  for (const r of releases) r();
  assert.equal(lane.status().waiting, 0);
});

test("under a rush the heavy requests get about half the loop, not one place per lap — and never more than a slice at a time", () => {
  const { createLane } = require("../src/lib/admission");
  const immediates = [];
  let t = 0; // ms
  const lane = createLane({ sliceMinMs: 8, sliceMaxMs: 60, setImmediate: (fn) => immediates.push(fn), setTimeout: () => {}, now: () => 1e12 + t, clock: () => t });
  let ran = 0;
  const COST = 20; // each heavy request costs 20 ms of the loop
  for (let i = 0; i < 200; i++) lane.enter(`client${i}`, (release) => { ran++; t += COST; release(); }, () => {});
  const lap = (otherWorkMs) => { const before = ran; t += otherWorkMs; const fn = immediates.shift(); if (fn) fn(); return ran - before; };
  ran = 0;
  assert.equal(lap(0), 1, "a quiet server: one per turn");
  assert.equal(lap(2), 1);
  assert.equal(lap(40), 2, "everything else took 40 ms: two (40 ms) of heavy work");
  assert.equal(lap(100), 3, "never more than the cap (60 ms = three) however busy the rest is");
  assert.equal(lap(500), 3);
});

test("a fair share: one client's sixty-four requests do not go ahead of everyone else's one", () => {
  const { lane, turn, turns } = laneRig({ perClient: 4, perClientQueue: 24 });
  const order = [];
  const held = new Map();
  const ask = (client, name) => lane.enter(client, (release) => { order.push(name); held.set(name, release); }, () => order.push(`429:${name}`));
  // the hammer: 64 at once from one client
  const verdicts = [];
  for (let i = 0; i < 64; i++) verdicts.push(ask("hammer", `h${i}`));
  assert.equal(verdicts.filter((v) => v === "run").length, 1);
  assert.equal(verdicts.filter((v) => v === "queued").length, 24, "its own queue is bounded");
  assert.equal(verdicts.filter((v) => v === "refused").length, 39, "the rest are told at once to come back");
  assert.equal(order.filter((n) => n.startsWith("429:")).length, 39);
  // three other devices ask, once each, after the hammer
  ask("tv", "tv");
  ask("phone", "phone");
  ask("laptop", "laptop");
  turns(10);
  const started = order.filter((n) => !n.startsWith("429:"));
  // the hammer may hold 4 at once; the others each get the very next turns
  assert.deepEqual(started.slice(0, 7).sort(), ["h0", "h1", "h2", "h3", "laptop", "phone", "tv"].sort());
  assert.ok(started.indexOf("tv") <= 5 && started.indexOf("phone") <= 6 && started.indexOf("laptop") <= 7, `the others are not behind the hammer's queue: ${started.slice(0, 8)}`);
  assert.equal(started.filter((n) => /^h/.test(n)).length, 4, "the hammer holds its four and no more");
  // as its answers go out, its queue drains — one per turn
  held.get("h0")();
  turns(5);
  assert.ok(order.includes("h4"));
  assert.ok(!order.includes("h8"), "still four at a time");
  assert.equal(lane.status().refused, 39);
});

test("a request that has waited too long is told so; a finished one frees its client's place", () => {
  const { lane, turn, tick } = laneRig({ perClient: 1, maxWaitMs: 8000 });
  const log = [];
  let releaseFirst;
  lane.enter("a", (release) => { log.push("a1"); releaseFirst = release; }, () => {});
  lane.enter("a", () => log.push("a2"), (why) => log.push(`refused a2: ${why}`));
  turn();
  assert.deepEqual(log, ["a1"], "the client is at its limit: its second request waits");
  tick(8001);
  turn(); // the once-a-second look…
  turn(); // …and the turn it asks for
  assert.deepEqual(log, ["a1", "refused a2: waited too long"]);
  lane.enter("a", () => log.push("a3"), () => {});
  releaseFirst();
  turn();
  turn();
  assert.ok(log.includes("a3"));
  assert.equal(lane.status().timedOut, 1);
});

test("the middleware: 429 with Retry-After when refused; the place is held until the answer has gone out; the key is the session, else the address", () => {
  const { lane, turns } = laneRig({ perClient: 1, perClientQueue: 1 });
  const mw = lane.middleware();
  const mk = (headers = {}, addr = "10.0.0.5") => {
    const res = new EventEmitter();
    Object.assign(res, { headers: {}, statusCode: 200, body: null, headersSent: false, writableEnded: false, destroyed: false,
      setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; } });
    return { req: { headers, socket: { remoteAddress: addr } }, res };
  };
  const one = mk({ cookie: "theme=dark; aurora_session=abcdef0123456789abcdef0123456789" });
  let nexts = 0;
  mw(one.req, one.res, () => nexts++);
  assert.equal(nexts, 1);
  const waits = mk({ cookie: "aurora_session=abcdef0123456789abcdef0123456789" });
  mw(waits.req, waits.res, () => nexts++); // its one waiting place
  const two = mk({ cookie: "aurora_session=abcdef0123456789abcdef0123456789" });
  mw(two.req, two.res, () => nexts++);
  assert.equal(two.res.statusCode, 429);
  assert.equal(two.res.headers["Retry-After"], "2");
  assert.match(two.res.body.error, /Too many requests at once/);
  // another session from the same address is another client
  const other = mk({ "x-session": "ffffffffffffffffffffffffffffffff" });
  mw(other.req, other.res, () => nexts++);
  turns();
  assert.equal(nexts, 2, "the other session ran; the first client's second request still waits for the first to finish");
  // the first answer goes out: the one that waited runs
  one.res.emit("finish");
  turns();
  assert.equal(nexts, 3);
  // a client that went away while waiting gives its turn up without running
  waits.res.emit("close");
  const gone = mk({ cookie: "aurora_session=abcdef0123456789abcdef0123456789" });
  gone.res.destroyed = true;
  mw(gone.req, gone.res, () => nexts++);
  turns();
  assert.equal(nexts, 3);
  // no session: the address (the proxy's X-Forwarded-For first)
  assert.equal(lane.clientKey({ headers: {}, socket: { remoteAddress: "::ffff:192.168.1.20" } }), "a:192.168.1.20");
  assert.equal(lane.clientKey({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } }), "a:203.0.113.7");
});

test("normal clients never notice: a page load's two heavy requests, and a household of twenty arriving together", () => {
  const { lane, turns } = laneRig();
  let refused = 0;
  let ran = 0;
  for (let device = 0; device < 20; device++) {
    for (const what of ["home", "library"]) lane.enter(`s:device${device}`, (release) => { ran++; release(); void what; }, () => refused++);
  }
  turns(200);
  assert.equal(refused, 0);
  assert.equal(ran, 40);
  assert.equal(lane.status().waiting, 0);
});

// ------------------------------------------------- the picture-variant queue

test("picture variants: the wait is bounded for everyone together and for one client", () => {
  const img = require("../src/lib/imgvariant");
  const I = img._internals;
  const savedQueue = I.queue.splice(0);
  try {
    assert.equal(I.roomFor("tv-1"), true);
    I.waitingOf.set("tv-1", img.MAX_QUEUE_CLIENT);
    assert.equal(I.roomFor("tv-1"), false, "one client has filled its share");
    assert.equal(I.roomFor("phone-2"), true, "and nobody else is affected");
    I.waitingOf.clear();
    for (let i = 0; i < img.MAX_QUEUE; i++) I.queue.push({ client: null, run: async () => {} });
    assert.equal(I.roomFor("phone-2"), false, "the whole queue is full: the original is sent instead");
    assert.equal(I.roomFor(null), false);
    assert.ok(img.MAX_QUEUE_CLIENT >= 40, "a page of forty posters fits");
  } finally {
    I.queue.length = 0;
    I.queue.push(...savedQueue);
    I.waitingOf.clear();
  }
});
