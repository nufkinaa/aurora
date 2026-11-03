// Stall detection (media/dlhealth.js): "slow but alive" vs "stalled" vs
// "dead", on a fake clock. Pure — no engine, no files.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const H = require("../src/media/dlhealth");

const MIN = 60 * 1000;
const KIB = 1024;
const cfg = H.DEFAULTS;
const T0 = 1_000_000_000;

// An attempt as media/downloads.js keeps it.
const att = (over = {}) => ({ startedAt: T0, metaAt: 0, connectedAt: 0, lastProgressAt: 0, completed: 0, speed: 0, seeders: 0, connections: 0, avail: null, availLowSince: 0, ...over });

test("no torrent details: starting, then stalled at 3 min (no slot), dead at 10 min", () => {
  const a = att();
  assert.equal(H.assess(a, T0 + 1 * MIN, cfg).state, "starting");
  assert.equal(H.assess(a, T0 + 1 * MIN, cfg).holdsSlot, true, "a fresh download holds its slot");
  const st = H.assess(a, T0 + 3 * MIN, cfg);
  assert.equal(st.state, "stalled");
  assert.equal(st.code, "no-meta");
  assert.equal(st.holdsSlot, false, "a stalled download never holds a slot");
  const dead = H.assess(a, T0 + 10 * MIN, cfg);
  assert.equal(dead.state, "dead");
  assert.match(dead.why, /details/);
});

test("details in, nobody to connect to: stalled 3 min after the details, dead at 8", () => {
  const a = att({ metaAt: T0 + 5000 });
  assert.equal(H.assess(a, T0 + 2 * MIN, cfg).state, "starting");
  assert.equal(H.assess(a, T0 + 5000 + 3 * MIN, cfg).code, "no-peers");
  assert.equal(H.assess(a, T0 + 5000 + 3 * MIN, cfg).state, "stalled");
  assert.equal(H.assess(a, T0 + 5000 + 8 * MIN, cfg).state, "dead");
});

test("bytes arriving at a good rate: ok; under 48 KiB/s for 5 min after the grace: slow — alive", () => {
  const a = att({ metaAt: T0 + 1000, connectedAt: T0 + 2000, seeders: 3, connections: 5 });
  let t = T0;
  for (let i = 0; i < 20; i++) {
    t += 30 * 1000;
    a.completed += 30 * 400 * KIB;
    a.lastProgressAt = t;
    a.speed = 400 * KIB;
    assert.equal(H.assess(a, t, cfg).state, "ok", `minute ${i / 2}`);
  }
  // the swarm thins out: a trickle, still moving
  a.speed = 20 * KIB;
  const start = t;
  let v;
  for (; t < start + 6 * MIN; t += 30 * 1000) {
    a.completed += 30 * 20 * KIB;
    a.lastProgressAt = t;
    v = H.assess(a, t, cfg);
  }
  assert.equal(v.state, "slow", "a trickle for 5 minutes is slow, not stalled");
  assert.equal(H.holdsSlot("slow", { lineFree: true }), false, "slow with room on the line: not counted");
  assert.equal(H.holdsSlot("slow", { lineFree: false }), true, "slow because the line is full: still counted");
  // speed comes back
  a.speed = 300 * KIB;
  assert.equal(H.assess(a, t + 1000, cfg).state, "ok");
});

test("connected but nothing arrives: stalled at 4 min; no seeder → dead at 12; a zombie seeder gets 20", () => {
  const base = { metaAt: T0, connectedAt: T0 + 1000, lastProgressAt: T0 + 60 * 1000, completed: 50e6, speed: 0 };
  const noSeeder = att({ ...base, connections: 4, seeders: 0 });
  assert.equal(H.assess(noSeeder, T0 + 60 * 1000 + 3 * MIN, cfg).state, "ok");
  assert.equal(H.assess(noSeeder, T0 + 60 * 1000 + 4 * MIN, cfg).state, "stalled");
  assert.equal(H.assess(noSeeder, T0 + 60 * 1000 + 12 * MIN, cfg).state, "dead");
  assert.equal(H.assess(noSeeder, T0 + 60 * 1000 + 12 * MIN, cfg).code, "no-bytes");
  const zombie = att({ ...base, connections: 4, seeders: 2 });
  assert.equal(H.assess(zombie, T0 + 60 * 1000 + 12 * MIN, cfg).state, "stalled", "a connected seeder may come back to life");
  const z = H.assess(zombie, T0 + 60 * 1000 + 20 * MIN, cfg);
  assert.equal(z.state, "dead");
  assert.equal(z.code, "zombie");
});

test("hysteresis: one stray piece does not bring a stalled download back; real bytes do", () => {
  const a = att({ metaAt: T0, connectedAt: T0, lastProgressAt: T0, completed: 10e6, connections: 3 });
  const t1 = T0 + 5 * MIN;
  assert.equal(H.assess(a, t1, cfg).state, "stalled");
  // 64 KiB arrives (one piece from a peer passing by)
  a.completed += 64 * KIB;
  a.lastProgressAt = t1 + 1000;
  a.speed = 2 * KIB;
  assert.equal(H.assess(a, t1 + 2000, cfg).state, "stalled", "still down: not enough has arrived");
  // a real recovery: megabytes
  a.completed += 3 * 1024 * KIB;
  a.lastProgressAt = t1 + 30 * 1000;
  a.speed = 200 * KIB;
  assert.equal(H.assess(a, t1 + 30 * 1000, cfg).state, "ok");
});

test("the people connected don't have the missing pieces: dead after 6 min instead of 12", () => {
  const a = att({ metaAt: T0, connectedAt: T0, lastProgressAt: T0, completed: 400e6, connections: 6, seeders: 0, avail: 0.6, availLowSince: T0 + 4 * MIN });
  assert.equal(H.assess(a, T0 + 5 * MIN, cfg).state, "stalled");
  const v = H.assess(a, T0 + 10 * MIN, cfg);
  assert.equal(v.state, "dead");
  assert.equal(v.code, "unavailable");
  // with a seeder connected the bitfields do not matter
  const b = att({ ...a, seeders: 1, hs: undefined });
  assert.equal(H.assess(b, T0 + 10 * MIN, cfg).state, "stalled");
});

test("availability: worked out from the peers' bitfields over the wanted file's pieces only", () => {
  // three files of 4 pieces each (piece = 100 bytes); we want file 2 (pieces 4–7)
  const files = [{ index: 1, length: 400 }, { index: 2, length: 400 }, { index: 3, length: 400 }];
  // we have pieces 4 and 5 (bits 0-based from the left of each hex digit)
  const ours = "0c0"; // 0000 1100 0000
  assert.equal(H.availability({ files, fileIndex: 2, pieceLength: 100, numPieces: 12, bitfield: ours, peers: [] }), 0, "nobody connected: none of what is missing");
  // a peer has piece 6 but not 7
  assert.equal(H.availability({ files, fileIndex: 2, pieceLength: 100, numPieces: 12, bitfield: ours, peers: [{ bitfield: "020" }] }), 0.5);
  // another has 7
  assert.equal(H.availability({ files, fileIndex: 2, pieceLength: 100, numPieces: 12, bitfield: ours, peers: [{ bitfield: "020" }, { bitfield: "010" }] }), 1);
  // a seeder: everything
  assert.equal(H.availability({ files, fileIndex: 2, pieceLength: 100, numPieces: 12, bitfield: ours, peers: [{ seeder: "true", bitfield: "000" }] }), 1);
  // pieces of the OTHER files are not asked about
  assert.equal(H.availability({ files, fileIndex: 2, pieceLength: 100, numPieces: 12, bitfield: "0f0", peers: [] }), 1, "we have all of file 2");
  assert.equal(H.availability({ files, fileIndex: 9, pieceLength: 100, numPieces: 12, bitfield: ours, peers: [] }), null, "an unknown file: no answer");
});

test("config overrides one number, ignores nonsense", () => {
  const c = H.resolveConfig({ metaDeadMs: 60000, slowBps: -5, bogus: 1 });
  assert.equal(c.metaDeadMs, 60000);
  assert.equal(c.slowBps, H.DEFAULTS.slowBps);
  assert.equal(c.bogus, undefined);
});
