// The drives feature's rules (src/lib/drives/rules.js): the reserve, where a
// new download goes, the speed score, and when the admin is told.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const r = require("../src/lib/drives/rules");

const GB = 1e9;
const TB = 1000 * GB;

test("the reserve: 10% of the drive or 50 GB, whichever is smaller", () => {
  assert.equal(r.reserveFor(200 * GB), 20 * GB);
  assert.equal(r.reserveFor(502 * GB), 50 * GB);
  assert.equal(r.reserveFor(4 * TB), 50 * GB);
  assert.equal(r.reserveFor(0), 0);
});

// nufurora.com on 2026-11-08: the 502 GB NVMe 79% used, the new 1 TB NFS volume empty
const nvme = (o = {}) => ({ root: "/opt/aurora/media/Movies", drive: "/", free: 105 * GB, total: 502 * GB, committed: 0, score: 92, accepts: true, answering: true, ...o });
const nfs = (o = {}) => ({ root: "/mnt/storagespace/Aurora/Movies", drive: "/mnt/storagespace", free: 990 * GB, total: 1000 * GB, committed: 0, score: 41, accepts: true, answering: true, ...o });

test("pick: the roomy new drive first — free space decides", () => {
  const p = r.pick([nvme(), nfs()], { kind: "movie", sizeBytes: 8 * GB });
  assert.equal(p.drive, "/mnt/storagespace");
  assert.equal(p.full, false);
});

test("pick: drives with about as much room are equals — the faster one wins", () => {
  const p = r.pick([nvme({ free: 800 * GB, total: 2 * TB }), nfs({ free: 900 * GB })], { kind: "movie", sizeBytes: 8 * GB });
  assert.equal(p.drive, "/", "800 GB is within 75% of 900 GB, and the NVMe is faster");
  const q = r.pick([nvme({ free: 800 * GB, total: 2 * TB, score: null }), nfs({ free: 900 * GB, score: null })], { kind: "movie", sizeBytes: 8 * GB });
  assert.equal(q.drive, "/mnt/storagespace", "no scores yet: the roomier one");
});

test("pick: the reserve is kept, and what is already on its way counts", () => {
  // the NFS volume has 60 GB left: 60 − 15 promised − 8 = 37 < 50 GB reserve
  const p = r.pick([nvme({ free: 120 * GB }), nfs({ free: 60 * GB, committed: 15 * GB })], { kind: "movie", sizeBytes: 8 * GB });
  assert.equal(p.drive, "/");
  // nothing has room: the roomiest, marked full (the disk gate then asks the admin)
  const f = r.pick([nvme({ free: 30 * GB }), nfs({ free: 40 * GB })], { kind: "movie", sizeBytes: 8 * GB });
  assert.equal(f.drive, "/mnt/storagespace");
  assert.equal(f.full, true);
});

test("pick: a show's new episode goes where the show already is, when there is room", () => {
  const shows = [nvme({ root: "/opt/aurora/media/Shows", hasShow: true }), nfs({ root: "/mnt/storagespace/Aurora/Shows" })];
  const p = r.pick(shows, { kind: "show", sizeBytes: 2 * GB });
  assert.equal(p.drive, "/");
  assert.match(p.why, /already/);
  // its drive is full: the episode goes elsewhere rather than not at all
  const full = r.pick([nvme({ root: "/opt/aurora/media/Shows", hasShow: true, free: 51 * GB }), nfs({ root: "/mnt/storagespace/Aurora/Shows" })], { kind: "show", sizeBytes: 2 * GB });
  assert.equal(full.drive, "/mnt/storagespace");
  // films never look for a show's home
  const film = r.pick([nvme({ hasShow: true }), nfs()], { kind: "movie", sizeBytes: 2 * GB });
  assert.equal(film.drive, "/mnt/storagespace");
});

test("pick: a drive that is not answering, or stopped for new downloads, gets nothing", () => {
  assert.equal(r.pick([nvme(), nfs({ answering: false })], { kind: "movie", sizeBytes: GB }).drive, "/");
  assert.equal(r.pick([nvme(), nfs({ accepts: false })], { kind: "movie", sizeBytes: GB }).drive, "/");
  const show = r.pick([nvme({ hasShow: false }), nfs({ hasShow: true, answering: false })], { kind: "show", sizeBytes: GB });
  assert.equal(show.drive, "/", "the show's drive is down: the episode still lands somewhere");
  // every drive stopped: the first folder, as before this feature
  assert.equal(r.pick([nvme({ accepts: false }), nfs({ accepts: false })], { kind: "movie" }).root, "/opt/aurora/media/Movies");
  assert.equal(r.pick([], { kind: "movie" }).root, null);
});

test("score: the maths", () => {
  assert.equal(r.score(null), null);
  assert.equal(r.score({}), null);
  // a fast NVMe: everything at or past the top of its scale
  const fast = r.score({ readMBps: 2500, writeMBps: 1800, iops: 50000, latencyMs: 0.05 });
  assert.deepEqual(fast, { value: 100, word: "Fast", streams: 200 });
  // the floor of every scale
  assert.deepEqual(r.score({ readMBps: 5, writeMBps: 5, iops: 50, latencyMs: 50 }), { value: 0, word: "Slow", streams: 0 });
  // a network volume over 2.5 Gbit/s: read 110 MB/s, write 90, 600 random reads/s, 2 ms
  const net = r.score({ readMBps: 110, writeMBps: 90, iops: 600, latencyMs: 2 });
  // 0.45·log(22)/log(200) + 0.25·log(18)/log(100) + 0.15·log(12)/log(400) + 0.15·log(25)/log(500)
  const expect = Math.round(100 * (0.45 * Math.log10(22) / Math.log10(200) + 0.25 * Math.log10(18) / Math.log10(100) + 0.15 * Math.log10(12) / Math.log10(400) + 0.15 * Math.log10(25) / Math.log10(500)));
  assert.equal(net.value, expect);
  assert.equal(net.word, "Good");
  assert.equal(net.streams, 8, "110 MB/s ÷ 12.5 MB/s per 4K stream");
  // a slow USB disk
  assert.equal(r.score({ readMBps: 25, writeMBps: 20, iops: 90, latencyMs: 12 }).word, "Slow");
});

test("alerts: one when a drive has been down a minute, one when it is back — no repeats", () => {
  const t0 = 1_800_000_000_000;
  let s = null;
  const step = (down, at) => { const out = r.alertStep(s, { down, now: at }); s = out.state; return out.send; };
  assert.equal(step(true, t0), null, "not at once");
  assert.equal(step(true, t0 + 30e3), null);
  const a = step(true, t0 + 61e3);
  assert.equal(a.type, "down");
  for (let i = 2; i < 40; i++) assert.equal(step(true, t0 + i * 60e3), null, "nothing more while it stays down");
  s.viewers.push("v1", "v2", "v3");
  const b = step(false, t0 + 12 * 60e3 + 30e3);
  assert.deepEqual(b, { type: "back", minutes: 13, viewers: 3 });
  assert.equal(step(false, t0 + 14 * 60e3), null);
});

test("alerts: a short outage says nothing; a flapping drive at most once per 30 minutes", () => {
  const t0 = 1_800_000_000_000;
  let s = null;
  const step = (down, at) => { const out = r.alertStep(s, { down, now: at }); s = out.state; return out.send; };
  assert.equal(step(true, t0), null);
  assert.equal(step(false, t0 + 40e3), null, "40 s down, never announced: no 'back' either");
  // down 2 min → told; back → told
  assert.equal(step(true, t0 + 60e3), null);
  assert.equal(step(true, t0 + 3 * 60e3).type, "down");
  assert.equal(step(false, t0 + 4 * 60e3).type, "back");
  // down again 5 minutes later, for 10 minutes: inside the 30-minute window — quiet
  assert.equal(step(true, t0 + 9 * 60e3), null);
  assert.equal(step(true, t0 + 15 * 60e3), null);
  assert.equal(step(false, t0 + 19 * 60e3), null, "it was never announced, so no 'back'");
  // down again and STILL down once the window has passed: said then
  assert.equal(step(true, t0 + 25 * 60e3), null);
  assert.equal(step(true, t0 + 32 * 60e3), null);
  assert.equal(step(true, t0 + 33 * 60e3 + 1).type, "down");
});

test("score of a NETWORK drive: what it serves at once, not how it compares with an NVMe", () => {
  // nufurora's NFS volume: 22 MB/s for one direct reader is latency-bound;
  // several buffered readers together are what viewers get
  const good = r.score({ parallelMBps: 60, bufferedMBps: 40, directMBps: 22, writeMBps: 45 }, { network: true });
  assert.equal(good.word, "Good", "several 4K streams at once is Good, however far from an NVMe");
  assert.equal(good.scale, "network");
  assert.equal(good.streams4k, 4); // 60 × 0.7 = 42 usable / 10
  assert.equal(good.streams1080, 28); // 42 / 1.5
  assert.equal(good.basis, "readers at once");
  assert.match(good.meaning, /^About 28 1080p streams and 4 4K streams at once — good enough to watch from\.$/);
  assert.equal(r.score({ parallelMBps: 150 }, { network: true }).word, "Fast");
  const hd = r.score({ parallelMBps: 22 }, { network: true });
  assert.equal(hd.word, "Fine for 1080p");
  assert.match(hd.meaning, /About 10 1080p streams and 1 4K stream at once — fine for 1080p, tight for 4K\./);
  const slow = r.score({ parallelMBps: 5 }, { network: true });
  assert.equal(slow.word, "Too slow");
  assert.match(slow.meaning, /^Too slow to watch from — about 2 1080p streams at once\.$/);
  // the number climbs with the word: Good near 65, Fast near 91
  assert.ok(slow.value < hd.value && hd.value < good.value && good.value < r.score({ parallelMBps: 150 }, { network: true }).value);
  // without the readers-at-once figure: one reader, then the write speed (a partial check)
  assert.equal(r.score({ bufferedMBps: 60 }, { network: true }).basis, "one reader");
  assert.match(r.score({ writeMBps: 60 }, { network: true }).basis, /write speed/);
  assert.equal(r.score({}, { network: true }), null);
  // a local drive's score is as it always was
  assert.deepEqual(r.score({ readMBps: 2300, writeMBps: 1500, iops: 21000, latencyMs: 0.08 }), r.score({ readMBps: 2300, writeMBps: 1500, iops: 21000, latencyMs: 0.08 }, { network: false }));
  assert.equal(r.score({ readMBps: 2300, writeMBps: 1500, iops: 21000, latencyMs: 0.08 }).word, "Fast");
});
