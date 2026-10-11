// lib/lazy.js: a require() that lives inside a function, asked for once.
// It must hand back exactly what require() would at that moment.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lazy = require("../src/lib/lazy");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lazy-"));
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

// a require() that counts how often it is really asked
const counting = () => {
  let calls = 0;
  const req = (id) => { calls++; return require(id); };
  req.resolve = require.resolve;
  req.cache = require.cache;
  return { req, calls: () => calls };
};

test("the module is asked for once, then answered from memory", () => {
  const file = write("once.js", "module.exports = { n: 1, bump() { this.n++; return this.n; } };");
  const { req, calls } = counting();
  const get = lazy(req, file);
  assert.equal(calls(), 0, "nothing is loaded until the first call");
  const a = get();
  assert.equal(a, require(file), "the module's own exports object");
  for (let i = 0; i < 50; i++) assert.equal(get(), a);
  assert.equal(calls(), 1);
  assert.equal(get().bump(), 2, "the live module, not a copy");
});

test("a module that replaces its exports is followed", () => {
  const file = write("swap.js", "module.exports = { v: 1 };");
  const { req } = counting();
  const get = lazy(req, file);
  assert.equal(get().v, 1);
  require.cache[require.resolve(file)].exports = { v: 2 };
  assert.equal(get().v, 2);
  assert.equal(get(), require(file));
});

test("dropped from require.cache (a test reloading a module): the next call loads it again", () => {
  const file = write("fresh.js", "module.exports = { made: Math.random() };");
  const { req, calls } = counting();
  const get = lazy(req, file);
  const first = get();
  delete require.cache[require.resolve(file)];
  const second = get();
  assert.notEqual(second, first, "a fresh copy");
  assert.equal(second, require(file));
  assert.equal(get(), second);
  assert.equal(calls(), 2);
});

test("in the middle of a circular load it gives require()'s own answer and remembers nothing yet", () => {
  // a.js asks for b.js while loading; b.js calls back into a through the lazy getter
  write("b.js", `
    const lazy = require(${JSON.stringify(path.join(__dirname, "..", "src", "lib", "lazy.js"))});
    const a = lazy(require, "./a.js");
    exports.early = Object.keys(a());          // a is half-built here
    exports.late = () => Object.keys(a());     // …and whole here
  `);
  const fileA = write("a.js", `
    exports.one = 1;
    const b = require("./b.js");
    exports.two = 2;
    exports.b = b;
  `);
  const a = require(fileA);
  assert.deepEqual(a.b.early, ["one"], "what a plain require() sees mid-load");
  assert.deepEqual(a.b.late(), ["one", "two", "b"], "the finished module afterwards");
});

test("a built-in works too", () => {
  const get = lazy(require, "os");
  assert.equal(get(), os);
  assert.equal(get(), os);
});

test("the server's own modules resolve through it", () => {
  // every `lazy(require, "…")` in src/ names a module that exists
  const src = path.join(__dirname, "..", "src");
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
  walk(src);
  let found = 0;
  for (const f of files.filter((x) => path.basename(x) !== "lazy.js")) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/lazy\(require, "([^"]+)"\)/g)) {
      found++;
      const target = m[1];
      const resolved = target.startsWith(".") ? require.resolve(path.resolve(path.dirname(f), target)) : require.resolve(target);
      assert.ok(resolved, `${path.relative(src, f)} -> ${target}`);
    }
  }
  assert.ok(found >= 20, `${found} lazy imports checked`);
});
