// The TV player's start-up tuning (src/lib/tvtuning.js): what config.json's
// "tvPlayer" may say, and what the app is told.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitize, RANGES } = require("../src/lib/tvtuning");

test("nothing set: nothing told — the app keeps the values it was built with", () => {
  for (const raw of [undefined, null, {}, [], "fast", 7, true]) assert.deepEqual(sanitize(raw), {}, JSON.stringify(raw));
});

test("the numbers, inside their ranges, as whole milliseconds", () => {
  assert.deepEqual(sanitize({ startBufferMs: 1000, rebufferMs: 5000 }), { startBufferMs: 1000, rebufferMs: 5000 });
  assert.deepEqual(sanitize({ startBufferMs: 750.4 }), { startBufferMs: 750 });
  assert.deepEqual(sanitize({ startBufferMs: RANGES.startBufferMs[0], rebufferMs: RANGES.rebufferMs[1] }), { startBufferMs: 250, rebufferMs: 20000 });
});

test("a value out of range, or not a number, is dropped — not pushed to an edge nobody chose", () => {
  assert.deepEqual(sanitize({ startBufferMs: 0 }), {});
  assert.deepEqual(sanitize({ startBufferMs: 100 }), {});
  assert.deepEqual(sanitize({ startBufferMs: 60000 }), {});
  assert.deepEqual(sanitize({ startBufferMs: "1000" }), {});
  assert.deepEqual(sanitize({ startBufferMs: NaN, rebufferMs: Infinity }), {});
  assert.deepEqual(sanitize({ rebufferMs: 500 }), {});
});

test("playback never resumes on less than it starts on", () => {
  assert.deepEqual(sanitize({ startBufferMs: 3000, rebufferMs: 2000 }), { startBufferMs: 3000 });
  assert.deepEqual(sanitize({ startBufferMs: 2000, rebufferMs: 2000 }), { startBufferMs: 2000, rebufferMs: 2000 });
});

test("switches are true or false, nothing else; unknown keys never reach the app", () => {
  assert.deepEqual(sanitize({ resumeAtSource: true }), { resumeAtSource: true });
  assert.deepEqual(sanitize({ resumeAtSource: false }), { resumeAtSource: false });
  assert.deepEqual(sanitize({ resumeAtSource: "yes" }), {});
  assert.deepEqual(sanitize({ resumeAtSource: 1 }), {});
  assert.deepEqual(sanitize({ adminPassword: "x", somethingElse: 5, startBufferMs: 800 }), { startBufferMs: 800 });
  assert.deepEqual(sanitize(Object.create({ startBufferMs: 1000, resumeAtSource: true })), {}, "only the object's own keys");
});

// ---- the rendering switches (`tvRender`, docs/qa/native-port/DEVICE-PLAN.md) ----
const { renderFor, RENDER_KEYS } = require("../src/lib/tvtuning");

test("tvRender: nothing set, nothing told — every rendering switch stays off on the TV", () => {
  for (const raw of [undefined, null, {}, [], "on", 1, true]) assert.deepEqual(renderFor(raw, "MiTV-AFMU0"), {}, JSON.stringify(raw));
});

test("tvRender: booleans of known switches only; the preset is a switch like the others", () => {
  assert.deepEqual(renderFor({ recommended: true, pool: false }), { recommended: true, pool: false });
  assert.deepEqual(renderFor({ card: "yes", row: 1, cull: true, x_hero: true, adminPassword: "x" }), { cull: true });
  assert.deepEqual(renderFor(Object.create({ card: true })), {}, "only the object's own keys");
  assert.ok(RENDER_KEYS.includes("recommended") && RENDER_KEYS.includes("cardlayer") && !RENDER_KEYS.includes("grid"));
});

test("tvRender: a model's own entry wins key by key; another model gets the shared keys only", () => {
  const raw = { cull: true, card: false, models: { "MiTV-AFMU0": { recommended: true, card: true, bogus: true }, Other: "x" } };
  assert.deepEqual(renderFor(raw, "MiTV-AFMU0"), { cull: true, card: true, recommended: true });
  assert.deepEqual(renderFor(raw, "Chromecast"), { cull: true, card: false });
  assert.deepEqual(renderFor(raw, undefined), { cull: true, card: false });
  assert.deepEqual(renderFor(raw, "Other"), { cull: true, card: false }, "a model entry that is not an object adds nothing");
  assert.deepEqual(renderFor({ models: { toString: { card: true } } }, "toString"), { card: true }, "own keys only, but any model name");
  assert.deepEqual(renderFor({ models: {} }, "constructor"), {}, "an inherited name is not a model entry");
});

test("the answer carries tvRender only when it names something", () => {
  const cfg = require("../src/config");
  const { current } = require("../src/lib/tvtuning");
  const was = { p: cfg.TV_PLAYER, r: cfg.TV_RENDER };
  try {
    cfg.TV_PLAYER = { startBufferMs: 1000 };
    cfg.TV_RENDER = null;
    const D = { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true };
    assert.deepEqual(current("MiTV-AFMU0"), D);
    cfg.TV_RENDER = { models: { "MiTV-AFMU0": { recommended: true } } };
    assert.deepEqual(current("MiTV-AFMU0"), { ...D, tvRender: { recommended: true } });
    assert.deepEqual(current("Chromecast"), D);
  } finally {
    cfg.TV_PLAYER = was.p;
    cfg.TV_RENDER = was.r;
  }
});

// ---- the measured defaults (the Mi TV device pass, 2026-10-17) ----
const { playerFor, DEFAULT_PLAYER } = require("../src/lib/tvtuning");

test("config.json says nothing: the TV is told the measured start-up", () => {
  const D = { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true };
  assert.deepEqual({ ...DEFAULT_PLAYER }, D);
  for (const raw of [undefined, null, {}, [], "fast", 7, true]) assert.deepEqual(playerFor(raw), D, JSON.stringify(raw));
  assert.ok(Object.isFrozen(DEFAULT_PLAYER));
  const a = playerFor(null); a.startBufferMs = 9; assert.equal(DEFAULT_PLAYER.startBufferMs, 1000, "callers get a copy");
});

test("config.json still wins key by key; an invalid key keeps the default", () => {
  assert.deepEqual(playerFor({ resumeAtSource: false }), { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: false });
  assert.deepEqual(playerFor({ startBufferMs: 2000, rebufferMs: 8000, resumeAtSource: false }), { startBufferMs: 2000, rebufferMs: 8000, resumeAtSource: false }, "the app's own values, back");
  assert.deepEqual(playerFor({ startBufferMs: 3000 }), { startBufferMs: 3000, rebufferMs: 5000, resumeAtSource: true });
  assert.deepEqual(playerFor({ startBufferMs: 100, rebufferMs: "x", resumeAtSource: 1 }), { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true });
  assert.deepEqual(playerFor({ startBufferMs: 5000 }), { startBufferMs: 5000, rebufferMs: 5000, resumeAtSource: true }, "never resumes on less than it starts on");
});
