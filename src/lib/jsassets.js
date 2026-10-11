// The website's JavaScript, as it goes over the wire: smaller, and cached for
// good.
//
// The modules in public/js are written to be read — comments are about half
// of every file — and were served exactly as written, on `no-cache`: every
// visit asked the server "has this changed?" once per module (48 questions
// for Home), and a first visit carried ~310 KB of JavaScript, half of it
// prose. Three things happen here, none of which changes what the code does:
//
//   1. WHITESPACE AND COMMENTS GO. esbuild re-prints each module without
//      them (`minifyWhitespace` only: no renaming, no rewriting — a stack
//      trace still names the real functions). 958 KB of source becomes
//      ~500 KB to parse, 309 KB on the wire becomes ~167 KB.
//      esbuild is an OPTIONAL dependency: where it is not installed, every
//      file is served as written and everything else here still works.
//
//   2. EVERY MODULE HAS A CONTENT-ADDRESSED URL — /js/ui.js?v=<hash of what
//      is served> — answered `immutable` for a year. The page's import map
//      (written into the shell, see assetver.js) maps each module to its
//      current address, so `import "./ui.js"` inside any module lands there
//      without the modules themselves knowing: no hash is written into a
//      file, so one changed module changes one URL, and a repeat visit asks
//      the server about no JavaScript at all.
//      A browser without import maps (before 2023: iOS < 16.4) ignores the
//      map and asks for /js/ui.js — which is answered as it always was,
//      `no-cache` with an ETag. Same code, the old caching.
//
//   3. PRE-COMPRESSED, ONCE. Brotli at its best setting (11) is ~10% smaller
//      than the on-the-fly setting (6) and far too slow to do per request —
//      so each module is compressed once in the background and that copy is
//      sent from memory. Until it is ready the `compression` middleware
//      does what it always did.
//
// Everything is rebuilt per file when its mtime or size changes, so editing
// a module with the server running still takes effect on the next reload.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

let esbuild; // undefined: not looked for yet; null: not installed
const minifier = () => {
  if (esbuild === undefined) {
    try {
      esbuild = require("esbuild");
    } catch {
      esbuild = null;
    }
  }
  return esbuild;
};

// Re-printed without comments and layout whitespace; the source itself when
// that cannot be done (no esbuild, a file it cannot parse, a file that is
// minified already).
const REPRINT = {
  loader: "js",
  minifyWhitespace: true,
  minifyIdentifiers: false,
  minifySyntax: false,
  legalComments: "none",
  charset: "utf8", // the app's strings carry emoji and Hebrew: keep them as written
  target: "esnext", // re-print only: no syntax is lowered
};
const minify = (source, file) => {
  const es = minifier();
  if (!es || /\.min\.js$/.test(file)) return source;
  try {
    return es.transformSync(source, { ...REPRINT, sourcefile: file }).code;
  } catch (e) {
    console.warn(`[js] ${file} served as written: ${String((e && e.message) || e).split("\n")[0]}`);
    return source;
  }
};

// ---------- pre-compression ----------
// key (content hash) -> { br, gzip } once made. Kept small: the newest few
// hundred bodies (a deploy replaces a handful).
const packed = new Map();
const packing = new Set();
const MIN_PACK_BYTES = 1024; // the same floor as the compression middleware
const pack = (key, body) => {
  if (packed.has(key) || packing.has(key) || body.length < MIN_PACK_BYTES) return;
  packing.add(key);
  const br = new Promise((resolve) =>
    zlib.brotliCompress(body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length },
    }, (err, out) => resolve(err ? null : out)));
  const gz = new Promise((resolve) => zlib.gzip(body, { level: 9 }, (err, out) => resolve(err ? null : out)));
  Promise.all([br, gz]).then(([b, g]) => {
    packing.delete(key);
    if (!b && !g) return;
    packed.set(key, { br: b, gzip: g });
    if (packed.size > 400) packed.delete(packed.keys().next().value);
  });
};
// Which of br / gzip this request accepts, best first ("" = neither).
const accepts = (req) => {
  const h = String(req.headers["accept-encoding"] || "").toLowerCase();
  const has = (name) => new RegExp(`(^|[,\\s])${name}(\\s*;\\s*q=(0\\.\\d*[1-9]\\d*|1(\\.0*)?))?\\s*(,|$)`).test(h);
  return has("br") ? "br" : has("gzip") ? "gzip" : "";
};
// Send `body` (a Buffer) — from the pre-compressed copy when there is one
// for what this client accepts, as it is otherwise (the compression
// middleware then compresses it on the way out, as it always did).
const send = (req, res, key, body) => {
  res.setHeader("Vary", "Accept-Encoding");
  const enc = accepts(req);
  const hit = packed.get(key);
  if (!hit) pack(key, body);
  // (the middleware's own opt-out is honoured here too)
  if (hit && enc && hit[enc] && !req.headers["x-no-compression"]) {
    res.setHeader("Content-Encoding", enc);
    res.setHeader("Content-Length", hit[enc].length);
    return res.end(req.method === "HEAD" ? undefined : hit[enc]);
  }
  res.send(body);
};

// ---------- the modules ----------
const assets = new Map(); // "/js/ui.js" -> { abs, stamp, body, hash, imports }
let listed = { at: 0, dir: null, urls: [] };

const walk = (dir, prefix, out) => {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}/${e.name}`, out);
    else if (/\.js$/.test(e.name)) out.push(`${prefix}/${e.name}`);
  }
  return out;
};
// Every module under public/js, as URL paths. (Re-listed at most once a
// second: a new file shows up on the next reload, a request does not walk
// the folder.)
const list = (publicDir) => {
  if (listed.dir === publicDir && Date.now() - listed.at < 1000) return listed.urls;
  listed = { at: Date.now(), dir: publicDir, urls: walk(path.join(publicDir, "js"), "/js", []).sort() };
  return listed.urls;
};

// The static imports of a module's SOURCE (`import … from "./x.js"`,
// `import "./x.js"`, `export … from "./x.js"`), as URL paths. Dynamic
// `import()` is deliberately not followed: that is code for later.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["'](\.{1,2}\/[^"']+\.js)["']/gm;
const importsOf = (source, url) => {
  const out = [];
  let m;
  STATIC_IMPORT.lastIndex = 0;
  while ((m = STATIC_IMPORT.exec(source))) {
    const to = path.posix.normalize(path.posix.join(path.posix.dirname(url), m[1]));
    if (!out.includes(to)) out.push(to);
  }
  return out;
};

// One module, current: null when there is no such file.
const asset = (publicDir, url) => {
  if (!/^\/js\/[A-Za-z0-9._/-]+\.js$/.test(url) || url.includes("..")) return null;
  const abs = path.join(publicDir, url);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    assets.delete(url);
    return null;
  }
  if (!st.isFile()) return null;
  const stamp = `${st.mtimeMs}:${st.size}:${minifier() ? 1 : 0}`;
  const hit = assets.get(url);
  if (hit && hit.stamp === stamp && hit.abs === abs) return hit;
  const source = fs.readFileSync(abs, "utf-8");
  const printed = minify(source, url);
  const body = Buffer.from(printed, "utf-8");
  const a = {
    abs,
    stamp,
    body,
    reprinted: printed !== source,
    hash: crypto.createHash("md5").update(body).digest("hex").slice(0, 10),
    imports: importsOf(source, url),
  };
  assets.set(url, a);
  return a;
};

// Everything `entries` import, statically, entries first then breadth-first —
// the order the browser would discover them in.
const closure = (publicDir, entries) => {
  const seen = [];
  const queue = [...entries];
  while (queue.length) {
    const url = queue.shift();
    if (seen.includes(url)) continue;
    const a = asset(publicDir, url);
    if (!a) continue;
    seen.push(url);
    queue.push(...a.imports);
  }
  return seen;
};

// { "/js/ui.js": "/js/ui.js?v=…", … } for every module there is.
const importMap = (publicDir) => {
  const imports = {};
  for (const url of list(publicDir)) {
    const a = asset(publicDir, url);
    if (a) imports[url] = `${url}?v=${a.hash}`;
  }
  return imports;
};
const versioned = (publicDir, url) => {
  const a = asset(publicDir, url);
  return a ? `${url}?v=${a.hash}` : url;
};

// LINE NUMBERS. A re-printed module is one long line: a stack trace reads
// "ui.js:1:48211" where the file as written says line 1322. (esbuild has no
// "drop the comments, keep the lines" — it prints its own layout either way —
// so keeping line numbers was not on offer.) What depends on it:
//   - the error reports (public/js/telemetry-core.js locOf, lib/tel/scrub.js
//     normLocation) group by FILE AND FUNCTION NAME and drop line, column and
//     the ?v= stamp on purpose — and names are never touched here. A fault
//     has the same fingerprint served either way (test/jsassets.test.js).
//   - a person reading a stack in the browser's own tools. For them every
//     re-printed module names its source map in a response header
//     (`SourceMap: /js/ui.js.map` — a header, so not one byte is added to
//     the code), and the map is made only when it is asked for, which is
//     when developer tools are open. It carries the file as written, so the
//     tools show the real lines, comments and all.
const sourceMap = (publicDir, url) => {
  const es = minifier();
  const a = asset(publicDir, url);
  if (!es || !a || !a.reprinted) return null;
  try {
    return es.transformSync(fs.readFileSync(a.abs, "utf-8"), {
      ...REPRINT,
      sourcefile: path.posix.basename(url),
      sourcemap: "external",
      sourcesContent: true,
    }).map;
  } catch {
    return null;
  }
};

// GET /js/**.js (and /js/**.js.map — "LINE NUMBERS" above)
const serve = (publicDir) => (req, res, next) => {
  if (req.path.endsWith(".js.map")) {
    const map = sourceMap(publicDir, req.path.slice(0, -4));
    if (!map) return next();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.send(map);
  }
  const a = asset(publicDir, req.path);
  if (!a) return next();
  if (a.reprinted) res.setHeader("SourceMap", `${req.path}.map`);
  const etag = `"${a.hash}"`;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("ETag", etag);
  // Immutable only under ITS OWN hash: an old page asking for an old address
  // after a deploy gets the current code, but not a year's licence to keep it
  // under the wrong name.
  res.setHeader("Cache-Control", req.query.v === a.hash ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  send(req, res, `js:${a.hash}`, a.body);
};

module.exports = { serve, asset, list, closure, importMap, importsOf, versioned, minify, sourceMap, send, pack, accepts, _minifier: minifier };
