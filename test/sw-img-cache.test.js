// The service worker's poster cache (public/sw.js) keeps a picture for a
// week — except an answer the server marked short-lived: the WebP sent while
// the AVIF is still being made (max-age=300) and the original sent while the
// variant queue was full (max-age=60). Kept for the week, the better picture
// would not have been asked for again for a week. Run here in a sandbox with
// the worker's own fetch handler, a stub cache and a stub network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

const worker = () => {
  const handlers = {};
  const store = new Map(); // url -> Response
  const net = [];
  const sandbox = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, location: { origin: "https://aurora.test" }, registration: {}, clients: {} },
    caches: {
      match: async (req) => store.get(typeof req === "string" ? req : req.url),
      open: async () => ({ put: async (req, res) => { store.set(typeof req === "string" ? req : req.url, res); }, keys: async () => [...store.keys()], delete: async (k) => store.delete(k) }),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (req) => { net.push(req.url); return new Response("fresh", { status: 200, headers: { "content-type": "image/avif", date: new Date().toUTCString(), "cache-control": "public, max-age=604800" } }); },
    location: { origin: "https://aurora.test" },
    URL, Request, Response, Headers, Date, Promise, JSON, console, setTimeout, clearTimeout, TextEncoder, crypto: globalThis.crypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "sw.js" });
  const ask = async (url) => {
    let answer = null;
    const req = new Request(url);
    handlers.fetch({ request: req, respondWith: (p) => { answer = p; }, waitUntil: () => {} });
    assert.ok(answer, `the worker answers ${url}`);
    const res = await answer;
    return { res, text: await res.clone().text() };
  };
  return { store, net, ask };
};
const cached = (ageS, cacheControl) =>
  new Response("cached", { status: 200, headers: { "content-type": "image/webp", date: new Date(Date.now() - ageS * 1000).toUTCString(), ...(cacheControl ? { "cache-control": cacheControl } : {}) } });

test("a week-long poster is served from the cache for the week", async () => {
  const w = worker();
  const url = "https://aurora.test/img/ext?u=x&w=480";
  w.store.set(url, cached(3 * 24 * 3600, "public, max-age=604800"));
  const { text } = await w.ask(url);
  assert.equal(text, "cached");
  assert.deepEqual(w.net, []);
  // (and one with no Cache-Control at all: the week, as before)
  w.store.set(url, cached(3 * 24 * 3600, null));
  assert.equal((await w.ask(url)).text, "cached");
  // older than the week: asked again
  w.store.set(url, cached(8 * 24 * 3600, "public, max-age=604800"));
  assert.equal((await w.ask(url)).text, "fresh");
  assert.equal(w.net.length, 1);
});

test("the WebP kept while the AVIF was made is asked again after its five minutes", async () => {
  const w = worker();
  const url = "https://aurora.test/img/12ab?w=360";
  w.store.set(url, cached(120, "public, max-age=300"));
  assert.equal((await w.ask(url)).text, "cached", "within the five minutes: the cached WebP");
  assert.deepEqual(w.net, []);
  w.store.set(url, cached(301, "public, max-age=300"));
  assert.equal((await w.ask(url)).text, "fresh", "past them: the server is asked (and has the AVIF)");
  assert.equal(w.net.length, 1);
  // the stand-in sent while the variant queue was full: a minute
  w.store.set(url, cached(61, "public, max-age=60"));
  assert.equal((await w.ask(url)).text, "fresh");
  // a day-long library cover keeps the week it always had here
  w.store.set(url, cached(2 * 24 * 3600, "public, max-age=86400"));
  assert.equal((await w.ask(url)).text, "cached");
});
