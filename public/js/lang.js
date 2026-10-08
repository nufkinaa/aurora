// The household's three subtitle / audio languages, told from a track.
// PURE — no imports, no DOM. tv-native/src/lang.ts is this file with types;
// src/profiles.js carries the same rule in miniature for the server's
// whitelist. Change one, change all three (test/subpick.test.js holds them
// together).
//
// Why it exists (2026-10-08): the player used to remember the subtitle you
// picked as the track's own LABEL — "Hebrew 2", "English - SDH", "English 9" —
// and find it again by exact equality, so "Hebrew 2" never matched an episode
// that only had "Hebrew". elia: "we should remember Hebrew and English and
// Russian that's ok." So what is remembered is the LANGUAGE, for those three.

// Language tags as they arrive: ISO 639-1 ("he"), 639-2 ("heb"), the old "iw".
const CODES = { he: "he", heb: "he", iw: "he", en: "en", eng: "en", ru: "ru", rus: "ru" };

// "eng" → "en", "en-US" → "en", "HEB" → "he"; null for every other language.
export const langCode = (tag) => {
  if (typeof tag !== "string") return null;
  const c = tag.trim().toLowerCase().split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(CODES, c) ? CODES[c] : null;
};

// A label in words. The names match anywhere ("Hebrew 2", "English - SDH",
// "English [Forced]", "עברית"); the three-letter codes only as a word of their
// own ("ENG", "movie.heb"), so "Belarusian" is not Russian.
const WORDS = [
  ["he", /hebrew|עבר|(?:^|[^a-z])heb(?:[^a-z]|$)/i],
  ["en", /english|(?:^|[^a-z])eng(?:[^a-z]|$)/i],
  ["ru", /russian|русск|(?:^|[^a-z])rus(?:[^a-z]|$)/i],
];
const wordLang = (text) => {
  let best = null;
  let at = Infinity;
  for (const [code, re] of WORDS) {
    const m = re.exec(text);
    if (m && m.index < at) {
      at = m.index;
      best = code;
    }
  }
  return best;
};
const CODE_SHAPED = /^[a-z]{2,3}(?:[-_][a-z0-9]+)*$/i;

// A subtitle or audio track → "he" | "en" | "ru" | null.
// The track's language tag decides when it has one (a tag for ANOTHER language
// is an answer too: null). Library tracks carry no tag at all, only the label
// the scanner made — so the label is read next.
export const langOf = (track) => {
  if (!track) return null;
  const tag = String(track.lang || track.language || "").trim();
  if (tag && !/^(und|mis|zxx|mul)$/i.test(tag)) {
    const c = langCode(tag);
    if (c) return c;
    if (CODE_SHAPED.test(tag)) return null; // "fre", "pt-BR": some other language
    const w = wordLang(tag); // a tag written out: "Hebrew"
    if (w) return w;
  }
  const label = String(track.label || "").trim();
  if (!label) return null;
  if (CODE_SHAPED.test(label)) {
    const c = langCode(label); // a label that is only a code: "en", "heb"
    if (c) return c;
  }
  return wordLang(label);
};

// What is stored as `subPick`, read back: "off" | "he" | "en" | "ru" | null.
// Reads every shape an older build wrote — a tag ("eng"), a label ("Hebrew 2",
// "English - SDH") — and ignores what it cannot place (null = nothing
// remembered).
export const normPick = (value) => {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === "off") return "off";
  return langCode(v) || langOf({ label: v });
};

// What a hand-picked subtitle track is remembered as: "off" for none, its
// language when it is one of the three, else null — NOT remembered. A French
// or untagged "Track 4" pick is a one-off for this title: it neither replaces
// nor clears the household language, which would otherwise be lost to one
// curious press.
export const pickOf = (track) => (track ? langOf(track) : "off");

// How good a default a track is, within its language: 0 a full track,
// 1 SDH / closed captions (sound descriptions nobody asked for), 2 forced /
// signs / commentary (only part of the dialogue).
export const trackRank = (track) => {
  const l = String((track && track.label) || "");
  if (/forced|(?:^|[^a-z])signs?(?:[^a-z]|$)|songs|commentary/i.test(l)) return 2;
  if (/(?:^|[^a-z])(?:sdh|cc)(?:[^a-z]|$)|hearing|closed.?caption/i.test(l)) return 1;
  return 0;
};

// The index of the best track in `lang`, -1 when the title has none.
// Best = lowest rank; among equals the FIRST in the list, which is what the
// players always did (findIndex) and what the server's ordering means:
// sidecar / fetched files before the file's embedded streams, "Hebrew" before
// "Hebrew 2".
export const bestTrackIndex = (tracks, lang) => {
  let best = -1;
  let rank = 9;
  if (!lang || lang === "off") return -1;
  for (let i = 0; i < (tracks || []).length; i++) {
    if (langOf(tracks[i]) !== lang) continue;
    const r = trackRank(tracks[i]);
    if (r < rank) {
      rank = r;
      best = i;
    }
  }
  return best;
};

// What a picked dub is remembered as (`audioLang`): the normalised code for
// the three, else the file's own tag, lowercased — dubs in other languages
// are legitimate and carry over too.
export const audioPick = (tag) => {
  if (typeof tag !== "string" || !tag.trim()) return null;
  return langCode(tag) || tag.trim().toLowerCase();
};
// Whether a track's tag is the remembered dub: "heb" is "he" is "iw".
export const sameAudio = (tag, liked) => {
  const a = audioPick(tag);
  const b = audioPick(liked);
  return !!a && !!b && a !== "und" && a === b;
};
