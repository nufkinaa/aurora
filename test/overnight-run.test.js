// The overnight run (src/media/overnight.js) on a fake clock with fake
// conversions: it starts only inside the quiet hours once nobody has watched
// for ten minutes, PAUSES the moment somebody starts watching, goes on when it
// is quiet again, stops when the pause lasts or the hours end (and the title
// is tried again), Run now works outside the hours, a failure is not retried
// the same night — and the admin's settings and line.
// No ffmpeg, no data/: the conversions are stand-ins (prepared.start), the
// stores are in memory, the plan is handed in (deps.gather).
const test = require("node:test");
const assert = require("node:assert/strict");

const overnight = require("../src/media/overnight");
const prepared = require("../src/media/prepared");
const settings = require("../src/lib/settings");
const cpuwork = require("../src/media/cpuwork");
const plan = require("../src/media/overnightplan");

const MIN = 60e3;
const GB = 1024 ** 3;
const D = overnight._internals.deps;
const R = overnight._internals.run;
const at = (h, m = 0, day = 10) => new Date(2026, 10, day, h, m, 0, 0).getTime();
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

let clock = at(1, 0);
let busy = { busy: false, why: null };
let wants = [];
const started = [];
const memStore = (data) => ({ data, save() {}, flush() {} });

// a stand-in for one conversion: finish(), fail(), and what was done to it
const fakeStart = async (w) => {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const c = {
    want: w, paused: false, pauses: 0, resumes: 0, stopped: null,
    done,
    progress: () => 0.4,
    pause: async () => { c.paused = true; c.pauses++; return true; },
    resume: async () => { c.paused = false; c.resumes++; return true; },
    stop: (why) => { c.stopped = why; resolve({ ok: false, stopped: why, ms: 1 }); },
    finish: () => resolve({ ok: true, bytes: 1e9, ms: 600e3 }),
    fail: (error) => resolve({ ok: false, error, ms: 1 }),
  };
  started.push(c);
  return c;
};

const want = (id, kind = "h264", reason = "next") => ({ key: `${id}|${kind}`, id, kind, bytes: 1 * GB, reason, at: clock, label: id, persons: ["p1"], devices: ["web Chrome"], facts: {}, audioIndex: 0, duration: 2700 });

let saved;
test.before(() => {
  saved = { now: D.now, busy: D.busy, gather: D.gather, start: prepared.start, list: prepared.list, usedBytes: prepared.usedBytes, freeBytes: prepared.freeBytes, save: settings.save, overnight: settings.data.overnight };
  D.now = () => clock;
  D.busy = () => busy;
  D.gather = async () => ({ wants: wants.slice(), considered: wants.map((w) => ({ id: w.id })), notes: [] });
  prepared.start = fakeStart;
  prepared.list = () => [];
  prepared.usedBytes = () => 0;
  prepared.freeBytes = () => 200 * GB;
  settings.save = () => {};
  overnight._internals.setState(memStore({ devices: {}, ahead: [], runs: [] }));
  cpuwork._internals._reset();
});
test.after(() => {
  D.now = saved.now; D.busy = saved.busy; D.gather = saved.gather;
  Object.assign(prepared, { start: saved.start, list: saved.list, usedBytes: saved.usedBytes, freeBytes: saved.freeBytes });
  settings.save = saved.save;
  settings.data.overnight = saved.overnight;
});
test.beforeEach(() => {
  overnight._internals.reset();
  overnight._internals.setState(memStore({ devices: {}, ahead: [], runs: [] }));
  settings.data.overnight = undefined;
  started.length = 0;
  busy = { busy: false, why: null };
  wants = [want("ep1"), want("ep2", "copy")];
  cpuwork._internals._reset();
});
// one look, and the async work it started
const look = async () => { const a = await overnight.tick(); await flush(); return a; };

test("outside the quiet hours nothing starts; inside, once quiet, the plan is made and the first title starts", async () => {
  clock = at(1, 30);
  assert.equal(await look(), "idle");
  assert.equal(started.length, 0);
  clock = at(2, 0);
  await look(); // the run opens, the plan is made
  assert.ok(R.current, "tonight's run is open");
  assert.equal(R.queue.length, 2);
  assert.equal(await look(), "start");
  assert.equal(started.length, 1);
  assert.equal(started[0].want.key, "ep1|h264", "the plan's order: the h264 of the next episode first");
  assert.match(overnight.status().line, /preparing 1 of 2 now/);
  started[0].finish();
  await flush();
  assert.equal(R.current.made.length, 1);
  assert.equal(await look(), "start");
  assert.equal(started[1].want.key, "ep2|copy");
});

test("somebody starts watching: paused at once; quiet for three minutes: it goes on", async () => {
  clock = at(2, 0);
  await look(); await look();
  const c = started[0];
  clock += 30e3;
  busy = { busy: true, why: "someone is watching" };
  assert.equal(await look(), "pause");
  assert.equal(c.pauses, 1);
  assert.equal(overnight.status().state, "paused");
  assert.match(overnight.status().line, /paused while someone watches/);
  clock += 5 * MIN;
  assert.equal(await look(), "hold", "still watching: held");
  busy = { busy: false, why: null };
  clock += MIN;
  assert.equal(await look(), "hold", "a minute of quiet is not enough");
  clock += 2 * MIN;
  assert.equal(await look(), "resume");
  assert.equal(c.resumes, 1);
  assert.equal(c.paused, false);
});

test("paused for half an hour: stopped and put back first in line; it starts again after ten quiet minutes", async () => {
  clock = at(2, 0);
  await look(); await look();
  const c = started[0];
  busy = { busy: true, why: "someone is watching" };
  await look();
  clock += 31 * MIN;
  assert.equal(await look(), "stop");
  await flush();
  assert.match(c.stopped, /paused for too long/);
  assert.equal(R.job, null);
  assert.equal(R.queue[0].key, "ep1|h264", "back at the front");
  assert.equal(R.current.stopped.length, 1);
  busy = { busy: false, why: null };
  clock += 5 * MIN;
  await look(); // (the plan is made again: it has been more than a quarter of an hour)
  assert.equal(await look(), "wait", "five quiet minutes is not ten");
  clock += 6 * MIN;
  assert.equal(await look(), "start");
  assert.equal(started[1].want.key, "ep1|h264");
});

test("the quiet hours end: what is running is stopped, the run is closed and recorded", async () => {
  clock = at(6, 50);
  await look(); await look();
  const c = started[0];
  clock = at(7, 0);
  assert.equal(await look(), "stop");
  await flush();
  assert.match(c.stopped, /quiet hours are over/);
  await look();
  assert.equal(R.current, null);
  const runs = overnight._internals.theState().data.runs;
  assert.equal(runs.length, 1);
  assert.match(runs[0].end, /quiet hours are over/);
  assert.equal(runs[0].stopped.length, 1);
  assert.match(overnight.status().line, /next run 02:00/);
});

test("Run now: outside the hours, nobody watching — it runs, and closes when everything is done", async () => {
  clock = at(15, 0);
  wants = [want("film", "copy", "landed")];
  assert.deepEqual(overnight.runNow(), { ok: true, waiting: null });
  await flush();
  await look();
  assert.equal(started.length, 1);
  started[0].finish();
  await flush();
  await look();
  assert.equal(R.current, null, "closed: nothing left");
  assert.match(overnight._internals.theState().data.runs[0].end, /everything is done/);
  // …and while somebody watches it says it waits
  busy = { busy: true, why: "someone is watching" };
  assert.match(overnight.runNow().waiting, /nobody is watching/);
});

test("a conversion that fails is not tried again the same night", async () => {
  clock = at(2, 0);
  wants = [want("bad")];
  await look(); await look();
  started[0].fail("ffmpeg exited 1");
  await flush();
  assert.equal(R.current.failed.length, 1);
  clock += 16 * MIN; // the plan is made again
  await look(); await flush(); await look();
  assert.equal(started.length, 1, "not started again");
  assert.match(R.lastPlan.skip[0].why, /failed lately/);
});

test("turned off: nothing starts, and a running conversion stops", async () => {
  clock = at(2, 0);
  await look(); await look();
  const r = overnight.setSettings({ on: false });
  assert.equal(r.ok, true);
  await flush();
  assert.match(started[0].stopped, /turned off/);
  assert.equal(await look(), "idle");
  assert.equal(overnight.status().line, "Overnight: off");
  assert.match(overnight.runNow().error, /off/);
});

test("settings: the hours, the budget and the downloads ahead are checked", () => {
  assert.equal(overnight.setSettings({ from: "25:00" }).error, "The hours are written like 02:00.");
  assert.match(overnight.setSettings({ from: "03:00", to: "03:00" }).error, /differ/);
  assert.match(overnight.setSettings({ budgetPct: 80 }).error, /1–50%/);
  assert.match(overnight.setSettings({ aheadEpisodes: 5 }).error, /none, the next episode/);
  const ok = overnight.setSettings({ on: true, from: "01:15", to: "06:00", budgetPct: 20, aheadEpisodes: 1 });
  assert.deepEqual(ok.settings, { on: true, from: "01:15", to: "06:00", budgetPct: 20, aheadEpisodes: 1 });
  assert.deepEqual(overnight.settings(), ok.settings);
  const st = overnight.status();
  assert.equal(st.budget.pct, 20);
  assert.equal(st.budget.bytes, plan.budgetBytes({ freeBytes: 200 * GB, preparedBytes: 0, pct: 20 }));
});

test("the budget holds: only what fits is planned", async () => {
  prepared.freeBytes = () => 15 * GB; // 10% of 15 GB = 1.5 GB: one of the two
  try {
    clock = at(2, 0);
    await look();
    assert.deepEqual(R.queue.map((w) => w.key), ["ep1|h264"]);
    assert.equal(R.lastPlan.skip[0].why, "over the disk budget");
  } finally {
    prepared.freeBytes = () => 200 * GB;
  }
});

test("who plays on which device: kept per person, a real profile only", () => {
  const profiles = require("../src/profiles");
  const real = profiles.list;
  profiles.list = () => [{ id: "p1", name: "P1" }];
  try {
    overnight.sawDevice("p1", "0123456789abcdef", clock);
    overnight.sawDevice("nobody", "0123456789abcdef", clock);
    overnight.sawDevice("p1", "not-an-id", clock);
    const d = overnight._internals.theState().data.devices;
    assert.deepEqual(Object.keys(d), ["p1"]);
    assert.deepEqual(Object.keys(d.p1), ["0123456789abcdef"]);
  } finally {
    profiles.list = real;
  }
});
