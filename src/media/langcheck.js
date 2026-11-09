// Is a finished download in the language it was fetched for? (Niso's report,
// 2026-10-31: a copy in the wrong language, and the replacement Aurora picked
// named no language in its title — so it could land in the wrong language
// again.) PURE: the caller (media/downloads.js completeJob) brings what
// ffprobe read off the file and what the request was after.
//
// WHAT THE FILE SAYS, per audio track:
//   its title, when it names a language ("Russian Dub", "English 5.1") — a
//   title is written by a person and beats the tag (a dub tagged "eng" is
//   common);
//   else its language tag ("eng", "heb"; "und" and the like say nothing).
// And the release name, which can name a language too ("…HEBREW.1080p…").
//
// THE VERDICT:
//   right    a track is in a wanted language; or some track says nothing and
//            the release name names a wanted language
//   wrong    every track says its language and none is wanted (and the name
//            does not claim one) — or, with nothing to look for, every track
//            is in a language of the copy being replaced
//   unknown  everything else: no audio read, untagged tracks, or the tags and
//            the name disagree. Nothing is thrown away on a guess.
"use strict";
const { iso1 } = require("../lib/lang");
const copylang = require("./copylang");

const uniq = (list) => [...new Set(list.filter(Boolean))];

// The languages one audio track says it is in ([] when it does not say).
const trackLangs = (t) => {
  if (!t) return [];
  const byTitle = copylang.wordsIn(t.title);
  if (byTitle.length) return byTitle;
  const tag = iso1(t.language);
  return tag ? [tag] : [];
};

// → { verdict, has, named, untagged }
//   audio    [{ language, title }] as ffprobe read them (null: not read)
//   release  the release name the copy was listed under
//   want     the languages it should be in (any form: "eng", "en", "he")
//   wrong    the languages it should NOT be in (the copy being replaced)
const verdict = ({ audio, release = null, want = [], wrong = [] } = {}) => {
  const wanted = uniq((want || []).map(iso1));
  const notWanted = uniq((wrong || []).map(iso1));
  const named = copylang.languagesOf({ release });
  const tracks = Array.isArray(audio) ? audio.map(trackLangs) : [];
  const untagged = tracks.filter((l) => !l.length).length;
  const has = uniq(tracks.flat());
  const out = (v) => ({ verdict: v, has, named, untagged });
  if (!tracks.length) return out("unknown");
  if (wanted.length && has.some((l) => wanted.includes(l))) return out("right");
  const nameSaysWanted = wanted.length && named.some((l) => wanted.includes(l));
  if (untagged > 0) return out(nameSaysWanted ? "right" : "unknown");
  // every track says its language, and none is a wanted one
  if (wanted.length) return out(nameSaysWanted ? "unknown" : "wrong");
  if (notWanted.length && has.every((l) => notWanted.includes(l))) return out("wrong");
  return out("unknown");
};

// "Russian", "Russian and Hindi"; "English or Hebrew"
const list = (codes, joiner) => {
  const names = uniq(codes).map(copylang.nameOf);
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
};

// The sentences — said the same on the website, the TV and the phone, because
// the server sends them (publicJob `langLine`, the download's `note`).
const UNKNOWN_LINE = "This copy doesn't say its language — report it again if it's wrong.";
const lines = {
  unknown: () => UNKNOWN_LINE,
  // the copy given up on, as the download's status line leads with it
  lead: (has, want) => `That copy was in ${list(has, "and")}${want.length ? `, not ${list(want, "or")}` : ""}`,
  // landed anyway: no other copy could be found
  keptWrong: (has, want) => `This copy is in ${list(has, "and")} — no copy in ${list(want, "or")} was found.`,
  // the end: every copy that could be found was in another language
  none: (want, n) => `No copy in ${list(want, "or") || "the right language"} could be found — ${n === 1 ? "the one copy tried was" : `the ${n} copies tried were`} in another language. Try again later.`,
};

module.exports = { verdict, trackLangs, lines, UNKNOWN_LINE, _internals: { list } };
