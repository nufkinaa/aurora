// Offline copies: who goes first, and that nothing waits without saying why
// (src/media/offline.js). elia, 2026-10-20, on his iPhone: "pressing the
// offline button on an episode and choosing Original just says 'Preparing on
// the server' and does not start the download". The cause: ONE slot for
// every copy — a play-ready copy made ahead of time after a download held it
// while it waited for viewers (or sat paused under them), and the person's
// ten-second repackaging queued behind it, saying nothing.
//
// Driven with a fake clock and fake ffmpeg processes (no real ffmpeg starts).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("node:events");

const cpuwork = require("../src/media/cpuwork");
const offline = require("../src/media/offline");
const scanner = require("../src/media/scanner");
const metadata = require("../src/media/metadata");
const config = require("../src/config");
const C = cpuwork._internals;
const O = offline._internals;

let pidSeq = 9000;
const resetOffline = () => (O._reset ? O._reset() : (O.jobs.clear(), (O.queue.length = 0)));
const tick = () => new Promise((r) => setImmediate(r));

// A library of fake files: hevc ones (an encode, or a remux on an HEVC
// device) and h264 MKVs (a remux anywhere).
const harness = async (fn) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-offq-"));
  const files = {};
  const meta = {};
  const add = (id, codec) => {
    const p = path.join(tmpDir, `${id}.mkv`);
    fs.writeFileSync(p, "x");
    files[id] = p;
    meta[p] = { duration: 600, width: 1920, height: 1080, video: { codec, bitDepth: codec === "hevc" ? 10 : 8 }, audioStreams: [{ codec: "ac3" }] };
  };
  add("hevcfilm0001", "hevc");
  add("hevcfilm0002", "hevc");
  add("hevcfilm0003", "hevc");
  add("h264mkv00001", "h264");
  add("h264mkv00002", "h264");
  const saved = { resolve: scanner.resolve, getCached: metadata.getCached, spawn: O.spawner.spawn, ffmpegAvailable: config.ffmpegAvailable, FFMPEG: config.FFMPEG, deps: { ...C.deps } };
  config.ffmpegAvailable = true;
  config.FFMPEG = config.FFMPEG || "ffmpeg";
  scanner.resolve = (id) => (files[id] ? { kind: "video", path: files[id] } : null);
  metadata.getCached = (p) => meta[p] || null;
  const spawned = [];
  O.spawner.spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.pid = ++pidSeq;
    c.args = args;
    c.signals = [];
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.file = args.find((a) => typeof a === "string" && path.isAbsolute(a) && a.startsWith(tmpDir) && a.endsWith(".mkv"));
    c.out = args[args.length - 1];
    c.copy = args.includes("copy");
    c.kill = (sig) => { c.signals.push(sig); setImmediate(() => { c.emit("exit", null, sig); c.emit("close", null); }); return true; };
    // the fake ffmpeg finishes: writes its output, exits 0
    c.finish = () => { fs.mkdirSync(path.dirname(c.out), { recursive: true }); fs.writeFileSync(c.out, "mp4"); c.emit("exit", 0, null); c.emit("close", 0); };
    c.fail = () => { c.emit("exit", 1, null); c.emit("close", 1); };
    spawned.push(c);
    return c;
  };
  const w = { now: 1e12, timers: [] };
  Object.assign(C.deps, {
    platform: "linux",
    cpus: () => 12,
    low: () => false,
    now: () => w.now,
    setTimeout: (f, ms) => { const t = { at: w.now + ms, f, live: true }; w.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    setPriority: () => {},
    ionice: () => {},
    kill: (child, sig) => { child.signals.push(sig); },
  });
  w.advance = async (ms) => {
    const end = w.now + ms;
    for (;;) {
      const due = w.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      w.now = due.at;
      due.f();
      await tick();
    }
    w.now = end;
    await tick();
  };
  C._reset();
  resetOffline();
  const logs = [];
  const quietLog = console.log;
  const quietWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
  const viewer = () => {
    const v = new EventEmitter();
    v.pid = ++pidSeq;
    v.kill = () => true;
    cpuwork.viewer.track(v, { kind: "ladder" });
    return { end: () => v.emit("exit", 0, null) };
  };
  const made = () => spawned.map((c) => `${path.basename(c.file || "?", ".mkv")}${c.copy ? ":copy" : ":encode"}`);
  try {
    await fn({ w, spawned, viewer, made, logs, files });
  } finally {
    console.log = quietLog;
    console.warn = quietWarn;
    for (const c of spawned) { try { fs.rmSync(c.out, { force: true }); fs.rmSync(c.out.replace(/\.part$/, ""), { force: true }); } catch {} }
    scanner.resolve = saved.resolve;
    metadata.getCached = saved.getCached;
    O.spawner.spawn = saved.spawn;
    config.ffmpegAvailable = saved.ffmpegAvailable;
    config.FFMPEG = saved.FFMPEG;
    Object.assign(C.deps, saved.deps);
    C._reset();
    resetOffline();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const AHEAD = { keepMs: 6 * 86400000 }; // how preconvert.js asks
const HEVC = { hevc: true }; // an iPhone

test("Original (a repackaging) starts at once while a copy made ahead of time waits for viewers — the iPhone report", async () => {
  await harness(async ({ spawned, viewer, made }) => {
    const v = viewer(); // somebody is watching something being encoded
    offline.prepare("hevcfilm0001", "1080", {}, AHEAD); // the download just landed: a play-ready copy is asked for
    await tick();
    assert.equal(spawned.length, 0, "the made-ahead encode waits for the viewer");
    const st = offline.prepare("h264mkv00001", "original", {}); // the person on the phone: Original
    await tick();
    assert.deepEqual(made(), ["h264mkv00001:copy"], "the repackaging did not wait behind the encode");
    assert.equal(offline.status("h264mkv00001", "original").state, "working");
    assert.ok(st.state === "working" || st.state === "queued");
    spawned[0].finish();
    await tick();
    const done = offline.status("h264mkv00001", "original");
    assert.equal(done.state, "ready");
    assert.match(done.url, /^\/offline\/file\/h264mkv00001\?q=original$/);
    // and the made-ahead copy still waits, and says why
    const ahead = offline.status("hevcfilm0001", "1080");
    assert.equal(ahead.state, "queued");
    assert.equal(ahead.wait.reason, "viewers");
    v.end();
  });
});

test("an HEVC original on an HEVC device (iPhone) is a repackaging too, and does not wait behind a running encode", async () => {
  await harness(async ({ spawned, made }) => {
    offline.prepare("hevcfilm0001", "1080", {}, AHEAD);
    await tick();
    assert.deepEqual(made(), ["hevcfilm0001:encode"], "nobody watching: the made-ahead copy starts");
    offline.prepare("hevcfilm0002", "original", HEVC);
    await tick();
    assert.deepEqual(made(), ["hevcfilm0001:encode", "hevcfilm0002:copy"], "the repackaging runs beside it, in its own lane");
    assert.ok(spawned[1].args.join(" ").includes("-tag:v hvc1"));
    assert.deepEqual(spawned[0].signals, [], "the encode is left alone: it is not in the way");
  });
});

test("a person's encode sets aside a copy made ahead of time that is running, which then starts over after it", async () => {
  await harness(async ({ w, spawned, made, logs }) => {
    offline.prepare("hevcfilm0001", "1080", {}, AHEAD);
    await tick();
    assert.deepEqual(made(), ["hevcfilm0001:encode"]);
    offline.prepare("hevcfilm0002", "720", {}); // a person wants a 720p copy of another film
    await tick(); await tick();
    assert.deepEqual(spawned[0].signals, ["SIGKILL"], "the made-ahead encode is stopped");
    assert.ok(logs.some((l) => /setting aside the copy made ahead of time/.test(l)), "and the log says so");
    await w.advance(1000);
    assert.deepEqual(made(), ["hevcfilm0001:encode", "hevcfilm0002:encode"], "the person's starts in its place");
    assert.equal(offline.status("hevcfilm0001", "1080").state, "queued", "set aside is not failed");
    spawned[1].finish();
    await w.advance(1000);
    assert.deepEqual(made(), ["hevcfilm0001:encode", "hevcfilm0002:encode", "hevcfilm0001:encode"], "then the made-ahead one again");
  });
});

test("a person who asks while a copy made ahead of time waits for its place goes first when the place comes", async () => {
  await harness(async ({ w, viewer, made }) => {
    const v = viewer();
    offline.prepare("hevcfilm0001", "1080", {}, AHEAD);
    offline.prepare("hevcfilm0002", "480", {});
    await tick();
    const st = offline.status("hevcfilm0002", "480");
    assert.equal(st.state, "queued");
    assert.equal(st.wait.reason, "viewers", "it says why it waits");
    assert.match(st.wait.text, /converting somebody's stream/);
    v.end();
    await w.advance(cpuwork.QUIET_MS + 100);
    assert.deepEqual(made(), ["hevcfilm0002:encode"], "the person's copy got the place, not the one made ahead");
  });
});

test("asking for the very copy that is being made ahead of time makes it the person's: it goes first", async () => {
  await harness(async ({ w, viewer, made }) => {
    const v = viewer();
    offline.prepare("hevcfilm0001", "1080", {}, AHEAD);
    offline.prepare("hevcfilm0002", "1080", {}, AHEAD);
    offline.prepare("hevcfilm0002", "1080", {}); // the person picks 1080p of the second one
    v.end();
    await w.advance(cpuwork.QUIET_MS + 100);
    assert.deepEqual(made(), ["hevcfilm0002:encode"]);
  });
});

test("two people's copies: the second says it is behind another one, and how many are before it", async () => {
  await harness(async ({ made }) => {
    offline.prepare("hevcfilm0001", "720", {});
    offline.prepare("hevcfilm0002", "720", {});
    offline.prepare("hevcfilm0003", "720", {});
    await tick();
    assert.deepEqual(made(), ["hevcfilm0001:encode"]);
    const second = offline.status("hevcfilm0002", "720");
    assert.equal(second.wait.reason, "behind");
    assert.match(second.wait.text, /another copy is being made/);
    const third = offline.status("hevcfilm0003", "720");
    assert.match(third.wait.text, /1 more before yours/);
  });
});

test("cancel: a queued copy leaves the line, a running one is stopped, and a made-ahead copy is not cancelled by a person", async () => {
  await harness(async ({ w, spawned, made }) => {
    offline.prepare("hevcfilm0001", "720", {});
    offline.prepare("hevcfilm0002", "720", {});
    await tick();
    assert.equal(offline.cancel("hevcfilm0002", "720").cancelled, true);
    assert.equal(offline.status("hevcfilm0002", "720").state, "idle", "gone from the queue");
    assert.equal(offline.cancel("hevcfilm0001", "720").cancelled, true);
    await tick(); await tick();
    assert.deepEqual(spawned[0].signals, ["SIGKILL"], "the running one is stopped");
    assert.equal(offline.status("hevcfilm0001", "720").state, "idle");
    assert.ok(!fs.existsSync(spawned[0].out), "no half-made file is left");
    // a made-ahead copy a person also asked for: the person's cancel hands it back to the background
    offline.prepare("hevcfilm0003", "1080", {}, AHEAD);
    offline.prepare("hevcfilm0003", "1080", {});
    await w.advance(1000);
    const n = spawned.length;
    assert.equal(offline.cancel("hevcfilm0003", "1080").cancelled, false);
    assert.equal(spawned.length, n);
    assert.deepEqual(spawned[n - 1].signals, [], "it carries on");
    // two people want the same copy: one cancel does not stop the other's
    offline.prepare("h264mkv00002", "original", {});
    offline.prepare("h264mkv00002", "original", {});
    await tick();
    assert.equal(offline.cancel("h264mkv00002", "original").cancelled, false);
    assert.equal(offline.status("h264mkv00002", "original").state, "working");
    assert.equal(offline.cancel("h264mkv00002", "original").cancelled, true);
    assert.deepEqual(made().slice(-1), ["h264mkv00002:copy"]);
  });
});

test("a copy that failed can be asked for again, and one the sweep removed is made again", async () => {
  await harness(async ({ spawned }) => {
    offline.prepare("h264mkv00001", "original", {});
    await tick();
    spawned[0].fail();
    await tick();
    assert.equal(offline.status("h264mkv00001", "original").state, "error");
    offline.prepare("h264mkv00001", "original", {});
    await tick();
    assert.equal(spawned.length, 2, "asked again: tried again (it used to answer the old error until a restart)");
    spawned[1].finish();
    await tick();
    const ready = offline.status("h264mkv00001", "original");
    assert.equal(ready.state, "ready");
    fs.rmSync(spawned[1].out.replace(/\.part$/, "")); // the sweep cleared it
    assert.equal(offline.status("h264mkv00001", "original").state, "idle", "not 'ready' with nothing behind it");
    offline.prepare("h264mkv00001", "original", {});
    await tick();
    assert.equal(spawned.length, 3, "made again");
  });
});

test("an ffmpeg that cannot start, or goes silent, ends as a failure the phone can show — never 'working' for ever", async () => {
  await harness(async ({ spawned, logs }) => {
    const realSpawn = O.spawner.spawn;
    O.spawner.spawn = () => { throw new Error("spawn EAGAIN"); };
    offline.prepare("h264mkv00001", "original", {});
    O.spawner.spawn = realSpawn;
    const st = offline.status("h264mkv00001", "original");
    assert.equal(st.state, "error");
    assert.match(st.error, /EAGAIN/);
    offline.prepare("h264mkv00002", "original", {});
    await tick();
    assert.equal(spawned.length, 1, "the lane was freed: the next one runs");
    const later = Date.now() + offline.STALL_MS + 1000;
    assert.deepEqual(O.checkStalls(later), ["h264mkv00002|original"]);
    await tick(); await tick();
    const stuck = offline.status("h264mkv00002", "original");
    assert.equal(stuck.state, "error");
    assert.match(stuck.error, /stopped making progress/);
    assert.ok(logs.some((l) => /made no progress/.test(l)));
  });
});

test("a person's encode running under a viewer says it is paused", async () => {
  await harness(async ({ viewer }) => {
    offline.prepare("hevcfilm0001", "720", {});
    await tick();
    const v = viewer(); // somebody starts watching: the encode is paused (Linux)
    const st = offline.status("hevcfilm0001", "720");
    assert.equal(st.state, "working");
    assert.equal(st.wait.reason, "paused");
    v.end();
  });
});
