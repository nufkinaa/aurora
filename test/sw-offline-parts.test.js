// The service worker serving a saved copy (public/sw.js): a copy saved in
// PARTS (js/offline.js, 2026-11-10) is streamed from them for any Range a
// player asks — across part boundaries, open-ended, the last bytes, Safari's
// bytes=0-1 — and a copy saved the old way (one entry) still plays. A site
// update never drops the media cache. Run in a sandbox with the worker's own
// handlers and a stub Cache Storage.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://aurora.test";

const worker = () => {
  const handlers = {};
  const caches = new Map(); // name -> Map(path -> Response)
  const cacheOf = (name) => { if (!caches.has(name)) caches.set(name, new Map()); return caches.get(name); };
  const keyOf = (req) => { const u = typeof req === "string" ? req : req.url; return new URL(u, ORIGIN).pathname; };
  const api = (name) => ({
    match: async (req) => { const r = cacheOf(name).get(keyOf(req)); return r ? r.clone() : undefined; },
    put: async (req, res) => { cacheOf(name).set(keyOf(req), res); },
    keys: async () => [...cacheOf(name).keys()].map((p) => new Request(ORIGIN + p)),
    delete: async (k) => cacheOf(name).delete(keyOf(k)),
  });
  const sandbox = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, location: { origin: ORIGIN }, registration: {}, clients: { claim: async () => {} }, skipWaiting: async () => {} },
    caches: {
      open: async (name) => api(name),
      match: async (req) => { for (const n of caches.keys()) { const r = cacheOf(n).get(keyOf(req)); if (r) return r.clone(); } return undefined; },
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
    },
    fetch: async () => { throw new Error("no network in this test"); },
    location: { origin: ORIGIN },
    URL, Request, Response, Headers, Blob, ReadableStream, Date, Promise, JSON, Math, console, setTimeout, clearTimeout, TextEncoder, crypto: globalThis.crypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "sw.js" });
  const ask = async (p, range = null) => {
    let answer = null;
    const req = new Request(ORIGIN + p, range ? { headers: { range } } : {});
    handlers.fetch({ request: req, respondWith: (x) => { answer = x; }, waitUntil: () => {} });
    assert.ok(answer, `the worker answers ${p}`);
    return answer;
  };
  return { handlers, caches, cacheOf, ask };
};

// a "film" of 1000 bytes, byte i = i % 251, in parts of 64
const FILM = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const PART = 64;
const saveParts = (w, id, { skip = -1 } = {}) => {
  const media = w.cacheOf("aurora-media");
  const count = Math.ceil(FILM.length / PART);
  for (let n = 0; n < count; n++) if (n !== skip) media.set(`/offline/part/${id}/${n}`, new Response(FILM.subarray(n * PART, Math.min(FILM.length, (n + 1) * PART))));
  media.set(`/offline/manifest/${id}`, new Response(JSON.stringify({ v: 2, size: FILM.length, part: PART, count, type: "video/mp4" })));
};
const bytes = async (res) => Buffer.from(await res.arrayBuffer());

test("a copy in parts: any range, across the parts, exact headers", async () => {
  const w = worker();
  saveParts(w, "abc123");
  for (const [range, a, b] of [["bytes=0-1", 0, 1], ["bytes=60-200", 60, 200], ["bytes=64-127", 64, 127], ["bytes=900-", 900, 999], ["bytes=-10", 990, 999], ["bytes=0-5000", 0, 999], ["bytes=0-", 0, 999]]) {
    const res = await w.ask("/offline/media/abc123", range);
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get("content-range"), `bytes ${a}-${b}/1000`, range);
    assert.equal(res.headers.get("content-length"), String(b - a + 1), range);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.ok((await bytes(res)).equals(FILM.subarray(a, b + 1)), `the right bytes for ${range}`);
  }
  const whole = await w.ask("/offline/media/abc123");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), "1000");
  assert.ok((await bytes(whole)).equals(FILM));
  const past = await w.ask("/offline/media/abc123", "bytes=1000-");
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */1000");
});

test("a part missing ends the answer with an error — never wrong bytes; the pieces are never served as they are", async () => {
  const w = worker();
  saveParts(w, "gap1", { skip: 3 });
  const res = await w.ask("/offline/media/gap1", "bytes=0-999");
  await assert.rejects(bytes(res));
  assert.equal((await w.ask("/offline/part/gap1/0")).status, 404);
  assert.equal((await w.ask("/offline/manifest/gap1")).status, 404);
});

test("a copy saved the old way (one entry) still plays, with Range; nothing saved is a 404", async () => {
  const w = worker();
  w.cacheOf("aurora-media").set("/offline/media/old1", new Response(new Blob([FILM], { type: "video/mp4" })));
  const res = await w.ask("/offline/media/old1", "bytes=100-199");
  assert.equal(res.status, 206);
  assert.ok((await bytes(res)).equals(FILM.subarray(100, 200)));
  assert.equal((await w.ask("/offline/media/nothing")).status, 404);
});

test("a removed copy: the worker forgets its manifest when told", async () => {
  const w = worker();
  saveParts(w, "gone1");
  assert.equal((await w.ask("/offline/media/gone1", "bytes=0-9")).status, 206);
  w.caches.get("aurora-media").clear();
  w.handlers.message({ data: { type: "offline-removed", id: "gone1" }, waitUntil: () => {} });
  assert.equal((await w.ask("/offline/media/gone1", "bytes=0-9")).status, 404);
});

test("a site update (the worker activating) never drops the saved films — only the old versions of its own caches", async () => {
  const w = worker();
  saveParts(w, "keep1");
  w.cacheOf("aurora-shell-v0").set("/", new Response("old shell"));
  w.cacheOf("aurora-api-v1").set("/api/profiles", new Response("[]"));
  let done = null;
  w.handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(w.caches.has("aurora-media"), "the media cache stays");
  assert.equal(w.caches.get("aurora-media").size, Math.ceil(1000 / PART) + 1);
  assert.ok(!w.caches.has("aurora-shell-v0"), "an old shell goes");
  assert.ok(w.caches.has("aurora-api-v1"));
});
