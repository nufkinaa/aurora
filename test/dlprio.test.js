// Priority classes, ageing, the start plan and pre-empting
// (media/dlprio.js). Pure — plain data in, decisions out.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/media/dlprio");

const MIN = 60 * 1000;
const cfg = P.DEFAULTS;

test("classes: watching now, asked for, next episode, background", () => {
  const t = 1e12;
  assert.equal(P.baseClass({ smart: false }, t), P.PERSON);
  assert.equal(P.baseClass({ smart: true, auto: "next" }, t), P.AUTO);
  assert.equal(P.baseClass({ smart: true }, t), P.AUTO, "an older smart job is a next episode");
  assert.equal(P.baseClass({ smart: true, auto: "follow" }, t), P.BACKGROUND);
  assert.equal(P.baseClass({ smart: true, auto: "mylist" }, t), P.BACKGROUND);
  assert.equal(P.baseClass({ smart: true, urgentUntil: t + 1 }, t), P.NOW, "the next episode of what is playing");
  assert.equal(P.baseClass({ smart: false, urgentUntil: t - 1 }, t), P.PERSON, "urgency runs out");
  assert.equal(P.baseClass({ smart: false, infoHash: "ABC" }, t, new Set(["abc"])), P.NOW, "a download being streamed as it lands");
});

test("ageing: one class up per 30 min waited, never past PERSON (only a viewer makes NOW)", () => {
  assert.equal(P.effectiveClass(P.BACKGROUND, 29 * MIN, cfg), P.BACKGROUND);
  assert.equal(P.effectiveClass(P.BACKGROUND, 30 * MIN, cfg), P.AUTO);
  assert.equal(P.effectiveClass(P.BACKGROUND, 61 * MIN, cfg), P.PERSON);
  assert.equal(P.effectiveClass(P.BACKGROUND, 10 * 3600e3, cfg), P.PERSON);
  assert.equal(P.effectiveClass(P.PERSON, 10 * 3600e3, cfg), P.PERSON);
  assert.equal(P.effectiveClass(P.NOW, 0, cfg), P.NOW);
});

test("order: class first, then whoever has waited longest", () => {
  const out = P.order([
    { id: "new-person", cls: 1, since: 300 },
    { id: "old-auto", cls: 2, since: 100 },
    { id: "old-person", cls: 1, since: 200 },
    { id: "now", cls: 0, since: 900 },
  ]).map((w) => w.id);
  assert.deepEqual(out, ["now", "old-person", "new-person", "old-auto"]);
});

test("plan: the setting is the cap; a stalled job is not in `holders`, so the next one starts", () => {
  const waiting = [{ id: "w1", cls: 1, since: 1, key: "h1" }, { id: "w2", cls: 1, since: 2, key: "h2" }];
  // four running, all healthy: nothing starts
  const holders = ["a", "b", "c", "d"].map((k) => ({ id: k, key: k, cls: 1 }));
  assert.deepEqual(P.plan({ cap: 4, holders, waiting }, cfg).start, []);
  // one of them stalled (the queue leaves it out of holders): one starts
  assert.deepEqual(P.plan({ cap: 4, holders: holders.slice(1), waiting }, cfg).start, ["w1"]);
});

test("plan: episodes of ONE pack count once, and a waiting sibling of a running pack is free", () => {
  const holders = [{ id: "e1", key: "pack", cls: 1 }, { id: "e2", key: "pack", cls: 1 }];
  const waiting = [{ id: "e3", key: "pack", cls: 1, since: 1 }, { id: "film", key: "f", cls: 1, since: 2 }];
  assert.deepEqual(P.plan({ cap: 2, holders, waiting }, cfg).start, ["e3", "film"], "the pack is one slot of two");
});

test("plan: NOW jumps the queue, the hold while people watch and the per-account limit — up to two past the setting", () => {
  const holders = [1, 2, 3, 4].map((i) => ({ id: `r${i}`, key: `r${i}`, cls: 1, owner: "p" }));
  const waiting = [
    { id: "person", cls: 1, since: 1, key: "x", owner: "q" },
    { id: "next1", cls: 0, since: 5, key: "n1", owner: "p" },
    { id: "next2", cls: 0, since: 6, key: "n2", owner: "p" },
    { id: "next3", cls: 0, since: 7, key: "n3", owner: "p" },
  ];
  const p = P.plan({ cap: 2, setting: 4, holders, waiting, perOwner: 3 }, cfg);
  assert.deepEqual(p.start, ["next1", "next2"], "two NOW jobs past the setting of 4, the third waits; the person waits for a slot");
  assert.ok(!p.overLimit.includes("next1"));
});

test("plan: the per-account limit counts a pack once", () => {
  const holders = [{ id: "a", key: "pack", cls: 1, owner: "p" }, { id: "b", key: "pack", cls: 1, owner: "p" }, { id: "c", key: "c", cls: 1, owner: "p" }];
  const waiting = [{ id: "d", key: "d", cls: 1, owner: "p", since: 1 }, { id: "e", key: "e", cls: 1, owner: "p", since: 2 }];
  const p = P.plan({ cap: 6, holders, waiting, perOwner: 3 }, cfg);
  assert.deepEqual(p.start, ["d"], "pack + c + d = three");
  assert.deepEqual(p.overLimit, ["e"]);
});

test("quick: small, well seeded and minutes away at this line's speed — elia's 'less than a gig'", () => {
  const ok = P.quickEstimate({ sizeBytes: 900e6, seeders: 80, lineBps: 50e6 }, cfg);
  assert.equal(ok.quick, true);
  assert.ok(ok.etaMs < 6 * MIN);
  assert.equal(P.quickEstimate({ sizeBytes: 4e9, seeders: 500, lineBps: 50e6 }, cfg).quick, false, "too big");
  assert.equal(P.quickEstimate({ sizeBytes: 600e6, seeders: 3, lineBps: 50e6 }, cfg).quick, false, "too few seeders");
  const slowLine = P.quickEstimate({ sizeBytes: 1.2e9, seeders: 100, lineBps: 1e6 }, cfg);
  assert.equal(slowLine.quick, false, "a slow line makes it minutes too many");
  assert.match(slowLine.why, /min/);
  assert.equal(P.quickEstimate({ sizeBytes: 0, seeders: 100 }, cfg).quick, false, "unknown size: not quick");
});

test("live check: after 90 s, an ETA over 15 min ends the hold; a stall ends it at once", () => {
  assert.equal(P.liveVerdict({ runMs: 30e3, etaMs: 60 * MIN }, cfg), "keep", "too early to judge");
  assert.equal(P.liveVerdict({ runMs: 100e3, etaMs: 60 * MIN }, cfg), "end");
  assert.equal(P.liveVerdict({ runMs: 100e3, etaMs: 4 * MIN }, cfg), "keep");
  assert.equal(P.liveVerdict({ runMs: 10e3, etaMs: 1, stalled: true }, cfg), "end");
});

test("victims: lower classes only, never the same torrent, a person's download only within its budget", () => {
  const running = [
    { id: "auto", cls: 2, key: "a" },
    { id: "person", cls: 1, key: "b", heldMs: 0 },
    { id: "tired", cls: 1, key: "c", heldMs: 20 * MIN },
    { id: "sibling", cls: 1, key: "pack" },
    { id: "other-now", cls: 0, key: "d" },
    { id: "bg-tired", cls: 3, key: "e", heldMs: 99 * MIN },
  ];
  assert.deepEqual(P.victims({ urgentKeys: new Set(["pack"]), running }, cfg), ["auto", "person", "bg-tired"]);
});

test("held time is counted inside the window only", () => {
  const t = 10 * 3600e3;
  const spans = [{ from: t - 5 * 3600e3, to: t - 4.5 * 3600e3 }, { from: t - 30 * MIN, to: t - 20 * MIN }, { from: t - 5 * MIN }];
  assert.equal(P.heldWithin(spans, t, cfg), 15 * MIN);
});
