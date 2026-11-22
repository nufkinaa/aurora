// "Wrong language": which of a title's sources are offered (media/copylang.js).
// Niso's report, 2026-10-31: the list ignored the reason, so a copy in the same
// wrong language could be offered, and be its star.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const copylang = require("../src/media/copylang");

const src = (release, over = {}) => ({ infoHash: release, release, filename: release, languages: [], dubbed: false, seeders: 10, ...over });

test("a release says its languages by flags and by words after the film's own title", () => {
  assert.deepEqual(copylang.languagesOf(src("Film.2026.1080p.WEB-DL.x265", { languages: ["RU", "EN"] })), ["ru", "en"]);
  assert.deepEqual(copylang.languagesOf(src("Film.2026.1080p.HINDI.WEB-DL")), ["hi"]);
  assert.deepEqual(copylang.languagesOf(src("Film 2026 1080p Dual Audio Hindi English")), ["hi", "en"]);
  // the BONE release of Niso's report names none: nothing is claimed for it
  assert.deepEqual(copylang.languagesOf(src("40 Dates and 40 Nights 2026 1080p WEB-DL HEVC x265 5.1 BONE")), []);
});

test("a word in the film's own title is not a language, and subtitles are not audio", () => {
  assert.deepEqual(copylang.languagesOf(src("The.French.Dispatch.2021.1080p.WEB")), []);
  assert.deepEqual(copylang.languagesOf(src("The French Dispatch 1080p WEB")), [], "no year: the title ends at the first technical word");
  assert.deepEqual(copylang.languagesOf(src("Film.2026.1080p.KOR.SUB.WEB")), []);
  assert.deepEqual(copylang.languagesOf(src("Hindi Lesson")), [], "no technical word at all: nothing counts");
});

test("what is wanted: the person's language, then the title's; never a language already on the copy", () => {
  assert.deepEqual(copylang.fitFor({ copy: ["rus"], original: "en" }), { wanted: ["en"], wrong: ["ru"] });
  assert.deepEqual(copylang.fitFor({ copy: ["rus"], wish: "heb", original: "en" }), { wanted: ["he", "en"], wrong: ["ru"] });
  // the copy IS in the title's language and the person says it's wrong: they want theirs
  assert.deepEqual(copylang.fitFor({ copy: ["fra"], wish: "eng", original: "fr" }), { wanted: ["en"], wrong: ["fr"] });
  // the tags say it is right, the person says it is not: the tags cannot be trusted
  assert.deepEqual(copylang.fitFor({ copy: ["eng"], original: "en" }), { wanted: ["en"], wrong: [] });
  // nothing known about what is wanted: what the copy is in is still out
  assert.deepEqual(copylang.fitFor({ copy: ["hin"] }), { wanted: [], wrong: ["hi"] });
  // an untagged copy
  assert.deepEqual(copylang.fitFor({ copy: [null, "und"], original: "en" }), { wanted: ["en"], wrong: [] });
});

test("the list: the same wrong language out, the right one first, silent copies next, other languages after", () => {
  const fit = copylang.fitFor({ copy: ["rus"], original: "en" });
  const out = copylang.arrange([
    src("Film.2026.1080p.RUS.WEB", { recommended: true, seeders: 900 }),
    src("Film.2026.1080p.HINDI.WEB", { seeders: 500 }),
    src("Film.2026.1080p.WEB.BONE", { seeders: 50 }),
    src("Film.2026.1080p.ENGLISH.WEB", { seeders: 5 }),
    src("Film.2026.720p.WEB", { seeders: 40, cam: true, prerelease: "cam" }),
  ], fit);
  assert.deepEqual(out.streams.map((s) => s.release), [
    "Film.2026.1080p.ENGLISH.WEB", "Film.2026.1080p.WEB.BONE", "Film.2026.1080p.HINDI.WEB", "Film.2026.720p.WEB",
  ]);
  assert.deepEqual(out.streams.map((s) => s.langFit), ["right", "unknown", "other", "unknown"]);
  assert.equal(out.streams[0].langLabel, "English");
  assert.equal(out.streams[2].langLabel, "Hindi");
  assert.ok(!out.streams.some((s) => s.recommended), "the star is picked again from this order");
  assert.equal(out.hidden, 1);
  assert.equal(out.note, "Versions in English first. 1 in Russian left out.");
});

test("a copy in the wanted language is no dub, even when a flag made it one", () => {
  const fit = copylang.fitFor({ copy: ["eng"], original: "ko" });
  const out = copylang.arrange([src("Film.2026.1080p.WEB", { languages: ["KO"], dubbed: true })], fit);
  assert.equal(out.streams[0].langFit, "right");
  assert.equal(out.streams[0].dubbed, false);
});

test("a release somebody here reported for its language counts as the same wrong language", () => {
  const fit = { wanted: ["en"], wrong: [] };
  assert.equal(copylang.judge(src("Film.2026.1080p.WEB", { badHere: { reason: "language" } }), fit), "same");
  assert.equal(copylang.judge(src("Film.2026.1080p.WEB", { badHere: { reason: "picture" } }), fit), "unknown");
});

test("a dub with no language named sinks, it is not left out", () => {
  const fit = copylang.fitFor({ copy: ["rus"], original: "en" });
  assert.equal(copylang.judge(src("Film.2026.1080p.DUBBED.WEB", { dubbed: true }), fit), "other");
});

test("nothing left: the sentence says why instead of a bare 'no versions'", () => {
  const fit = copylang.fitFor({ copy: ["rus"], original: "en" });
  const out = copylang.arrange([src("Film.2026.1080p.RUS.WEB"), src("Film.2026.720p.RUSSIAN.WEB")], fit);
  assert.deepEqual(out.streams, []);
  assert.equal(out.hidden, 2);
  assert.equal(out.note, "Every other version found is in Russian, like this copy.");
});

test("an empty list is an empty list, and nothing known means no sentence", () => {
  assert.deepEqual(copylang.arrange([], { wanted: [], wrong: [] }), { streams: [], hidden: 0, note: null });
  assert.equal(copylang.arrange([src("Film.2026.1080p.WEB")], { wanted: [], wrong: [] }).note, null);
});

// Dor's report, Haven S3E7 (2026-11-20): "Wrong language" was answered with a
// Russian TV channel's voice-over pack, flagged 🇷🇺 / 🇬🇧 — and so "English",
// first on the list.
const HAVEN_RU = "Тайны Хейвена / Haven [S01-05] (2010-2014) WEB-DLRip | Sony Sci-Fi";
test("a voice-over release: a Cyrillic name, a voice-over studio, or MVO / DVO after the title", () => {
  assert.equal(copylang.voiceOverOf(src(HAVEN_RU)), "ru");
  assert.equal(copylang.voiceOverOf(src("Haven.S03.720p.WEB-DL.Sony.Sci-Fi")), "ru");
  assert.equal(copylang.voiceOverOf(src("Film.2020.1080p.WEB-DL.LostFilm")), "ru");
  assert.equal(copylang.voiceOverOf(src("Show S01 1080p NewStudio")), "ru");
  assert.equal(copylang.voiceOverOf(src("Film.2020.1080p.BDRip.MVO")), "ru");
  assert.equal(copylang.voiceOverOf(src("Film 2020 BDRip 720p DVO")), "ru");
  assert.equal(copylang.voiceOverOf(src("Фильм / Film (2020) BDRip 720p | Кураж-Бамбей")), "ru");
  assert.equal(copylang.voiceOverOf(src("Фільм / Film (2020) WEB-DL 1080p | Ukr")), "uk", "Ukrainian letters: a Ukrainian release");
  // not voice-overs
  assert.equal(copylang.voiceOverOf(src("Haven 2010 Season 3 Complete BDRip 720p x264 [i c]")), null);
  assert.equal(copylang.voiceOverOf(src("Haven (2010) Season 3 S03 (1080p BluRay x265 HEVC 10bit DDP 5.1 EDGE2020)")), null);
  assert.equal(copylang.voiceOverOf(src("Avo.2020.1080p.WEB")), null, "a film called Avo is not a voice-over mark");
  assert.equal(copylang.voiceOverOf(null), null);
});

test("a voice-over is never 'right' for a language it is not, whatever its flags; never ★; labelled", () => {
  const fit = copylang.fitFor({ copy: ["eng"], original: "en" });
  const ru = src(HAVEN_RU, { languages: ["RU", "EN"], seeders: 90 });
  assert.equal(copylang.judge(ru, fit), "other");
  const out = copylang.arrange([ru, src("Haven.2010.S03E07.1080p.BluRay.x264"), src("Haven 2010 Season 3 Complete BDRip 720p x264 [i c]")], fit);
  assert.deepEqual(out.streams.map((s) => s.release), ["Haven.2010.S03E07.1080p.BluRay.x264", "Haven 2010 Season 3 Complete BDRip 720p x264 [i c]", HAVEN_RU], "it goes to the bottom");
  const row = out.streams[2];
  assert.equal(row.langFit, "other");
  assert.equal(row.langLabel, "Russian voice-over");
  // replacing a Russian copy: a Russian voice-over is the same wrong language
  assert.equal(copylang.judge(ru, copylang.fitFor({ copy: ["rus"], original: "en" })), "same");
  // somebody who wants Russian: it is right
  assert.equal(copylang.judge(ru, copylang.fitFor({ copy: ["eng"], wish: "rus", original: "en" })), "right");
  assert.equal(copylang.arrange([ru], copylang.fitFor({ copy: ["eng"], wish: "rus", original: "en" })).streams[0].langLabel, "Russian");
});

test("any other reason: a voice-over not in this person's languages goes to the foot (a pre-release copy still last), never ★", () => {
  const ru = src(HAVEN_RU, { recommended: true, seeders: 90 });
  const en = src("Haven 2010 Season 3 Complete BDRip 720p x264 [i c]");
  const cam = src("Haven.2010.S03E07.HDTS", { cam: true });
  const out = copylang.sinkVoiceOver([ru, cam, en], ["eng", "en"]);
  assert.deepEqual(out.map((s) => s.release), [en.release, HAVEN_RU, cam.release]);
  assert.equal(out[1].recommended, undefined);
  assert.equal(out[1].voiceOver, "ru");
  assert.equal(out[1].langLabel, "Russian voice-over");
  // a Russian speaker keeps it where it was
  assert.deepEqual(copylang.sinkVoiceOver([ru, en], ["ru"]).map((s) => s.release), [HAVEN_RU, en.release]);
  assert.equal(copylang.sinkVoiceOver([ru, en], ["ru"])[0].recommended, true);
});
