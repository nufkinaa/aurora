// Player options (2026-10-19): night mode, dialogue boost and the look of
// subtitles — the PERSON's, on the website and on the TV alike.
//   src/profiles.js              PLAYER_OPTIONS: what the profile stores
//   public/js/subStyle.js        the look's table, the site's drawing of it
//   public/js/audiofx.js         the sound: the chain, its numbers, where it cannot work
//   public/js/playerOptions.js   a profile's choices laid into this browser, the one-time move
//   tv-native/src/subStyle.ts    the TV's copy of the look's table (held equal here)
//   tv-native/src/audioFx.ts     the TV's words for the sound (held equal here)
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const profiles = require("../src/profiles");

profiles._internals.store.save = () => {};
const withProfiles = (list, fn) => {
  const keep = profiles._internals.store.data;
  profiles._internals.store.data = { profiles: list, state: {}, pending: [], access: {} };
  try {
    return fn();
  } finally {
    profiles._internals.store.data = keep;
  }
};
const web = (f) => import(`../public/js/${f}`);

// The TV's subStyle.ts, as JavaScript (it has no imports): esbuild strips the
// types. esbuild is an optional dependency — without it this part is skipped.
const tvStyle = async () => {
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch {
    return null;
  }
  const src = fs.readFileSync(path.join(__dirname, "..", "tv-native", "src", "subStyle.ts"), "utf8");
  const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora-tvstyle-")), "subStyle.mjs");
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
};

// ---------------------------------------------------------------- the server
test("the profile stores every player option, by name, inside its set", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    const out = profiles.update("p1", {
      prefs: { nightMode: true, dialogueBoost: false, subSize: "XL", subColor: "yellow", subBg: "outline", subOpacity: 50, subWeight: "normal", subPos: "raised" },
    });
    assert.deepStrictEqual(out.prefs, { nightMode: true, dialogueBoost: false, subSize: "XL", subColor: "yellow", subBg: "outline", subOpacity: 50, subWeight: "normal", subPos: "raised" });
  });
});

test("a value outside its set changes nothing (and the old device keys never land)", () => {
  withProfiles([{ id: "p1", name: "T", prefs: { subSize: "L", nightMode: true } }], () => {
    const out = profiles.update("p1", {
      prefs: { nightMode: "yes", dialogueBoost: 1, subSize: "XXL", subColor: "#ff0000", subBg: "glow", subOpacity: "50", subWeight: 700, subPos: "top", cueSize: "S", cueBackground: false },
    });
    assert.deepStrictEqual(out.prefs, { subSize: "L", nightMode: true });
  });
});

// ------------------------------------------------------- one table, three places
test("the server, the website and the TV have the same choices and the same defaults", async (t) => {
  const s = await web("subStyle.js");
  const a = await web("audiofx.js");
  const { PLAYER_OPTIONS } = profiles;
  assert.deepStrictEqual(Object.keys(PLAYER_OPTIONS).sort(), [...a.AUDIO_FX_KEYS, ...s.SUB_STYLE_KEYS].sort());
  for (const k of s.SUB_STYLE_KEYS) assert.deepStrictEqual(PLAYER_OPTIONS[k], s.SUB_STYLE_CHOICES[k], k);
  for (const k of a.AUDIO_FX_KEYS) assert.deepStrictEqual(PLAYER_OPTIONS[k], [true, false], k);
  for (const [k, v] of Object.entries(s.SUB_STYLE_DEFAULTS)) assert.ok(PLAYER_OPTIONS[k].includes(v), `default ${k}`);

  const tv = await tvStyle();
  if (!tv) return t.skip("esbuild is not installed: the TV's table is not compared");
  assert.deepStrictEqual(tv.SUB_STYLE_DEFAULTS, s.SUB_STYLE_DEFAULTS);
  assert.deepStrictEqual(tv.SUB_STYLE_CHOICES, s.SUB_STYLE_CHOICES);
  // the same words on both screens
  assert.deepStrictEqual(tv.SUB_STYLE_NAMES, s.SUB_STYLE_NAMES);
  assert.deepStrictEqual(tv.SUB_STYLE_LABELS, s.SUB_STYLE_LABELS);
  assert.deepStrictEqual(tv.SUB_STYLE_SETTINGS, s.SUB_STYLE_SETTINGS);
  assert.deepStrictEqual(tv.SUB_COLORS, s.SUB_COLORS);
  assert.deepStrictEqual(tv.styleFromDevice({ cueSize: "L", cueBackground: false }, "web"), s.styleFromDevice({ cueSize: "L", cueBackground: false }, "web"));
});

test("the sound's words and numbers are the TV's too", () => {
  const ts = fs.readFileSync(path.join(__dirname, "..", "tv-native", "src", "audioFx.ts"), "utf8");
  const kt = fs.readFileSync(path.join(__dirname, "..", "tv-native", "android", "app", "src", "main", "java", "com", "auroratv", "audio", "AudioFxCurve.kt"), "utf8");
  return web("audiofx.js").then((a) => {
    for (const k of a.AUDIO_FX_KEYS) {
      assert.ok(ts.includes(`${k}: '${a.AUDIO_FX_NAMES[k]}'`), `TV name of ${k}`);
      assert.ok(ts.includes(`${k}: '${a.AUDIO_FX_NOTES[k]}'`), `TV note of ${k}`);
    }
    const kv = (name) => Number((new RegExp(`const val ${name} = (-?[\\d.]+)f`).exec(kt) || [])[1]);
    assert.strictEqual(kv("NIGHT_THRESHOLD"), a.FX.night.threshold);
    assert.strictEqual(kv("NIGHT_RATIO"), a.FX.night.ratio);
    assert.strictEqual(kv("NIGHT_KNEE"), a.FX.night.knee);
    assert.strictEqual(kv("NIGHT_ATTACK_MS"), a.FX.night.attack * 1000);
    assert.strictEqual(kv("NIGHT_RELEASE_MS"), a.FX.night.release * 1000);
    assert.strictEqual(kv("NIGHT_MAKEUP"), a.FX.night.makeupDb);
    assert.strictEqual(kv("VOICE_DB"), a.FX.dialogue.peakDb);
    assert.strictEqual(kv("LOW_DB"), a.FX.dialogue.lowDb);
    assert.strictEqual(kv("LOW_CUT_HZ"), a.FX.dialogue.lowHz);
    assert.strictEqual(kv("CENTRE_DB"), a.FX.dialogue.centreDb);
    assert.strictEqual(kv("LIM_THRESHOLD"), a.FX.limiter.threshold);
    assert.strictEqual(kv("LIM_RATIO"), a.FX.limiter.ratio);
  });
});

// ---------------------------------------------------------------- the look
test("readStyle: every key, each a real choice; a press steps and wraps", async () => {
  const s = await web("subStyle.js");
  assert.deepStrictEqual(s.readStyle({ subSize: "XL", subColor: "pink", subOpacity: "75" }), { ...s.SUB_STYLE_DEFAULTS, subSize: "XL" });
  assert.strictEqual(s.nextChoice("subSize", "XL"), "S");
  assert.strictEqual(s.nextChoice("subOpacity", 100), 25);
  assert.strictEqual(s.styleLabel("subBg", { subBg: "outline" }), "Outline");
});

test("the ::cue rule draws each background", async () => {
  const s = await web("subStyle.js");
  const box = s.cueCss({ subBg: "box", subOpacity: 50, subColor: "yellow", subWeight: "normal" }, "20px");
  assert.match(box, /font-size: 20px/);
  assert.match(box, /color: #ffe14d/);
  assert.match(box, /background: rgba\(0, 0, 0, 0\.5\)/);
  assert.match(box, /text-shadow: none/);
  assert.match(box, /font-weight: 400/);
  const outline = s.cueCss({ subBg: "outline" }, "20px");
  assert.match(outline, /background: transparent/);
  assert.strictEqual((outline.match(/0 #000/g) || []).length, 8, "eight dark offsets make the outline");
  assert.match(s.cueCss({ subBg: "shadow" }, "1px"), /text-shadow: 0 0\.08em/);
  assert.match(s.cueCss({}, "1px"), /font-weight: 700/, "bold by default");
});

// ------------------------------------------------------- this browser, a profile
test("a profile's choices land in this browser's player settings — never the last person's", async () => {
  const { playerOptionsFor, OPTION_DEFAULTS } = await web("playerOptions.js");
  const r = playerOptionsFor({ prefs: { nightMode: true, subColor: "cyan" }, local: { nightMode: false, subColor: "green", subSize: "XL", autoplayNext: false }, moved: true });
  assert.deepStrictEqual(r.local, { ...OPTION_DEFAULTS, nightMode: true, subColor: "cyan", autoplayNext: false });
  assert.deepStrictEqual(r.owed, {});
  assert.strictEqual(r.changed, true);
  // nothing to do is no change
  assert.strictEqual(playerOptionsFor({ prefs: {}, local: r.local, moved: true }).changed, true, "a profile with nothing gets the defaults");
  assert.strictEqual(playerOptionsFor({ prefs: {}, local: { ...OPTION_DEFAULTS }, moved: true }).changed, false);
});

test("THE MOVE: this browser's old size and dark box go to a profile that has none, once", async () => {
  const { playerOptionsFor } = await web("playerOptions.js");
  const local = { cueSize: "L", cueBackground: false };
  const first = playerOptionsFor({ prefs: {}, local, moved: false });
  assert.deepStrictEqual(first.owed, { subSize: "L", subBg: "none" }, "the site's old 'off' was bare text");
  assert.strictEqual(first.local.subSize, "L");
  // done for this profile: nothing more is offered, the profile decides
  const later = playerOptionsFor({ prefs: { subSize: "M" }, local: first.local, moved: true });
  assert.deepStrictEqual(later.owed, {});
  assert.strictEqual(later.local.subSize, "M");
  // a profile that already chose keeps its choice
  const chose = playerOptionsFor({ prefs: { subSize: "S", subBg: "box" }, local, moved: false });
  assert.deepStrictEqual(chose.owed, {});
  assert.strictEqual(chose.local.subSize, "S");
  // a browser that never changed them offers nothing
  assert.deepStrictEqual(playerOptionsFor({ prefs: {}, local: { cueSize: "M", cueBackground: true }, moved: false }).owed, {});
});

// ---------------------------------------------------------------- the sound
test("switched off, every stage is at its neutral value; on, at the numbers", async () => {
  const a = await web("audiofx.js");
  // (the compressors are set once and crossfaded in: `night` / `limiter` are
  // their shares of the mix)
  assert.deepStrictEqual(a.fxTargets({}), { night: 0, lowDb: 0, peakDb: 0, centre: 0, limiter: 0 });
  const night = a.fxTargets({ nightMode: true });
  assert.strictEqual(night.night, 1);
  assert.strictEqual(night.peakDb, 0, "night mode alone leaves the EQ flat");
  assert.strictEqual(night.limiter, 1);
  assert.strictEqual(a.COMP_DELAY_S, 0.006, "the dry paths wait for the compressors' look-ahead");
  const dlg = a.fxTargets({ dialogueBoost: true });
  assert.strictEqual(dlg.night, 0, "dialogue boost alone does not compress");
  assert.strictEqual(dlg.limiter, 1);
  assert.strictEqual(dlg.peakDb, 6);
  assert.strictEqual(dlg.lowDb, -4);
  // the centre of a 5.1 down-mix: √½ normally, +3 dB with the boost
  assert.ok(Math.abs(20 * Math.log10((Math.SQRT1_2 + dlg.centre) / Math.SQRT1_2) - 3) < 0.01);
  // the compressor's own make-up is taken back out: the night stage gives +6 dB in all
  assert.ok(a.FX_TRIM.night < 0 && a.FX_TRIM.limiter < 0);
  assert.ok(Math.abs(a.autoMakeupDb(a.FX.night) + a.FX_TRIM.night - a.FX.night.makeupDb) < 1e-9);
});

test("where the switches cannot work, they say why: iPhone, iPad, Safari, no Web Audio", async () => {
  const { fxBlocked } = await web("audiofx.js");
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
  for (const ua of [chrome, android, chromeMac, firefox]) assert.strictEqual(fxBlocked({ ua }), null, ua);
  for (const ua of [iphone, safari]) assert.match(fxBlocked({ ua }), /iPhone, iPad or Safari/, ua);
  assert.match(fxBlocked({ ua: chrome, hasCtx: false }), /can't change the sound/);
});
