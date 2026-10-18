// lib/imgcheck.js: what a picture file is, answered from memory while the
// file is the one that was looked at. The answers must be the ones the
// open-and-read check gave, and a file that changes must be looked at again.
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validImageFile, mimeOfFile, readHead, magicOk, sniffMime, MIN_IMAGE_BYTES } = require("../src/lib/imgcheck");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-imgcheck-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, head, size = 4096) => { const f = path.join(dir, name); const b = Buffer.alloc(size, 7); Buffer.from(head).copy(b); fs.writeFileSync(f, b); return f; };
const JPEG = [0xff, 0xd8, 0xff, 0xe0], PNG = [0x89, 0x50, 0x4e, 0x47], WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], GIF = [0x47, 0x49, 0x46, 0x38];
// the check as it was in 1.6.92
const oldValid = (f) => { try { const st = fs.statSync(f); if (st.size < MIN_IMAGE_BYTES) return false; const h = readHead(f); return !!h && magicOk(h); } catch { return false; } };
const oldMime = (f) => { const h = readHead(f); return h ? sniffMime(h) : null; };
// blocking calls that open the file (the ones the memory saves)
const opens = (fn) => { const real = fs.openSync; let n = 0; fs.openSync = function (...a) { n++; return real.apply(this, a); }; try { fn(); } finally { fs.openSync = real; } return n; };

test("the same answers as opening and reading, for every kind of file", () => {
  const cases = [file("a.jpg", JPEG), file("b.png", PNG), file("c.webp", WEBP), file("d.gif", GIF), file("e.html", [0x3c, 0x68, 0x74, 0x6d]), file("small.jpg", JPEG, 200), file("tiny", [1, 2, 3], 5), path.join(dir, "missing.img")];
  for (let round = 0; round < 3; round++) for (const f of cases) {
    assert.equal(validImageFile(f), oldValid(f), `valid ${path.basename(f)}`);
    assert.equal(mimeOfFile(f), oldMime(f), `type ${path.basename(f)}`);
  }
  assert.deepEqual(cases.map(mimeOfFile), ["image/jpeg", "image/png", "image/webp", "image/gif", "application/octet-stream", "image/jpeg", null, null]);
  assert.deepEqual(cases.map(validImageFile), [true, true, true, true, false, false, false, false]);
});

test("a file already looked at is not opened again", () => {
  const f = file("again.jpg", JPEG);
  assert.equal(opens(() => { validImageFile(f); }), 1);
  assert.equal(opens(() => { for (let i = 0; i < 20; i++) { validImageFile(f); mimeOfFile(f); } }), 0);
});

test("a file that changes is looked at again: replaced, repaired, removed", () => {
  const f = file("swap.img", [0x3c, 0x68, 0x74, 0x6d], 3000); // an error page saved as a picture
  assert.equal(validImageFile(f), false);
  fs.writeFileSync(f, Buffer.concat([Buffer.from(PNG), Buffer.alloc(5000, 1)])); // fetched again, properly
  assert.equal(validImageFile(f), true);
  assert.equal(mimeOfFile(f), "image/png");
  // same size, another picture: the date tells — at the first look after
  // the trust window (a good picture is not re-checked on every request)
  require("../src/lib/imgcheck")._internals.known.get(f).at -= require("../src/lib/imgcheck").TRUST_MS;
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(f, Buffer.concat([Buffer.from(JPEG), Buffer.alloc(5000, 2)]));
  fs.utimesSync(f, later, later);
  assert.equal(mimeOfFile(f), "image/jpeg");
  fs.rmSync(f);
  require("../src/lib/imgcheck").forget(f);
  assert.equal(validImageFile(f), false);
  assert.equal(mimeOfFile(f), null);
});

test("a good picture looked at within the trust window is not even stat'ed; a bad one always is", () => {
  const good = file("trusted.jpg", JPEG);
  const bad = file("broken.img", [0x3c, 0x68, 0x74, 0x6d]);
  validImageFile(good);
  validImageFile(bad);
  const real = fs.statSync;
  let n = 0;
  fs.statSync = function (...a) { n++; return real.apply(this, a); };
  try {
    for (let i = 0; i < 10; i++) { validImageFile(good); mimeOfFile(good); }
    assert.equal(n, 0);
    for (let i = 0; i < 3; i++) validImageFile(bad);
    assert.equal(n, 3, "a bad file is looked at every time: a repaired download is seen at once");
  } finally { fs.statSync = real; }
});
