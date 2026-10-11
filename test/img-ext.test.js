// /img/ext — the picture proxy-cache (src/routes/stream.js). It fetches an
// address a CLIENT names, so it is one mistake away from an open proxy: what
// is checked here is that it is not one. Exact hosts on a short list, https
// only, every redirect hop checked against the same list, a size cap, bytes
// that are a picture. (That it sits behind the sign-in wall and the kids gate
// is checked where those live: test/ui/boot.test.js, test/must-reset.test.js,
// test/kids.test.js.)
// The outside world is a stub: nothing here leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const config = require("../src/config");
const streamRouter = require("../src/routes/stream");

const CACHE = path.join(config.CACHE_DIR, "posters-web");
const cacheFile = (url) => path.join(CACHE, crypto.createHash("md5").update(url).digest("hex") + ".img");
// a JPEG as far as anyone sniffing it can tell, 4 KB
const picture = (bytes = 4096) => { const b = Buffer.alloc(bytes, 0x20); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b; };

const withProxy = async (upstream, fn) => {
  const app = express();
  app.use(streamRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const real = global.fetch;
  const asked = [];
  // the server's own outgoing fetch: every host but this test's server is the stub
  global.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return real(url, init);
    asked.push(String(url));
    assert.equal(init && init.redirect, "manual", "the proxy must not let fetch follow redirects by itself");
    return upstream(String(url));
  };
  const made = [];
  const get = async (u, extra = "") => {
    made.push(cacheFile(u));
    const res = await real(`${base}/img/ext?u=${encodeURIComponent(u)}${extra}`);
    return { status: res.status, type: res.headers.get("content-type"), bytes: (await res.arrayBuffer()).byteLength };
  };
  const warn = console.warn;
  console.warn = () => {}; // (each refusal upstream is said out loud; not here)
  try {
    await fn({ get, asked });
  } finally {
    console.warn = warn;
    global.fetch = real;
    for (const f of made) { try { fs.unlinkSync(f); } catch {} }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
};
const ok = (body, headers = {}) => new Response(body, { status: 200, headers: { "content-type": "image/jpeg", ...headers } });
const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });
const run = crypto.randomBytes(4).toString("hex"); // (a fresh address every run: nothing is answered from an old cache file)

test("only the listed hosts, exactly, over https — nothing else is ever fetched", async () => {
  await withProxy(async () => ok(picture()), async ({ get, asked }) => {
    for (const u of [
      "http://episodes.metahub.space/tt1/1/1/w780.jpg",            // not https
      "https://episodes.metahub.space.evil.example/tt1/1/1.jpg",   // a look-alike that only starts with the name
      "https://evil.example/episodes.metahub.space/x.jpg",         // the name in the path
      "https://episodes.metahub.space@evil.example/x.jpg",         // the name as a user name
      "https://evil.example#@episodes.metahub.space/x.jpg",
      "https://episodes.metahub.space:8443/x.jpg",                 // another port is another host
      "https://sub.episodes.metahub.space/x.jpg",
      "https://metahub.space/x.jpg",
      "https://127.0.0.1/x.jpg", "https://localhost/x.jpg", "https://[::1]/x.jpg", "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/x.jpg", "file:///etc/passwd", "ftp://episodes.metahub.space/x.jpg", "//episodes.metahub.space/x.jpg",
      "", "not a url",
    ]) {
      const r = await get(u);
      assert.equal(r.status, 403, `${u || "(empty)"} was not refused`);
    }
    assert.deepEqual(asked, [], "a refused address was fetched all the same");
  });
});

test("an episode still comes through, is kept, and is asked of the catalogue's host once", async () => {
  const u = `https://episodes.metahub.space/tt0000004/1/2/w780-${run}.jpg`;
  await withProxy(async () => ok(picture()), async ({ get, asked }) => {
    const first = await get(u);
    assert.equal(first.status, 200);
    assert.equal(first.type, "image/jpeg");
    assert.equal(first.bytes, 4096);
    assert.equal((await get(u)).status, 200);
    assert.deepEqual(asked, [u], "the second answer came from the server's own copy");
    assert.ok(fs.existsSync(cacheFile(u)));
  });
});

test("a redirect is followed only to a host on the list — one that points anywhere else ends there, with nothing kept", async () => {
  const inside = `https://commons.wikimedia.org/wiki/Special:FilePath/x-${run}.jpg`;
  const landed = `https://upload.wikimedia.org/wikipedia/commons/x-${run}.jpg`;
  const outside = `https://episodes.metahub.space/tt0000004/9/9/redirect-${run}.jpg`;
  const loop = `https://episodes.metahub.space/tt0000004/9/9/loop-${run}.jpg`;
  await withProxy(async (url) => {
    if (url === inside) return redirect(landed);
    if (url === landed) return ok(picture());
    if (url === outside) return redirect("http://169.254.169.254/latest/meta-data/");
    if (url === loop) return redirect(loop);
    throw new Error(`the proxy fetched ${url}`);
  }, async ({ get, asked }) => {
    assert.equal((await get(inside)).status, 200, "list → list is allowed (Wikimedia's own file redirect)");
    assert.deepEqual(asked, [inside, landed]);
    asked.length = 0;
    assert.equal((await get(outside)).status, 502);
    assert.deepEqual(asked, [outside], "the address it pointed to was never fetched");
    assert.equal(fs.existsSync(cacheFile(outside)), false);
    asked.length = 0;
    assert.equal((await get(loop)).status, 502);
    assert.ok(asked.length <= 3, "a redirect loop ends after three hops");
  });
});

test("too big, or not a picture: refused, and nothing is kept", async () => {
  const big = `https://episodes.metahub.space/tt0000004/9/9/big-${run}.jpg`;
  const bigNoLength = `https://episodes.metahub.space/tt0000004/9/9/big2-${run}.jpg`;
  const html = `https://episodes.metahub.space/tt0000004/9/9/page-${run}.jpg`;
  const tiny = `https://episodes.metahub.space/tt0000004/9/9/tiny-${run}.jpg`;
  await withProxy(async (url) => {
    if (url === big) return ok(picture(), { "content-length": String(7 * 1024 * 1024) });
    if (url === bigNoLength) return ok(picture(6 * 1024 * 1024 + 1));
    if (url === html) return ok(Buffer.from("<!doctype html>" + "x".repeat(4000)), { "content-type": "image/jpeg" });
    if (url === tiny) return ok(picture(200));
    throw new Error(`the proxy fetched ${url}`);
  }, async ({ get }) => {
    for (const u of [big, bigNoLength, html, tiny]) {
      assert.equal((await get(u)).status, 502, u);
      assert.equal(fs.existsSync(cacheFile(u)), false, `${u} was kept`);
    }
  });
});

test("the website and the server agree on the hosts — and the TV app's list is a subset (it was not touched)", () => {
  const listIn = (file, name) => {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const at = src.indexOf(`const ${name} = new Set([`);
    assert.ok(at >= 0, `${name} in ${file}`);
    const body = src.slice(at, src.indexOf("]);", at)).replace(/\/\/.*$/gm, "");
    return [...body.matchAll(/["']([a-z0-9.-]+\.[a-z]{2,})["']/g)].map((m) => m[1]).sort();
  };
  // (the server's list lives in a module of its own on the TV bundle's branch —
  // src/lib/imghosts.js, which /api/ping also reads to say what was added)
  const server = [...require("../src/lib/imghosts").EXT_IMG_HOSTS].sort();
  const web = listIn("public/js/ui.js", "PROXY_ART_HOSTS");
  assert.ok(server.includes("episodes.metahub.space"));
  for (const h of web) assert.ok(server.includes(h), `the website would send ${h} through a proxy that refuses it`);
  let tv = null;
  try { tv = listIn("tv-native/src/api.ts", "PROXY_ART_HOSTS"); } catch {}
  if (tv) {
    for (const h of tv) assert.ok(server.includes(h), `the TV app sends ${h} through the proxy`);
    assert.ok(!tv.includes("episodes.metahub.space"), "the TV app's stills are fetched as they always were");
  }
});
