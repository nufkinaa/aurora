// The website's JavaScript as served (src/lib/jsassets.js) and the shell that
// points at it (src/lib/assetver.js): re-printed without comments, one
// content-addressed URL per module, an import map, a preload list walked from
// main.js. Run against the real public/ folder — the point is that THIS
// site's modules survive the treatment.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const jsassets = require("../src/lib/jsassets");
const assetver = require("../src/lib/assetver");

const PUBLIC = path.join(__dirname, "..", "public");

const tmpPublic = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jsassets-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
};

test("static imports are found; dynamic ones and look-alikes are not", () => {
  const src = [
    'import "./focus.js";',
    'import { a, b } from "./ui.js";',
    'import * as n from "../narrator.js";',
    "import {",
    "  x,",
    "  y,",
    '} from "./multi.js";',
    'export { z } from "./re.js";',
    'const lazy = () => import("./screens/player.js");',
    '// import { nope } from "./comment.js";',
    'const s = \'import x from "./string.js"\';',
    'import("./also-dynamic.js").then(() => {});',
  ].join("\n");
  assert.deepEqual(jsassets.importsOf(src, "/js/screens/home.js"), [
    "/js/screens/focus.js", "/js/screens/ui.js", "/js/narrator.js", "/js/screens/multi.js", "/js/screens/re.js",
  ]);
});

test("every module of the site is served, hashed and still parses", async () => {
  const urls = jsassets.list(PUBLIC);
  assert.ok(urls.includes("/js/main.js") && urls.includes("/js/screens/player.js"));
  for (const url of urls) {
    const a = jsassets.asset(PUBLIC, url);
    assert.ok(a, url);
    assert.match(a.hash, /^[0-9a-f]{10}$/);
    assert.ok(a.body.length > 0);
    // every static import names a module that exists
    for (const dep of a.imports) assert.ok(jsassets.asset(PUBLIC, dep), `${url} imports ${dep}, which is not there`);
  }
});

test("re-printing removes comments and nothing else that matters", { skip: !jsassets._minifier() && "esbuild is not installed: files are served as written" }, () => {
  const src = [
    "// a comment that explains",
    "/* and a block */",
    'export const greet = (name) => `hello ${name} // not a comment`;',
    "export const re = /\\/\\/ also not a comment/g;",
    'export const emoji = "🍿 שלום";',
    "export function keepsItsName() { return greet.name; }",
  ].join("\n");
  const out = jsassets.minify(src, "/js/x.js");
  assert.ok(out.length < src.length);
  assert.ok(!out.includes("explains") && !out.includes("and a block"));
  assert.ok(out.includes("// not a comment") && out.includes("also not a comment"));
  assert.ok(out.includes("🍿 שלום"), "non-ASCII text is kept as written, not escaped");
  assert.ok(out.includes("keepsItsName") && out.includes("greet"), "no renaming");
  // a file that is minified already, and one that does not parse, are served as written
  assert.equal(jsassets.minify("var a = 1; // x", "/js/vendor/lib.min.js"), "var a = 1; // x");
  const broken = "export const = ;";
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(jsassets.minify(broken, "/js/broken.js"), broken); } finally { console.warn = warn; }
});

test("the site's modules are much smaller on the wire", { skip: !jsassets._minifier() && "esbuild is not installed" }, () => {
  let before = 0;
  let after = 0;
  for (const url of jsassets.list(PUBLIC)) {
    if (/vendor/.test(url)) continue;
    before += fs.statSync(path.join(PUBLIC, url)).size;
    after += jsassets.asset(PUBLIC, url).body.length;
  }
  assert.ok(after < before * 0.7, `${before} -> ${after}`);
});

test("a changed file gets a new address, an unchanged one keeps its own", () => {
  const dir = tmpPublic({ "js/a.js": 'import "./b.js";\nexport const a = 1;\n', "js/b.js": "export const b = 1;\n" });
  try {
    const a1 = jsassets.asset(dir, "/js/a.js").hash;
    const b1 = jsassets.asset(dir, "/js/b.js").hash;
    fs.writeFileSync(path.join(dir, "js", "b.js"), "export const b = 2; // changed\n");
    assert.notEqual(jsassets.asset(dir, "/js/b.js").hash, b1);
    assert.equal(jsassets.asset(dir, "/js/a.js").hash, a1, "a.js names b.js by its plain path: its own bytes did not change");
    assert.equal(jsassets.asset(dir, "/js/nope.js"), null);
    assert.equal(jsassets.asset(dir, "/js/../a.js"), null);
    assert.equal(jsassets.asset(dir, "/css/a.js"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the boot list is everything main.js needs before it can run", () => {
  const boot = jsassets.closure(PUBLIC, assetver.BOOT_ENTRIES);
  assert.equal(boot[0], "/js/main.js");
  // the four the hand-kept list had missed
  for (const url of ["/js/net.js", "/js/blur.js", "/js/artUpgrade.js", "/js/glassTone.js", "/js/offline.js"]) assert.ok(boot.includes(url), url);
  // nothing that is for later
  for (const url of ["/js/screens/player.js", "/js/vendor/hls.min.js", "/js/screens/discover-detail.js"]) assert.ok(!boot.includes(url), url);
  // complete: every static import of a listed module is listed
  for (const url of boot) for (const dep of jsassets.asset(PUBLIC, url).imports) assert.ok(boot.includes(dep), `${url} -> ${dep}`);
});

test("the shell: an import map, the preload script ahead of the stylesheet, a versioned entry", () => {
  const raw = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf-8");
  const html = assetver.withModules(raw, PUBLIC);
  const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(html)[1]).imports;
  assert.deepEqual(Object.keys(map).sort(), jsassets.list(PUBLIC));
  for (const [url, to] of Object.entries(map)) assert.equal(to, `${url}?v=${jsassets.asset(PUBLIC, url).hash}`);
  assert.ok(!/<link rel="modulepreload"/.test(html), "the hand-kept list is replaced, not added to");
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('<script type="importmap">') < at("modulepreload") && at("modulepreload") < at('<link rel="stylesheet" href="/css/aurora.css'));
  assert.ok(html.includes(`<script type="module" src="${map["/js/main.js"]}"></script>`));
  // the preload script is valid JavaScript and asks for versioned or plain addresses by what the browser can do
  const code = /<script>(\(function\(\)\{var S=.*?)<\/script>/.exec(html)[1];
  // supportsMaps: true / false, or a user-agent string for a browser that cannot be asked
  const run = (supportsMaps) => {
    const links = [];
    const window = { HTMLScriptElement: typeof supportsMaps === "string" ? {} : { supports: () => supportsMaps } };
    const document = { head: { appendChild: (l) => links.push(l) }, createElement: () => ({}) };
    new Function("window", "document", "HTMLScriptElement", "navigator", "location", code)(window, document, window.HTMLScriptElement, { userAgent: String(supportsMaps) }, { hash: "" });
    return links.map((l) => l.href);
  };
  // Chrome 89–95 read import maps but have no supports(): the version answers
  assert.ok(run("Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/92.0.4515.159 Mobile Safari/537.36").slice(1).every((h) => h.includes("?v=")));
  assert.ok(run("Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 Chrome/80.0.3987.99 Mobile Safari/537.36").slice(1).every((h) => !h.includes("?")));
  assert.ok(run("Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1").slice(1).every((h) => !h.includes("?")));
  const modern = run(true);
  const old = run(false);
  assert.equal(modern.length, jsassets.closure(PUBLIC, assetver.BOOT_ENTRIES).length);
  assert.ok(modern.every((h) => /\?v=[0-9a-f]{10}$/.test(h)));
  assert.equal(old[0], map["/js/main.js"], "the entry is versioned for every browser");
  assert.ok(old.slice(1).every((h) => !h.includes("?")), "a browser without import maps preloads what its imports will ask for");
  // a shell without the app's entry script (admin.html) is left alone
  const admin = fs.readFileSync(path.join(PUBLIC, "admin.html"), "utf-8");
  assert.equal(assetver.withModules(admin, PUBLIC), admin);
});

test("serving: immutable under its own hash only, 304 on a matching ETag, pre-compressed once ready", async () => {
  const handler = jsassets.serve(PUBLIC);
  const a = jsassets.asset(PUBLIC, "/js/ui.js");
  const call = (query, headers = {}) => new Promise((resolve) => {
    const out = { headers: {}, status: 200, body: null };
    const res = {
      setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
      status: (s) => { out.status = s; return res; },
      end: (b) => { out.body = b || null; resolve(out); },
      send: (b) => { out.body = b; resolve(out); },
    };
    handler({ path: "/js/ui.js", query, headers, method: "GET" }, res, () => resolve(null));
  });
  let r = await call({ v: a.hash });
  assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(r.headers["etag"], `"${a.hash}"`);
  r = await call({});
  assert.equal(r.headers["cache-control"], "no-cache");
  r = await call({ v: "0000000000" });
  assert.equal(r.headers["cache-control"], "no-cache", "an old address is answered, but not as immutable");
  r = await call({}, { "if-none-match": `"${a.hash}"` });
  assert.equal(r.status, 304);
  // the pre-compressed copy arrives in the background; then it is what is sent
  let packed = null;
  for (let i = 0; i < 100 && !packed; i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = await call({ v: a.hash }, { "accept-encoding": "gzip, deflate, br" });
    if (r.headers["content-encoding"]) packed = r;
  }
  assert.ok(packed, "a pre-compressed copy was made");
  assert.equal(packed.headers["content-encoding"], "br");
  assert.equal(zlib.brotliDecompressSync(packed.body).toString("utf-8"), a.body.toString("utf-8"));
  r = await call({ v: a.hash }, { "accept-encoding": "gzip" });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(r.body).toString("utf-8"), a.body.toString("utf-8"));
  r = await call({ v: a.hash }, { "accept-encoding": "identity" });
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["vary"], "Accept-Encoding");
});

test("what a client accepts", () => {
  const acc = (h) => jsassets.accepts({ headers: { "accept-encoding": h } });
  assert.equal(acc("gzip, deflate, br, zstd"), "br");
  assert.equal(acc("gzip, deflate"), "gzip");
  assert.equal(acc("br;q=0, gzip"), "gzip");
  assert.equal(acc("identity"), "");
  assert.equal(acc(""), "");
});

test("an address that names another screen preloads that screen's code too", () => {
  for (const [pattern, entry] of assetver.ROUTE_ENTRIES) {
    assert.ok(jsassets.asset(PUBLIC, entry), `${entry} (for ${pattern}) is not there`);
    assert.doesNotThrow(() => new RegExp(pattern));
  }
  const html = assetver.withModules(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf-8"), PUBLIC);
  const code = html.slice(html.indexOf("<script>(function(){var S=") + 8).split("</script>")[0];
  const run = (hash) => {
    const links = [];
    const window = { HTMLScriptElement: { supports: () => true } };
    const document = { head: { appendChild: (l) => links.push(l) }, createElement: () => ({}) };
    new Function("window", "document", "HTMLScriptElement", "navigator", "location", code)(window, document, window.HTMLScriptElement, { userAgent: "" }, { hash });
    return links.map((l) => l.href.split("?")[0]);
  };
  const boot = run("#/");
  assert.deepEqual(run(""), boot);
  assert.ok(run("#/movies").includes("/js/screens/browse.js") && !boot.includes("/js/screens/browse.js"));
  assert.ok(run("#/discover/movie/tt123").includes("/js/screens/discover-detail.js"));
  assert.ok(run("#/search").includes("/js/screens/search.js"));
  assert.equal(new Set(run("#/show/abc")).size, run("#/show/abc").length, "nothing is listed twice");
});
