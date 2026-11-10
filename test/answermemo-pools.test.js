// lib/answermemo.js (perf-server 2026-11-10): a large kept answer is
// compressed on the thread pool, not on the event loop — the SAME bytes as
// the synchronous compression it replaces, made once however many requests
// wait for it — and pools are separate sets with their own bounds.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const memo = require("../src/lib/answermemo");

const fakeReq = (headers = {}, method = "GET") => ({ method, headers });
const fakeRes = () => {
  let done;
  const finished = new Promise((r) => { done = r; });
  const res = {
    statusCode: 200, headers: {}, body: undefined, headersSent: false, writableEnded: false, destroyed: false, finished,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    removeHeader(k) { delete this.headers[k.toLowerCase()]; },
    end(b) { this.body = b === undefined ? null : b; this.writableEnded = true; this.headersSent = true; done(); },
    send(b) { this.sentThroughExpress = b; this.end(b); },
  };
  return res;
};
// ~600 KB of JSON shaped like a Home answer
const bigBody = () => JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ id: `id${i}`, title: `Title number ${i}`, cover: `/img/${(i * 7919).toString(16)}`, genres: ["Drama", "Comedy"], year: 1990 + (i % 30), synopsis: `A story about ${i} things and the people around them.` })) });
const BR = (raw) => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });

test("a large answer: compressed off the event loop, to exactly the bytes the synchronous compression made", async () => {
  memo.clear();
  const body = bigBody();
  assert.ok(Buffer.byteLength(body) > memo._internals.SYNC_MAX);
  const first = fakeRes();
  assert.equal(memo.begin(fakeReq({ "accept-encoding": "gzip, deflate, br" }), first, { key: "big", stamp: "1" }), false);
  first.send(body);
  assert.equal(first.writableEnded, false, "send() returned before the compression: the loop was not held for it");
  // two more ask meanwhile: they wait for the same compression
  const second = fakeRes();
  const third = fakeRes();
  assert.equal(memo.begin(fakeReq({ "accept-encoding": "br" }), second, { key: "big", stamp: "1" }), true);
  assert.equal(memo.begin(fakeReq({ "accept-encoding": "br" }), third, { key: "big", stamp: "1" }), true);
  const entry = memo._internals.entries.get("big");
  assert.ok(entry.brWait, "one compression in flight, shared");
  await Promise.all([first.finished, second.finished, third.finished]);
  const raw = Buffer.from(body, "utf8");
  for (const r of [first, second, third]) {
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["content-encoding"], "br");
    assert.ok(Buffer.compare(r.body, BR(raw)) === 0, "the same bytes as brotliCompressSync with the same parameters");
    assert.equal(r.headers["content-length"], r.body.length);
    assert.match(r.headers.etag, /^"[A-Za-z0-9_-]{22}-br"$/);
  }
  // later requests take the made form at once
  const later = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br" }), later, { key: "big", stamp: "1" });
  assert.equal(later.writableEnded, true, "ready: sent in place");
  // gzip: the same as gzipSync
  const gz = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "gzip" }), gz, { key: "big", stamp: "1" });
  await gz.finished;
  assert.ok(Buffer.compare(gz.body, zlib.gzipSync(raw)) === 0);
  assert.equal(gz.headers["content-encoding"], "gzip");
  // a client that has it: 304 at once, nothing compressed
  const inm = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br", "if-none-match": later.headers.etag }), inm, { key: "big", stamp: "1" });
  assert.equal(inm.statusCode, 304);
  // uncompressed: the raw bytes, its own validator
  const plain = fakeRes();
  memo.begin(fakeReq({}), plain, { key: "big", stamp: "1" });
  assert.equal(plain.body.toString("utf8"), body);
  assert.equal(plain.headers["content-encoding"], undefined);
});

test("a small answer is still compressed in place", () => {
  memo.clear();
  const body = JSON.stringify({ rows: "abcdefgh".repeat(2000) });
  const r = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br" }), r, { key: "small", stamp: "1" });
  r.send(body);
  assert.equal(r.writableEnded, true);
  assert.equal(zlib.brotliDecompressSync(r.body).toString("utf8"), body);
});

test("a client gone while its answer was being compressed is simply not written to", async () => {
  memo.clear();
  const body = bigBody();
  const a = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br" }), a, { key: "gone", stamp: "1" });
  a.destroyed = true;
  a.send(body);
  const b = fakeRes();
  memo.begin(fakeReq({ "accept-encoding": "br" }), b, { key: "gone", stamp: "1" });
  await b.finished;
  assert.equal(a.body, undefined, "nothing written to the closed response");
  assert.equal(zlib.brotliDecompressSync(b.body).toString("utf8"), body);
});

test("pools: separate entries, their own bound and age; recheck only answers from its own pool", () => {
  memo.clear();
  const p = memo.pool({ name: "test pool", maxEntries: 3, maxAgeMs: 1000 });
  assert.ok(memo.pools.has(p));
  const prime = (pl, key) => { const r = fakeRes(); pl.begin(fakeReq(), r, { key, stamp: "s" }); r.send('{"k":"' + key + '"}'); };
  for (const k of ["a", "b", "c", "d"]) prime(p, k);
  assert.equal(p._internals.entries.size, 3, "bounded");
  assert.equal(p._internals.entries.has("a"), false, "the oldest went first");
  assert.equal(memo._internals.entries.size, 0, "the main pool is untouched");
  assert.equal(p.begin(fakeReq(), fakeRes(), { key: "d", stamp: "s" }), true);
  assert.equal(memo.begin(fakeReq(), fakeRes(), { key: "d", stamp: "s" }), false, "not shared across pools");
  p._internals.entries.get("d").at = Date.now() - 1001;
  assert.equal(p.begin(fakeReq(), fakeRes(), { key: "d", stamp: "s" }), false, "its own age");
  // a request that began in the main pool is not answered by another pool's recheck
  prime(p, "x");
  const r = fakeRes();
  memo.begin(fakeReq(), r, { key: "x", stamp: "s" });
  assert.equal(p.recheck(fakeReq(), r), false);
  p.clear();
  memo.pools.delete(p);
});
