// The torrent-metadata cache: raw .torrent buffers keyed by infoHash, so a
// re-add (replay, post-eviction seek, restart) never hunts the swarm for
// metadata again. These pin the mechanics: round-trip, no-clobber, and the
// LRU sweep that keeps the directory bounded.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const torrent = require("../src/media/torrent");
const { metadataCachePath, readCachedMetadata, saveMetadata, sweepMetadataCache } =
  torrent._internals;

const HASH = "f".repeat(40); // never a real torrent — safe to write and delete

test.afterEach(() => {
  try { fs.unlinkSync(metadataCachePath(HASH)); } catch {}
});

test("saveMetadata + readCachedMetadata round-trip the exact bytes", async () => {
  const buf = Buffer.from("d8:announce0:4:infod4:name6:sintele e");
  saveMetadata({ infoHash: HASH, torrentFile: buf });
  // saveMetadata writes async (fire-and-forget) — give it a beat
  await new Promise((r) => setTimeout(r, 150));
  const back = readCachedMetadata(HASH);
  assert.ok(back, "cache file exists");
  assert.ok(buf.equals(back), "bytes identical");
});

test("an existing cache file is never overwritten", async () => {
  fs.writeFileSync(metadataCachePath(HASH), Buffer.from("original"));
  saveMetadata({ infoHash: HASH, torrentFile: Buffer.from("newer data") });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(readCachedMetadata(HASH).toString(), "original");
});

test("a torrent with no torrentFile yet is skipped without throwing", () => {
  saveMetadata({ infoHash: HASH, torrentFile: null });
  saveMetadata(null);
  assert.equal(readCachedMetadata(HASH), null);
});

test("readCachedMetadata misses return null, not a throw", () => {
  assert.equal(readCachedMetadata("0".repeat(40)), null);
});

test("the sweep deletes oldest-first down to the cap and spares the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mdcache-"));
  try {
    for (let i = 0; i < 8; i++) {
      const f = path.join(dir, `${String(i).repeat(4)}.torrent`);
      fs.writeFileSync(f, "x");
      const t = new Date(Date.now() - (8 - i) * 60000); // i=0 oldest
      fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(dir, "not-a-torrent.txt"), "spared");
    sweepMetadataCache(dir, 5);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".torrent"));
    assert.equal(left.length, 5, "capped at max");
    assert.ok(!left.includes("0000.torrent"), "oldest gone");
    assert.ok(left.includes("7777.torrent"), "newest kept");
    assert.ok(fs.existsSync(path.join(dir, "not-a-torrent.txt")), "non-.torrent files untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- one transcode job per chosen audio track ----------
const { jobKey } = require("../src/media/torrent-transcode")._internals;
test("a chosen audio stream names its own transcode job; the default keeps the old name", () => {
  const h = "a".repeat(40);
  assert.equal(jobKey(h, 0, 0), `${h}-0-0`);
  assert.equal(jobKey(h, 0, 0, null, 0), `${h}-0-0`);
  assert.equal(jobKey(h, 0, 120, "fmp4", 2), `${h}-0-120-f4-a2`);
  assert.notEqual(jobKey(h, 0, 0, null, 1), jobKey(h, 0, 0, null, 0));
});

// The verified-bitfield sidecar is saved OFF the event loop (capacity-2026-10:
// its statSync + writeFileSync waited 6–13 s on a busy disk, freezing every
// request); what is saved still round-trips through loadStartupBitfield.
test("saveBitfield: asynchronous, one save at a time, and it round-trips", async () => {
  const { saveBitfield, loadStartupBitfield, bitfieldPath } = torrent._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-bf-"));
  fs.writeFileSync(path.join(dir, "film.mkv"), Buffer.alloc(4096, 1));
  const bits = new Uint8Array([0xff, 0x0f]);
  const t = { infoHash: HASH, ready: true, progress: 0.5, path: dir, files: [{ path: "film.mkv" }], bitfield: { buffer: bits.buffer } };
  const real = { stat: fs.statSync, write: fs.writeFileSync };
  let sync = 0;
  fs.statSync = (...a) => { sync++; return real.stat(...a); };
  fs.writeFileSync = (...a) => { sync++; return real.write(...a); };
  try {
    saveBitfield(t);
    saveBitfield(t); // (a second sweep while the first save is still on its way: skipped)
  } finally { fs.statSync = real.stat; fs.writeFileSync = real.write; }
  assert.equal(sync, 0, "no synchronous file call on the event loop");
  for (let i = 0; i < 50 && !fs.existsSync(bitfieldPath(HASH)); i++) await new Promise((r) => setTimeout(r, 20));
  const back = loadStartupBitfield(HASH);
  assert.ok(back, "the sidecar was written");
  assert.deepStrictEqual([...back], [...bits]);
  fs.rmSync(bitfieldPath(HASH), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
