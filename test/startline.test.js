// A play's start-up, step by step from the press on Play (public/js/startline.js,
// the players' "start-up" mark → src/lib/playmarks.js recordStart/startSummary,
// the admin's App health → Slow starts, and a problem report's context).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../public/js/startline.js");

test("the steps become ms from the press, in order, and the slowest gap is named", async () => {
  const { startupOf, stepsText } = await load();
  const s = startupOf({ press: 1000, at: { open: 1020, item: 1100, history: 1110, mount: 1130, decide: 1135, ask: 1140, byte: 61140, frame: 61400 }, path: "jit", srv: { seg: 59800, playlist: 12 } });
  assert.deepEqual(s.steps.map(([n]) => n), ["open", "item", "history", "mount", "decide", "ask", "byte", "frame"]);
  assert.equal(s.total, 60400);
  assert.equal(s.slow, "byte");
  assert.equal(s.slowMs, 60000);
  assert.deepEqual(s.srv, { playlist: 12, seg: 59800 });
  assert.equal(stepsText(s), "open:20,item:100,history:110,mount:130,decide:135,ask:140,byte:60140,frame:60400");
});

test("a step that happened before the one listed ahead of it (a request sent before the player was built) is not counted back in time", async () => {
  const { startupOf } = await load();
  const s = startupOf({ press: 0, at: { open: 5, item: 40, ask: 30, mount: 60, frame: 900 } });
  assert.deepEqual(s.steps, [["open", 5], ["item", 40], ["mount", 60], ["ask", 60], ["frame", 900]]);
  assert.equal(s.slow, "frame");
});

test("no press, no steps: nothing", async () => {
  const { startupOf } = await load();
  assert.equal(startupOf({}), null);
  assert.equal(startupOf({ press: 5, at: {} }), null);
});

test("resource timing: the first request for the film after the press, the first byte of the film itself, and what the server said", async () => {
  const { firstMedia, serverSide } = await load();
  const isMedia = (u) => /\/stream\//.test(u);
  const e = [
    { name: "/stream/transcode/x/jit/master.m3u8", startTime: 50, responseStart: 60, serverTiming: [{ name: "app", duration: 3 }] }, // a warm-up before the press
    { name: "/api/item/x", startTime: 120, responseStart: 130 },
    { name: "/stream/transcode/x/jit/index.m3u8?v=copy", startTime: 140, responseStart: 160, serverTiming: [{ name: "app", duration: 9 }] },
    { name: "/stream/transcode/x/jit/seg00000.ts?v=copy", startTime: 170, responseStart: 2100, serverTiming: [{ name: "app", duration: 1900 }, { name: "seg", duration: 1880 }] },
  ];
  assert.deepEqual(firstMedia(e, isMedia, 100), { ask: 140, byte: 2100 });
  assert.deepEqual(serverSide(e.slice(2), isMedia), { playlist: 9, seg: 1880 });
});

test("the server keeps start-ups apart from plays, and says which step makes the slow ones slow", () => {
  const pm = require("../src/lib/playmarks");
  pm._reset();
  const now = Date.now();
  pm.recordStart({ id: "a", extra: { steps: "open:10,item:40,mount:60,decide:70,ask:80,byte:400,frame:500", path: "direct" }, now });
  pm.recordStart({ id: "b", extra: { steps: "open:10,item:40,mount:60,decide:70,ask:80,byte:58000,frame:58400", path: "jit", seg: "57000" }, now });
  pm.recordStart({ id: "c", extra: { steps: "open:10,item:9000,mount:9050,frame:9600", path: "jit" }, now });
  pm.recordStart({ id: "d", extra: { steps: "junk:1,frame:x" }, now }); // nothing usable: not kept
  const s = pm.startSummary(undefined, now);
  assert.equal(s.n, 3);
  assert.equal(s.slow.n, 2);
  assert.deepEqual(s.slow.byStep, { byte: 1, item: 1 });
  assert.equal(s.byPath.jit.n, 2);
  assert.equal(s.recent[0].id, "c");
  assert.equal(s.recent[1].seg, 57000);
  assert.ok(s.stepP50.byte.p50 >= 320);
  assert.equal(pm.list().length, 0, "a start-up is not a play of its own");
  pm._reset();
});

test("a problem report keeps the start-up and the marks' meaning (why, rendition, stage)", () => {
  const reports = require("../src/routes/reports");
  const r = reports.add({
    text: "took ages", quiet: true,
    context: {
      playMarks: [{ name: "decision", ms: 3, why: "hevc-in-mkv → copy first" }, { name: "stall", ms: 900, stage: "nudge", junk: "x".repeat(500) }],
      startup: { total: 91000, slow: "byte", path: "jit", steps: [["open", 10], ["byte", 90000], ["frame", 91000], ["<script>", 1]], srv: { seg: 88000 } },
    },
  });
  assert.equal(r.context.playMarks[0].why, "hevc-in-mkv → copy first");
  assert.equal(r.context.playMarks[1].stage, "nudge");
  assert.equal(r.context.playMarks[1].junk, undefined);
  assert.deepEqual(r.context.startup, { total: 91000, slow: "byte", path: "jit", steps: [["open", 10], ["byte", 90000], ["frame", 91000]], srv: { seg: 88000 } });
});
