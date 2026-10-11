// lib/keptjson.js and the kept /api/library: an answer made once and sent
// many times must be, for every kind of client, what res.json sent before —
// the same bytes once decoded, the same headers, the same 304s.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const zlib = require("zlib");
const express = require("express");
const compression = require("compression");

const keptjson = require("../src/lib/keptjson");
const blurup = require("../src/lib/blurup");
const scanner = require("../src/media/scanner");

// the compression middleware exactly as server.js sets it up
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|xml|manifest)|text\/|image\/svg)/i;
const compress = () => compression({
  threshold: 1024,
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } },
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) return false;
    if (res.statusCode === 206) return false;
    return COMPRESSIBLE.test(String(res.getHeader("Content-Type") || ""));
  },
});

const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => resolve(s)); });
const ask = (server, path, headers = {}, method = "GET") => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method, headers }, (res) => {
    const chunks = [];
    res.on("data", (d) => chunks.push(d));
    res.on("end", () => {
      const raw = Buffer.concat(chunks);
      const enc = res.headers["content-encoding"];
      let text = "";
      try { text = (enc === "br" ? zlib.brotliDecompressSync(raw) : enc === "gzip" ? zlib.gunzipSync(raw) : enc === "deflate" ? zlib.inflateSync(raw) : raw).toString("utf8"); } catch (e) { return reject(e); }
      resolve({ status: res.statusCode, headers: res.headers, text, rawBytes: raw.length });
    });
  });
  req.on("error", reject);
  req.end();
});
// what must match between the old way and the kept way
const essence = (r) => ({ status: r.status, type: r.headers["content-type"], etag: r.headers.etag, encoding: r.headers["content-encoding"] || "identity", vary: r.headers.vary, text: r.text });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the helper, beside res.json ----------
const BIG = { rows: Array.from({ length: 400 }, (_, i) => ({ id: `id${i}`, title: `Title ${i} — é ü 日本`, synopsis: "words ".repeat(20) + i, n: i, ok: i % 2 === 0, none: null })) };
const SMALL = { ok: true, n: 1 };
let server;
before(async () => {
  const app = express();
  app.use(compress());
  let keptBig = null, keptSmall = null;
  app.get("/old/big", (req, res) => res.json(BIG));
  app.get("/old/small", (req, res) => res.json(SMALL));
  app.get("/kept/big", (req, res) => { if (!keptBig) keptBig = keptjson.make(req.app, BIG); keptjson.send(req, res, keptBig); });
  app.get("/kept/small", (req, res) => { if (!keptSmall) keptSmall = keptjson.make(req.app, SMALL); keptjson.send(req, res, keptSmall); });
  server = await listen(app);
});
after(() => { if (server) server.close(); });

const ENCODINGS = [
  undefined, "", "gzip, deflate, br", "gzip, deflate, br, zstd", "br", "gzip", "gzip, deflate", "deflate", "identity",
  "br;q=1.0, gzip;q=0.8, *;q=0.1", "gzip;q=1.0, br;q=0.5", "*", "BR, GZIP", "zstd",
];

test("first use and every use after: the same as res.json, for every Accept-Encoding", async () => {
  for (let pass = 0; pass < 3; pass++) {
    for (const ae of ENCODINGS) {
      const h = ae === undefined ? {} : { "Accept-Encoding": ae };
      for (const size of ["big", "small"]) {
        const old = essence(await ask(server, `/old/${size}`, h));
        const kept = essence(await ask(server, `/kept/${size}`, h));
        assert.deepEqual(kept, old, `pass ${pass}, ${size}, Accept-Encoding: ${ae}`);
      }
    }
    await sleep(150); // (by the second pass the compressed copies exist)
  }
  assert.equal(JSON.stringify(JSON.parse((await ask(server, "/kept/big")).text)), JSON.stringify(BIG));
});

test("once the compressed copies are ready they are what goes out — with a length, not chunked", async () => {
  await ask(server, "/kept/big"); await ask(server, "/kept/big"); await sleep(200);
  const br = await ask(server, "/kept/big", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(Number(br.headers["content-length"]), br.rawBytes);
  assert.equal(br.headers["transfer-encoding"], undefined);
  const gz = await ask(server, "/kept/big", { "Accept-Encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(Number(gz.headers["content-length"]), gz.rawBytes);
  // an answer under the middleware's 1 KB threshold is never compressed, as before
  const small = await ask(server, "/kept/small", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(small.headers["content-encoding"], undefined);
});

test("a client whose copy is current gets the same 304, and a HEAD the same headers", async () => {
  for (const size of ["big", "small"]) {
    const etag = (await ask(server, `/old/${size}`)).headers.etag;
    assert.ok(/^W\/"/.test(etag));
    for (const ae of ["gzip, deflate, br", undefined]) {
      const h = { "If-None-Match": etag, ...(ae ? { "Accept-Encoding": ae } : {}) };
      const old = await ask(server, `/old/${size}`, h);
      const kept = await ask(server, `/kept/${size}`, h);
      assert.equal(kept.status, 304);
      assert.deepEqual([kept.status, kept.headers.etag, kept.text, kept.headers["content-encoding"], kept.headers["content-type"]], [old.status, old.headers.etag, old.text, old.headers["content-encoding"], old.headers["content-type"]]);
      // a stale validator is a full answer
      assert.equal((await ask(server, `/kept/${size}`, { ...h, "If-None-Match": 'W/"nope"' })).status, 200);
    }
    const oldHead = await ask(server, `/old/${size}`, { "Accept-Encoding": "identity" }, "HEAD");
    const keptHead = await ask(server, `/kept/${size}`, { "Accept-Encoding": "identity" }, "HEAD");
    assert.deepEqual([keptHead.status, keptHead.headers.etag, keptHead.headers["content-type"], keptHead.headers["content-length"], keptHead.text], [oldHead.status, oldHead.headers.etag, oldHead.headers["content-type"], oldHead.headers["content-length"], ""]);
  }
});

test("X-No-Compression is honoured, as the middleware honours it", async () => {
  const h = { "Accept-Encoding": "gzip, deflate, br", "X-No-Compression": "1" };
  const old = essence(await ask(server, "/old/big", h));
  const kept = essence(await ask(server, "/kept/big", h));
  assert.equal(kept.encoding, "identity");
  assert.deepEqual(kept, old);
});

test("only the plain Accept-Encoding lists are decided here", () => {
  assert.equal(keptjson.choose("gzip, deflate, br"), "br");
  assert.equal(keptjson.choose("gzip, deflate"), "gzip");
  assert.equal(keptjson.choose("GZIP"), "gzip");
  for (const h of [undefined, "", "deflate", "identity", "gzip, identity", "br;q=0.5, gzip", "*", "gzip, *"]) assert.equal(keptjson.choose(h), null, String(h));
});

test("an app with its own JSON settings is left to res.json", () => {
  const app = express();
  app.set("json spaces", 2);
  assert.equal(keptjson.make(app, { a: 1 }), null);
});

// ---------- /api/library: kept, and still what it was ----------
test("/api/library: the kept answer is the old answer — plain, with blur-up placeholders, after every kind of change", async () => {
  const saved = { movies: scanner.index.movies, shows: scanner.index.shows, scannedAt: scanner.index.scannedAt, enriched: scanner.index.enriched };
  const film = (i) => ({ id: `film${i}`, type: "movie", title: `Film ${i}`, year: 2000 + i, cover: `/img/cover${i}`, backdrop: `/img/still/film${i}`, genres: ["Drama"], synopsis: "A synopsis long enough to matter. ".repeat(4), subtitles: [{ label: "English", url: `/stream/subtitle/s${i}` }] });
  const show = (i) => ({ id: `show${i}`, type: "show", title: `Show ${i}`, cover: `/img/scover${i}`, episodeCount: 2, seasons: [{ number: 1, episodes: [{ id: `ep${i}a`, season: 1, episode: 1 }, { id: `ep${i}b`, season: 1, episode: 2 }] }] });
  scanner.index.movies = Array.from({ length: 30 }, (_, i) => film(i));
  scanner.index.shows = Array.from({ length: 4 }, (_, i) => show(i));
  scanner.index.scannedAt = 1700000000000;
  scanner.index.enriched = false;

  // the route as it was in 1.6.92, behind the same middlewares
  const identity = require("../src/media/identity");
  const listEntry = (i) => { if (!i || !i.seasons) return i; const { seasons, ...rest } = i; return rest; };
  const oldApp = express();
  oldApp.use(compress());
  oldApp.use(blurup.middleware);
  oldApp.get("/api/library", (req, res) => {
    identity.ensureStamped();
    res.json({ movies: scanner.index.movies, shows: scanner.index.shows.map(listEntry), scannedAt: scanner.index.scannedAt, enriched: scanner.index.enriched });
  });
  const newApp = express();
  newApp.use(compress());
  newApp.use(blurup.middleware);
  newApp.use(require("../src/routes/api"));
  const oldS = await listen(oldApp);
  const newS = await listen(newApp);
  const mem = blurup._internals.mem;
  const added = [];
  const BLUR = { "X-Blur": "1", "Accept-Encoding": "gzip, deflate, br" };
  const same = async (why) => {
    for (const h of [BLUR, { "Accept-Encoding": "gzip, deflate, br" }, {}]) {
      for (let i = 0; i < 3; i++) {
        const o = essence(await ask(oldS, "/api/library", h));
        const n = essence(await ask(newS, "/api/library", h));
        assert.deepEqual(n, o, `${why} (${JSON.stringify(h)}, request ${i + 1})`);
      }
      await sleep(120);
    }
    return JSON.parse((await ask(newS, "/api/library", BLUR)).text);
  };
  try {
    let body = await same("a library with no placeholders yet");
    assert.equal(body.movies.length, 30);
    assert.equal(body.shows[0].seasons, undefined, "shows go out without their episode trees");
    assert.equal(body._blur, undefined);

    // placeholders arrive (as lib/blurup.js files them)
    for (const u of ["/img/cover0", "/img/cover1", "/img/scover0"]) { blurup._internals.learn(u, `data:image/webp;base64,AAAA${u.length}`); added.push(u); }
    body = await same("placeholders made since");
    assert.deepEqual(Object.keys(body._blur).sort(), ["/img/cover0", "/img/cover1", "/img/scover0"]);
    blurup._internals.learn("/img/cover2", "data:image/webp;base64,BBBB"); added.push("/img/cover2");
    body = await same("one more placeholder");
    assert.equal(Object.keys(body._blur).length, 4);

    // the library changes: a rescan (new index), the probes finishing, a title added in place
    scanner.index.movies = [...scanner.index.movies, film(99)];
    scanner.index.scannedAt = 1700000600000;
    body = await same("a rescan found a new film");
    assert.equal(body.movies.length, 31);
    scanner.index.enriched = true;
    body = await same("the probes finished");
    assert.equal(body.enriched, true);
    scanner.index.scannedAt = 1700001200000;
    body = await same("a rescan that found nothing new still moves scannedAt");
    assert.equal(body.scannedAt, 1700001200000);
    scanner.index.shows = scanner.index.shows.slice(1);
    body = await same("a show left");
    assert.equal(body.shows.length, 3);

    // …and a 304 for the client that has it
    const etag = (await ask(newS, "/api/library", BLUR)).headers.etag;
    const fresh = await ask(newS, "/api/library", { ...BLUR, "If-None-Match": etag });
    assert.equal(fresh.status, 304);
    assert.equal((await ask(oldS, "/api/library", { ...BLUR, "If-None-Match": etag })).status, 304, "the old route agrees it is the same answer");
  } finally {
    oldS.close(); newS.close();
    for (const u of added) mem.delete(u);
    Object.assign(scanner.index, saved);
  }
});
