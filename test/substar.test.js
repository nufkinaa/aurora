// The subtitle menu's ★ (media/scanner.js starBest): ONE track per language
// marked "Matches this release", only where the evidence says so.
//   "mark ONE best track PER LANGUAGE … an EMBEDDED track (inside the file)
//    is preferred for its language unless empty/broken or forced-only (a
//    forced-narrative track never wins the star for full subtitles)" (owner)
const test = require("node:test");
const assert = require("node:assert/strict");
const { starBest } = require("../src/media/scanner");

const starred = (tracks) => starBest(tracks.map((t) => ({ ...t }))).filter((t) => t.star).map((t) => t.label);

test("an embedded track wins its language; a checked sidecar wins where there is none", () => {
  assert.deepEqual(starred([
    { label: "Hebrew", lang: "he", timing: { verdict: "in-time", by: "audio", r: 0.5 } },
    { label: "Hebrew 2", lang: "he", embedded: true },
    { label: "English", lang: "en", timing: { verdict: "moved", by: "audio", r: 0.4 } },
  ]), ["Hebrew 2", "English"]);
});

test("among sidecars: in time beats moved beats matched in parts; the better match among equals", () => {
  assert.deepEqual(starred([
    { label: "Hebrew", lang: "he", timing: { verdict: "parts", r: 0.6 } },
    { label: "Hebrew 2", lang: "he", timing: { verdict: "moved", r: 0.3 } },
    { label: "Hebrew 3", lang: "he", timing: { verdict: "moved", r: 0.45 } },
  ]), ["Hebrew 3"]);
  assert.deepEqual(starred([
    { label: "Hebrew", lang: "he", timing: { verdict: "moved", r: 0.6 } },
    { label: "Hebrew 2", lang: "he", timing: { verdict: "in-time", by: "track" } },
  ]), ["Hebrew 2"]);
});

test("no evidence, no ★: unchecked or unmatched sidecars, the file's own timing after an undo", () => {
  assert.deepEqual(starred([
    { label: "Hebrew", lang: "he" },
    { label: "Hebrew 2", lang: "he", timing: { verdict: "unmatched" } },
    { label: "Hebrew 3", lang: "he", timing: { verdict: "original" } },
  ]), []);
});

test("an embedded track found empty, matching nothing, or off (served as the file has it) loses its claim", () => {
  const side = { label: "English", lang: "en", timing: { verdict: "in-time", r: 0.4 } };
  for (const timing of [{ verdict: "unmatched" }, { verdict: "in-time", cues: 3 }, { verdict: "moved", r: 0.5 }]) {
    assert.deepEqual(starred([{ label: "English 2", lang: "en", embedded: true, timing }, side]), ["English"], JSON.stringify(timing));
  }
  // …unless a Resync moved it: then it is served lined up
  assert.deepEqual(starred([{ label: "English 2", lang: "en", embedded: true, timing: { verdict: "moved", resync: true, r: 0.5 } }, { ...side, timing: { verdict: "parts", r: 0.6 } }]), ["English 2"]);
});

test("a forced / signs track never wins the ★ for full subtitles, nor an SDH one over a full one", () => {
  assert.deepEqual(starred([
    { label: "English (Forced)", lang: "en", embedded: true, forced: true },
    { label: "English", lang: "en", timing: { verdict: "moved", r: 0.3 } },
  ]), ["English"]);
  assert.deepEqual(starred([
    { label: "English (Forced)", lang: "en", embedded: true, forced: true },
    { label: "Signs & Songs", lang: "en", embedded: true },
  ]), [], "only forced kinds: no ★ at all");
  assert.deepEqual(starred([
    { label: "English (SDH)", lang: "en", embedded: true, sdh: true },
    { label: "English", lang: "en", timing: { verdict: "in-time" } },
  ]), ["English"]);
  assert.deepEqual(starred([{ label: "English (SDH)", lang: "en", embedded: true, sdh: true }]), ["English (SDH)"], "SDH when it is the language's best kind");
});

test("one ★ per language, never on a track without a language", () => {
  const out = starBest([
    { label: "Hebrew", lang: "he", embedded: true },
    { label: "Hebrew 2", lang: "he", embedded: true },
    { label: "Track 3", embedded: true },
  ]);
  assert.deepEqual(out.map((t) => !!t.star), [true, false, false]);
  assert.equal(out[0].starWhy, "Matches this release");
});
