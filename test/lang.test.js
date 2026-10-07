// src/lib/lang.js: ffprobe's three-letter audio tags against TMDB's two-letter
// original language — the match that picks the original dub.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { iso1, sameLanguage } = require("../src/lib/lang");

test("iso1 folds 639-2 and regional tags to 639-1", () => {
  assert.equal(iso1("eng"), "en");
  assert.equal(iso1("heb"), "he");
  assert.equal(iso1("fre"), "fr");
  assert.equal(iso1("fra"), "fr");
  assert.equal(iso1("en-US"), "en");
  assert.equal(iso1("pt_BR"), "pt");
  assert.equal(iso1("ja"), "ja");
  assert.equal(iso1("und"), null);
  assert.equal(iso1(null), null);
  assert.equal(iso1("xyz"), null);
});

test("sameLanguage says whether a track is in the title's language", () => {
  assert.equal(sameLanguage("eng", "en"), true);
  assert.equal(sameLanguage("heb", "he"), true);
  assert.equal(sameLanguage("jpn", "en"), false);
  assert.equal(sameLanguage(null, "en"), false);
  assert.equal(sameLanguage("eng", null), false);
  assert.equal(sameLanguage("und", "und"), false, "unknown never matches unknown");
});
