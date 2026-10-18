// Write less (server round 2026-10-18, STORAGE): a store that changes on
// every tick is written on a cadence, not after every change.
//   - lib/jsonstore.js save({ within }): "this may wait up to N ms"; an
//     ordinary save() still brings the write forward; flush/flushAll write it
//     at once; prepare/afterWrite/digestOnLoad/beforeFlushAll hooks.
//   - telemetry.js: a live viewing session is written when it starts, ends,
//     on a seek, and otherwise at most once a minute.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const js = require("../src/lib/jsonstore");
const { JsonStore } = js;
const I = js._internals;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-cadence-"));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
const forget = (s) => { if (s.saveTimer) clearTimeout(s.saveTimer); if (s.retryTimer) clearTimeout(s.retryTimer); I.instances.delete(s); };

test("save({ within }) waits up to that long; a plain save() brings it forward; nothing is lost", async (t) => {
  const dir = tmp();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = new JsonStore(path.join(dir, "ticks.json"), {});
  try {
    for (let i = 0; i < 50; i++) { s.data.n = i; s.save({ within: 60000 }); }
    t.mock.timers.tick(I.DEBOUNCE_MS + 10);
    await s.idle();
    assert.equal(s.writes, 0, "a routine change does not wait only the debounce");
    assert.equal(s.dirty, true, "it is marked unwritten all the same");
    t.mock.timers.tick(60000);
    await s.idle();
    assert.equal(s.writes, 1, "written once within the minute");
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, "utf8")).n, 49, "with the latest value");

    s.data.n = 50; s.save({ within: 60000 });
    t.mock.timers.tick(1000);
    s.data.n = 51; s.save(); // something that matters: the debounce, not the minute
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await s.idle();
    assert.equal(s.writes, 2, "a plain save brings the pending write forward");
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, "utf8")).n, 51);

    s.data.n = 52; s.save(); s.save({ within: 60000 }); // a later 'within' never delays a sooner write
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await s.idle();
    assert.equal(s.writes, 3);

    s.data.n = 53; s.save({ within: 60000 });
    js.flushAll(); // what a shutdown does
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, "utf8")).n, 53, "a shutdown writes what is waiting");
    assert.equal(s.saveTimer, null);
  } finally {
    forget(s);
    rm(dir);
  }
});

test("prepare fills the data in before a write, afterWrite hears the text the disk holds, digestOnLoad keeps the md5", () => {
  const dir = tmp();
  const file = path.join(dir, "built.json");
  try {
    const heard = [];
    let source = { a: 1 };
    const s = new JsonStore(file, {}, { prepare() { s.data = { ...source }; }, afterWrite: (text) => heard.push(text) });
    s.save();
    s.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
    assert.deepEqual(heard, ['{"a":1}']);
    s.flush(); // nothing changed: skipped, but the disk holds it, so it is heard again
    assert.equal(s.skipped, 1);
    assert.equal(heard.length, 2);
    source = { a: 2 };
    s.flush();
    assert.equal(heard[2], '{"a":2}');
    forget(s);

    const again = new JsonStore(file, {}, { digestOnLoad: true });
    assert.equal(again.loadedMd5, js.md5('{"a":2}'), "the md5 of exactly what was read");
    forget(again);
    const plain = new JsonStore(file, {});
    assert.equal(plain.loadedMd5, null, "only when asked for");
    forget(plain);
  } finally {
    rm(dir);
  }
});

test("a beforeFlushAll hook runs before the stores are flushed", () => {
  const dir = tmp();
  try {
    const s = new JsonStore(path.join(dir, "late.json"), {});
    let ran = false;
    js.beforeFlushAll(() => { ran = true; s.data.byHook = true; s.dirty = true; });
    js.flushAll();
    assert.equal(ran, true);
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, "utf8")).byHook, true, "what the hook changed is written by the same flush");
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ telemetry.js

const telemetryPath = require.resolve("../src/telemetry");
const loadTelemetry = () => {
  const calls = { "watch-sessions.json": [], "telemetry-hours.json": [] };
  const Real = js.JsonStore;
  js.JsonStore = class {
    constructor(filePath, fallback) {
      this.name = path.basename(filePath);
      this.filePath = path.join(os.tmpdir(), "aurora-cadence-never-written", this.name);
      this.data = typeof fallback === "function" ? fallback() : JSON.parse(JSON.stringify(fallback));
    }
    save(opts) { (calls[this.name] || (calls[this.name] = [])).push(opts && opts.within ? `within ${opts.within}` : "now"); }
    flush() { this.save(); }
  };
  delete require.cache[telemetryPath];
  let tel;
  try { tel = require("../src/telemetry"); } finally { js.JsonStore = Real; }
  return { tel, calls };
};

test("a live viewing session: written at its start, at a seek, at its end — every other report waits up to a minute", () => {
  const { tel, calls } = loadTelemetry();
  try {
    const w = calls["watch-sessions.json"];
    w.length = 0; // (boot: a fresh folder writes once)
    const client = { id: "c1", profile: "Ann", ip: "10.0.0.2", device: { device: "TV" } };
    const r = tel.onWatch(client, "A film", 100, 7200);
    assert.equal(r.started, true);
    assert.deepEqual(w, ["now"], "the start is written straight away");
    tel.onWatch(client, "A film", 105, 7200);
    tel.onWatch(client, "A film", 110, 7200);
    assert.deepEqual(w.slice(1), [`within ${tel.LIVE_WRITE_MS}`, `within ${tel.LIVE_WRITE_MS}`], "playback ticks wait");
    tel.onWatch(client, "A film", 1500, 7200); // jumped 23 minutes ahead
    assert.equal(w[3], "now", "a seek is written straight away");
    tel.onWatch(client, "A film", 200, 7200); // and back
    assert.equal(w[4], "now");
    const s = tel.sessions.data[0];
    assert.equal(s.position, 200, "memory always has the latest");
    tel.onStopWatching("c1");
    assert.equal(w[5], "now", "the end is written straight away");
    assert.equal(s.live, false);
    assert.equal(tel.LIVE_WRITE_MS, 60000, "the documented window");
  } finally {
    delete require.cache[telemetryPath];
  }
});

test("isSeek: steady playback, a pause and small drifts are not seeks", () => {
  const { tel } = loadTelemetry();
  try {
    const { isSeek } = tel._internals;
    const t0 = 1_000_000;
    assert.equal(isSeek(100, t0, 105, t0 + 5000), false, "five seconds on");
    assert.equal(isSeek(100, t0, 100, t0 + 600000), false, "paused for ten minutes");
    assert.equal(isSeek(100, t0, 95, t0 + 5000), false, "a small step back");
    assert.equal(isSeek(100, t0, 60, t0 + 5000), true, "back 40 s");
    assert.equal(isSeek(100, t0, 140, t0 + 5000), true, "ahead 40 s in 5 s");
    assert.equal(isSeek(null, t0, 140, t0 + 5000), false, "no position known");
  } finally {
    delete require.cache[telemetryPath];
  }
});

test("telemetry-hours.json: written when an hour closes (and at shutdown) — not every 30 s sample", (t) => {
  const { tel, calls } = loadTelemetry();
  try {
    const h = calls["telemetry-hours.json"];
    const HOUR = 3600 * 1000;
    const start = Date.UTC(2026, 9, 18, 10, 59, 0); // one minute before an hour closes
    try {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
    } catch {
      t.skip("this Node has no Date in its mock timers");
      return;
    }
    tel.start(() => ({ clients: 2, watching: 1 }));
    assert.equal(h.length, 1);
    assert.match(h[0], /^within \d+$/, "the first sample waits");
    assert.ok(Number(h[0].split(" ")[1]) <= 60 * 1000 + 5000, "at most until the hour closes (+ a grace)");
    t.mock.timers.tick(tel.SAMPLE_MS); // 10:59:30
    assert.match(h[1], /^within/, "a sample inside the same hour waits too");
    t.mock.timers.tick(tel.SAMPLE_MS); // 11:00:00 — a new hour
    assert.equal(h[2], "now", "the closed hour is written");
    for (let i = 0; i < 10; i++) t.mock.timers.tick(tel.SAMPLE_MS);
    assert.ok(h.slice(3).every((c) => c.startsWith("within")), "and the open one waits again");
    const key = new Date(start + HOUR).toISOString().slice(0, 13);
    assert.ok(tel.hourly.data[key].samples >= 10, "memory has every sample (the admin page reads memory)");
    assert.equal(tel._internals.msToNextHour(Date.UTC(2026, 0, 1, 5, 45, 0)), 15 * 60 * 1000);
  } finally {
    t.mock.timers.reset();
    delete require.cache[telemetryPath];
  }
});
