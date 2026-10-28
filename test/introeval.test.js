// Skip intro / Up next / Skip recap, measured (tools/intro-eval/run.js) on
// the small synthetic labelled set: what analysis 3 must keep doing, and
// what analysis 2 could not (so a regression shows here first). The full
// set and the real-file evaluation: node tools/intro-eval/run.js / real.js.
const test = require("node:test");
const assert = require("node:assert");
const { evaluate } = require("../tools/intro-eval/run");

let r = null;
test.before(async () => { r = await evaluate({ quick: true }); });

test("intros: found, to the frame, where the old analysis found none", () => {
  const now = r.now.all;
  assert.ok(now.recall >= 0.95, `recall ${now.recall}`);
  assert.equal(now.precision, 1, "an episode with no intro never gets a button");
  assert.ok(now.start.p90 <= 0.5, `start error p90 ${now.start.p90} s`);
  assert.ok(now.end.p90 <= 0.6, `end error p90 ${now.end.p90} s`);
  assert.equal(now.start.late1, 0, "never more than a second late");
  assert.ok(r.before.all.recall < now.recall - 0.5, `before: recall ${r.before.all.recall}`);
  // alone (the newest episode, the rest cleaned away) and urgent (pressed Play)
  assert.equal(r.now.byScenario.alone.recall, 1);
  assert.equal(r.now.byScenario.urgent.recall, 1);
});

test("Up next on time at the credits, and no countdown over a scene after them", () => {
  const now = r.credits.now.all;
  assert.equal(now.recall, 1);
  assert.ok(now.credits.p90 <= 0.5, `credits start error p90 ${now.credits.p90} s`);
  assert.equal(now.upNext.onTime, now.episodes, `${now.upNext.early} early, ${now.upNext.late} late`);
  assert.ok(now.scenes > 0);
  assert.equal(now.countdownOverScene, 0, "a scene after the credits is never counted down over");
  assert.equal(now.sceneFalse, 0);
  assert.equal(r.credits.before.all.countdownOverScene, r.credits.before.all.scenes, "(before: always)");
});

test("Skip recap only where there is a recap; a crowd database's mistakes are not buttons", () => {
  assert.equal(r.recaps.now.wrongShown, 0);
  assert.equal(r.recaps.now.recall, 1);
  assert.ok(r.recaps.before.precision < 0.5, `before: precision ${r.recaps.before.precision}`);
});

test("a database's intro from another cut is moved onto this file; a wrong one is dropped", () => {
  assert.equal(r.database.now.all.precision, 1);
  assert.ok(r.database.now.all.recall >= 0.7, `recall ${r.database.now.all.recall}`);
  assert.ok(r.database.before.all.precision < 0.5, `before: precision ${r.database.before.all.precision}`);
});
