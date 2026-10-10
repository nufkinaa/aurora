// jit, before and after the viewer: a start that is made ahead of the click
// (warmSegment), a title's producers stopping when its viewer leaves
// (release), and an encoder nobody reads any more no longer holding a slot
// against the next title (the census's `left`).
//  • the bounds are pure — fixture jobs with fake producers;
//  • the real thing, when ffmpeg is on the machine: a warm-up makes the
//    first segments and stops by itself; a viewer arriving turns it into an
//    ordinary producer.
//      node --test test/jit-warm.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const J = jit._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitwarm-"));
const table = Array.from({ length: 900 }, (_, i) => ({ start: i * 6, dur: 6 }));
let made = 0;
const dirs = [];
const mkJob = ({ enc = false, title = `W${made}` } = {}) => {
  const d = path.join(tmp, `job${made++}`);
  dirs.push(d);
  const job = jit.jobFor(d, { key: title, table }, { enc });
  job.dir = d;
  return job;
};
const producer = (job, fromSeg, nextSeg = fromSeg) => {
  const run = { fromSeg, nextSeg, proc: { kill() { run.killed = true; } } };
  job.producers.push(run);
  return run;
};
const forget = () => {
  for (const d of dirs.splice(0)) { const j = J.jobs.get(d); if (j) j.producers.length = 0; J.dropJob(d); }
  J.warmStarts.length = 0;
};
test.after(() => { forget(); fs.rmSync(tmp, { recursive: true, force: true }); });

const fakeInput = { url: "nothing.mkv", extra: [], fmt: null };

// ---------- an encoder nobody reads no longer blocks the next title ----------
test("census: another title's encoder counts while someone reads it, and stops counting once nobody has asked for 20 s", () => {
  forget();
  J.setOutsideEncodes(() => 0);
  try {
    const ep1 = mkJob({ enc: true, title: "episode 1" });
    producer(ep1, 3, 9);
    const now = Date.now();
    // its viewer is there (the job was just asked for something)
    let c = J.encodeCensus("episode 2", null, now);
    assert.equal(c.others, 1);
    assert.equal(c.left.length, 0);
    assert.equal(jit.encodeRoom("episode 2", false), false, "a lighter rendition never takes the last slot");
    // …and 21 s later, with nobody waiting: left behind
    assert.equal(J.ABANDONED_MS, 20000);
    c = J.encodeCensus("episode 2", null, now + 21000);
    assert.equal(c.others, 0);
    assert.equal(c.left.length, 1);
    // a request still waiting on it is a viewer, however long ago it was made
    ep1.waiting = 1;
    assert.equal(J.encodeCensus("episode 2", null, now + 60000).others, 1);
    ep1.waiting = 0;
  } finally {
    forget();
  }
});

test("admission: the abandoned encoder is parked when the next title wants the slot, and only then", () => {
  forget();
  J.setOutsideEncodes(() => 0);
  try {
    const ep1 = mkJob({ enc: true, title: "episode 1" });
    const run = producer(ep1, 3, 9);
    const ep2 = mkJob({ enc: true, title: "episode 2" });
    // still being read: the lighter rendition of episode 2 is refused
    assert.equal(J.admitEncode(ep2, false), false);
    assert.equal(run.killed, undefined, "a refusal parks nothing");
    // nobody has asked episode 1 for anything in 21 s
    ep1.lastAccess = Date.now() - 21000;
    assert.equal(jit.encodeRoom("episode 2", false), true, "the master may offer the lighter renditions again");
    assert.equal(run.killed, undefined, "asking parks nothing");
    assert.equal(J.admitEncode(ep2, false), true);
    assert.equal(run.killed, true, "episode 1's encoder was parked for it");
    assert.equal(ep1.producers.length, 0);
    assert.equal(jit.encodeCount(), 0);
  } finally {
    forget();
  }
});

test("admission: encodes outside jit are never 'abandoned' — they still count", () => {
  forget();
  J.setOutsideEncodes(() => 1);
  try {
    const ep2 = mkJob({ enc: true, title: "episode 2" });
    assert.equal(J.admitEncode(ep2, false), false);
    assert.equal(J.admitEncode(ep2, true), true, "the essential rendition takes the last slot, as before");
  } finally {
    forget();
    J.setOutsideEncodes(() => 0);
  }
});

// ---------- the viewer left ----------
test("release: every producer of that title nobody is waiting on stops; other titles and waited-on producers do not", () => {
  forget();
  const copy = mkJob({ title: "film A" });
  const enc = mkJob({ enc: true, title: "film A" });
  const busy = mkJob({ enc: true, title: "film A" });
  const other = mkJob({ enc: true, title: "film B" });
  const a = producer(copy, 0, 40);
  const b = producer(enc, 10, 14);
  const c = producer(busy, 20, 20);
  const d = producer(other, 0, 2);
  busy.waiting = 1; // a request is waiting on this one right now
  assert.equal(jit.release("film A"), 2);
  assert.equal(a.killed, true);
  assert.equal(b.killed, true);
  assert.equal(c.killed, undefined, "somebody is waiting on it");
  assert.equal(d.killed, undefined, "another title");
  assert.equal(jit.release("film A"), 0, "nothing left to stop");
  assert.equal(jit.release("no such title"), 0);
  busy.waiting = 0;
  forget();
});

// ---------- a client that hung up ----------
test("a request whose client hung up stops waiting — and stops holding its producer", async () => {
  forget();
  J.setOutsideEncodes(() => 0);
  try {
    const job = mkJob({ enc: true, title: "film" });
    const run = producer(job, 0, 0); // an encoder about to make segment 0 (it never will: it is a fixture)
    const input = { ...fakeInput, enc: { videoArgs: [], audioRate: "96k" } };
    let hungUp = false;
    const waiting = jit.ensureSegment(job.dir, job, input, 0, { gone: () => hungUp });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(job.waiting, 1);
    assert.deepEqual(job.wanted, [0]);
    // while it waits, the producer is somebody's: the title cannot be released, the next title is refused
    assert.equal(jit.release("film"), 0);
    assert.equal(jit.encodeRoom("the next episode", false), false);
    // the player seeks away / changes level / closes: the connection drops
    hungUp = true;
    const t0 = Date.now();
    assert.equal(await waiting, null);
    assert.ok(Date.now() - t0 < 1000, "the wait ended at once, not at the 90 s deadline");
    assert.equal(job.waiting, 0);
    assert.deepEqual(job.wanted, []);
    assert.equal(run.killed, undefined, "hanging up stops the wait, not the producer");
    // …and now the viewer's leaving frees the encoder
    assert.equal(jit.release("film"), 1);
    assert.equal(run.killed, true);
    assert.equal(jit.encodeRoom("the next episode", false), true);
  } finally {
    forget();
  }
});

test("a request with nobody hanging up waits as it always did", async () => {
  forget();
  const job = mkJob();
  producer(job, 0, 0);
  let settled = false;
  const p = jit.ensureSegment(job.dir, job, fakeInput, 0, { gone: () => false }).then((f) => { settled = true; return f; });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(settled, false);
  assert.equal(job.waiting, 1);
  // the segment appears (as a producer's publish would put it there)
  fs.writeFileSync(jit.segPath(job.dir, 0, null), "x");
  assert.equal(await p, jit.segPath(job.dir, 0, null));
  assert.equal(job.waiting, 0);
  forget();
});

// ---------- warm-up: the bounds ----------

test("warm-up never takes, re-aims or adds to a job's producers", () => {
  forget();
  const job = mkJob();
  const run = producer(job, 100, 104);
  // about to be made by the producer that is there
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 105), "coming");
  // far from it: a viewer's request would re-aim or add a producer — a hint does neither
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 0), "busy");
  assert.equal(run.killed, undefined);
  assert.equal(job.producers.length, 1);
  assert.equal(job.readers.length, 0, "a hint is nobody's reader");
  assert.equal(job.wanted.length, 0);
  forget();
});

test("warm-up answers 'ready' for a segment on disk and 'no' outside the film or for a broken job", () => {
  forget();
  const job = mkJob();
  fs.writeFileSync(jit.segPath(job.dir, 7, null), "x");
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 7), "ready");
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, -1), "no");
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, table.length), "no");
  job.broken = "the index lied";
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 3), "no");
  assert.equal(job.producers.length, 0);
  forget();
});

test("warm-up of an ENCODED rendition is refused while any encoder is running, here or elsewhere", () => {
  forget();
  let outside = 1;
  J.setOutsideEncodes(() => outside);
  try {
    const job = mkJob({ enc: true, title: "film" });
    const input = { ...fakeInput, enc: { videoArgs: [], audioRate: "96k" } };
    assert.equal(jit.warmSegment(job.dir, job, input, 0), "refused", "an encode outside jit");
    outside = 0;
    const watched = mkJob({ enc: true, title: "someone else's film" });
    producer(watched, 0, 3);
    assert.equal(jit.warmSegment(job.dir, job, input, 0), "refused", "another title's encoder");
    assert.equal(job.producers.length, 0);
    assert.equal(J.warmStarts.length, 0, "a refusal is not charged to the minute's budget");
  } finally {
    forget();
    J.setOutsideEncodes(() => 0);
  }
});

test("warm-up is rationed: no more than a handful of starts a minute across the server", () => {
  forget();
  const now = Date.now();
  for (let i = 0; i < J.WARM_MAX_PER_MIN; i++) J.warmStarts.push(now - 1000);
  const job = mkJob();
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 0, now), "throttled");
  assert.equal(job.producers.length, 0);
  // a minute on, the budget is back (nothing is started here: the job is made unable to)
  job.broken = "stop";
  assert.equal(jit.warmSegment(job.dir, job, fakeInput, 0, now + 61000), "no");
  forget();
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
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const segs = (d) => fs.readdirSync(d).filter((f) => /^seg\d{5}\.ts$/.test(f)).sort();

test("real ffmpeg: a warm-up makes the start and stops by itself; the viewer's request is then a file read", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitwarm-real-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  const d = path.join(dir, "warm");
  try {
    const file = makeFilm(dir);
    const buf = fs.readFileSync(file);
    const entry = await jit.tableFor(`warm-${Date.now()}`, async (s, l) => buf.subarray(s, s + l), buf.length);
    assert.ok(entry && entry.table.length >= 12, "the film has a table");
    const input = { url: file, extra: [], fmt: null, vtagHvc1: false };
    const job = jit.jobFor(d, entry);
    // a hint for a resume point, mid-film
    assert.equal(jit.warmSegment(d, job, input, 5), "started");
    assert.equal(job.producers.length, 1);
    assert.equal(jit.warmSegment(d, job, input, 5), "coming", "asked twice: still one producer");
    assert.equal(job.producers.length, 1);
    // it makes segment 5 and the two after it, then stops — it does not run on to the end of the film
    assert.ok(await until(() => job.producers.length === 0), "the warm-up producer stopped by itself");
    await new Promise((r) => setTimeout(r, 300)); // (what it had decided reaches the disk)
    const have = segs(d);
    assert.ok(have.includes("seg00005.ts"), `segment 5 was made (${have.join(",")})`);
    assert.ok(have.length >= 1 + J.WARM_AHEAD && have.length <= 2 + J.WARM_AHEAD, `a bounded number of segments, not the film: ${have.join(",")}`);
    assert.ok(!have.includes("seg00000.ts"), "nothing before the point asked for");
    assert.equal(job.broken, null);
    assert.equal(job.readers.length, 0, "the hint was nobody's reader");
    // the viewer arrives: the segment is there
    assert.equal(jit.warmSegment(d, job, input, 5), "ready");
    const t0 = Date.now();
    const got = await jit.ensureSegment(d, job, input, 5);
    assert.ok(got && fs.existsSync(got));
    assert.ok(Date.now() - t0 < 200, `served from disk (${Date.now() - t0} ms)`);
    assert.equal(job.gen, 1, "no second producer was needed for it");
  } finally {
    J.dropJob(d);
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
    forget();
  }
});

test("real ffmpeg: a viewer who arrives while the warm-up is running keeps its producer — it plays on past the warm-up's bound", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitwarm-real2-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  const d = path.join(dir, "warm");
  try {
    const file = makeFilm(dir);
    const buf = fs.readFileSync(file);
    const entry = await jit.tableFor(`warm2-${Date.now()}`, async (s, l) => buf.subarray(s, s + l), buf.length);
    const input = { url: file, extra: [], fmt: null, vtagHvc1: false };
    const job = jit.jobFor(d, entry);
    assert.equal(jit.warmSegment(d, job, input, 0), "started");
    // the click lands at once: the same producer serves it (nothing is restarted)
    assert.ok(await jit.ensureSegment(d, job, input, 0));
    assert.equal(job.gen, 1, "the warm-up's producer served the viewer");
    // …and, a viewer's now, it is not stopped at the warm-up's bound
    const beyond = J.WARM_AHEAD + 3;
    assert.ok(await jit.ensureSegment(d, job, input, 1));
    assert.ok(await until(() => fs.existsSync(jit.segPath(d, beyond, null))), `segment ${beyond} was made by the same producer`);
    assert.equal(job.gen, 1);
    assert.equal(job.broken, null);
  } finally {
    J.dropJob(d);
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
    forget();
  }
});
