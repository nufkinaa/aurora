// The judgement calls of the public-timestamp module: which database answer
// is trusted, which is dropped, and what counts as a plausible segment.
const test = require("node:test");
const assert = require("node:assert");
const { _internals: s } = require("../src/media/skipsegments");

test("the two response shapes normalise to seconds under Aurora's names", () => {
  const a = s.fromSkipDb({ segments: { intro: { start_ms: 61000, end_ms: 91000, match: "exact", confidence: 0.93 }, recap: null, outro: { start_ms: 2760000, end_ms: 2820000, match: "shifted" }, preview: null } });
  assert.deepEqual(a.intro, { start: 61, end: 91, match: "exact", confidence: 0.93 });
  assert.equal(a.credits.start, 2760, "SkipDB's outro is Aurora's credits");
  const b = s.fromTidb({ intro: [{ start_ms: 228650, end_ms: 246025 }], credits: [{ start_ms: 3431000, end_ms: null }] });
  assert.deepEqual(b.intro, { start: 228.7, end: 246 });
  assert.deepEqual(b.credits, { start: 3431, end: null });
});

test("an exact or shifted SkipDB match is used on its own", () => {
  const out = s.merge({ intro: { start: 61, end: 91, match: "exact" } }, {}, 2820);
  assert.deepEqual(out.intro, { start: 61, end: 91 });
  assert.equal(out.source, "skipdb");
});

test("a lone out-of-range answer is dropped — a wrong Skip button is worse than none", () => {
  const out = s.merge({ intro: { start: 229, end: 246, match: "out-of-range", confidence: 0.6 } }, {}, 3480);
  assert.equal(out.intro, null);
  assert.equal(out.source, null);
});

test("two databases agreeing within 5s rescue an uncertain match", () => {
  const out = s.merge(
    { intro: { start: 229.5, end: 246.5, match: "out-of-range", confidence: 0.6 } },
    { intro: { start: 228.7, end: 246 } },
    3480,
  );
  assert.deepEqual(out.intro, { start: 228.7, end: 246 }, "the matched database's numbers are the ones kept");
  assert.equal(out.source, "skipdb+theintrodb");
});

test("TheIntroDB alone is accepted; a low-confidence agnostic SkipDB guess is not", () => {
  assert.deepEqual(s.merge({}, { recap: { start: 0, end: 62 } }, 2700).recap, { start: 0, end: 62 });
  assert.equal(s.merge({ intro: { start: 30, end: 60, match: "agnostic", confidence: 0.4 } }, {}, 0).intro, null);
  assert.deepEqual(s.merge({ intro: { start: 30, end: 60, match: "agnostic", confidence: 0.8 } }, {}, 0).intro, { start: 30, end: 60 });
});

test("plausibility: intros live early and are short, credits live late", () => {
  assert.equal(s.plausible("intro", { start: 60, end: 120 }, 2700), true);
  assert.equal(s.plausible("intro", { start: 60, end: 62 }, 2700), false, "two seconds is not an intro");
  assert.equal(s.plausible("intro", { start: 2000, end: 2060 }, 2700), false, "not in the second half");
  assert.equal(s.plausible("intro", { start: 60, end: 900 }, 2700), false, "fourteen minutes is not an intro");
  assert.equal(s.plausible("credits", { start: 2600, end: null }, 2700), true);
  assert.equal(s.plausible("credits", { start: 600, end: null }, 2700), false);
  assert.equal(s.plausible("recap", { start: 0, end: 75 }, 2700), true);
});

test("cache keys separate cuts of different length, not jitter of a few seconds", () => {
  assert.equal(s.keyFor("tt1", 1, 2, 2700), s.keyFor("tt1", 1, 2, 2705));
  assert.notEqual(s.keyFor("tt1", 1, 2, 2700), s.keyFor("tt1", 1, 2, 2790));
});
