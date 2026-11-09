// The language check's rules (media/langcheck.js): what a finished file's
// audio tracks and release name say, against what the request was after.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/media/langcheck");

const t = (language, title = null) => ({ language, title });

test("right: a track in a wanted language, in any code form", () => {
  assert.equal(L.verdict({ audio: [t("heb")], want: ["he"] }).verdict, "right");
  assert.equal(L.verdict({ audio: [t("rus"), t("eng")], want: ["en"] }).verdict, "right", "one of several dubs is enough");
  assert.equal(L.verdict({ audio: [t("en-US")], want: ["eng"] }).verdict, "right");
});

test("a track's title beats its tag (a dub tagged 'eng')", () => {
  const v = L.verdict({ audio: [t("eng", "Russian Dub")], want: ["en"] });
  assert.equal(v.verdict, "wrong");
  assert.deepEqual(v.has, ["ru"]);
  assert.equal(L.verdict({ audio: [t(null, "Hebrew AC3")], want: ["he"] }).verdict, "right");
});

test("wrong: every track says its language and none is wanted", () => {
  const v = L.verdict({ audio: [t("rus"), t("ukr")], want: ["en"] });
  assert.equal(v.verdict, "wrong");
  assert.deepEqual(v.has, ["ru", "uk"]);
});

test("unknown: untagged audio, no audio read, or the tags and the name disagree", () => {
  assert.equal(L.verdict({ audio: [t("und"), t(null)], want: ["he"] }).verdict, "unknown");
  assert.equal(L.verdict({ audio: null, want: ["he"] }).verdict, "unknown");
  assert.equal(L.verdict({ audio: [], want: ["he"] }).verdict, "unknown");
  assert.equal(L.verdict({ audio: [t("rus"), t(null)], want: ["he"] }).verdict, "unknown", "the untagged track could be the one");
  assert.equal(L.verdict({ audio: [t("eng")], release: "Film.2020.1080p.HEBREW.WEB", want: ["he"] }).verdict, "unknown", "the name claims Hebrew, the tag says English");
});

test("the release name counts when a track says nothing", () => {
  assert.equal(L.verdict({ audio: [t("rus"), t(null)], release: "Film.2020.1080p.HEBREW.WEB-DL", want: ["he"] }).verdict, "right");
});

test("with nothing to look for: wrong only when every track is in the copy-replaced's language", () => {
  assert.equal(L.verdict({ audio: [t("eng")], want: [], wrong: ["en"] }).verdict, "wrong");
  assert.equal(L.verdict({ audio: [t("fre")], want: [], wrong: ["en"] }).verdict, "unknown");
  assert.equal(L.verdict({ audio: [t("eng")], want: [], wrong: [] }).verdict, "unknown");
});

test("the sentences", () => {
  assert.equal(L.UNKNOWN_LINE, "This copy doesn't say its language — report it again if it's wrong.");
  assert.equal(L.lines.lead(["ru"], ["he", "en"]), "That copy was in Russian, not Hebrew or English");
  assert.equal(L.lines.keptWrong(["ru", "uk"], ["en"]), "This copy is in Russian and Ukrainian — no copy in English was found.");
  assert.equal(L.lines.none(["he"], 1), "No copy in Hebrew could be found — the one copy tried was in another language. Try again later.");
  assert.equal(L.lines.none([], 3), "No copy in the right language could be found — the 3 copies tried were in another language. Try again later.");
});
