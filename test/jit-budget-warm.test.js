// The start made ready ahead of the press (jit.warmSegment), the encoders
// their viewers have left (abandoned), and the goodbye — against the
// machine's encode budget (encbudget.js) and "who is using the CPU for whom"
// (cpuwork.js):
//  • a warm-up is SPECULATIVE: it is in nobody's count, it never takes room a
//    viewer could want, it is stopped by the first viewer encode that starts
//    (whoever starts it) and it is the first thing shed when the machine
//    falls behind;
//  • an encoder whose viewer has gone is not counted against the next viewer
//    — by the ladder or by the single-rendition and torrent transcodes — and
//    is stopped when the room is wanted;
//  • a goodbye frees the budget.
// The rules on fixture jobs (no process); then the real thing with the
// budget pinned to two, when ffmpeg with libx264 is on the machine.
//      node --test test/jit-budget-warm.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const budget = require("../src/media/encbudget");
const cpuwork = require("../src/media/cpuwork");
const J = jit._internals;
const B = budget._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitbudget-"));
const table = Array.from({ length: 900 }, (_, i) => ({ start: i * 6, dur: 6 }));
let made = 0;
const dirs = [];
const mkJob = ({ enc = true, title = `B${made}` } = {}) => {
  const d = path.join(tmp, `job${made++}`);
  dirs.push(d);
  const job = jit.jobFor(d, { key: title, table }, { enc });
  job.dir = d;
  return job;
};
const producer = (job, fromSeg, nextSeg = fromSeg, extra = {}) => {
  const run = { fromSeg, nextSeg, proc: { kill() { run.killed = true; } }, ...extra };
  job.producers.push(run);
  return run;
};
const forget = () => {
  for (const d of dirs.splice(0)) { const j = J.jobs.get(d); if (j) j.producers.length = 0; J.dropJob(d); }
  J.warmStarts.length = 0;
};
// The admin's "Fixed: n" (Server → Encoding; settings.maxEncodes): every encode one slot.
const pinned = async (n, fn) => {
  const keep = { setting: B.deps.setting, started: B.state.started };
  B.deps.setting = () => n;
  B.state.started = true;
  B.state.overloadedUntil = 0;
  try { return await fn(); } finally {
    B.deps.setting = keep.setting;
    B.state.started = keep.started;
    B.state.overloadedUntil = 0;
  }
};
const fakeChild = (pid) => Object.assign(new EventEmitter(), { pid, kill() { this.killed = true; } });
test.after(() => { forget(); cpuwork._internals._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- cpuwork: speculative work, and viewers who have gone ----------
test("speculative work is in nobody's count, holds nothing back, and is stopped by the first viewer encode — and shed before any background job", () => {
  cpuwork._internals._reset();
  const shed = [];
  const warm = fakeChild(11);
  const entry = cpuwork.speculative.track(warm, { label: "warm A", cost: 1, onShed: (why) => shed.push(["warm A", why]) });
  assert.equal(cpuwork.speculative.count(), 1);
  assert.equal(cpuwork.viewer.count(), 0, "it is not a viewer");
  assert.equal(cpuwork.viewer.busy(), false);
  assert.equal(cpuwork.viewer.cost(), 0);
  assert.equal(cpuwork.viewer.load(), 0);
  assert.equal(cpuwork.viewer.quiet(), true, "background work is not held back for it");
  assert.equal(cpuwork.background.mayStart("encode"), true);
  assert.equal(cpuwork.status().speculative.length, 1, "the admin's page can see it");
  // the machine falls behind (encbudget → shedNewest): the warm-up goes, before a background job would
  const bgShed = [];
  return cpuwork.background.gate("encode", { label: "a play-ready copy", onShed: () => bgShed.push(1) }).then((place) => {
    place.attach(fakeChild(12));
    assert.equal(cpuwork.background.shedNewest("behind"), "warm A");
    assert.deepEqual(shed, [["warm A", "behind"]]);
    assert.deepEqual(bgShed, [], "the background job is still there");
    assert.equal(cpuwork.speculative.count(), 0);
    assert.ok(cpuwork.background.shedNewest("behind"), "…and is next");
    assert.equal(bgShed.length, 1);
    // a viewer's encoder starts: everything speculative stops at once
    const w2 = fakeChild(13);
    cpuwork.speculative.track(w2, { label: "warm B", onShed: (why) => shed.push(["warm B", why]) });
    const w3 = fakeChild(14);
    const mine = cpuwork.speculative.track(w3, { label: "warm C", onShed: () => shed.push(["warm C"]) });
    mine.release(); // its own viewer came: its owner takes it out, and registers it as viewer work
    const v = cpuwork.viewer.track(w3, { kind: "ladder", cost: 1 });
    assert.deepEqual(shed.slice(1), [["warm B", "a viewer's encoder started"]], "the other warm-up was stopped; the promoted one was not");
    assert.equal(cpuwork.speculative.count(), 0);
    assert.equal(cpuwork.viewer.count(), 1);
    // a process that ends takes its entry with it
    const w4 = fakeChild(15);
    cpuwork.speculative.track(w4, { label: "warm D" });
    w4.emit("exit", 0);
    assert.equal(cpuwork.speculative.count(), 0);
    v.release();
    entry.release();
    cpuwork._internals._reset();
  });
});

test("a viewer encoder whose viewer has gone is left out of what an admission counts, and is stopped when the room is wanted", () => {
  cpuwork._internals._reset();
  let gone = false;
  const stopped = [];
  cpuwork.viewer.track(fakeChild(21), { kind: "ladder", label: "left behind", cost: 1, idle: () => gone, reclaim: () => stopped.push("left behind") });
  cpuwork.viewer.track(fakeChild(22), { kind: "transcode", label: "being watched", cost: 1 });
  assert.equal(cpuwork.viewer.load(), 2);
  assert.equal(cpuwork.viewer.reclaim(), 0, "nobody has gone");
  gone = true;
  assert.equal(cpuwork.viewer.cost(), 2, "it is still running — the whole picture says so");
  assert.equal(cpuwork.viewer.load(), 1, "but it is nobody's: an admission does not count it");
  assert.equal(cpuwork.viewer.list().find((v) => v.label === "left behind").idle, true);
  assert.equal(cpuwork.viewer.reclaim(), 1);
  assert.deepEqual(stopped, ["left behind"]);
  cpuwork._internals._reset();
});

// ---------- the ladder's own census, budget pinned to two ----------
test("budget fixed at 2, on fixtures: a warm-up holds no slot, two viewers are admitted over it and it is parked; a third is refused; an abandoned encoder gives its slot up", () => pinned(2, () => {
  forget();
  J.setOutsideEncodes(() => 0);
  try {
    const now = Date.now();
    // a warm-up of some title's encoded rendition is running
    const warm = mkJob({ title: "warmed film" });
    const w = producer(warm, 0, 1, { warm: 2 });
    assert.equal(J.speculative(warm), true);
    let c = J.encodeCensus("film A", null, now);
    assert.equal(c.others, 0, "it is counted against nobody");
    assert.equal(c.left.length, 1);
    assert.equal(jit.encodeRoom("film A", false), true, "even a courtesy rung of another film has its room");
    // viewer A
    const a = mkJob({ title: "film A" });
    assert.equal(J.admitEncode(a, true), true);
    assert.equal(w.killed, true, "the warm-up was stopped for the viewer");
    producer(a, 0, 1);
    a.waiting = 1;
    // viewer B: the second of two
    const b = mkJob({ title: "film B" });
    assert.equal(jit.encodeRoom("film B", true), true);
    assert.equal(J.admitEncode(b, true), true);
    producer(b, 0, 1);
    b.waiting = 1;
    // no room for anything speculative, nor for a third viewer
    const w2 = mkJob({ title: "another warmed film" });
    assert.equal(jit.warmSegment(w2.dir, w2, { url: "x.mkv", extra: [], fmt: null, enc: { videoArgs: [], audioRate: "96k", cost: 1 } }, 0), "refused");
    assert.equal(w2.producers.length, 0);
    const third = mkJob({ title: "film C" });
    assert.equal(J.admitEncode(third, true), false);
    assert.equal(jit.refusedJustNow(third), true, "the route answers 503 + Retry-After");
    // viewer A goes away without a word: 20 s later the encoder is nobody's
    a.waiting = 0;
    a.lastAccess = now - J.ABANDONED_MS - 1000;
    c = J.encodeCensus("film C", null, now);
    assert.equal(c.others, 1, "only B's");
    assert.equal(J.admitEncode(third, true), true);
    assert.equal(a.producers.length, 0, "A's encoder was parked for the viewer who is here");
    // …and a viewer who comes for what a warm-up is making turns it into their own
    const w3 = mkJob({ title: "film D" });
    const r3 = producer(w3, 0, 1, { warm: 2 });
    assert.equal(J.speculative(w3), true);
    J.promote(w3.dir, w3, r3);
    assert.equal(r3.warm, null);
    assert.equal(J.speculative(w3), false, "counted like any viewer's encoder from here");
    b.waiting = 0;
  } finally {
    forget();
    J.setOutsideEncodes(() => 0);
  }
}));

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};
// Ten minutes of 720p with grain (a 30 s master, repeated as a copy): long
// and heavy enough that an encoder is still running while the test looks.
const makeLongFilm = (dir) => {
  const master = path.join(dir, "master.mkv");
  const file = path.join(dir, "film.mkv");
  execFileSync(config.FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=30:size=1280x720:rate=24,noise=alls=10:allf=t,format=yuv420p",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=48000",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1500k", "-maxrate", "2000k", "-bufsize", "3000k", "-bf", "2", "-g", "72", "-keyint_min", "72", "-sc_threshold", "0",
    "-c:a", "ac3", "-b:a", "96k", master,
  ]);
  execFileSync(config.FFMPEG, ["-v", "error", "-stream_loop", "19", "-i", master, "-map", "0", "-c", "copy", file]);
  fs.rmSync(master, { force: true });
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

test("real ffmpeg, budget fixed at 2: two viewers and one warm-up — both viewers start, the warm-up is stopped for the first and refused beside them; a third viewer is told 'busy'; a goodbye frees the budget", { timeout: 180000 }, async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  forget();
  cpuwork._internals._reset();
  J.setOutsideEncodes(() => { try { return cpuwork.viewer.cost((v) => v.kind !== "ladder"); } catch { return 0; } });
  const ladder = require("../src/media/ladder");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitbudget-real-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  const mine = [];
  await pinned(2, async () => {
    try {
      const file = makeLongFilm(dir);
      const size = fs.statSync(file).size;
      const readRange = async (start, len) => {
        const fd = fs.openSync(file, "r");
        try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b; } finally { fs.closeSync(fd); }
      };
      const base = { url: file, extra: [], fmt: null, vtagHvc1: false, audio: 0 };
      // one file, four "titles" (keys): each its own jobs
      const title = async (name) => {
        const key = `${name}-${Date.now()}`;
        const entry = await jit.tableFor(key, readRange, size);
        assert.ok(entry && entry.table.length > 30, "a segment table");
        // the top rung of a device that cannot decode the file: its only way to play (essential)
        const top = await ladder.encInput(base, { key, name: "h264", fmt: null, audio: 0, jit });
        // a lighter rung under it (a courtesy to a slow line): what a title page warms on a thin line
        const low = await ladder.encInput(base, { key, name: "h264-480", fmt: null, audio: 0, jit });
        assert.ok(top && top.enc && top.enc.essential, "the full encode is essential");
        assert.ok(low && low.enc && !low.enc.essential, "the 480p rung is a courtesy");
        const job = (v) => { const d = path.join(dir, `${name}-${v}`); mine.push(d); const j = jit.jobFor(d, entry, { enc: true }); j.dir = d; return j; };
        return { key, entry, top, low, job };
      };
      const W = await title("warmed");
      const A = await title("filma");
      const Bt = await title("filmb");
      const C = await title("filmc");

      // 1. a title page warms the first seconds of its 480p rung: speculative work
      const wjob = W.job("480");
      assert.equal(jit.warmSegment(wjob.dir, wjob, W.low, 0), "started");
      const wrun = wjob.producers[0];
      assert.ok(wrun && wrun.proc && wrun.spec, "a warm-up encoder, registered as speculative");
      assert.equal(cpuwork.speculative.count(), 1);
      assert.equal(cpuwork.viewer.count(), 0, "not viewer work: no admission counts it");
      assert.equal(budget.admit({ cost: 1, running: cpuwork.viewer.load(), essential: true }).why, "alone", "the single-rendition transcodes see an empty machine");
      // a second warm-up beside it: no
      const w2 = Bt.job("480warm");
      assert.equal(jit.warmSegment(w2.dir, w2, Bt.low, 0), "refused");

      // 2. viewer A presses Play on a film this device cannot decode
      const ajob = A.job("top");
      jit.noteViewer(ajob, "s:alice");
      const pa = jit.ensureSegment(ajob.dir, ajob, A.top, 0);
      const arun = ajob.producers[0];
      assert.ok(arun && arun.proc && arun.viewer, "A's encoder started, as viewer work");
      assert.equal(wrun.stopped, true, "the warm-up was stopped for A");
      assert.equal(wjob.producers.length, 0);
      assert.equal(cpuwork.speculative.count(), 0);
      assert.equal(cpuwork.viewer.count(), 1);
      assert.notEqual(os.getPriority(arun.proc.pid), cpuwork.PRIORITY.viewer, "normal priority while A waits for the first segment");

      // 3. viewer B, another film: the second slot
      const bjob = Bt.job("top");
      jit.noteViewer(bjob, "s:bob");
      const pb = jit.ensureSegment(bjob.dir, bjob, Bt.top, 0);
      const brun = bjob.producers[0];
      assert.ok(brun && brun.proc && brun.viewer, "B's encoder started beside A's");
      assert.equal(cpuwork.viewer.count(), 2);
      assert.equal(arun.stopped, false, "A was not disturbed");

      // 4. beside two viewers: no warm-up, and no third viewer
      const w3 = C.job("480warm");
      assert.equal(jit.warmSegment(w3.dir, w3, C.low, 0), "refused");
      assert.equal(w3.producers.length, 0);
      assert.equal(jit.encodeRoom(C.key, true), false);
      const cjob = C.job("top");
      const pc = jit.ensureSegment(cjob.dir, cjob, C.top, 0);
      assert.equal(cjob.producers.length, 0, "no third encoder");
      assert.equal(await pc, null);
      assert.equal(jit.refusedJustNow(cjob), true, "the route says 503 + Retry-After");

      // both viewers get their first segment
      assert.ok(await pa, `A's first segment (${ajob.broken || "ok"})`);
      assert.ok(await pb, `B's first segment (${bjob.broken || "ok"})`);
      assert.equal(arun.yielding, true, "…and A's encoder stepped down to the viewers' priority once it was out");
      if (arun.proc) assert.equal(os.getPriority(arun.proc.pid), cpuwork.PRIORITY.viewer);

      // 5. A leaves (the goodbye beacon): the budget is free for C at once
      // (both are still being read — a playing reader asks every few seconds;
      // on a loaded machine the waits above can outlast the 20 s after which
      // an encoder nobody asked anything of counts as left behind)
      ajob.lastAccess = bjob.lastAccess = Date.now();
      if (ajob.producers.length && bjob.producers.length) {
        assert.equal(jit.release(A.key, "s:mallory"), 0, "not somebody else's goodbye");
        assert.equal(jit.encodeRoom(C.key, true), false);
        assert.ok(jit.release(A.key, "s:alice") >= 1);
        assert.equal(ajob.producers.length, 0);
      }
      else if (ajob.producers.length) jit.release(A.key, "s:alice");
      assert.equal(jit.encodeRoom(C.key, true), true, "room for a viewer again");
      assert.ok(await until(() => cpuwork.viewer.list().every((v) => v.pid !== (arun.viewer && arun.viewer.pid))), "A's encoder left the registry");
      const pc2 = jit.ensureSegment(cjob.dir, cjob, C.top, 0);
      assert.equal(cjob.producers.length, 1, "C's encoder starts now");
      assert.ok(await pc2, "and C plays");
    } finally {
      for (const d of mine) J.dropJob(d);
      await new Promise((r) => setTimeout(r, 400));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      J.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
      J.setOutsideEncodes(() => 0);
      forget();
      cpuwork._internals._reset();
    }
  });
});
