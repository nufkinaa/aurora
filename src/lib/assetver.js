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
  const boot = jsassets.closure(publicDir, BOOT_ENTRIES).map((url) => [url, map[url].split("?v=")[1]]);
  // (the entry is asked for by its versioned URL in every browser — see ENTRY below)
  const preloader =
    // (Chrome 89–95 read import maps but cannot be asked whether they do —
    // HTMLScriptElement.supports arrived in 96 — so there the version number answers)
    "(function(){var S=window.HTMLScriptElement&&HTMLScriptElement.supports," +
    "m=S?S.call(HTMLScriptElement,\"importmap\"):/Chrom(e|ium)\\/(89|9\\d|[1-9]\\d\\d)/.test(navigator.userAgent)," +
    `L=${JSON.stringify(boot)},h=document.head,i,l;` +
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
const sendShell = (publicDir) => (res, name) => {
  let html;
  try {
    html = withModules(readShell(path.join(publicDir, name)), publicDir).replace(
      /href="(\/css\/[^"?]+\.css)"/g,
      (whole, href) => {
        const v = versionFor(path.join(publicDir, href.replace(/^\//, "")));
        return v ? `href="${href}?v=${v}"` : whole;
      }
    );
  } catch {
    return res.status(404).type("text/plain").send("Not found");
  }
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(html);
};

module.exports = { sendShell, versionFor, withModules, BOOT_ENTRIES };
