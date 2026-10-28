// The encoder limit follows the machine (src/media/encbudget.js): what a job
// costs, what a machine has (from a measurement, here a fake one), who is
// admitted — for one core, a 4-core laptop, a 12-thread desktop, little
// memory, mixed sources — the order things degrade in, the fixed override,
// and what happens when the encoders fall behind real time. No ffmpeg runs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const budget = require("../src/media/encbudget");
const B = budget._internals;

// A machine: n logical CPUs, a per-thread speed against the reference, RAM.
const machine = async ({ logical, speed = 1, freeGb = 12, totalGb = 16, setting = "auto", model = "Test CPU", started = true }, fn) => {
  const saved = { ...B.deps };
  B._reset();
  const cpu = Array.from({ length: logical }, () => ({ model, times: { user: 0, sys: 0, nice: 0, irq: 0, idle: 1 } }));
  let now = 1e12;
  const shed = [];
  Object.assign(B.deps, {
    cpus: () => cpu,
    totalmem: () => totalGb * 1024 ** 3,
    freemem: () => freeGb * 1024 ** 3,
    now: () => now,
    setting: () => setting,
    viewerBusy: () => false,
    shed: (why) => { shed.push(why); return "a background copy"; },
  });
  if (started) {
    B.state.started = true;
    if (speed != null) B.state.cal = { speed, cpuSecPerFilmSec: budget.REF_CAL / speed, wallSpeed: 4, at: now, key: { cpu: model, logical, ffmpeg: "ffmpeg test" } };
  }
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    await fn({ cpu, shed, tick: (ms) => { now += ms; }, setSetting: (v) => { setting = v; }, setFree: (gb) => { freeGb = gb; } });
  } finally {
    Object.assign(console, quiet);
    Object.assign(B.deps, saved);
    B._reset();
  }
};
const P1080 = { srcW: 1920, srcH: 1080, codec: "hevc", fps: 24 };
const P4K = { srcW: 3840, srcH: 2160, codec: "hevc", fps: 24 };

test("what a job costs: fitted to the measured table (thread-seconds per second of film)", () => {
  const within = (got, lo, hi, what) => assert.ok(got >= lo * 0.9 && got <= hi * 1.1, `${what}: ${got} against ${lo}–${hi}`);
  within(budget.costOf({ srcW: 1920, srcH: 1080, codec: "h264", outH: 480 }), 0.44, 0.44, "1080p H.264 → 480p");
  within(budget.costOf({ srcW: 1920, srcH: 1080, codec: "h264", outH: 720 }), 0.60, 0.60, "1080p H.264 → 720p");
  within(budget.costOf({ ...P1080, outH: 720 }), 0.73, 0.73, "1080p HEVC → 720p");
  within(budget.costOf(P1080), 1.23, 1.23, "1080p HEVC → 1080p");
  within(budget.costOf({ ...P1080, legacy: true }), 1.30, 1.30, "the same through the older route");
  within(budget.costOf({ ...P4K, outH: 720 }), 1.9, 1.9, "4K → 720p");
  within(budget.costOf(P4K), 2.3, 2.5, "4K → 1080p");
  within(budget.costOf({ ...P4K, outH: 720, tonemap: true }), 2.7, 2.9, "4K HDR → 720p tone-mapped");
  within(budget.costOf({ ...P4K, tonemap: true }), 3.7, 4.2, "4K HDR → 1080p tone-mapped");
  // frame rate: 60 fps costs 2.5 times 24 fps; nothing costs less than 24
  assert.ok(Math.abs(budget.costOf({ ...P1080, fps: 60 }) - budget.costOf(P1080) * 2.5) < 0.02);
  assert.equal(budget.costOf({ ...P1080, fps: 12 }), budget.costOf(P1080));
  // nothing known about the source: one standard transcode, not zero
  within(budget.costOf({}), 1.23, 1.23, "unknown source");
  // memory: 0.3–1.1 GB per encoder, more for 4K
  assert.ok(budget.memOf(P1080) > 300 && budget.memOf(P1080) < 600);
  assert.ok(budget.memOf({ ...P4K, tonemap: true }) > 850 && budget.memOf({ ...P4K, tonemap: true }) < 1150);
});

test("the automatic number, by machine: one core, a 4-core laptop, a 12-thread desktop, the 16-thread reference", async () => {
  // 1 core: one encode — and that one is always allowed
  await machine({ logical: 1, speed: 0.8 }, async () => {
    assert.equal(budget.slots(), 1);
    assert.equal(budget.admit({ cost: budget.costFor(P1080), running: 0 }).ok, true, "alone: allowed whatever it costs");
    assert.equal(budget.admit({ cost: budget.costFor(P1080), running: 1.23 }).ok, false);
  });
  // i5-10210U: 4 cores / 8 threads at 0.65 of the reference → 3.64 units → 2
  await machine({ logical: 8, speed: 0.65 }, async () => {
    assert.equal(budget.capacity(), 3.64);
    assert.equal(budget.slots(), 2);
    assert.equal(budget.explain().examples["4K → 1080p"], 1);
    assert.equal(budget.admit({ cost: budget.costFor({ ...P4K, tonemap: true }), running: 0 }).ok, true, "a 4K HDR title still plays when it is the only encode");
  });
  // i5-10400: 6 cores / 12 threads at 0.86 → 7.22 units → 5 (the study: "5–6 with headroom")
  await machine({ logical: 12, speed: 0.86 }, async () => {
    assert.equal(budget.capacity(), 7.22);
    assert.equal(budget.slots(), 5);
    const ex = budget.explain();
    assert.equal(ex.examples["4K → 1080p"], 3);
    assert.equal(ex.examples["4K HDR → 1080p, tone-mapped"], 1);
    assert.match(ex.sentence, /^Automatic: 5 now, because 12 CPU threads × 0\.86 .* × 70% = 7\.22 thread-seconds per second of film, and a 1080p transcode costs 1\.23\.$/);
    // five 1080p fit; the sixth does not
    let running = 0;
    for (let i = 0; i < 5; i++) { assert.equal(budget.admit({ cost: 1.23, running }).ok, true, `encode ${i + 1}`); running += 1.23; }
    assert.deepEqual(budget.admit({ cost: 1.23, running }), { ok: false, why: "cpu" });
  });
  // the reference machine
  await machine({ logical: 16, speed: 1 }, async () => {
    assert.equal(budget.capacity(), 11.2);
    assert.equal(budget.slots(), 9);
  });
  // not measured yet: a cautious guess, never zero
  await machine({ logical: 12, speed: null }, async () => {
    assert.equal(budget.explain().measured, false);
    assert.equal(budget.capacity(), Math.round(12 * B.UNKNOWN_SPEED * 0.7 * 100) / 100);
    assert.ok(budget.slots() >= 2 && budget.slots() <= 5);
    assert.match(budget.explain().sentence, /not measured yet, a cautious guess/);
  });
});

test("a machine that is shared: the CPU other programs are using is not counted as ours — looked at only while we encode nothing", async () => {
  await machine({ logical: 16, speed: 1 }, async (m) => {
    const busyFor = (share) => { for (const c of m.cpu) { c.times.user += share * 1000; c.times.idle += (1 - share) * 1000; } };
    assert.equal(budget.slots(), 9, "an idle 16-thread machine");
    assert.equal(B.otherShare(), 0);
    // a build is running beside the server: a quarter to a third of the CPUs, for minutes
    B.sampleOther(false);
    for (const share of [0.28, 0.31, 0.25, 0.9, 0.3, 0.27, 0.33]) { busyFor(share); B.sampleOther(false); }
    assert.equal(B.otherShare(), 0.3, "the median: one spike does not move it");
    assert.equal(budget.capacity(), Math.round(16 * 0.7 * 1 * 0.7 * 100) / 100);
    assert.equal(budget.slots(), 6);
    assert.match(budget.explain().sentence, /16 CPU threads \(other programs on this machine are using 30% of them\)/);
    // while we are encoding, the CPUs are busy with OUR work: that is not "other"
    const before = B.otherShare();
    busyFor(0.95); B.sampleOther(true);
    busyFor(0.95); B.sampleOther(true);
    busyFor(0.95); B.sampleOther(false); // (the first look after: nothing to compare with yet)
    assert.equal(B.otherShare(), before);
    // the build ends: the machine is ours again
    for (let i = 0; i < 45; i++) { busyFor(0.02); B.sampleOther(false); }
    assert.equal(budget.slots(), 9);
    // a box that is flat out all day still gets a try: never less than a quarter counted
    for (let i = 0; i < 45; i++) { busyFor(1); B.sampleOther(false); }
    assert.equal(B.otherShare(), 0.75);
    assert.ok(budget.slots() >= 2);
  });
});

test("mixed sources share one budget by cost: a 4K HDR title takes the room of three 1080p ones", async () => {
  await machine({ logical: 12, speed: 0.86 }, async () => {
    const hdr = budget.costFor({ ...P4K, tonemap: true }); // ~4.0
    const hd = budget.costFor(P1080); // 1.23
    const low = budget.costFor({ ...P1080, outH: 480 }); // ~0.56
    let running = 0;
    assert.equal(budget.admit({ cost: hdr, running }).ok, true); running += hdr;
    assert.equal(budget.admit({ cost: hd, running }).ok, true); running += hd;
    assert.equal(budget.admit({ cost: hd, running }).ok, true); running += hd;
    assert.equal(budget.admit({ cost: hd, running }).ok, false, "a third 1080p beside the 4K HDR one does not fit");
    assert.equal(budget.admit({ cost: low, running }).ok, true, "but a 480p rung does: the lower rung that fits");
    // a courtesy rung (a lighter stream for a slow line) leaves room for somebody who NEEDS an encode
    assert.deepEqual(budget.admit({ cost: budget.costFor({ ...P1080, outH: 720 }), running, essential: false }), { ok: false, why: "cpu-courtesy" });
    assert.equal(budget.admit({ cost: budget.costFor({ ...P1080, outH: 720 }), running: 2.46, essential: false }).ok, true);
  });
});

test("memory is a limit of its own: an encoder that does not fit in what is free is not started", async () => {
  await machine({ logical: 12, speed: 0.86, freeGb: 1.5, totalGb: 16 }, async (m) => {
    const mem4k = budget.memOf(P4K); // ~930 MB
    assert.equal(budget.admit({ cost: 1.23, memMb: budget.memOf(P1080), running: 1.23 }).ok, true, "476 MB fits beside one");
    assert.deepEqual(budget.admit({ cost: 2.4, memMb: mem4k, running: 1.23 }), { ok: false, why: "memory" });
    assert.equal(budget.admit({ cost: 2.4, memMb: mem4k, running: 0 }).ok, true, "alone it may dip into the reserve");
    m.setFree(1.1);
    assert.deepEqual(budget.admit({ cost: 2.4, memMb: mem4k, running: 0 }), { ok: false, why: "memory" }, "…but never past what the machine has");
    m.setFree(12);
    assert.equal(budget.admit({ cost: 2.4, memMb: mem4k, running: 1.23 }).ok, true);
    assert.ok(budget.explain().memory.budgetMb <= 16 * 1024 * 0.6, "never more than 60% of all memory to encoders");
  });
});

test("the override: a fixed number is a plain count again; 'auto' and nonsense are automatic; before start() it is the old 2", async () => {
  await machine({ logical: 12, speed: 0.86, setting: 3 }, async (m) => {
    assert.equal(budget.slots(), 3);
    assert.equal(budget.capacity(), 3);
    assert.equal(budget.costFor({ ...P4K, tonemap: true }), 1, "every encode counts as one");
    assert.equal(budget.unit(), 1);
    assert.equal(budget.reserve(), 1);
    assert.equal(budget.admit({ cost: 1, running: 2 }).ok, true);
    assert.equal(budget.admit({ cost: 1, running: 3 }).ok, false);
    assert.equal(budget.admit({ cost: 1, running: 2, essential: false }).ok, false, "a courtesy rung never takes the last slot");
    assert.match(budget.explain().sentence, /^Fixed at 3 at once \(set by the admin\)/);
    for (const v of ["auto", undefined, null, 0, -2, 17, 2.5, "lots"]) { m.setSetting(v); assert.equal(budget.override(), "auto", String(v)); }
    assert.equal(budget.slots(), 5);
    m.setSetting("4");
    assert.equal(budget.slots(), 4);
  });
  await machine({ logical: 12, speed: 0.86, started: false }, async () => {
    assert.equal(budget.slots(), 2);
    assert.equal(budget.costFor(P4K), 1);
    assert.equal(budget.explain().mode, "unstarted");
  });
});

test("the measurement: taken once, kept on disk, taken again only when the CPU or ffmpeg changes — and never while a viewer is encoded for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-encbudget-"));
  const file = path.join(dir, "encode-calibration.json");
  try {
    await machine({ logical: 12, speed: null }, async () => {
      let runs = 0;
      let version = "ffmpeg version 7.1";
      let busy = false;
      let cpuSec = 9.3; // per 10 s of film → 0.93 per film-second
      Object.assign(B.deps, { cacheFile: () => file, version: async () => version, viewerBusy: () => busy, run: async (args) => { runs++; assert.ok(args.includes("libx264") && args.includes("superfast"), "the ladder's encoder settings"); return { cpuSec: runs % 2 ? cpuSec * 1.3 : cpuSec, wallSec: 2.5 }; } });
      // a viewer is being encoded for: not now
      busy = true;
      assert.equal(await budget.calibrate(), null);
      assert.equal(runs, 0);
      busy = false;
      const cal = await budget.calibrate();
      assert.equal(runs, 2, "two runs");
      assert.equal(cal.cpuSecPerFilmSec, 0.93, "the cheaper run counts");
      assert.equal(cal.speed, Math.round((budget.REF_CAL / 0.93) * 1000) / 1000);
      assert.equal(cal.key.logical, 12);
      assert.ok(fs.existsSync(file));
      assert.equal(budget.explain().measured, true);
      // the next boot: read back, nothing is run
      B.state.cal = null;
      const again = await budget.calibrate();
      assert.equal(runs, 2);
      assert.equal(again.speed, cal.speed);
      // ffmpeg was updated: measured again
      version = "ffmpeg version 8.0";
      await budget.calibrate();
      assert.equal(runs, 4);
      // the CPU changed (the data folder moved to another machine): measured again
      B.deps.cpus = () => Array.from({ length: 8 }, () => ({ model: "Another CPU", times: {} }));
      await budget.calibrate();
      assert.equal(runs, 6);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).key.cpu, "Another CPU");
      // a month old: measured again
      const kept = JSON.parse(fs.readFileSync(file, "utf8"));
      kept.at -= 31 * 24 * 3600 * 1000;
      fs.writeFileSync(file, JSON.stringify(kept));
      await budget.calibrate();
      assert.equal(runs, 8);
      // timed again later: only a FASTER answer replaces what is kept
      cpuSec = 12;
      const before = B.state.cal.speed;
      await budget.refine();
      assert.equal(B.state.cal.speed, before, "a busy moment does not make the machine slower for a month");
      cpuSec = 7;
      await budget.refine();
      assert.ok(B.state.cal.speed > before);
      // ffmpeg that cannot run the job: the limit stays what it was
      B.deps.run = async () => null;
      const speedNow = B.state.cal.speed;
      await budget.calibrate({ force: true });
      assert.equal(B.state.cal.speed, speedNow);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("falling behind real time: new encodes are refused and background work is shed — only when a watched encode is slow on a busy machine", async () => {
  const feed = (key, speed, waited, m, secs = 20) => {
    for (let t = 0; t <= secs; t += 2) { budget.progress(key, t * speed, waited); m.tick(2000); }
  };
  const busyCpu = (m, share) => { for (const c of m.cpu) { c.times.user += share * 1000; c.times.idle += (1 - share) * 1000; } };
  // healthy: 1.4× real time
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.95);
    feed("a", 1.4, true, m);
    assert.equal(budget.overloaded(), false);
    assert.equal(budget.admit({ cost: 1.23, running: 1.23 }).ok, true);
  });
  // behind (0.7×), watched, CPUs 95% busy — and busy with OUR encoders
  // (eight of them, 1.23 thread-s each at 0.7× on a 0.86× machine: 8 of its
  // 12 threads): overloaded
  const feedAll = (keys, sp, waited, m, secs = 20) => {
    for (let t = 0; t <= secs; t += 2) { for (const k of keys) budget.progress(k, t * sp, waited); m.tick(2000); }
  };
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.95);
    const ours = Array.from({ length: 8 }, () => ({ cost: 1.23 }));
    feedAll(ours, 0.7, true, m);
    assert.ok(budget.ownShare() > 0.6, `own share ${budget.ownShare()}`);
    assert.equal(budget.overloaded(), true);
    assert.equal(m.shed.length, 1, "the newest background job is shed, once");
    assert.deepEqual(budget.admit({ cost: 1.23, running: 1.23 }), { ok: false, why: "falling-behind" });
    assert.equal(budget.admit({ cost: 1.23, running: 1.23, replacing: true }).ok, true, "a viewer's own seek is not refused");
    assert.equal(budget.admit({ cost: 1.23, running: 0 }).ok, true, "and an encode with nothing else running always starts");
    assert.match(budget.explain().overloadWhy, /0\.70 s of film per second/);
    // it catches up: the refusals end by themselves
    m.tick(B.OVERLOAD_HOLD_MS + 1);
    assert.equal(budget.overloaded(), false);
    assert.equal(budget.admit({ cost: 1.23, running: 1.23 }).ok, true);
  });
  // behind on a machine kept busy by OTHER programs (one encoder of ours, a
  // twelfth of it): said, and nobody is refused for it
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.95);
    feed({ cost: 1.23 }, 0.7, true, m);
    assert.ok(budget.ownShare() < 0.2);
    assert.equal(budget.overloaded(), false);
    assert.equal(m.shed.length, 0);
    assert.equal(budget.admit({ cost: 1.23, running: 1.23 }).ok, true);
  });
  // slow, but the CPUs are idle: the source is slow (a torrent), not the machine
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.2);
    feed("a", 0.5, true, m);
    assert.equal(budget.overloaded(), false);
    assert.equal(m.shed.length, 0);
  });
  // slow, but nobody is waiting on it (it runs ahead of its reader at low priority)
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.95);
    feed("a", 0.5, false, m);
    assert.equal(budget.overloaded(), false);
  });
  // a few slow seconds are not "behind"
  await machine({ logical: 12, speed: 0.86 }, async (m) => {
    B.sampleCpu(); busyCpu(m, 0.95);
    feed("a", 0.5, true, m, 8);
    assert.equal(budget.overloaded(), false);
  });
});

test("an encode that cannot keep up while watched: the next encoders start at the faster preset, for half an hour", async () => {
  const feed = (key, speed, waited, m, secs = 20) => {
    for (let t = 0; t <= secs; t += 2) { budget.progress(key, t * speed, waited); m.tick(2000); }
  };
  const busyCpu = (m, share) => { for (const c of m.cpu) { c.times.user += share * 1000; c.times.idle += (1 - share) * 1000; } };
  await machine({ logical: 2, speed: 0.6 }, async (m) => {
    assert.equal(budget.presetNow(), "superfast");
    B.sampleCpu(); busyCpu(m, 0.95);
    feed("fast", 1.4, true, m);
    assert.equal(budget.presetNow(), "superfast", "an encode that keeps up changes nothing");
    feed("slow", 0.8, false, m);
    assert.equal(budget.presetNow(), "superfast", "slow with nobody waiting (running ahead) changes nothing");
    feed("slow2", 0.8, true, m);
    assert.equal(budget.presetNow(), "ultrafast", "behind real time while a viewer waited");
    m.tick(B.SLOW_PRESET_MS + 1000);
    assert.equal(budget.presetNow(), "superfast", "and back after half an hour");
  });
});

test("the ladder's encoders are admitted by cost: on a 12-thread desktop three 4K encodes fit, on a laptop one — and the old count rules still hold in units", async () => {
  const jit = require("../src/media/jit");
  const J = jit._internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-encjit-"));
  const table = Array.from({ length: 50 }, (_, i) => ({ start: i * 6, dur: 6 }));
  const dirs = [];
  const mkJob = (title, cost) => { const d = path.join(tmp, `job${dirs.length}`); dirs.push(d); const j = jit.jobFor(d, { key: title, table }, { enc: true }); j.cost = cost; return j; };
  const producer = (job) => { const run = { fromSeg: 0, nextSeg: 0, proc: { kill() {} } }; job.producers.push(run); return run; };
  const forget = () => { for (const d of dirs.splice(0)) { const j = J.jobs.get(d); if (j) j.producers.length = 0; J.dropJob(d); } };
  J.setOutsideEncodes(() => 0);
  try {
    await machine({ logical: 12, speed: 0.86 }, async () => {
      const c4k = budget.costFor(P4K);
      assert.equal(J.MAX_ENCODES, 5, "the number shown follows the machine");
      const a = mkJob("film A", c4k); assert.equal(J.admitEncode(a, true), true); producer(a);
      const b = mkJob("film B", c4k); assert.equal(J.admitEncode(b, true), true); producer(b);
      const c = mkJob("film C", c4k); assert.equal(J.admitEncode(c, true), true); producer(c);
      const d = mkJob("film D", c4k);
      assert.equal(J.admitEncode(d, true), false, "the fourth 4K encode does not fit 7.22 units");
      assert.equal(jit.refusedJustNow(d), true, "and the route says busy at once");
      assert.equal(jit.encodeRoom("film D", true, c4k), false);
      assert.equal(jit.encodeRoom("film D", true, budget.costFor({ ...P4K, outH: 480 })), false, "even its 480p rung is too much beside three 4K decodes");
      // one of them ends: a 1080p title fits at once
      b.producers.length = 0;
      const e = mkJob("film E", budget.costFor(P1080));
      assert.equal(J.admitEncode(e, true), true);
      assert.deepEqual(jit.encodeLoad().count, 2);
      forget();
    });
    await machine({ logical: 8, speed: 0.65 }, async () => {
      const c4k = budget.costFor(P4K);
      const a = mkJob("film A", c4k); assert.equal(J.admitEncode(a, true), true); producer(a);
      const b = mkJob("film B", budget.costFor(P1080));
      assert.equal(J.admitEncode(b, true), true, "a 1080p beside a 4K: 2.4 + 1.23 fits 3.64");
      producer(b);
      const c = mkJob("film C", budget.costFor({ ...P1080, outH: 480 }));
      assert.equal(J.admitEncode(c, true), false);
      forget();
    });
  } finally {
    forget();
    J.setOutsideEncodes(() => 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the order things degrade in: a lower rung that fits → a short wait → the quick 'busy'", async () => {
  const ladder = require("../src/media/ladder");
  const config = require("../src/config");
  const saved = { FFMPEG: config.FFMPEG };
  config.FFMPEG = config.FFMPEG || "ffmpeg";
  const key = `enc-degrade-${Date.now()}`;
  ladder._internals.seedFacts(key, { codec: "hevc", width: 1920, height: 1080, fps: 24, pixFmt: "yuv420p10le", transfer: "bt709", primaries: "bt709", matrix: "bt709", range: "tv", profile: "Main 10", level: 120, dv: null });
  const entry = { rate: 6000 * 125 };
  try {
    await machine({ logical: 8, speed: 0.65 }, async () => {
      const full = ladder.costFor("h264", { codec: "hevc", width: 1920, height: 1080, fps: 24 });
      const c720 = ladder.costFor("h264-720", { codec: "hevc", width: 1920, height: 1080, fps: 24 });
      const c480 = ladder.costFor("h264-480", { codec: "hevc", width: 1920, height: 1080, fps: 24 });
      assert.ok(full > c720 && c720 > c480);
      const asked = [];
      const jitWith = (room) => ({
        encodeDeclined: () => null,
        encodeRoom: (k, essential, cost) => { asked.push(cost); return cost <= room; },
        encodeRoomSoon: async () => { asked.push("wait"); return false; },
      });
      // everything fits: the full ladder, nothing marked
      const all = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: jitWith(99) });
      assert.deepEqual(all.rungs.map((r) => r.name), ["h264", "h264-720", "h264-480"]);
      assert.ok(!/need=1/.test(all.text));
      assert.equal(all.degraded, null);
      // 1. the full encode does not fit, 720p does: THAT is offered, as the viewer's own
      asked.length = 0;
      const lower = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: jitWith(c720) });
      assert.equal(lower.status, undefined);
      assert.deepEqual(lower.rungs.map((r) => r.name), ["h264-720", "h264-480"]);
      assert.match(lower.text, /index\.m3u8\?v=h264-720&need=1\n/);
      assert.equal(lower.degraded, "h264-720");
      assert.ok(!asked.includes("wait"), "no waiting when a lower rung fits");
      // only 480p fits
      const lowest = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: jitWith(c480) });
      assert.deepEqual(lowest.rungs.map((r) => r.name), ["h264-480"]);
      // 2 + 3. nothing fits: a short wait, then the quick 503
      asked.length = 0;
      const none = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: jitWith(0) });
      assert.equal(none.status, 503);
      assert.match(none.message, /Server is busy/);
      assert.ok(asked.includes("wait"), "it waited for room first");
      // …and if room appears during the wait, the full ladder is the answer
      const soon = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: { encodeDeclined: () => null, encodeRoom: (() => { let n = 0; return () => n++ > 3; })(), encodeRoomSoon: async () => true } });
      assert.equal(soon.status, undefined);
      assert.equal(soon.rungs[0].name, "h264");
      // the rung asked for with need=1 is admitted as essential
      const enc = await ladder.encFor({ name: "h264-720", h: 720, level: 31 }, { codec: "hevc", width: 1920, height: 1080, fps: 24 }, { need: true });
      assert.equal(enc.essential, true);
      assert.equal(enc.cost, c720);
      assert.ok(enc.memMb > 200);
      assert.equal((await ladder.encFor({ name: "h264-720", h: 720, level: 31 }, null, {})).essential, false, "a courtesy rung otherwise");
    });
  } finally {
    config.FFMPEG = saved.FFMPEG;
  }
});

test("the older single-rendition routes say 'busy' as 503 with Retry-After, not 500", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "stream.js"), "utf8");
  const tor = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "torrent.js"), "utf8");
  // every catch of a job start goes through the one answer
  assert.ok(/const sendStreamError = \(res, err\) => \{\s+if \(err && err\.busy\) \{\s+res\.setHeader\("Retry-After"/.test(src));
  assert.equal((src.match(/sendStreamError\(res, err\)/g) || []).length, 2, "both single-rendition library routes");
  assert.ok(/if \(err && err\.busy\) \{\s+res\.setHeader\("Retry-After"[^}]+return res\.status\(503\)/.test(tor), "and the torrent one");
  // and the modules mark the refusal
  for (const f of ["remux.js", "torrent-transcode.js"]) {
    const m = fs.readFileSync(path.join(__dirname, "..", "src", "media", f), "utf8");
    assert.ok(/busyError\(/.test(m) && /Server is busy transcoding other streams/.test(m), f);
  }
});
