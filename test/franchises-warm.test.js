// The franchise list read ahead, off the event loop (media/franchises warm,
// perf-server 2026-11-10): the first Home after a start used to read the 165
// files synchronously. warm() must give exactly the catalogue the synchronous
// first read gives, and once it has run, catalogue() reads nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const franchises = require("../src/media/franchises");

const shape = (cat) => JSON.stringify({
  all: cat.all,
  byId: [...cat.byId.keys()],
  byTitle: [...cat.byTitle].map(([k, v]) => [k, v.map((f) => f.id)]),
  byTmdbCollection: [...cat.byTmdbCollection].map(([k, v]) => [k, v.id]),
});

test("readAllAsync reads the shipped list exactly as readAll does", async () => {
  const a = franchises.readAll();
  const b = await franchises.readAllAsync();
  assert.ok(a.length >= 100);
  assert.deepStrictEqual(b, a);
});

test("readAllAsync matches readAll on broken and odd files too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "franchise-warm-"));
  try {
    fs.writeFileSync(path.join(dir, "b-good.json"), JSON.stringify({ id: "b-good", name: "B" }));
    fs.writeFileSync(path.join(dir, "a-broken.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    fs.mkdirSync(path.join(dir, "c-dir.json")); // a folder with a .json name: unreadable as a file
    assert.deepStrictEqual(await franchises.readAllAsync(dir), franchises.readAll(dir));
    assert.deepStrictEqual(await franchises.readAllAsync(path.join(dir, "missing")), franchises.readAll(path.join(dir, "missing")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("warm() builds the same catalogue as the first synchronous read, and catalogue() then reads nothing", async () => {
  franchises._reset();
  const sync = shape(franchises.catalogue());
  franchises._reset();
  await franchises.warm();
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...a) => { reads++; return read(...a); };
  let warmed;
  try { warmed = shape(franchises.catalogue()); } finally { fs.readFileSync = read; }
  assert.strictEqual(reads, 0);
  assert.strictEqual(warmed, sync);
  franchises._reset();
});

test("a synchronous first read during warm() wins, and warm() leaves it alone", async () => {
  franchises._reset();
  const p = franchises.warm();
  const first = franchises.catalogue();
  await p;
  assert.strictEqual(franchises.catalogue(), first);
  assert.strictEqual(franchises.warm(), p); // asked once
  franchises._reset();
});
