// "Wrong language": which of a title's other sources are worth offering
// (Niso's report, 2026-10-31: "Problem with this copy: Wrong language"; the
// list it was answered with knew nothing about languages — it was the title's
// usual list, best-seeded first, and a copy in the same wrong language could
// be its ★). PURE: no store, no network, nothing but the arguments.
//
// WHAT IS KNOWN, and it is not much:
//   the copy    the languages its audio streams are tagged with (ffprobe)
//   the title   its original language (TMDB)
//   the person  the audio language they last picked in a player (prefs.audioLang)
//   a source    what its NAME says: Torrentio's flags, and a language word
//               after the film's own title ("Film.2026.1080p.HINDI.WEB-DL")
// Most releases name no language at all, and the file's language can only be
// checked once it is here. So nothing is promised: a source is RIGHT when it
// names a language this person wants, SAME when it names only the language(s)
// of the copy being replaced (or somebody here reported it for the language),
// OTHER when it names another language or says it is a dub, and UNKNOWN when
// it says nothing — which is most of them, and they stay on the list. A
// VOICE-OVER release (voiceOverOf: a Cyrillic name, a voice-over studio) is
// in the voice-over's language, whatever its flags add.
//
//   right     listed first, may be ★, "English" on the row
//   unknown   next, may be ★
//   other     after those, never ★, "Hindi" on the row
//   same      left out: the one thing the person just said they don't want
"use strict";
const { iso1 } = require("../lib/lang");
const { tierOf, _internals: { tokensOf } } = require("./releasekind");

// A language word in a release name → its ISO 639-1 code. The three-letter
// ones count only after the film's own title (see namedIn), like every marker
// in media/releasekind.js.
const WORDS = {
  english: "en", eng: "en",
  hebrew: "he", heb: "he",
  russian: "ru", rus: "ru", ukrainian: "uk", ukr: "uk",
  hindi: "hi", tamil: "ta", telugu: "te", malayalam: "ml", kannada: "kn", bengali: "bn", marathi: "mr", punjabi: "pa",
  italian: "it", ita: "it",
  french: "fr", truefrench: "fr", vff: "fr", vfq: "fr", vfi: "fr",
  german: "de", ger: "de", deutsch: "de",
  spanish: "es", spa: "es", esp: "es", castellano: "es", latino: "es",
  portuguese: "pt", por: "pt", dublado: "pt",
  korean: "ko", kor: "ko", japanese: "ja", jpn: "ja",
  chinese: "zh", chi: "zh", mandarin: "zh", cantonese: "zh",
  turkish: "tr", tur: "tr", arabic: "ar", ara: "ar", polish: "pl", pol: "pl", dutch: "nl", nld: "nl",
  thai: "th", vietnamese: "vi", tagalog: "tl", filipino: "tl", indonesian: "id", persian: "fa", farsi: "fa",
};
// "KOR SUB", "HEB SUBS": that language's SUBTITLES, not its audio
const SUBS_AFTER = /^(?:subs?|subbed|subtitles?)$/i;
// With no year in the name the film's title ends at the first technical word.
const TECH = /^(?:\d{3,4}p|4k|uhd|web|webrip|webdl|web-dl|hdrip|bluray|blu-ray|bdrip|brrip|remux|dvdrip|hdtv|x26[45]|h26[45]|hevc|avc|av1)$/i;

const uniq = (list) => [...new Set(list.filter(Boolean))];

// The language words after the film's own title in one release name.
const namedIn = (line) => {
  const { tokens, from } = tokensOf(line);
  const start = from > 0 ? from : tokens.findIndex((t) => TECH.test(t));
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < tokens.length; i++) {
    const code = WORDS[tokens[i].toLowerCase()];
    if (code && !(tokens[i + 1] && SUBS_AFTER.test(tokens[i + 1]))) out.push(code);
  }
  return out;
};

// The language words in a short free text — an audio track's title ("Russian
// Dub", "English 5.1", "Hebrew AC3"): every word counts, the three-letter ones
// too (a track title has no film title in front to be mistaken for).
const wordsIn = (text) => uniq(String(text || "").toLowerCase().split(/[^a-z]+/).map((w) => WORDS[w]).filter(Boolean));

// Every language a source's name and flags say it has, as ISO 639-1 codes.
const languagesOf = (s) => {
  if (!s) return [];
  const flags = (Array.isArray(s.languages) ? s.languages : []).map(iso1);
  return uniq([...flags, ...namedIn(s.release), ...namedIn(s.filename)]);
};

// A VOICE-OVER release (Dor's report, Haven S3E7, 2026-11-20: "Wrong
// language" was answered with "Тайны Хейвена / Haven [S01-05] (2010-2014)
// WEB-DLRip | Sony Sci-Fi" — a Russian TV channel's voice-over, its sound
// Russian first, the English, if any, a second untagged track). Such a
// release's NAME says what its main sound is, whatever flags it carries
// ("🇷🇺 / 🇬🇧" made it "English" here, so it led the list):
//   * a name written in Cyrillic — a Russian (or, with і ї є ґ, Ukrainian)
//     tracker's release;
//   * a voice-over studio or channel (LostFilm, NewStudio, Кураж-Бамбей,
//     Sony Sci-Fi, …), anywhere in the name — no film is called that;
//   * the Russian trackers' marks for the kind of voice-over — MVO
//     (multi-voice), DVO (two voices), AVO (one author), "дубляж" — after the
//     film's own title.
// → its language (ISO 639-1), or null.
const CYRILLIC = /[Ѐ-ӿ]/;
const UKRAINIAN = /[іїєґІЇЄҐ]/;
const STUDIOS = /(?:^|[^a-z0-9])(?:lostfilm|newstudio|novafilm|baibako|alexfilm|coldfilm|hdrezka|jaskier|amedia|ideafilm|kuraj[\s._-]*bambey|kurazh[\s._-]*bambey|sony[\s._-]*sci[\s._-]*fi|viruse[\s._-]*project|gears[\s._-]*media|rudub|kerob)(?:$|[^a-z0-9])/i;
const VO_MARKS = /^(?:mvo|dvo|avo)$/i;
const voiceOverOf = (s) => {
  if (!s) return null;
  for (const name of [s.release, s.filename]) {
    const line = String(name || "");
    if (!line) continue;
    if (CYRILLIC.test(line)) return UKRAINIAN.test(line) ? "uk" : "ru";
    if (STUDIOS.test(line)) return "ru";
    const { tokens, from } = tokensOf(line);
    const start = from > 0 ? from : tokens.findIndex((t) => TECH.test(t));
    if (start >= 0 && tokens.slice(start).some((t) => VO_MARKS.test(t))) return "ru";
  }
  return null;
};
// "Russian voice-over"
const voiceOverLabel = (code) => `${nameOf(code)} voice-over`;

// What this request is after:
//   wanted  the languages to look for, in order
//   wrong   the languages of the copy being replaced — what the person just
//           said they don't want
// A language that is on the copy cannot be the one they want; when that leaves
// nothing the tags cannot be trusted (a dub tagged "eng") and no source can be
// called "the same".
const fitFor = ({ copy = [], wish = null, original = null } = {}) => {
  const has = uniq(copy.map(iso1));
  const want = uniq([iso1(wish), iso1(original)]);
  const others = want.filter((l) => !has.includes(l));
  if (others.length || !want.length) return { wanted: others, wrong: has };
  return { wanted: want, wrong: [] };
};

// right | same | other | unknown — the header above.
const judge = (s, fit) => {
  const langs = languagesOf(s);
  // a voice-over in a language not wanted is never "right", whatever its
  // flags say: its sound starts in the voice-over's language
  const vo = voiceOverOf(s);
  if (vo && !fit.wanted.includes(vo)) {
    if (fit.wrong.includes(vo) || (s.badHere && s.badHere.reason === "language")) return "same";
    return "other";
  }
  if (vo || langs.some((l) => fit.wanted.includes(l))) return "right";
  if (s && s.badHere && s.badHere.reason === "language") return "same";
  if (langs.length && langs.every((l) => fit.wrong.includes(l))) return "same";
  if (langs.length || (s && s.dubbed)) return "other";
  return "unknown";
};

// "ru" → "Russian" (the code itself if this Node has no name for it).
const nameOf = (code) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || String(code).toUpperCase();
  } catch {
    return String(code).toUpperCase();
  }
};
const namesOf = (codes) => codes.map(nameOf).join(", ");

const RANK = { right: 0, unknown: 1, other: 2 };

// The list for a "Wrong language" request: same-language copies out, right
// ones first, each row told how it fits (`langFit`, `langLabel`), the ★ cleared
// (the caller picks it again from this order) and one sentence for the sheet.
// A pre-release copy stays last whatever it says about its language.
const arrange = (streams, fit) => {
  const kept = [];
  let hidden = 0;
  for (const s of streams || []) {
    const v = judge(s, fit);
    if (v === "same") { hidden++; continue; }
    const langs = languagesOf(s);
    const vo = voiceOverOf(s);
    const label = v === "right"
      ? nameOf(vo && fit.wanted.includes(vo) ? vo : langs.find((l) => fit.wanted.includes(l)))
      : v === "other" ? (vo ? voiceOverLabel(vo) : langs.length ? namesOf(langs) : null) : null;
    const c = { ...s, langFit: v, langLabel: label };
    delete c.recommended;
    // the language wanted here is no dub, whatever a flag made of it
    if (v === "right") c.dubbed = false;
    kept.push(c);
  }
  const rank = (s) => (tierOf(s) === 2 ? 3 : RANK[s.langFit]);
  const list = kept.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
  const wrongNames = fit.wrong.length ? namesOf(fit.wrong) : null;
  let note = null;
  if (!list.length && hidden) note = `Every other version found is ${wrongNames ? `in ${wrongNames}, like this copy` : "reported for its language"}.`;
  else {
    const first = fit.wanted.length ? `Versions in ${namesOf(fit.wanted)} first.` : null;
    const left = hidden ? `${hidden} in ${wrongNames || "the same language"} left out.` : null;
    note = [first, left].filter(Boolean).join(" ") || null;
  }
  return { streams: list, hidden, note };
};

// Any other "Get another version" reason (bad sound, bad picture…): a
// voice-over in a language this person does not watch in (`wanted`: their
// audio language and the title's own) goes below every other copy — a
// pre-release copy stays last — never ★, and says what it is on the row.
const sinkVoiceOver = (streams, wanted = []) => {
  const want = uniq((wanted || []).map(iso1));
  const rows = (streams || []).map((s, i) => {
    const vo = voiceOverOf(s);
    if (!vo || want.includes(vo)) return { s, i, r: tierOf(s) === 2 ? 2 : 0 };
    const c = { ...s, voiceOver: vo, langLabel: s.langLabel || voiceOverLabel(vo) };
    delete c.recommended;
    return { s: c, i, r: tierOf(s) === 2 ? 2 : 1 };
  });
  return rows.sort((a, b) => a.r - b.r || a.i - b.i).map(({ s }) => s);
};

module.exports = { languagesOf, fitFor, judge, arrange, nameOf, namesOf, wordsIn, voiceOverOf, voiceOverLabel, sinkVoiceOver };
