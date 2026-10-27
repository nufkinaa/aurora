// A torrent played straight through (a TV or a browser playing the file, not
// an HLS job) is ONE long range request. Its torrent must count as watched for
// as long as that response is open — the idle sweeper evicts (and destroys the
// store of) a torrent untouched for 30 minutes, and used to hear of a viewer
// only when a request arrived: half an hour into a film the read died with
// "File is destroyed" and the picture froze.
//
// And a client that stops reading (a full buffer, a pause) is not a stalled
// swarm: the read is not recreated every 10 s while the client is not asking.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("stream");

const torrent = require("../src/media/torrent");

// A torrent file whose reads hand out `chunk`-sized pieces as fast as asked.
const fakeFile = (length, chunk = 64 * 1024) => {
  const reads = [];
  return {
    reads,
    name: "film.mkv", path: "film.mkv", offset: 0, length,
    createReadStream: ({ start, end }) => {
      let pos = start;
      const r = new Readable({
        highWaterMark: chunk,
        read() {
          if (pos > end) return this.push(null);
          const n = Math.min(chunk, end - pos + 1);
          pos += n;
          this.push(Buffer.alloc(n));
        },
      });
      reads.push({ start, stream: r });
      return r;
    },
  };
};

test("an open stream keeps its torrent touched, bytes moving or not — and a client that does not read is not 'a stalled read'", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
  const infoHash = "ab".repeat(20);
  const file = fakeFile(50 * 1024 * 1024);
  const tor = { infoHash, files: [file] }; // no .path: the swarm read path
  const out = torrent.recoveringStream(file, { start: 0, torrent: tor });
  // A consumer that takes a little and then stops reading (a full buffer)
  let got = 0;
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(c, _e, cb) { got += c.length; if (got < 512 * 1024) cb(); /* else: never calls back — stops reading */ },
  });
  out.pipe(sink);
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const before = file.reads.length;
  assert.equal(before, 1, "one read to begin with");

  // 40 minutes go by with the client holding its buffer full
  for (let s = 0; s < 40 * 60; s += 2.5) {
    t.mock.timers.tick(2500);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(file.reads.length, before, "the read was not recreated while the CLIENT was not reading");
  const last = torrent._internals.lastAccessOf(infoHash);
  assert.ok(Date.now() - last <= 2500, `the torrent was touched while its stream was open (last touch ${Date.now() - last} ms ago)`);
  out.destroy();
  sink.destroy();
});

test("a read that really stops delivering (the swarm, not the client) is still recreated after 10 s", { timeout: 30000 }, async () => {
  // (real time: the swarm's 10 s, waited for once)
  const reads = [];
  const file = {
    name: "film.mkv", path: "film.mkv", offset: 0, length: 10 * 1024 * 1024,
    createReadStream: ({ start }) => {
      const r = new Readable({ read() {} }); // never delivers
      reads.push(start);
      return r;
    },
  };
  const out = torrent.recoveringStream(file, { start: 0, torrent: { infoHash: "cd".repeat(20) } });
  out.resume();
  await new Promise((r) => setTimeout(r, 13500));
  assert.ok(reads.length >= 2, `a dead swarm read is recreated (reads: ${reads.length})`);
  out.destroy();
});
