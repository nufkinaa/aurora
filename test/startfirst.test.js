// lib/startfirst.js: while a viewer waits for a first segment, CPU encoders
// with two segments made beyond their own viewers are held (SIGSTOP on
// Linux/macOS, the idle class on Windows) and let go the moment the segment is
// out, the viewer nears, somebody waits on them, 10 s pass, the process dies,
// it is killed, or the server exits — never left held. Plus the owners'
// estimates (jit aheadOf / noteReader, remux aheadOf / noteFetch) and the
// jit / remux wiring. No real process: deps are stubs.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { EventEmitter } = require("events");

const sf = require("../src/lib/startfirst");
const D = sf._internals.deps;
const real = { ...D };

let clock = 1_000_000;
let sent = []; // [pid, signal] / [pid, "prio", p]
let ticker = null;
const child = (pid) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
const die = (c) => { c.exitCode = 0; c.emit("exit", 0); };

beforeEach(() => {
  sf._internals._reset();
  clock = 1_000_000;
  sent = [];
  ticker = null;
  D.platform = () => "linux";
  D.kill = (pid, sig) => { sent.push([pid, sig]); };
  D.setPriority = (pid, p) => { sent.push([pid, "prio", p]); };
  D.now = () => clock;
  D.setInterval = (fn) => { ticker = fn; return { t: 1 }; };
  D.clearInterval = () => { ticker = null; };
  D.enabled = () => true;
  D.log = () => {};
});
afterEach(() => { sf._internals._reset(); Object.assign(D, real); });

const cand = (pid, ahead, extra = {}) => {
  const c = child(pid);
  const holder = { name: `h${pid}` };
  const state = { ahead, waited: false, paused: false };
  sf.track(holder, { child: c, label: `enc${pid}`, aheadSec: () => state.ahead, waited: () => state.waited, pausedElsewhere: () => state.paused, ...extra });
  return { c, holder, state };
};
const sigs = (pid) => sent.filter((s) => s[0] === pid).map((s) => s[1]);

test("nobody waiting: nothing is held, however far ahead", () => {
  const a = cand(11, 100);
  sf.check();
  assert.deepEqual(sent, []);
  assert.equal(sf.held(a.holder), false);
  assert.equal(ticker, null, "no timer while nothing waits or is held");
});

test("a first-segment wait holds the encoders two segments ahead (and only those); its end lets them go", () => {
  const far = cand(11, 40);
  const edge = cand(12, sf.HOLD_FROM_SEC);
  const near = cand(13, sf.HOLD_FROM_SEC - 0.5); // under the start margin
  const close = cand(14, 5); // its viewer right behind it: never
  const w = sf.wait("viewer B seg0");
  assert.deepEqual(sigs(11), ["SIGSTOP"]);
  assert.deepEqual(sigs(12), ["SIGSTOP"]);
  assert.deepEqual(sigs(13), []);
  assert.deepEqual(sigs(14), []);
  assert.ok(sf.held(far.holder) && far.holder.sfHeld === true);
  assert.ok(ticker, "the watchdog ticks while something is held");
  clock += 1500;
  w.end();
  assert.deepEqual(sigs(11), ["SIGSTOP", "SIGCONT"]);
  assert.deepEqual(sigs(12), ["SIGSTOP", "SIGCONT"]);
  assert.equal(sf.held(far.holder), false);
  assert.equal(far.holder.sfHeld, false);
  assert.equal(ticker, null, "timer gone once nothing is held or waited for");
  const st = sf.status();
  assert.equal(st.stats.holds, 2);
  assert.equal(st.stats.why["segment out"], 2);
  w.end(); // idempotent
  assert.equal(sf.status().stats.releases, 2);
  void near; void close;
});

test("its viewer nears (under two segments made beyond it): let go at the next look, while the wait goes on", () => {
  const a = cand(21, 20);
  const w = sf.wait("x");
  assert.deepEqual(sigs(21), ["SIGSTOP"]);
  a.state.ahead = sf.HOLD_AHEAD_SEC; // still two segments: stays
  clock += 250; ticker();
  assert.deepEqual(sigs(21), ["SIGSTOP"]);
  a.state.ahead = sf.HOLD_AHEAD_SEC - 0.01;
  clock += 250; ticker();
  assert.deepEqual(sigs(21), ["SIGSTOP", "SIGCONT"]);
  assert.equal(sf.status().stats.why["viewer near"], 1);
  // not held again while it stays near, though the wait goes on
  clock += 250; ticker();
  assert.deepEqual(sigs(21), ["SIGSTOP", "SIGCONT"]);
  w.end();
});

test("never longer than MAX_HOLD_MS; then not again for REHOLD_MS", () => {
  cand(31, 60);
  const w = sf.wait("slow start");
  for (let t = 0; t < sf.MAX_HOLD_MS; t += sf.TICK_MS) { clock += sf.TICK_MS; ticker(); if (sigs(31).length > 1) break; }
  assert.deepEqual(sigs(31), ["SIGSTOP", "SIGCONT"]);
  assert.equal(sf.status().stats.maxed, 1);
  assert.ok(sf.status().stats.longestHoldMs <= sf.MAX_HOLD_MS + sf.TICK_MS);
  clock += sf.REHOLD_MS - 1; ticker();
  assert.deepEqual(sigs(31), ["SIGSTOP", "SIGCONT"], "not held again at once");
  clock += 2; ticker();
  assert.deepEqual(sigs(31), ["SIGSTOP", "SIGCONT", "SIGSTOP"], "held again after the pause");
  w.end();
  assert.deepEqual(sigs(31), ["SIGSTOP", "SIGCONT", "SIGSTOP", "SIGCONT"]);
});

test("somebody waits on it: not held, and let go if it comes to that while held", () => {
  const a = cand(41, 30);
  a.state.waited = true;
  const w = sf.wait("x");
  assert.deepEqual(sigs(41), []);
  a.state.waited = false;
  clock += 250; ticker();
  assert.deepEqual(sigs(41), ["SIGSTOP"]);
  a.state.waited = true;
  clock += 250; ticker();
  assert.deepEqual(sigs(41), ["SIGSTOP", "SIGCONT"]);
  w.end();
});

test("a wait never ended stops counting after WAIT_TTL_MS (nothing stays held for a lost wait)", () => {
  cand(51, 30);
  sf.wait("lost"); // never ended
  assert.deepEqual(sigs(51), ["SIGSTOP"]);
  // the hold's own max lets it go at 10 s, re-held after 2 s… until the wait expires
  for (let t = 0; t < sf.WAIT_TTL_MS + 5000; t += sf.TICK_MS) { clock += sf.TICK_MS; if (ticker) ticker(); }
  assert.equal(sf.status().waiting, 0);
  assert.equal(sigs(51).at(-1), "SIGCONT");
  assert.equal(ticker, null);
});

test("crash paths: the process exits while held (no signal to a dead pid), killNow lets it go first, kill fails, server exit", () => {
  // exits while held
  const a = cand(61, 30);
  const w = sf.wait("x");
  assert.deepEqual(sigs(61), ["SIGSTOP"]);
  die(a.c);
  assert.deepEqual(sigs(61), ["SIGSTOP"], "no SIGCONT to a process that is gone");
  assert.equal(sf.status().encoders, 0);
  assert.equal(sf.status().stats.why.exited, 1);
  assert.equal(ticker !== null, true, "still ticking: the wait is open");
  w.end();
  assert.equal(ticker, null);

  // children.killNow: SIGCONT first, then the kill
  const children = require("../src/lib/children");
  const b = cand(62, 30);
  const realKill = b.c.kill;
  b.c.kill = (sig) => { sent.push([62, `kill:${sig}`]); return true; };
  const w2 = sf.wait("y");
  const realSet = os.setPriority;
  os.setPriority = () => {};
  try { children.killNow(b.c, "SIGTERM"); } finally { os.setPriority = realSet; }
  assert.deepEqual(sigs(62), ["SIGSTOP", "SIGCONT", "kill:SIGTERM"]);
  assert.equal(sf.held(b.holder), false);
  b.c.kill = realKill;
  w2.end();

  // the OS refuses the hold (ESRCH): not held, counted, not asked again at once
  const c = cand(63, 30);
  D.kill = (pid, sig) => { if (sig === "SIGSTOP") { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; } sent.push([pid, sig]); };
  const w3 = sf.wait("z");
  assert.equal(sf.held(c.holder), false);
  assert.ok(sf.status().stats.failed >= 1);
  w3.end();

  // server exit: everything held goes on (the process "exit" hook calls this)
  D.kill = (pid, sig) => { sent.push([pid, sig]); };
  const d1 = cand(64, 30);
  const d2 = cand(65, 30);
  sf.wait("shutdown");
  assert.ok(sf.held(d1.holder) && sf.held(d2.holder));
  assert.equal(sf.releaseAll("server exit"), 2);
  assert.deepEqual(sigs(64), ["SIGSTOP", "SIGCONT"]);
  assert.deepEqual(sigs(65), ["SIGSTOP", "SIGCONT"]);
  assert.ok(process.listeners("exit").length > 0);
});

test("paused by another rule (remux's far-ahead pause): not held; and never resumed by this when that rule paused it meanwhile", () => {
  const a = cand(71, 30);
  a.state.paused = true;
  const w = sf.wait("x");
  assert.deepEqual(sigs(71), []);
  a.state.paused = false;
  clock += 250; ticker();
  assert.deepEqual(sigs(71), ["SIGSTOP"]);
  a.state.paused = true; // (procpause took it over)
  w.end();
  assert.deepEqual(sigs(71), ["SIGSTOP"], "no SIGCONT: procpause resumes it");
});

test("Windows: the idle class while held, the owner's priority put back after (and no priority games before a kill)", () => {
  D.platform = () => "win32";
  const { PRIORITY_LOW, PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
  let want = PRIORITY_BELOW_NORMAL;
  const a = cand(81, 30, { priority: () => want });
  const w = sf.wait("x");
  assert.deepEqual(sent, [[81, "prio", PRIORITY_LOW]]);
  want = PRIORITY_NORMAL; // its owner decided meanwhile (sfHeld kept it from touching the OS)
  w.end();
  assert.deepEqual(sent.at(-1), [81, "prio", PRIORITY_NORMAL]);
  assert.ok(!sent.some((s) => s[1] === "SIGSTOP"), "no signals on Windows");
  // before a kill: let go without a priority call (killNow raises it itself)
  const w2 = sf.wait("y");
  const n = sent.length;
  sf.letGo(a.c);
  assert.equal(sent.length, n);
  assert.equal(sf.held(a.holder), false);
  w2.end();
});

test("switched off (AURORA_STARTFIRST=off): nothing is held, and what is held is let go", () => {
  const a = cand(91, 30);
  const w = sf.wait("x");
  assert.deepEqual(sigs(91), ["SIGSTOP"]);
  D.enabled = () => false;
  clock += 250; ticker();
  assert.deepEqual(sigs(91), ["SIGSTOP", "SIGCONT"]);
  const b = cand(92, 30);
  sf.check();
  assert.deepEqual(sigs(92), []);
  w.end();
  void a; void b;
  // the real switch reads the environment
  const was = process.env.AURORA_STARTFIRST;
  try {
    process.env.AURORA_STARTFIRST = "off";
    assert.equal(real.enabled(), false);
    process.env.AURORA_STARTFIRST = "";
    assert.equal(real.enabled(), true);
  } finally { if (was == null) delete process.env.AURORA_STARTFIRST; else process.env.AURORA_STARTFIRST = was; }
});

test("an untracked holder is not held; untrack while held lets go", () => {
  const c = child(101);
  const holder = {};
  const untrack = sf.track(holder, { child: c, aheadSec: () => 30 });
  const w = sf.wait("x");
  assert.deepEqual(sigs(101), ["SIGSTOP"]);
  untrack();
  assert.deepEqual(sigs(101), ["SIGSTOP", "SIGCONT"]);
  assert.equal(sf.status().encoders, 0);
  w.end();
  assert.doesNotThrow(() => sf.track(null, {}));
  assert.doesNotThrow(() => sf.track({}, {})());
});

// ---------------------------------------------------------------- jit's side

const jit = require("../src/media/jit");
const J = jit._internals;
const tableOf = (n) => Array.from({ length: n }, (_, i) => ({ start: i * 6, dur: 6 }));

test("jit noteReader: anchored at the END of the first segment asked, at the time of asking; a forward skip moves it on", () => {
  const job = { readers: [], returns: [], contendedAt: 0, lastReader: null, table: tableOf(100) };
  const r = J.noteReader(job, 10, 5000);
  assert.equal(r.anchorSec, 66);
  assert.equal(r.anchorAt, 5000);
  assert.equal(r.got, false);
  r.got = true;
  // the next segments, in order: the same reader, anchor kept
  assert.equal(J.noteReader(job, 11, 8000), r);
  assert.equal(r.anchorSec, 66);
  assert.equal(r.got, true);
  // a skip of two: a seek inside its reach — anchored again (never back)
  assert.equal(J.noteReader(job, 13, 9000), r);
  assert.equal(r.anchorSec, 84);
  assert.equal(r.anchorAt, 9000);
  assert.equal(r.got, false);
  // estimate already past the new segment's end: kept
  r.got = true;
  r.anchorSec = 200; r.anchorAt = 9000;
  J.noteReader(job, 15, 10000);
  assert.equal(r.anchorSec, 201);
});

test("jit aheadOf: film made beyond the viewers' estimated playheads; -Infinity when it cannot be said", () => {
  const now = 100_000;
  const job = { enc: true, table: tableOf(100), readers: [] };
  const run = { fromSeg: 0, nextSeg: 10, proc: { pid: 1 }, warm: null, stopped: false }; // made through 60 s
  assert.equal(J.aheadOf(job, run, now), -Infinity, "nobody reads it");
  job.readers.push({ seg: 3, at: now - 1000, anchorSec: 6, anchorAt: now - 20000, got: true }); // watching ~26 s
  assert.equal(J.aheadOf(job, run, now), 60 - 26);
  job.readers.push({ seg: 8, at: now - 500, anchorSec: 48, anchorAt: now - 2000, got: true }); // watching ~50 s
  assert.equal(J.aheadOf(job, run, now), 10, "the least of its readers");
  job.readers.push({ seg: 9, at: now, anchorSec: 60, anchorAt: now, got: false });
  assert.equal(J.aheadOf(job, run, now), -Infinity, "one of its readers has had nothing yet");
  job.readers.pop();
  job.readers.push({ seg: 40, at: now, anchorSec: 246, anchorAt: now, got: false }); // far away: another producer's
  assert.equal(J.aheadOf(job, run, now), 10);
  job.readers.push({ seg: 5, at: now - J.READER_TTL_MS - 1, anchorSec: 0, anchorAt: 0, got: true }); // gone
  assert.equal(J.aheadOf(job, run, now), 10);
  assert.equal(J.aheadOf(job, { ...run, nextSeg: 0 }, now), -Infinity, "made nothing yet");
  assert.equal(J.aheadOf(job, { ...run, warm: 2 }, now), -Infinity, "a warm-up");
  assert.equal(J.aheadOf(job, { ...run, stopped: true }, now), -Infinity);
  assert.equal(J.aheadOf(job, { ...run, proc: null }, now), -Infinity);
  // readers made before the anchor existed (no estimate): never held
  assert.equal(J.aheadOf({ enc: true, table: tableOf(100), readers: [{ seg: 3, at: now, got: true }] }, run, now), -Infinity);
});

test("jit: Windows priority changes wait while a run is held (yieldCpu, paceEncoder, leadprio)", () => {
  const prio = require("../src/lib/prio");
  const leadprio = require("../src/lib/leadprio");
  const realSet = os.setPriority;
  const realPd = { ...prio._deps };
  const realLd = { ...leadprio._deps };
  const calls = [];
  try {
    os.setPriority = (pid, p) => calls.push([pid, p]);
    prio._deps.platform = () => "win32";
    leadprio._deps.platform = () => "win32";
    leadprio._deps.set = (pid, p) => calls.push([pid, p]);
    leadprio._deps.get = () => 0;
    const job = { enc: true, readers: [{ seg: 0, at: Date.now() }], table: tableOf(100) };
    const run = { fromSeg: 0, nextSeg: 9, proc: { pid: 5 }, yielding: false, warm: null, stopped: false, sfHeld: true };
    J.yieldCpu(run);
    assert.equal(run.yielding, true, "the state moves on…");
    assert.deepEqual(calls, [], "…the OS priority does not");
    run.nextSeg = 1;
    J.paceEncoder(job, run, Date.now());
    assert.deepEqual(calls, []);
    assert.equal(leadprio.step(run, 5, 50), null);
    assert.deepEqual(calls, []);
    run.sfHeld = false;
    assert.equal(leadprio.step(run, 5, 50), "low");
  } finally {
    os.setPriority = realSet;
    Object.assign(prio._deps, realPd);
    Object.assign(leadprio._deps, realLd);
  }
});

// -------------------------------------------------------------- remux's side

const remux = require("../src/media/remux");
const R = remux._internals;

test("remux aheadOf / noteFetch: the playlist's made film beyond the estimated playhead; a skip ahead moves it on", () => {
  const now = 50_000;
  const job = { proc: { pid: 1 }, done: false, readyDone: true, dir: "x", segEnds: null };
  assert.equal(R.aheadOf(job, now), -Infinity, "no playlist read yet");
  job.segEnds = [2, 8, 14, 20, 26, 32, 38, 44, 50, 56]; // 2 s first segment, then 6 s
  assert.equal(R.aheadOf(job, now), -Infinity, "nothing fetched yet");
  R.noteFetch(job, 0, now - 10000); // first segment fetched 10 s ago: watching ≤ 12 s
  assert.equal(R.aheadOf(job, now), 56 - 12);
  R.noteFetch(job, 1, now - 9000);
  R.noteFetch(job, 2, now - 8000);
  assert.equal(R.aheadOf(job, now), 44, "sequential fetches keep the anchor");
  R.noteFetch(job, 7, now); // a seek inside the playlist
  assert.equal(R.aheadOf(job, now), 56 - 44);
  assert.equal(R.aheadOf({ ...job, readyDone: false }, now), -Infinity, "its own first segment is still awaited");
  assert.equal(R.aheadOf({ ...job, proc: null }, now), -Infinity);
  assert.equal(R.aheadOf({ ...job, segEnds: [] }, now), -Infinity);
  // fetched a segment the last read of the playlist did not list yet: unknown
  const j2 = { proc: { pid: 1 }, done: false, readyDone: true, segEnds: [2, 8] };
  R.noteFetch(j2, 5, now);
  assert.equal(R.aheadOf(j2, now), -Infinity);
});

test("remux readEnds: cumulative #EXTINF of the job's playlist", async () => {
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-sf-"));
  try {
    fs.writeFileSync(path.join(dir, "index.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:2.002000,\nseg00000.ts\n#EXTINF:6.006000,\nseg00001.ts\n#EXTINF:5.5,\nseg00002.ts\n");
    const job = { dir };
    await R.readEnds(job);
    assert.equal(job.segEnds.length, 3);
    assert.ok(Math.abs(job.segEnds[2] - 13.508) < 1e-9);
    await R.readEnds({ dir: path.join(dir, "nope") }); // never throws
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
