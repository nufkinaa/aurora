// Reading a library file for a viewer, the way a spinning disk likes it.
//
// fs.createReadStream reads 64 KB at a time, and every stream reads for
// itself: five people watching five films from one hard disk are five
// readers asking for 64 KB each in turn, so the disk head spends its time
// moving between five places instead of reading (measured on the house
// server's 7,200 rpm disk, cold regions, 12 films read at once: 78–80 MB/s
// in all with 64 KB reads; docs/qa/server-round/STREAMING.md has the table).
//
// Here every read is bigger (READ_BYTES), and reads from ONE disk take
// turns: at most PER_DISK at once, the rest wait in order of arrival — each
// stream has at most one read outstanding, so the queue is round robin
// between the viewers, and a slow reader is never starved by a fast one.
// A disk is told apart by the file's device number (stat.dev: the volume on
// Windows, the device on Linux). An SSD loses nothing by the turns (its reads
// are short) and the cap only applies per disk.
//
//   createReadStream(file, { start, end, highWaterMark, limit, dev })
//
// is a drop-in for the fs one for what the stream route uses: a byte range,
// "error" on a failed open or read, destroy() closes the file.
"use strict";
const fs = require("fs");
const { Readable } = require("stream");

const READ_BYTES = 1024 * 1024;
const PER_DISK = 2;

// device -> { busy, queue }
const gates = new Map();
const gateFor = (dev) => {
  let g = gates.get(dev);
  if (!g) gates.set(dev, (g = { busy: 0, queue: [], reads: 0, waits: 0 }));
  return g;
};
const acquire = (g, limit) => new Promise((resolve) => {
  if (g.busy < limit) { g.busy++; return resolve(); }
  g.waits++;
  g.queue.push(resolve);
});
const releaseGate = (g) => {
  const next = g.queue.shift();
  if (next) next(); // the slot passes straight to the next reader in line
  else g.busy--;
};

class DiskReadStream extends Readable {
  constructor(file, { start = 0, end = Infinity, highWaterMark = READ_BYTES, limit = PER_DISK, dev = null, fd = null } = {}) {
    // the stream's own buffer holds one read: the socket's backpressure
    // reaches the disk after at most one chunk in hand
    super({ highWaterMark });
    this.file = file;
    this.pos = start;
    this.end = end; // inclusive, as in fs.createReadStream
    this.chunk = highWaterMark;
    this.limit = Math.max(1, limit | 0);
    this.dev = dev;
    this.fd = fd;
    this.bytesRead = 0;
  }

  _construct(cb) {
    if (this.fd != null) return cb();
    fs.open(this.file, "r", (err, fd) => {
      if (err) return cb(err);
      this.fd = fd;
      if (this.dev != null) return cb();
      fs.fstat(fd, (e, st) => {
        this.dev = e ? "?" : st.dev;
        cb();
      });
    });
  }

  _read() {
    const left = this.end - this.pos + 1;
    if (left <= 0) return this.push(null);
    const len = Math.min(this.chunk, left);
    const g = gateFor(this.dev);
    acquire(g, this.limit).then(() => {
      if (this.destroyed || this.fd == null) return releaseGate(g);
      g.reads++;
      const buf = Buffer.allocUnsafe(len);
      fs.read(this.fd, buf, 0, len, this.pos, (err, n) => {
        releaseGate(g);
        if (err) return this.destroy(err);
        if (!n) return this.push(null); // the file is shorter than it was
        this.pos += n;
        this.bytesRead += n;
        this.push(n < len ? buf.subarray(0, n) : buf);
      });
    });
  }

  _destroy(err, cb) {
    const fd = this.fd;
    this.fd = null;
    if (fd == null) return cb(err);
    fs.close(fd, () => cb(err));
  }
}

const createReadStream = (file, opts) => new DiskReadStream(file, opts);

// For the admin page / tests: per disk, reads in flight, waiting, and totals.
const stats = () => {
  const out = {};
  for (const [dev, g] of gates) out[String(dev)] = { busy: g.busy, waiting: g.queue.length, reads: g.reads, waits: g.waits };
  return out;
};

module.exports = { createReadStream, DiskReadStream, stats, READ_BYTES, PER_DISK };
