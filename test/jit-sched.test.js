// S7 — more than one reader in a film. A rendition (a jit job) keeps a short
// list of producers instead of one that every request re-aims: this file
// pins who gets a producer, whose is taken, and who waits.
//  • the decision itself (plan) is pure — fixture jobs with fake producers;
//  • how a job tells two players from one that is seeking (noteReader);
//  • the bounds: producers per rendition, and encoders — a second encoder
//    of one rendition against the server-wide cap;
//  • the real thing, when ffmpeg is on the machine: two requests far apart
//    in one film, made at the same moment, are both served by two producers
//    (this used to be six ffmpeg starts and a refusal inside 50ms), and what
//    they publish is what one producer from the top publishes.
//      node --test test/jit-sched.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const J = jit._internals;
const { plan, noteReader, usage, reapable, contended, CLAIM_MS, READER_TTL_MS, STEAL_LEAD, MAX_PRODUCERS_PER_JOB, MAX_EXTRA_PRODUCERS, COVER_AHEAD } = J;

// A job with fake producers: { fromSeg, nextSeg } is all the scheduler reads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitsched-"));
const table = Array.from({ length: 900 }, (_, i) => ({ start: i * 6, dur: 6 }));
let made = 0;
const made_dirs = [];
const mkJob = ({ enc = false, title = `T${made}` } = {}) => {
  const d = path.join(tmp, `job${made++}`);
  made_dirs.push(d);
  return jit.jobFor(d, { key: title, table }, { enc });
};
const producer = (job, fromSeg, nextSeg = fromSeg) => {
  const run = { fromSeg, nextSeg, proc: { kill() { run.killed = true; } } };
  job.producers.push(run);
  return run;
};
const forget = () => {
  for (const d of made_dirs.splice(0)) { const j = J.jobs.get(d); if (j) j.producers.length = 0; J.dropJob(d); }
};
test.after(() => { forget(); fs.rmSync(tmp, { recursive: true, force: true }); });

const T0 = 1_000_000;

test("plan: a job with no producer starts one", () => {
  const job = mkJob();
  assert.deepEqual(plan(job, T0, { room: false }), { spawn: true });
});

test("plan: a producer somebody is waiting on is never taken — the bug this replaces", () => {
  const job = mkJob();
  const a = producer(job, 0);
  noteReader(job, 0, T0);
  job.wanted.push(0); // the request for segment 0 is still waiting
  noteReader(job, 400, T0);
  // room for a second producer: it gets its own
  assert.deepEqual(plan(job, T0, { room: true }), { spawn: true });
  // no room: it waits — it does not re-aim the one being waited on
  assert.deepEqual(plan(job, T0, { room: false }), { wait: true });
  // "waited on" is about the segments a producer is about to make
  job.wanted = [COVER_AHEAD - 1];
  assert.deepEqual(plan(job, T0, { room: false }), { wait: true });
  job.wanted = [COVER_AHEAD]; // not this producer's to make soon: that waiter does not protect it
  assert.deepEqual(plan(job, T0, { room: false }), { steal: a });
});

test("plan: one viewer seeking re-aims the producer, as it always did", () => {
  const job = mkJob();
  const a = producer(job, 0, 4);
  for (const k of [0, 1, 2, 3]) noteReader(job, k, T0 + k);
  noteReader(job, 500, T0 + 10); // the seek
  assert.equal(contended(job, T0 + 10), false);
  // even with room for a second producer: one viewer, one producer
  assert.deepEqual(plan(job, T0 + 10, { room: true }), { steal: a });
  assert.deepEqual(plan(job, T0 + 10, { room: false }), { steal: a });
});

test("plan: two live readers — a second producer when there is room, a turn when there is not", () => {
  const job = mkJob();
  const a = producer(job, 0, 3);
  const b = producer(job, 400, 403);
  // A, B, A, B: two players
  let t = T0;
  for (const k of [0, 400, 1, 401, 2, 402]) noteReader(job, k, (t += 1000));
  assert.equal(contended(job, t), true);
  // a third reader somewhere else
  noteReader(job, 800, (t += 1000));
  assert.deepEqual(plan(job, t, { room: true }), { spawn: true });
  // no room, and both producers are just ahead of their readers: wait
  assert.deepEqual(plan(job, t, { room: false }), { wait: true });
  // one of them gets far enough ahead of its reader that taking it costs
  // that reader nothing soon
  b.nextSeg = 402 + STEAL_LEAD + 1;
  assert.equal(usage(job, b, t).lead, STEAL_LEAD);
  assert.deepEqual(plan(job, t, { room: false }), { steal: b });
  b.nextSeg = 402 + STEAL_LEAD;
  assert.deepEqual(plan(job, t, { room: false }), { wait: true });
  // …or its reader goes quiet (left, or paused): it is taken even though a
  // new one could be started
  t += CLAIM_MS;
  noteReader(job, 3, t); // A is still playing
  noteReader(job, 801, t);
  assert.deepEqual(plan(job, t, { room: true }), { steal: b });
  assert.deepEqual(plan(job, t, { room: false }), { steal: b });
  assert.equal(a.killed, undefined, "plan decides, it stops nothing");
});

test("plan: a look-ahead takes only what costs nobody", () => {
  const job = mkJob();
  const a = producer(job, 0, 4);
  for (const k of [0, 1, 2, 3]) noteReader(job, k, T0);
  // a viewer's request would re-aim it; a look-ahead does not
  assert.deepEqual(plan(job, T0, { room: false }), { steal: a });
  assert.deepEqual(plan(job, T0, { room: false, polite: true }), { wait: true });
  assert.deepEqual(plan(job, T0, { room: true, polite: true }), { spawn: true });
  // a producer nobody reads is fair game for it too
  assert.deepEqual(plan(job, T0 + CLAIM_MS, { room: false, polite: true }), { steal: a });
});

test("readers: requests moving along the film are one reader; a seek is another", () => {
  const job = mkJob();
  let t = T0;
  for (const k of [10, 11, 12, 12, 13, 15]) noteReader(job, k, (t += 500)); // a repeat and a skipped segment included
  assert.deepEqual(job.readers.map((r) => r.seg), [15]);
  noteReader(job, 300, (t += 500));
  assert.deepEqual(job.readers.map((r) => r.seg), [15, 300]);
  assert.equal(contended(job, t), false, "a seek is not a second viewer");
  // …nor is a seek back to where it was, once
  noteReader(job, 16, (t += 500));
  assert.equal(contended(job, t), false);
  for (const k of [17, 18, 19]) noteReader(job, k, (t += 500));
  assert.equal(contended(job, t), false);
  // a reader not heard from is forgotten
  noteReader(job, 20, t + READER_TTL_MS);
  assert.deepEqual(job.readers.map((r) => r.seg), [20]);
});

test("readers: going back and forth between two places is two players — for a while", () => {
  const job = mkJob();
  let t = T0;
  noteReader(job, 0, (t += 1000)); // A
  noteReader(job, 400, (t += 1000)); // B (or A seeking)
  noteReader(job, 1, (t += 1000)); // A again
  assert.equal(contended(job, t), false);
  noteReader(job, 401, (t += 1000)); // B again
  assert.equal(contended(job, t), true);
  assert.equal(contended(job, t + J.CLAIM_MS), true);
  assert.equal(contended(job, t + 60000), false, "it is forgotten when it stops happening");
  // returning to a place left long ago is not it
  const slow = mkJob();
  noteReader(slow, 0, T0);
  noteReader(slow, 400, T0 + 1000);
  noteReader(slow, 1, T0 + 1000 + CLAIM_MS);
  noteReader(slow, 401, T0 + 2000 + 2 * CLAIM_MS);
  assert.equal(contended(slow, T0 + 2000 + 2 * CLAIM_MS), false);
});

test("usage: a producer's reader is the one in its range, and its lead is counted from that reader", () => {
  const job = mkJob();
  const a = producer(job, 100, 120);
  assert.deepEqual(usage(job, a, T0), { at: 0, lead: 19 }, "nobody: counted from where it started");
  noteReader(job, 110, T0);
  assert.deepEqual(usage(job, a, T0 + 5), { at: T0, lead: 9 });
  noteReader(job, 600, T0 + 1); // somebody else, elsewhere
  assert.deepEqual(usage(job, a, T0 + 5), { at: T0, lead: 9 });
  // a reader a few segments BEHIND a producer's start is its reader (a
  // producer resumed ahead of a viewer), one further back is not
  const b = producer(job, 300, 300);
  noteReader(job, 296, T0 + 2);
  assert.equal(usage(job, b, T0 + 5).at, T0 + 2);
  const c = producer(job, 700, 700);
  noteReader(job, 680, T0 + 3);
  assert.equal(usage(job, c, T0 + 5).at, 0);
});

test("reaping: a second producer nobody reads any more is stopped; a job's only producer never is", () => {
  const job = mkJob();
  const a = producer(job, 0, 50);
  noteReader(job, 10, T0);
  assert.deepEqual(reapable(job, T0 + 10 * READER_TTL_MS), [], "one producer: a paused viewer keeps it");
  const b = producer(job, 400, 450);
  noteReader(job, 410, T0);
  assert.deepEqual(reapable(job, T0 + 1000), []);
  // B's viewer leaves, A's plays on
  noteReader(job, 11, T0 + READER_TTL_MS);
  assert.deepEqual(reapable(job, T0 + READER_TTL_MS), [b]);
  // …but not while a request is waiting on it
  job.wanted.push(451);
  assert.deepEqual(reapable(job, T0 + READER_TTL_MS), []);
  job.wanted.length = 0;
  // everybody gone: one stays (the job's idle timeout is what ends it)
  assert.equal(reapable(job, T0 + 5 * READER_TTL_MS).length, 1);
  assert.ok(a && b);
});

test("bounds: producers per rendition, extra copy producers across the server", () => {
  assert.equal(MAX_PRODUCERS_PER_JOB, 3);
  assert.equal(MAX_EXTRA_PRODUCERS, 4);
  forget();
  const before = J.extraCount();
  const one = mkJob();
  producer(one, 0);
  assert.equal(J.extraCount(), before, "a job's first producer is not an extra");
  producer(one, 300);
  producer(one, 600);
  const two = mkJob();
  producer(two, 0);
  producer(two, 300);
  assert.equal(J.extraCount(), before + 3);
  assert.equal(jit.liveCount() >= 5, true);
  // encoders are counted by the encoder cap, not here
  const enc = mkJob({ enc: true });
  producer(enc, 0);
  producer(enc, 300);
  assert.equal(J.extraCount(), before + 3);
  forget();
});

test("encoder cap: a second encoder of one rendition never takes the last slot unless the rendition is essential", () => {
  forget();
  let outside = 0;
  J.setOutsideEncodes(() => outside);
  try {
    assert.equal(J.MAX_ENCODES, 2);
    const job = mkJob({ enc: true, title: "film" });
    assert.equal(J.admitEncode(job, false), true, "its first encoder");
    const first = producer(job, 0, 3);
    assert.equal(jit.encodeCount(), 1);
    // a courtesy rung (720p under a copy): its viewers share the one encoder
    assert.equal(J.admitEncode(job, false), false);
    assert.equal(jit.refusedJustNow(job), true);
    // …re-aiming that one (one viewer seeking, or a turn) needs no new slot
    assert.equal(J.admitEncode(job, false, first), true);
    // the essential rendition (the only way its viewers can play the file)
    // gets a second encoder into a free slot
    assert.equal(J.admitEncode(job, true), true);
    producer(job, 400, 403);
    assert.equal(jit.encodeCount(), 2);
    // never a third
    assert.equal(J.admitEncode(job, true), false);
    assert.equal(J.admitEncode(job, true, first), true, "but one of the two may be re-aimed");
    job.producers.length = 1;
    // an encode elsewhere holds the other slot: no second encoder here
    outside = 1;
    assert.equal(J.admitEncode(job, true), false);
    assert.equal(J.admitEncode(job, true, first), true);
    // both slots held by one rendition are both counted against other titles
    outside = 0;
    producer(job, 400, 403);
    const other = mkJob({ enc: true, title: "another film" });
    assert.equal(J.admitEncode(other, true), false);
    assert.equal(jit.encodeRoom("another film", true), false);
    // parking a rendition stops every encoder it has
    J.park("x", job, "test");
    assert.equal(job.producers.length, 0);
    assert.equal(jit.encodeCount(), 0);
    assert.equal(first.killed, true);
  } finally {
    forget();
    J.setOutsideEncodes(() => 0);
  }
});

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};
// 90s, a keyframe every 3s: 15 segments of 6s.
const makeFilm = (dir) => {
  const file = path.join(dir, "film.mkv");
  execFileSync(config.FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=90:size=160x90:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=90:sample_rate=48000",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "72", "-keyint_min", "72", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
    "-c:a", "ac3", "-b:a", "96k", file,
  ]);
  return file;
};
const videoSig = (dir, seg) =>
  execFileSync(config.FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size,flags", "-of", "csv=p=0", seg], { cwd: dir })
    .toString().split(/\r?\n/).filter(Boolean).join("|");

test("real ffmpeg: two viewers far apart in one film are both served, by two producers, with the same segments", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jit2v-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  const dirs = [];
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, jit.liveCount()); }, 5);
  try {
    const file = makeFilm(dir);
    const buf = fs.readFileSync(file);
    const key = `twoviewers-${Date.now()}`;
    const entry = await jit.tableFor(key, async (s, l) => buf.subarray(s, s + l), buf.length);
    assert.ok(entry && entry.table.length >= 12, "the film has a table");
    const N = entry.table.length;
    const input = { url: file, extra: [], fmt: null, vtagHvc1: false };
    const d = path.join(dir, "shared");
    dirs.push(d);
    const job = jit.jobFor(d, entry);
    const far = N - 5;
    // the two requests of the bug: the top and far along, at the same moment
    const t0 = Date.now();
    const [a, b] = await Promise.all([jit.ensureSegment(d, job, input, 0), jit.ensureSegment(d, job, input, far)]);
    assert.ok(a, `the viewer at the top is served (${job.broken || "no file"})`);
    assert.ok(b, `the viewer far along is served (${job.broken || "no file"})`);
    assert.equal(job.gen, 2, "one producer each — nothing was re-aimed");
    assert.ok(Date.now() - t0 < 20000);
    // both play on, a segment at a time each, in turn
    for (let i = 1; i <= 3; i++) {
      const [x, y] = await Promise.all([jit.ensureSegment(d, job, input, i), jit.ensureSegment(d, job, input, far + i)]);
      assert.ok(x && y, `step ${i}`);
    }
    assert.ok(job.gen <= 3, `no thrash: ${job.gen} producers were started`);
    assert.ok(peak <= 2, `never more than two producers at once (saw ${peak})`);
    // the whole film is there in the end, every segment published once…
    for (let k = 0; k < N; k++) assert.ok(await jit.ensureSegment(d, job, input, k), `segment ${k} (${job.broken || "ok"})`);
    assert.equal(fs.readdirSync(d).filter((f) => /^seg\d{5}\.ts$/.test(f)).length, N);
    assert.equal(job.broken, null);
    assert.equal(jit.declinedReason(key), null);
    // …and it is the film one producer from the top makes
    const solo = path.join(dir, "solo");
    dirs.push(solo);
    const sj = jit.jobFor(solo, entry);
    for (let k = 0; k < N; k++) assert.ok(await jit.ensureSegment(solo, sj, input, k));
    assert.equal(sj.gen, 1);
    for (let k = 0; k < N; k++) {
      const name = path.basename(jit.segPath(d, k, null));
      assert.equal(videoSig(d, name), videoSig(solo, name), `segment ${k} differs from the single producer's`);
    }
  } finally {
    clearInterval(watch);
    for (const x of dirs) J.dropJob(x);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    J.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
  }
});
