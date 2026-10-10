// What is known and made ready about a library file before it is played
// (src/lib/playprep.js): where an MP4's index sits, and the start warmed —
// one file at a time, each once in a while, never queued.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const playprep = require("../src/lib/playprep");
const P = playprep._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-playprep-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const box = (type, size) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write(type, 4, "latin1");
  return b;
};
const write = (name, ...boxes) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Buffer.concat(boxes));
  return f;
};

test("indexInfo: an MP4's index — its size, and whether it comes before the film", () => {
  P.reset();
  const front = write("front.mp4", box("ftyp", 32), box("moov", 5000), box("free", 8), box("mdat", 20000));
  const tail = write("tail.mp4", box("ftyp", 32), box("free", 8), box("mdat", 20000), box("moov", 7000));
  assert.deepEqual(playprep.indexInfo(front), { bytes: 5000, front: true });
  assert.deepEqual(playprep.indexInfo(tail), { bytes: 7000, front: false });
  assert.deepEqual(playprep.indexInfo(write("film.m4v", box("ftyp", 32), box("moov", 900), box("mdat", 100))), { bytes: 900, front: true });
});

test("indexInfo: nothing for a file that is not an MP4, is fragmented, has no index, or is not there", () => {
  P.reset();
  assert.equal(playprep.indexInfo(write("film.mkv", box("ftyp", 32), box("moov", 5000))), null, "not by its name");
  assert.equal(playprep.indexInfo(write("junk.mp4", Buffer.alloc(4096, 0x41))), null, "not by its bytes");
  assert.equal(playprep.indexInfo(write("frag.mp4", box("ftyp", 32), box("moov", 800), box("moof", 100), box("mdat", 500))), null, "fragmented");
  assert.equal(playprep.indexInfo(write("nomoov.mp4", box("ftyp", 32), box("mdat", 500))), null);
  assert.equal(playprep.indexInfo(write("empty.mp4", Buffer.alloc(0))), null);
  assert.equal(playprep.indexInfo(path.join(tmp, "missing.mp4")), null);
  // a box that claims less than a header is a broken file, not an endless loop
  const liar = Buffer.concat([box("ftyp", 32), Buffer.alloc(16)]);
  assert.equal(playprep.indexInfo(write("liar.mp4", liar)), null);
});

test("indexInfo: remembered per file — and read again when the file changes", () => {
  P.reset();
  const f = write("change.mp4", box("ftyp", 32), box("moov", 1000), box("mdat", 100));
  assert.deepEqual(playprep.indexInfo(f), { bytes: 1000, front: true });
  // replaced by another cut of the film (a new mtime)
  fs.writeFileSync(f, Buffer.concat([box("ftyp", 32), box("mdat", 100), box("moov", 2000)]));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(playprep.indexInfo(f), { bytes: 2000, front: false });
});

// ---------- warm ----------
const fakes = () => {
  const calls = { table: [], probe: [] };
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const mkv = write(`film-${Math.random().toString(36).slice(2)}.mkv`, Buffer.alloc(64));
  const mp4 = write(`film-${Math.random().toString(36).slice(2)}.mp4`, box("ftyp", 32), box("moov", 100));
  P.reset();
  P.setDeps({
    ffmpeg: () => true,
    resolve: (id) => (id === "mkv" || id === "mkv2" ? { kind: "video", path: mkv } : id === "mp4" ? { kind: "video", path: mp4 } : id === "pic" ? { kind: "image", path: mkv } : null),
    jit: () => ({ tableFor: async (key) => { calls.table.push(key); await gate; return calls.noTable ? null : { key, table: [] }; } }),
    ladder: () => ({ probe: async (key, file) => { calls.probe.push([key, file]); return {}; } }),
  });
  return { calls, release: () => release(), mkv };
};
const finished = (id) => new Promise((resolve) => { const r = playprep.warm(id, resolve); if (r !== "started") resolve(r); });

test("warm: a file jit can serve gets its index read and its video probed — once, not on every look", async () => {
  const f = fakes();
  f.release();
  assert.equal(await finished("mkv"), "done");
  assert.equal(f.calls.table.length, 1);
  assert.match(f.calls.table[0], /^mkv-\d+$/, "under the key the stream routes use: id-mtime");
  assert.deepEqual(f.calls.probe, [[f.calls.table[0], f.mkv]]);
  // the title page is opened again a moment later: nothing is done twice
  assert.equal(playprep.warm("mkv"), "skipped: fresh");
  assert.equal(f.calls.table.length, 1);
});

test("warm: one at a time — a second file while one is warming is skipped, never queued", async () => {
  const f = fakes();
  const first = new Promise((resolve) => playprep.warm("mkv", resolve));
  assert.equal(playprep.warm("mkv2"), "skipped: busy");
  f.release();
  assert.equal(await first, "done");
  assert.equal(f.calls.table.length, 1);
});

test("warm: no table (jit will not serve the file) — no probe either", async () => {
  const f = fakes();
  f.calls.noTable = true;
  f.release();
  assert.equal(await finished("mkv"), "done");
  assert.equal(f.calls.probe.length, 0);
});

test("warm: never for an MP4 (its index is megabytes), a picture, an unknown id, or a server without ffmpeg", async () => {
  const f = fakes();
  f.release();
  assert.equal(playprep.warm("mp4"), "skipped: mp4");
  assert.equal(playprep.warm("pic"), "skipped: not a video");
  assert.equal(playprep.warm("nothing"), "skipped: not a video");
  P.setDeps({ ffmpeg: () => false });
  assert.equal(playprep.warm("mkv"), "skipped: no ffmpeg");
  assert.equal(f.calls.table.length, 0);
});

test("warm: a failure inside is swallowed, and the next file can still be warmed", async () => {
  const f = fakes();
  P.setDeps({ jit: () => ({ tableFor: async () => { throw new Error("disk gone"); } }) });
  assert.equal(await finished("mkv"), "done");
  P.setDeps({ jit: () => ({ tableFor: async (key) => { f.calls.table.push(key); return { key }; } }) });
  // (another file: the first one is "fresh" for ten minutes whatever became of it)
  P.reset();
  assert.equal(await finished("mkv2"), "done");
  assert.equal(f.calls.table.length, 1);
});
