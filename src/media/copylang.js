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
// it says nothing — which is most of them, and they stay on the list.
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

// Every language a source's name and flags say it has, as ISO 639-1 codes.
const languagesOf = (s) => {
  if (!s) return [];
  const flags = (Array.isArray(s.languages) ? s.languages : []).map(iso1);
  return uniq([...flags, ...namedIn(s.release), ...namedIn(s.filename)]);
};

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
  if (langs.some((l) => fit.wanted.includes(l))) return "right";
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
    const label = v === "right"
      ? nameOf(langs.find((l) => fit.wanted.includes(l)))
      : v === "other" ? (langs.length ? namesOf(langs) : null) : null;
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

module.exports = { languagesOf, fitFor, judge, arrange, nameOf };
