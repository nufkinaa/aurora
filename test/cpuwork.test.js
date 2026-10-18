// Viewers first (src/media/cpuwork.js): background work runs at the lowest
// priority on a capped number of threads, is counted against a small budget,
// does not start while somebody's stream is being encoded, is paused when one
// starts (where the OS can), and resumes after a quiet period — and viewer
// work is never touched. Driven with a fake clock and fake processes; one
// test at the end uses a real (node) child to check the OS really did it.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { EventEmitter } = require("node:events");
const { spawn } = require("child_process");

const cpuwork = require("../src/media/cpuwork");
const C = cpuwork._internals;
const LOW = os.constants.priority.PRIORITY_LOW;

let pidSeq = 5000;
const fakeChild = () => {
  const c = new EventEmitter();
  c.pid = ++pidSeq;
  c.signals = [];
  c.kill = (sig) => { c.signals.push(sig || "SIGTERM"); return true; };
  c.end = () => c.emit("exit", 0, null);
  return c;
};

// A world with a hand-driven clock; restores the real one afterwards.
const world = async (platform, fn) => {
  const saved = { ...C.deps };
  const w = { now: 1e12, timers: [], priorities: [], ionice: [], signals: [] };
  Object.assign(C.deps, {
    platform,
    cpus: () => 12,
    low: () => false,
    now: () => w.now,
    setTimeout: (f, ms) => { const t = { at: w.now + ms, f, live: true }; w.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    setPriority: (pid, prio) => w.priorities.push([pid, prio]),
    ionice: (pid) => w.ionice.push(pid),
    kill: (child, sig) => { w.signals.push([child.pid, sig]); child.signals.push(sig); },
  });
  w.advance = async (ms) => {
    const end = w.now + ms;
    for (;;) {
      const due = w.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      w.now = due.at;
      due.f();
      await new Promise((r) => setImmediate(r));
    }
    w.now = end;
    await new Promise((r) => setImmediate(r));
  };
  C._reset();
  const quietLog = console.log;
  const quietWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { await fn(w); } finally {
    console.log = quietLog;
    console.warn = quietWarn;
    C._reset();
    Object.assign(C.deps, saved);
  }
};
const settled = async (p) => { let done = false; p.then(() => { done = true; }); await new Promise((r) => setImmediate(r)); return done; };

test("a background process gets the lowest priority (and the idle I/O class on Linux); viewer work is never repriced here", async () => {
  await world("linux", async (w) => {
    const place = await cpuwork.background.gate("encode", { label: "copy of Film" });
    const child = place.attach(fakeChild());
    assert.deepEqual(w.priorities, [[child.pid, LOW]], "nice 19 / the Windows idle class");
    assert.deepEqual(w.ionice, [child.pid]);
    // a viewer encoder registering changes nothing about ITS priority
    const v = fakeChild();
    cpuwork.viewer.track(v, { kind: "ladder", label: "Film-h264" });
    assert.equal(w.priorities.length, 1, "cpuwork never touches a viewer's process");
    assert.deepEqual(v.signals, []);
    assert.ok(cpuwork.PRIORITY.background > cpuwork.PRIORITY.viewer, "one step under the viewers' encoders (a higher number is a lower priority)");
  });
  await world("win32", async (w) => {
    const place = await cpuwork.background.gate("encode", {});
    const child = place.attach(fakeChild());
    assert.deepEqual(w.priorities, [[child.pid, LOW]]);
    assert.deepEqual(w.ionice, [], "no ionice on Windows");
    cpuwork.background.lower(fakeChild());
    assert.equal(w.priorities.length, 2, "a small helper is lowered too, without a place in the budget");
    assert.equal(cpuwork.background.used(), 2);
  });
});

test("the thread cap: half the machine", async () => {
  await world("linux", async () => {
    assert.equal(cpuwork.background.threads(), 6);
    C.deps.cpus = () => 4;
    assert.equal(cpuwork.background.threads(), 2);
    C.deps.cpus = () => 1;
    assert.equal(cpuwork.background.threads(), 1);
  });
});

test("the budget: an encode takes all of it; OCR and intro detection fit together; the next waits its turn, in order", async () => {
  await world("linux", async () => {
    const encode = await cpuwork.background.gate("encode", { label: "copy" });
    const ocr = cpuwork.background.gate("ocr", { label: "ocr" });
    const intro = cpuwork.background.gate("intro", { label: "intro" });
    assert.equal(await settled(ocr), false, "nothing beside a background encode");
    assert.equal(await settled(intro), false);
    assert.deepEqual(cpuwork.status().waiting, ["ocr", "intro"]);
    encode.release();
    assert.equal(await settled(ocr), true);
    assert.equal(await settled(intro), true, "one unit each: together");
    assert.equal(cpuwork.background.used(), 2);
    const second = cpuwork.background.gate("encode", {});
    assert.equal(await settled(second), false, "an encode needs the whole budget");
    (await ocr).release();
    assert.equal(await settled(second), false);
    (await intro).release();
    assert.equal(await settled(second), true);
  });
});

test("NO new background job starts while a viewer encode runs — nor for the quiet period after it; then it does", async () => {
  await world("linux", async (w) => {
    const v = fakeChild();
    cpuwork.viewer.track(v, { kind: "ladder" });
    assert.equal(cpuwork.background.mayStart("encode"), false);
    assert.equal(cpuwork.background.mayStart("ocr"), false);
    const waiting = cpuwork.background.gate("encode", { label: "play-ready copy" });
    await w.advance(10 * 60 * 1000);
    assert.equal(await settled(waiting), false, "ten minutes of viewing: still waiting");
    // the viewer's encoder ends: not at once…
    v.end();
    await w.advance(cpuwork.QUIET_MS - 1000);
    assert.equal(await settled(waiting), false, "a seek or the next episode restarts an encoder within seconds: wait for quiet");
    // …a second viewer encode inside the quiet period starts the wait over
    const v2 = fakeChild();
    cpuwork.viewer.track(v2, {});
    await w.advance(5000);
    v2.end();
    await w.advance(cpuwork.QUIET_MS - 1000);
    assert.equal(await settled(waiting), false);
    await w.advance(1100);
    assert.equal(await settled(waiting), true, "quiet for the whole period: go");
    assert.equal(cpuwork._internals.stats.heldBack, 1);
  });
});

test("a background encode that is already running is PAUSED when a viewer encode starts and resumed after the quiet period (POSIX)", async () => {
  await world("linux", async (w) => {
    const place = await cpuwork.background.gate("encode", { label: "copy", pausable: true });
    const bg = place.attach(fakeChild());
    const helper = (await cpuwork.background.gate("light", {})).attach(fakeChild()); // not pausable
    const v = fakeChild();
    cpuwork.viewer.track(v, {});
    assert.deepEqual(bg.signals, ["SIGSTOP"]);
    assert.deepEqual(helper.signals, [], "only what said it can be paused");
    assert.equal(cpuwork.background.list().find((j) => j.pid === bg.pid).paused, true);
    // a second viewer encode does not stop it twice
    const v2 = fakeChild();
    cpuwork.viewer.track(v2, {});
    assert.deepEqual(bg.signals, ["SIGSTOP"]);
    v.end();
    await w.advance(60000);
    assert.deepEqual(bg.signals, ["SIGSTOP"], "one viewer is still being encoded for");
    v2.end();
    await w.advance(cpuwork.QUIET_MS - 500);
    assert.deepEqual(bg.signals, ["SIGSTOP"]);
    await w.advance(600);
    assert.deepEqual(bg.signals, ["SIGSTOP", "SIGCONT"], "resumed once things have been quiet");
    assert.deepEqual(v.signals.concat(v2.signals), [], "the viewers' encoders were never signalled");
    // a job granted its place just before a viewer encode began is paused the moment it starts
    const v3 = fakeChild();
    const late = await cpuwork.background.gate("light", { pausable: true });
    cpuwork.viewer.track(v3, {});
    const lateChild = late.attach(fakeChild());
    assert.deepEqual(lateChild.signals, ["SIGSTOP"]);
  });
});

test("Windows cannot suspend another process: nothing is signalled — the idle priority class is the yield, and nothing new starts", async () => {
  await world("win32", async (w) => {
    const place = await cpuwork.background.gate("encode", { label: "copy", pausable: true });
    const bg = place.attach(fakeChild());
    cpuwork.viewer.track(fakeChild(), {});
    assert.deepEqual(bg.signals, [], "no SIGSTOP on Windows");
    assert.deepEqual(w.priorities, [[bg.pid, LOW]], "it has been in the idle class from the start");
    assert.equal(cpuwork.background.mayStart("ocr"), false);
    assert.equal(cpuwork.status().pauses, "priority");
  });
});

test("shedding: the NEWEST background job that can go back in its queue is stopped; one that cannot is left", async () => {
  await world("linux", async () => {
    const shed = [];
    const a = (await cpuwork.background.gate("intro", { label: "intro detection", onShed: () => shed.push("intro") }));
    a.attach(fakeChild());
    C.deps.now = () => 1e12 + 5000;
    const b = (await cpuwork.background.gate("ocr", { label: "OCR" })); // no onShed: cannot be put back
    b.attach(fakeChild());
    assert.equal(cpuwork.background.shedNewest("the viewers' encoders fell behind"), "intro detection");
    assert.deepEqual(shed, ["intro"]);
    a.release();
    assert.equal(cpuwork.background.shedNewest(), null, "nothing left that can be shed");
  });
});

test("the play-ready copy (offline.js) obeys all of it: waits for viewers, capped threads, asked-for copies first, shed means queued again", async () => {
  const fs = require("fs");
  const path = require("path");
  const offline = require("../src/media/offline");
  const scanner = require("../src/media/scanner");
  const metadata = require("../src/media/metadata");
  const O = offline._internals;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-offline-"));
  const film = (n) => { const p = path.join(tmpDir, `film${n}.mkv`); fs.writeFileSync(p, "x"); return p; };
  const files = { aaaaaaaaaaa1: film(1), aaaaaaaaaaa2: film(2) };
  const config = require("../src/config");
  const saved = { resolve: scanner.resolve, getCached: metadata.getCached, spawn: O.spawner.spawn, ffmpegAvailable: config.ffmpegAvailable, FFMPEG: config.FFMPEG };
  // (no real ffmpeg is started: the spawner below stands in, also on a machine that has none)
  config.ffmpegAvailable = true;
  config.FFMPEG = config.FFMPEG || "ffmpeg";
  scanner.resolve = (id) => (files[id] ? { kind: "video", path: files[id] } : null);
  metadata.getCached = () => ({ duration: 600, width: 1920, height: 1080, video: { codec: "hevc", bitDepth: 10 }, audioStreams: [{ codec: "ac3" }] });
  const spawned = [];
  O.spawner.spawn = (cmd, args) => {
    const c = fakeChild();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.args = args;
    c.kill = (sig) => { c.signals.push(sig); setImmediate(() => c.emit("close", null)); c.emit("exit", null, sig); return true; };
    spawned.push(c);
    return c;
  };
  try {
    await world("linux", async (w) => {
      // somebody's stream is being encoded when a download lands
      const v = fakeChild();
      cpuwork.viewer.track(v, { kind: "ladder" });
      offline.prepare("aaaaaaaaaaa1", "1080", {}, { keepMs: 6 * 86400000 }); // the play-ready copy (made ahead)
      await new Promise((r) => setImmediate(r));
      assert.equal(spawned.length, 0, "not started while a viewer is being encoded for");
      assert.equal(offline.status("aaaaaaaaaaa1", "1080").state, "queued");
      // meanwhile a person asks for a phone copy of another film
      offline.prepare("aaaaaaaaaaa2", "720", {});
      v.end();
      await w.advance(cpuwork.QUIET_MS + 100);
      assert.equal(spawned.length, 1, "one at a time");
      const first = spawned[0];
      assert.ok(first.args.includes(files.aaaaaaaaaaa1), "the one that was already waiting for its place");
      // capped: decoder, filters and encoder
      const threadsAt = first.args.map((a, i) => (a === "-threads" ? first.args[i + 1] : null)).filter(Boolean);
      assert.deepEqual(threadsAt, ["6", "6"], "half of twelve, for the decoder and for x264");
      assert.equal(first.args[first.args.indexOf("-filter_threads") + 1], "6");
      assert.ok(w.priorities.some(([pid, prio]) => pid === first.pid && prio === LOW), "lowest priority");
      // a viewer encode starts: paused; the viewers fall behind: shed, and queued again
      const v2 = fakeChild();
      cpuwork.viewer.track(v2, {});
      assert.deepEqual(first.signals, ["SIGSTOP"]);
      assert.match(cpuwork.background.shedNewest("test"), /play-ready copy of film1\.mkv/);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(offline.status("aaaaaaaaaaa1", "1080").state, "queued", "shed is not failed");
      assert.equal(spawned.length, 1, "and nothing starts while the viewer encode runs");
      v2.end();
      await w.advance(cpuwork.QUIET_MS + 100);
      assert.equal(spawned.length, 2);
      assert.ok(spawned[1].args.includes(files.aaaaaaaaaaa2), "the copy a person asked for goes ahead of the one made in advance");
      spawned[1].emit("exit", 1, null); spawned[1].emit("close", 1); // (it fails: no real ffmpeg wrote a file)
      await w.advance(cpuwork.QUIET_MS + 100);
      assert.equal(spawned.length, 3);
      assert.ok(spawned[2].args.includes(files.aaaaaaaaaaa1), "then the shed one, from the start");
      spawned[2].emit("exit", 1, null); spawned[2].emit("close", 1);
    });
    // a repackaging (video copied) is the disk's speed: not held back, no thread cap — but still lowest priority
    await world("linux", async (w) => {
      metadata.getCached = () => ({ duration: 600, width: 1920, height: 1080, video: { codec: "h264" }, audioStreams: [{ codec: "ac3" }] });
      cpuwork.viewer.track(fakeChild(), {});
      const before = spawned.length;
      offline.prepare("aaaaaaaaaaa2", "original", {});
      await new Promise((r) => setImmediate(r));
      assert.equal(spawned.length, before + 1, "started at once, viewers or not");
      const c = spawned[spawned.length - 1];
      assert.ok(c.args.includes("copy") && !c.args.includes("-threads"));
      assert.ok(w.priorities.some(([pid, prio]) => pid === c.pid && prio === LOW));
      c.emit("exit", 1, null); c.emit("close", 1);
    });
  } finally {
    scanner.resolve = saved.resolve;
    metadata.getCached = saved.getCached;
    O.spawner.spawn = saved.spawn;
    config.ffmpegAvailable = saved.ffmpegAvailable;
    config.FFMPEG = saved.FFMPEG;
    O.jobs.clear();
    O.queue.length = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("for real: the OS priority of a background process is the lowest, and (POSIX) it really stops and continues", { timeout: 60000 }, async () => {
  C._reset();
  const child = spawn(process.execPath, ["-e", "let n = 0; setInterval(() => { n++; }, 20);"], { stdio: "ignore", windowsHide: true });
  const viewerChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });
  const quiet = console.log;
  console.log = () => {};
  try {
    await new Promise((r) => setTimeout(r, 300));
    const place = await cpuwork.background.gate("encode", { label: "real", pausable: true });
    place.attach(child);
    assert.equal(os.getPriority(child.pid), LOW, "the OS says: lowest");
    const before = os.getPriority(viewerChild.pid);
    cpuwork.viewer.track(viewerChild, { kind: "ladder" });
    assert.equal(os.getPriority(viewerChild.pid), before, "the viewer's process is as it was");
    if (process.platform === "linux") {
      const stateOf = (pid) => require("fs").readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0];
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(stateOf(child.pid), "T", "stopped while a viewer is encoded for");
      viewerChild.kill("SIGKILL");
      await new Promise((r) => viewerChild.once("exit", r));
      // (the real quiet period is 20 s: resume by hand, as drain() does)
      cpuwork._internals.viewers.clear();
      for (const j of cpuwork._internals.jobs.values()) { if (j.paused) { j.child.kill("SIGCONT"); j.paused = false; } }
      await new Promise((r) => setTimeout(r, 200));
      assert.notEqual(stateOf(child.pid), "T", "running again");
    }
  } finally {
    console.log = quiet;
    try { child.kill("SIGCONT"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    try { viewerChild.kill("SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 100));
    C._reset();
  }
});
