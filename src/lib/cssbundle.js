// One stylesheet for the app shell instead of six render-blocking ones.
//
// The six sheets in public/css are concatenated in the order index.html
// always loaded them (tokens → base → components → screens → responsive →
// glass; the order IS the cascade, so it must not change) and lightly
// minified: comments and blank lines go, indentation goes, nothing inside a
// string or url() is touched. Comments are ~40% of these files — they are
// written for the person editing them, and that person reads the source,
// not the wire.
//
// Served at /css/aurora.css (server.js). Rebuilt when any source file's
// mtime/size changes, so editing a sheet with the server running still takes
// effect on the next reload — the same dev loop assetver.js keeps for the
// individual files. The hash of the bundle rides the shell's ?v= (assetver
// asks here for /css/aurora.css), so the bundle long-caches like the rest.
//
// admin.html and browser.html keep their individual <link>s: they only use
// the first three sheets, and their pages aren't the ones a phone cold-loads.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ORDER = ["tokens.css", "base.css", "components.css", "screens.css", "responsive.css", "glass.css"];

// Strip /* … */ comments and collapse layout whitespace. A small state machine
// rather than a regex: a comment opener inside a string or a url() must be
// left alone (data: URIs carry `//`, quoted content can carry anything).
const minify = (css) => {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    // strings: copied verbatim, escapes respected
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && css[j] !== q) {
        if (css[j] === "\\") j++;
        j++;
      }
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // UNQUOTED url(...) — copied verbatim up to the closing paren. A quoted
    // one is left to the string branch: its value can carry a `)` of its own
    // (an SVG data URI with filter='url(#g)' does), which would end this
    // branch early and leave a stray quote to mis-tokenise everything after.
    if (css.startsWith("url(", i) && css[i + 4] !== '"' && css[i + 4] !== "'") {
      const j = css.indexOf(")", i);
      const end = j < 0 ? n : j + 1;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const j = css.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    out += c;
    i++;
  }
  // indentation + blank lines: each line trimmed, empties dropped
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
};

const stampOf = (dir) =>
  ORDER.map((f) => {
    try {
      const st = fs.statSync(path.join(dir, f));
      return `${f}:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${f}:missing`;
    }
  }).join("|");

let cache = null; // { stamp, css, hash }

// The current bundle: { css, hash }. Cheap when nothing changed (six stats).
const get = (cssDir) => {
  const stamp = stampOf(cssDir);
  if (cache && cache.stamp === stamp) return cache;
  const parts = [];
  for (const f of ORDER) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(cssDir, f), "utf8");
    } catch {}
    parts.push(`/* ${f} */\n${minify(raw)}`);
  }
  const css = parts.join("\n");
  const hash = crypto.createHash("md5").update(css).digest("hex").slice(0, 10);
  cache = { stamp, css, hash };
  return cache;
};

// The bundle compressed, once per version of it ("br" or "gzip"; null for
// anything else). It is 38 KB of text that only changes with a release, and
// the compression middleware was compressing it again for every request
// (6-13 ms of CPU each on a two-core box).
const zlib = require("zlib");
const BROTLI_QUALITY = 6; // the quality server.js gives the middleware
// …and then once more, at brotli's best. This is the one request that blocks
// the first paint: quality 11 is ~13% smaller (31.5 KB against 36 KB) and far
// too slow to make while a request waits (hundreds of ms), so the quality-6
// copy answers at once and the better one takes its place when it is ready —
// off the event loop's back (zlib's thread pool), once per version. Same
// cache, same call: there is one compressed copy of the bundle, not two.
const best = (c) => {
  if (c.best) return;
  c.best = true;
  const body = Buffer.from(c.css, "utf8");
  zlib.brotliCompress(body, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length },
  }, (err, out) => { if (!err && out && c.br && out.length < c.br.length) c.br = out; });
};
const compressed = (cssDir, encoding) => {
  const c = get(cssDir);
  if (encoding === "br") {
    if (!c.br) c.br = zlib.brotliCompressSync(Buffer.from(c.css, "utf8"), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } });
    best(c);
    return c.br;
  }
  if (encoding === "gzip") return c.gzip || (c.gzip = zlib.gzipSync(Buffer.from(c.css, "utf8")));
  return null;
};

module.exports = { ORDER, minify, get, compressed };
