// The shell stylesheet bundle: comments go, strings and url() values stay
// byte-for-byte, and the real sheets survive the trip.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { minify, get, ORDER } = require("../src/lib/cssbundle");

test("comments are stripped, rules survive", () => {
  assert.strictEqual(minify("a{}\n/* x */\nb{}"), "a{}\nb{}");
  assert.strictEqual(minify("a {\n  color: red; /* inline */\n}\n"), "a {\ncolor: red;\n}");
});

test("a quoted data URI with a ')' and quotes inside is untouched", () => {
  const uri = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect filter='url(%23g)'/%3E%3C/svg%3E")`;
  const css = `a { background: ${uri}; }\n/* gone */\nb { c: 1; }`;
  const out = minify(css);
  assert.ok(out.includes(uri), "data URI must survive verbatim");
  assert.ok(!out.includes("/* gone */"));
  assert.ok(out.includes("b { c: 1; }"));
});

test("an unquoted url() and a string holding a comment opener survive", () => {
  const css = `a { background: url(/img/x.png); content: "/* not a comment */"; }`;
  assert.strictEqual(minify(css), css);
});

test("the real sheets bundle with only the six file markers left as comments", () => {
  const dir = path.join(__dirname, "..", "public", "css");
  const { css, hash } = get(dir);
  assert.strictEqual((css.match(/\/\*/g) || []).length, ORDER.length);
  assert.match(hash, /^[0-9a-f]{10}$/);
  // every data URI in the sources is in the bundle
  const count = (s) => (s.match(/url\(["']?data:/g) || []).length;
  const raw = ORDER.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.strictEqual(count(css), count(raw));
  // and the cascade order is the load order index.html always used
  assert.ok(css.indexOf("/* tokens.css */") < css.indexOf("/* glass.css */"));
});

// ---------- compressed once per version ----------
{
  const zlib = require("zlib");
  const fsx = require("fs");
  const osx = require("os");
  const pathx = require("path");
  const bundle = require("../src/lib/cssbundle");
  require("node:test").test("compressed(): the bundle's own bytes, made once per version, remade when a sheet changes", () => {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "aurora-css-"));
    try {
      for (const f of bundle.ORDER) fsx.writeFileSync(pathx.join(dir, f), `.${f.replace(/\W/g, "")} { color: red; margin: 0 auto; }\n`.repeat(40));
      const { css, hash } = bundle.get(dir);
      const br = bundle.compressed(dir, "br");
      const gz = bundle.compressed(dir, "gzip");
      require("node:assert").equal(zlib.brotliDecompressSync(br).toString("utf8"), css);
      require("node:assert").equal(zlib.gunzipSync(gz).toString("utf8"), css);
      require("node:assert").ok(br.length < css.length / 2);
      require("node:assert").equal(bundle.compressed(dir, "br"), br, "the same buffer the second time");
      require("node:assert").equal(bundle.compressed(dir, "gzip"), gz);
      require("node:assert").equal(bundle.compressed(dir, "deflate"), null);
      require("node:assert").equal(bundle.compressed(dir, null), null);
      // a sheet changes: a new version, compressed afresh
      const first = pathx.join(dir, bundle.ORDER[0]);
      fsx.writeFileSync(first, ".changed { color: blue; }\n".repeat(60));
      const later = new Date(Date.now() + 5000);
      fsx.utimesSync(first, later, later);
      const next = bundle.get(dir);
      require("node:assert").notEqual(next.hash, hash);
      require("node:assert").equal(zlib.brotliDecompressSync(bundle.compressed(dir, "br")).toString("utf8"), next.css);
    } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
  });
}
