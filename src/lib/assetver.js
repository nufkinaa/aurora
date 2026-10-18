// Content-addressed stylesheet URLs, so CSS can long-cache without ever going
// stale. The HTML shells are rewritten at serve time: every /css/*.css href
// gains ?v=<content hash>, and the static mount serves *versioned* CSS
// requests with an immutable year-long cache (see server.js). A changed file
// changes the hash, the always-fresh HTML points at the new URL, and every
// old cached copy is simply never asked for again.
//
// (This file used to say "CSS only": a ?v on a <script> names a different
// resource than the unversioned `import "./ui.js"` inside the modules, so
// every module would have been downloaded twice. An import map removes that
// objection — see "the app shell's JavaScript" below and src/lib/jsassets.js.)
//
// The hash is re-checked per request via statSync (mtime+size), so editing a
// stylesheet with the server running takes effect on the next reload — same
// dev loop as before versioning existed.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const versions = new Map(); // abs path -> { stamp, v }
const versionFor = (abs) => {
  // the bundled shell stylesheet has no file of its own — its hash is the
  // bundle's (src/lib/cssbundle.js), recomputed when any source sheet moves
  if (/[\\/]aurora\.css$/.test(abs)) {
    try {
      return require("./cssbundle").get(path.dirname(abs)).hash;
    } catch {
      return null;
    }
  }
  try {
    const st = fs.statSync(abs);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = versions.get(abs);
    if (hit && hit.stamp === stamp) return hit.v;
    const v = crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex").slice(0, 10);
    versions.set(abs, { stamp, v });
    return v;
  } catch {
    return null; // missing file: leave the href untouched
  }
};

const shells = new Map(); // abs path -> { stamp, raw }
const readShell = (abs) => {
  const st = fs.statSync(abs);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = shells.get(abs);
  if (hit && hit.stamp === stamp) return hit.raw;
  const raw = fs.readFileSync(abs, "utf-8");
  shells.set(abs, { stamp, raw });
  return raw;
};

// ---------- the app shell's JavaScript ----------
// (index.html only — it is the one shell that loads modules.) Three things
// are written into it, all from src/lib/jsassets.js:
//
//   an import map       every module -> its content-addressed, immutable URL
//   the preload list    the modules boot needs, so they are all fetched at
//                       once instead of being discovered level by level. It
//                       is WALKED from main.js's static imports on every
//                       change — the hand-kept list in index.html had fallen
//                       four modules behind (net, blur, artUpgrade, glassTone:
//                       two extra round trips before boot could start), and
//                       it now only stands in if this rewrite cannot be made.
//   the entry script    main.js under its own versioned URL
//
// The preload links are added by a small inline script rather than written as
// tags, because their URLs depend on the browser: one that understands import
// maps preloads the versioned addresses (what its imports will resolve to),
// one that does not preloads the plain ones (what its imports will ask for) —
// the wrong kind would download every module twice. The script sits ahead of
// the stylesheet so it never waits for it.
//
// Beside main.js's own graph, two modules boot imports dynamically are on the
// list: offline.js (awaited before the first screen can build — state.js
// refreshProgress) and aurora-sky.js (the glass look's sky; it was on the
// hand-kept list too).
const BOOT_ENTRIES = ["/js/main.js", "/js/offline.js", "/js/aurora-sky.js"];
// Address (location.hash) -> the screen module main.js loads for it. READ
// FROM main.js's own route table (`route("/movies", lazy("./screens/browse.js"
// …))`) every time the file changes — this was a table kept by hand here, and
// a table kept by hand is how the preload list fell behind. A hint only: a
// route written in a shape this does not read costs the round trip it always
// cost and nothing else (test/jsassets.test.js says which shapes are read,
// and fails when a route that loads a screen is not among them).
//   -> [[pattern (a RegExp source, tested against location.hash), module URL], …]
const routeTables = new Map(); // main.js's asset stamp -> entries
const routeEntries = (publicDir) => {
  let jsassets, main, source;
  try {
    jsassets = require("./jsassets");
    main = jsassets.asset(publicDir, "/js/main.js");
    if (!main) return [];
    const hit = routeTables.get(publicDir);
    if (hit && hit.stamp === main.stamp) return hit.entries;
    source = fs.readFileSync(main.abs, "utf-8");
  } catch {
    return [];
  }
  const toUrl = (spec) => path.posix.normalize(path.posix.join("/js", spec));
  // helpers that stand for one screen: `const renderDetailLazy = (root, opts) =>
  //   import("./screens/discover-detail.js")…`
  const helpers = new Map();
  for (const m of source.matchAll(/^const (\w+) = \([^)]*\) =>\s*import\("(\.\/[^"]+\.js)"\)/gm)) helpers.set(m[1], toUrl(m[2]));
  const byModule = new Map(); // module URL -> [address patterns]
  const starts = [...source.matchAll(/^route\("([^"]+)",/gm)];
  for (const [i, m] of starts.entries()) {
    // one route(...) statement: up to the next one, or to the first line that
    // closes it at the left margin
    let body = source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : m.index + 4000);
    const end = /^(?:route\(.*\);|\}\)?\);)[ \t]*(?:\/\/.*)?\r?$/m.exec(body);
    if (end) body = body.slice(0, end.index + end[0].length);
    const first = /(?:import|lazy)\("(\.\/[^"]+\.js)"|\b(\w+)\(root\b/.exec(body.slice(m[0].length));
    const url = first ? (first[1] ? toUrl(first[1]) : helpers.get(first[2])) : null;
    if (!url || !jsassets.asset(publicDir, url)) continue; // (Home, or a route that only redirects)
    // "/movie/:id" -> "/movie/[^/]+"; the address may go on (a query, a deeper path)
    const pattern = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z]+/g, "[^/]+");
    if (!byModule.has(url)) byModule.set(url, []);
    byModule.get(url).push(pattern);
  }
  const entries = [...byModule].map(([url, patterns]) => [`^#(?:${patterns.join("|")})(?:[/?]|$)`, url]);
  routeTables.set(publicDir, { stamp: main.stamp, entries });
  return entries;
};
const PRELOAD_BLOCK = /(?:[ \t]*<link rel="modulepreload" href="[^"]+" \/>\r?\n)+/;
const STYLESHEET = /([ \t]*)<link rel="stylesheet" href="\/css\/aurora\.css/;
const ENTRY = '<script type="module" src="/js/main.js"></script>';
const withModules = (html, publicDir) => {
  if (!html.includes(ENTRY) || !STYLESHEET.test(html)) return html;
  let jsassets;
  try {
    jsassets = require("./jsassets");
  } catch {
    return html;
  }
  const map = jsassets.importMap(publicDir);
  if (!map["/js/main.js"]) return html;
  const pair = (url) => [url, map[url].split("?v=")[1]];
  const bootUrls = jsassets.closure(publicDir, BOOT_ENTRIES);
  const boot = bootUrls.map(pair);
  // The screen the address names, when it is not Home: its module and what
  // that imports join the list, so a page opened (or reloaded, or restored by
  // the phone) on a title, a grid or Search does not find out only after boot
  // that it needs another round trip or two of code.
  const routes = routeEntries(publicDir)
    .map(([pattern, entry]) => [pattern, jsassets.closure(publicDir, [entry]).filter((url) => !bootUrls.includes(url)).map(pair)])
    .filter(([, list]) => list.length);
  // (the entry is asked for by its versioned URL in every browser — see ENTRY below)
  const preloader =
    // (Chrome 89–95 read import maps but cannot be asked whether they do —
    // HTMLScriptElement.supports arrived in 96 — so there the version number answers)
    "(function(){var S=window.HTMLScriptElement&&HTMLScriptElement.supports," +
    "m=S?S.call(HTMLScriptElement,\"importmap\"):/Chrom(e|ium)\\/(89|9\\d|[1-9]\\d\\d)/.test(navigator.userAgent)," +
    `L=${JSON.stringify(boot)},R=${JSON.stringify(routes)},h=document.head,i,l;` +
    "for(i=0;i<R.length;i++)if(new RegExp(R[i][0]).test(location.hash)){L=L.concat(R[i][1]);break}" +
    "for(i=0;i<L.length;i++){l=document.createElement(\"link\");l.rel=\"modulepreload\";" +
    "l.href=L[i][0]+(m||!i?\"?v=\"+L[i][1]:\"\");h.appendChild(l)}})();";
  return html
    .replace(PRELOAD_BLOCK, "")
    .replace(STYLESHEET, (whole, indent) =>
      `${indent}<script type="importmap">${JSON.stringify({ imports: map })}</script>\n` +
      `${indent}<script>${preloader}</script>\n${whole}`)
    .replace(ENTRY, `<script type="module" src="${map["/js/main.js"]}"></script>`);
};

// Serve an HTML shell from public/ with versioned stylesheet hrefs.
//
// The finished shell is kept for SHELL_RECHECK_MS. Writing it means asking
// every module and stylesheet whether it changed (the import map, the
// preload closure, the route table): 318 blocking file calls and 34 ms of a
// two-core box's CPU for EVERY page load (server round, 2026-10-18 —
// docs/qa/server-round/EVENTLOOP.md). Kept two seconds, an edit still shows
// on the next reload, and a burst of page loads (a household opening the app
// after a release) costs one.
const SHELL_RECHECK_MS = 2000;
const finished = new Map(); // abs path -> { at, html }
const renderShell = (publicDir, name) => {
  const run = () =>
    withModules(readShell(path.join(publicDir, name)), publicDir).replace(
      /href="(\/css\/[^"?]+\.css)"/g,
      (whole, href) => {
        const v = versionFor(path.join(publicDir, href.replace(/^\//, "")));
        return v ? `href="${href}?v=${v}"` : whole;
      }
    );
  // (each module looked at once for the whole shell: jsassets.within)
  let js = null;
  try { js = require("./jsassets"); } catch {}
  return js && js.within ? js.within(run) : run();
};
const sendShell = (publicDir) => (res, name) => {
  const abs = path.join(publicDir, name);
  const now = Date.now();
  let hit = finished.get(abs);
  if (!hit || now - hit.at > SHELL_RECHECK_MS) {
    try {
      hit = { at: now, html: renderShell(publicDir, name) };
    } catch {
      finished.delete(abs);
      return res.status(404).type("text/plain").send("Not found");
    }
    finished.set(abs, hit);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(hit.html);
};

module.exports = { sendShell, versionFor, withModules, BOOT_ENTRIES, routeEntries, SHELL_RECHECK_MS, _internals: { finished } };
