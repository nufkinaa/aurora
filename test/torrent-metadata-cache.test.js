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
