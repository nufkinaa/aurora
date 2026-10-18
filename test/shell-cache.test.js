// The app shell and the stylesheet bundle are not re-checked on EVERY page
// load (server round, 2026-10-18): writing the shell asked every module and
// stylesheet whether it changed — 318 blocking file calls a page load. Kept
// for a couple of seconds, an edit still shows on the next reload.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const assetver = require("../src/lib/assetver");
const cssbundle = require("../src/lib/cssbundle");

const PUBLIC = path.join(__dirname, "..", "public");
const fakeRes = () => {
  const r = { headers: {}, body: null, code: 200 };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.type = () => r;
  r.send = (b) => { r.body = b; return r; };
  return r;
};
const countingFs = (fn) => {
  const names = ["statSync", "readFileSync", "readdirSync"];
  const real = {};
  let n = 0;
  for (const k of names) { real[k] = fs[k]; fs[k] = function (...a) { n++; return real[k].apply(this, a); }; }
  try { fn(); } finally { Object.assign(fs, real); }
  return n;
};

test("the shell: the second page load inside the window reads no file and sends the same bytes", () => {
  assetver._internals.finished.clear();
  const send = assetver.sendShell(PUBLIC);
  const a = fakeRes();
  const first = countingFs(() => send(a, "index.html"));
  assert.equal(a.code, 200);
  assert.ok(first > 20, `the first one looks at the files (${first} calls)`);
  const b = fakeRes();
  const second = countingFs(() => send(b, "index.html"));
  assert.equal(second, 0);
  assert.equal(b.body, a.body);
  assert.equal(b.headers["cache-control"], "no-cache");
  // after the window it looks again
  for (const v of assetver._internals.finished.values()) v.at -= assetver.SHELL_RECHECK_MS + 1;
  const c = fakeRes();
  assert.ok(countingFs(() => send(c, "index.html")) > 0);
  assert.equal(c.body, a.body);
  // a shell that does not exist is still a 404
  const d = fakeRes();
  send(d, "no-such-shell.html");
  assert.equal(d.code, 404);
});

test("the stylesheet bundle: looked at once per window", () => {
  const dir = path.join(PUBLIC, "css");
  cssbundle._internals.lookAgain();
  const one = cssbundle.get(dir);
  assert.equal(countingFs(() => cssbundle.get(dir)), 0);
  assert.equal(cssbundle.get(dir), one);
  cssbundle._internals.lookAgain();
  assert.ok(countingFs(() => cssbundle.get(dir)) > 0);
});

test("writing the shell looks at each module once (jsassets.within), not once per list it is on", () => {
  const jsassets = require("../src/lib/jsassets");
  assetver._internals.finished.clear();
  const modules = jsassets.list(PUBLIC).length;
  const real = fs.statSync;
  let stats = 0;
  fs.statSync = function (...a) { stats++; return real.apply(this, a); };
  try { assetver.sendShell(PUBLIC)(fakeRes(), "index.html"); } finally { fs.statSync = real; }
  assert.ok(stats <= modules + 12, `${stats} stats for ${modules} modules`);
});
