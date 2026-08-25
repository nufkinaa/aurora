// Content-addressed stylesheet URLs, so CSS can long-cache without ever going
// stale. The HTML shells are rewritten at serve time: every /css/*.css href
// gains ?v=<content hash>, and the static mount serves *versioned* CSS
// requests with an immutable year-long cache (see server.js). A changed file
// changes the hash, the always-fresh HTML points at the new URL, and every
// old cached copy is simply never asked for again.
//
// CSS ONLY, deliberately: JS module imports (import "./ui.js") carry no query
// string, so a ?v on the <script>/<link rel=modulepreload> URLs would name a
// DIFFERENT resource than the import graph fetches — every module would be
// downloaded twice. JS stays on no-cache + cheap 304s.
//
// The hash is re-checked per request via statSync (mtime+size), so editing a
// stylesheet with the server running takes effect on the next reload — same
// dev loop as before versioning existed.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const versions = new Map(); // abs path -> { stamp, v }
const versionFor = (abs) => {
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

// Serve an HTML shell from public/ with versioned stylesheet hrefs.
const sendShell = (publicDir) => (res, name) => {
  let html;
  try {
    html = readShell(path.join(publicDir, name)).replace(
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

module.exports = { sendShell, versionFor };
