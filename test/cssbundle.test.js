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
