// Many viewers at once (the load test's findings): segment tables are kept
// for the files being watched and read once per file however many ask; a run
// cut short is not taken for a lying index the first time; a job broken by
// something that is not the file's fault is made again; the offset copy
// (remux.js) pauses when it is far ahead of its reader.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const jit = require("../src/media/jit");
const J = jit._internals;

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitload-"));
  J.setDeclinedFile(path.join(tmp, "declined.json"));
});
after(() => {
  for (const d of [...J.jobs.keys()]) if (d.startsWith(tmp)) J.dropJob(d);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// an MKV index the parser accepts would need a real file; a fake parser
// result is enough: tableFor's own logic is what is tested
const fakeIndex = (n) => ({ durationSec: n * 6, cues: Array.from({ length: n }, (_, i) => ({ t: i * 6, offset: i * 1e6 })) });

test("one read of a file's index serves every viewer asking at once", async () => {
  const mk = require("../src/media/mkvindex");
  const real = mk.parseMkvIndex;
  let reads = 0;
  // tableFor calls parseMkvIndex through the module object it required
  const key = `load-${Date.now()}`;
  const readRange = async () => { reads++; await new Promise((r) => setTimeout(r, 30)); return Buffer.alloc(0); };
  // the real parser on an empty read answers null: count the reads of one build
  const all = await Promise.all(Array.from({ length: 20 }, () => jit.tableFor(key, readRange, 1000)));
  assert.ok(all.every((t) => t === null));
  const perBuild = reads;
  assert.ok(perBuild >= 1);
  reads = 0;
  await jit.tableFor(key, readRange, 1000);
  assert.equal(reads, perBuild, "a second build reads as much as one — twenty at once read no more than one");
  mk.parseMkvIndex = real;
});

test("the table cache keeps the most recently used, and a hit counts as use", () => {
  const T = J.tables;
  T.clear();
  for (let i = 0; i < J.MAX_TABLES; i++) T.set(`f${i}`, { key: `f${i}`, table: [] });
  // f0 is used: it moves to the back
  return jit.tableFor("f0", null, 0).then((hit) => {
    assert.ok(hit);
    assert.equal([...T.keys()].pop(), "f0");
    T.clear();
  });
});

test("a run that ends inside a segment: once is not a lie; twice at the same place is", () => {
  const table = [{ start: 0, dur: 6 }, { start: 6, dur: 6 }, { start: 12, dur: 6 }];
  const dir = path.join(tmp, "short");
  const key = `short-${Date.now()}`;
  const job = jit.jobFor(dir, { key, table });
  const run = () => {
    const r = { fromSeg: 1, nextSeg: 1, cursor: 0, gops: [{ start: 6, closed: true }], ended: true, stopped: false, proc: null, queue: Promise.resolve(), pdir: path.join(dir, "p9") };
    job.producers.push(r);
    return r;
  };
  J.advance(dir, job, run());
  assert.equal(job.broken, null, "not broken after the first short run");
  assert.equal(jit.declinedReason(key), null);
  assert.equal(job.producers.length, 0, "that run was stopped");
  J.advance(dir, job, run());
  assert.match(String(job.broken), /ends inside segment 1/);
  assert.match(String(jit.declinedReason(key)), /ends inside segment 1/);
  J.dropJob(dir);
});

test("a job broken by something that is not the file's is made again after a moment", () => {
  const table = [{ start: 0, dur: 6 }, { start: 6, dur: 6 }];
  const dir = path.join(tmp, "broken");
  const key = `broken-${Date.now()}`;
  const job = jit.jobFor(dir, { key, table });
  job.broken = "could not publish segment 3: EPERM";
  job.brokenAt = Date.now();
  assert.equal(jit.jobFor(dir, { key, table }), job, "not at once");
  job.brokenAt = Date.now() - 11000;
  const again = jit.jobFor(dir, { key, table });
  assert.notEqual(again, job);
  assert.equal(again.broken, null);
  J.dropJob(dir);
});

test("a declined encode leaves the copy's table and segments alone", async () => {
  const key = `dec-${Date.now()}`;
  J.tables.set(key, { key, table: [{ start: 0, dur: 6 }, { start: 6, dur: 6 }] });
  J.decline(`${key}|enc`, "the encoder missed a boundary");
  assert.ok(await jit.tableFor(key, null, 0), "the copy still has its table");
  assert.ok(jit.encodeDeclined(key));
  assert.equal(jit.declinedReason(key), null);
});

test("remux: an offset job far ahead of its reader is paused, and resumed as the reader nears the end", async () => {
  const remux = require("../src/media/remux");
  const pp = require("../src/lib/procpause");
  const calls = [];
  const realS = pp.suspend;
  const realR = pp.resume;
  pp.suspend = async (pid) => { calls.push(["suspend", pid]); return true; };
  pp.resume = async (pid) => { calls.push(["resume", pid]); return true; };
  try {
    const dir = path.join(tmp, "offset");
    fs.mkdirSync(dir, { recursive: true });
    const write = (n) => fs.writeFileSync(path.join(dir, "index.m3u8"), "#EXTM3U\n" + Array.from({ length: n }, (_, i) => `#EXTINF:6.0,\nseg${String(i).padStart(5, "0")}.ts\n`).join(""));
    const job = { proc: { pid: 4242 }, done: false, dir, readSeg: 3, paused: false };
    write(10);
    await remux.pace(job);
    assert.equal(job.paused, false, "10 made, reader at 3: runs on");
    write(3 + remux.AHEAD_MAX + 2);
    await remux.pace(job);
    assert.equal(job.paused, true);
    assert.deepEqual(calls, [["suspend", 4242]]);
    job.readSeg = 3 + remux.AHEAD_MAX + 2 - remux.AHEAD_MIN; // the reader has caught up
    await remux.pace(job);
    assert.equal(job.paused, false);
    assert.deepEqual(calls[1], ["resume", 4242]);
  } finally {
    pp.suspend = realS;
    pp.resume = realR;
  }
});
