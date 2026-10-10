// Settings that follow the person, the website's side (public/js/personprefs.js
// — pure, imported as lang.js is in subpick.test.js): what a browser's player
// settings hold for a profile, and the one-time move of the browser's own old
// choice to a profile that has none.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const load = () => import("../public/js/personprefs.js");

test("the profile's choices land in this browser's player settings", async () => {
  const { personPrefsFor } = await load();
  const r = personPrefsFor({
    prefs: { autoplayNext: false, subsDefault: true, subLang: "ru", usageStats: false },
    local: { autoplayNext: true, cueSize: "L" },
    box: {},
    moved: true,
  });
  assert.deepStrictEqual(r.local, { autoplayNext: false, cueSize: "L", subsDefault: true, subLang: "ru" });
  assert.deepStrictEqual(r.owed, {});
  assert.strictEqual(r.changed, true);
});

test("a profile that says nothing gets the defaults — never the last person's values left in the browser", async () => {
  const { personPrefsFor } = await load();
  // the browser's settings still hold what the PREVIOUS profile had (off/off)
  const r = personPrefsFor({ prefs: {}, local: { autoplayNext: false, subsDefault: false, subLang: "he" }, box: {}, moved: false });
  assert.strictEqual(r.local.autoplayNext, true);
  assert.strictEqual(r.local.subsDefault, true);
  assert.strictEqual(r.local.subLang, "he", "the subtitle language keeps its old rule: only a profile that has one overwrites it");
  assert.deepStrictEqual(r.owed, {});
});

test("the one-time move: the browser's own old choice goes to a profile that has none, once", async () => {
  const { personPrefsFor, boxFrom } = await load();
  const box = boxFrom({ autoplayNext: false, subsDefault: true, cueSize: "S" });
  assert.deepStrictEqual(box, { autoplayNext: false, subsDefault: true });
  const first = personPrefsFor({ prefs: {}, local: { autoplayNext: false }, box, moved: false });
  assert.deepStrictEqual(first.owed, { autoplayNext: false }, "off was a real choice; on is only the default and is not sent");
  assert.strictEqual(first.local.autoplayNext, false);
  // already moved for this profile: nothing more is offered, and the profile decides
  const later = personPrefsFor({ prefs: { autoplayNext: true }, local: first.local, box, moved: true });
  assert.deepStrictEqual(later.owed, {});
  assert.strictEqual(later.local.autoplayNext, true);
});

test("the move never overrides a profile that already chose", async () => {
  const { personPrefsFor } = await load();
  const r = personPrefsFor({ prefs: { autoplayNext: true }, local: {}, box: { autoplayNext: false }, moved: false });
  assert.strictEqual(r.local.autoplayNext, true);
  assert.deepStrictEqual(r.owed, {});
});

test("nothing to do is reported as no change (no needless write)", async () => {
  const { personPrefsFor } = await load();
  const r = personPrefsFor({ prefs: { subLang: "en" }, local: { autoplayNext: true, subsDefault: true, subLang: "en" }, box: {}, moved: true });
  assert.strictEqual(r.changed, false);
});

test("both clients agree on which switches are the person's (the TV's table names the website's two)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const tv = fs.readFileSync(path.join(__dirname, "../tv-native/src/personPrefs.ts"), "utf8");
  const server = require("../src/profiles").PREF_SWITCHES;
  for (const k of ["autoplayNext", "subsDefault", "usageStats", "smartDownloads", "smartCleanup"]) {
    assert.ok(server.includes(k), `the server stores ${k}`);
    assert.ok(new RegExp(`^\\s+${k}: true,`, "m").test(tv), `the TV treats ${k} as the person's, default on`);
  }
});
