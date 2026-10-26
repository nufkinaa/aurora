// What kind of copy a release is, read off its name — "has it really come
// out, and is this a good copy?" (elia, 2026-10-26: "Many times I put a film
// on My List to remember to watch it. But it's a film that hasn't come out in
// good quality yet. You immediately run to download it even if it's a CAM.")
//
// Two things a release name can say that make it a poor pick:
//
//   PRE-RELEASE  a copy made before the film is out at home: filmed in a
//                cinema (CAM, HDCAM, TS / TELESYNC / HDTS), copied off a
//                cinema print (TC / TELECINE), an awards screener (SCR,
//                SCREENER, DVDSCR…), or an early "HC" copy (hardcoded Korean
//                or Chinese subtitles — the leak that comes before the real
//                digital release). Never the best pick, never started by
//                itself; listed last, marked, and a person is asked first.
//   BURNED-IN    subtitles painted into the picture (HC, HARDSUB, hardcoded,
//                KORSUB, "Sub ita hardcoded"…): it cannot be turned off.
//                Pushed below every clean copy and marked.
//
// HOW IT READS A NAME. The name is cut into tokens at dots, spaces, dashes,
// underscores and brackets ("Some.Film.2026.HDTS.x264-GRP" → Some, Film,
// 2026, HDTS, x264, GRP). When a year token is there, only what comes AFTER
// the last one counts: the words before it are the film's own title, and a
// film may well be called "Cam", "Scream" or "TS Eliot". Short markers that
// are also ordinary letters ("TS", "TC", "HC", "CAM") count only in capitals;
// the long ones (HDCAM, TELESYNC, SCREENER, HARDCODED…) in any case. Never a
// piece of a word: "Camille", "Ghosts", "DTS", "Scream", "TCM", ".ts" are not
// markers.
"use strict";

const SPLIT = /[\s._\-[\](){}+,~/\\|]+/;
const YEAR = /^(?:19|20)\d{2}$/;

// kind → the badge and the sentence every client shows (one wording on the
// website and on the TV — the server sends them, the clients print them)
const WORDS = Object.freeze({
  cam: { badge: "CAM", warning: "CAM — filmed in a cinema" },
  telesync: { badge: "TS", warning: "TS — recorded in a cinema" },
  telecine: { badge: "TC", warning: "TC — copied from a cinema reel" },
  screener: { badge: "SCREENER", warning: "Screener — an early preview copy" },
  hc: { badge: "HC", warning: "HC — an early copy with subtitles burned in" },
});
const HARDSUB_WORDS = Object.freeze({ badge: "BURNED-IN SUBS", warning: "Subtitles burned into the picture" });

// token → pre-release kind. `cs`: capitals only. `strong`: a word no film's
// title uses, so it counts wherever it stands in the name (even before the
// year); the others count only after the year.
const PRE = [
  { kind: "cam", cs: /^CAM$/ },
  { kind: "cam", ci: /^(?:HD|HQ|NEW)?CAM(?:RIP)?$/i, not: /^CAM$/i, strong: true },
  { kind: "telesync", cs: /^TS$/ },
  { kind: "telesync", ci: /^(?:HD|HQ)TS(?:RIP)?$/i, strong: true },
  { kind: "telesync", ci: /^TSRIP$/i, strong: true },
  { kind: "telesync", ci: /^TELESYNCH?$/i, strong: true },
  { kind: "telesync", ci: /^P(?:RE)?DVD(?:RIP)?$/i, strong: true },
  { kind: "telecine", cs: /^TC$/ },
  { kind: "telecine", ci: /^HDTC$/i, strong: true },
  { kind: "telecine", ci: /^TELECINE$/i, strong: true },
  { kind: "screener", ci: /^SCR$/i },
  { kind: "screener", ci: /^(?:DVD|BD|WEB|HD)SCR$/i, strong: true },
  { kind: "screener", ci: /^(?:DVD|BD|WEB)?SCREENERS?$/i, strong: true },
];
// burned-in subtitles: one token that says it (strong: anywhere)…
const HARD_ONE = /^(?:HARDSUBS?|HARDSUBBED|HARDCODED|HARDCODE|HARDCODEDSUBS?|KORSUBS?|KORSUBBED|HCSUBS?)$/i;
// …or two that say it together ("Hard Sub", "KOR SUB"), after the year
const HARD_TWO = [
  [/^HARD$/i, /^(?:SUBS?|SUBBED|CODED)$/i],
  [/^KOR$/i, /^(?:SUBS?|SUBBED)$/i],
];

// Every line of a Torrentio `title` that is a name (not the 👤 / 💾 / ⚙️ line
// or the flags), plus the quality line of `name` ("CAM", "SCR", "TeleSync").
const namesOf = (name, title) => {
  const lines = String(title || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/[\u{1F464}\u{1F4BE}⚙]/u.test(l) && !/^[\u{1F1E6}-\u{1F1FF}\s/|]+$/u.test(l));
  const quality = String(name || "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  return { lines, quality };
};

// One name → its tokens, and where the film's own title ends (just after the
// last year token; 0 when there is no year — then every token counts fully).
const tokensOf = (line) => {
  const tokens = String(line || "").split(SPLIT).filter(Boolean);
  let last = -1;
  tokens.forEach((t, i) => { if (YEAR.test(t)) last = i; });
  return { tokens, from: last + 1 };
};

const preKindOf = (token, strongOnly) => {
  for (const r of PRE) {
    if (strongOnly && !r.strong) continue;
    if (r.cs && r.cs.test(token)) return r.kind;
    if (r.ci && r.ci.test(token) && !(r.not && r.not.test(token))) return r.kind;
  }
  return null;
};

// One name → { prerelease: kind | null, hardsub: boolean }
const readName = (line) => {
  const { tokens, from } = tokensOf(line);
  let prerelease = null;
  let hardsub = false;
  // the first marker wins, but a real cinema copy outranks "HC"
  const take = (k) => { if (k && (!prerelease || prerelease === "hc")) prerelease = k; };
  tokens.forEach((t, i) => {
    if (HARD_ONE.test(t)) { hardsub = true; return; }
    if (i < from) { take(preKindOf(t, true)); return; } // still the film's own name
    if (t === "HC") { hardsub = true; take("hc"); return; }
    const next = tokens[i + 1];
    if (next && HARD_TWO.some(([a, b]) => a.test(t) && b.test(next))) { hardsub = true; return; }
    take(preKindOf(t, false));
  });
  return { prerelease, hardsub };
};

// Torrentio's `name` (provider \n quality) and `title` (release \n file …) →
// what kind of copy it is.
//   { prerelease: "cam" | "telesync" | "telecine" | "screener" | "hc" | null,
//     hardsub, cam (any pre-release — the field every client already knows),
//     badge, warning }
const classify = (name, title) => {
  const { lines, quality } = namesOf(name, title);
  let prerelease = null;
  let hardsub = false;
  for (const line of lines) {
    const r = readName(line);
    if (r.hardsub) hardsub = true;
    if (r.prerelease && (!prerelease || prerelease === "hc")) prerelease = r.prerelease;
  }
  // Torrentio's own quality word ("CAM", "SCR", "TeleSync", "TeleCine") is
  // never a film's title: read whole, in any case
  for (const q of quality) {
    for (const t of q.split(SPLIT).filter(Boolean)) {
      const k = /^cam$/i.test(t) ? "cam" : /^ts$/i.test(t) ? "telesync" : /^tc$/i.test(t) ? "telecine" : preKindOf(t);
      if (k && (!prerelease || prerelease === "hc")) prerelease = k;
    }
  }
  const words = prerelease ? WORDS[prerelease] : hardsub ? HARDSUB_WORDS : null;
  return {
    prerelease,
    hardsub,
    cam: !!prerelease,
    badge: words ? words.badge : null,
    warning: words ? words.warning : null,
  };
};

// Sort weight: 0 a clean copy, 1 burned-in subtitles, 2 a pre-release copy.
const tierOf = (s) => (s && (s.cam || s.prerelease) ? 2 : s && s.hardsub ? 1 : 0);

// Can this source be the one picked FOR someone (the ★ Best, a download that
// starts by itself, "Save & watch")? Never a pre-release copy, never a dub.
const pickable = (s) => !!s && !s.cam && !s.prerelease && !s.dubbed;

module.exports = { classify, tierOf, pickable, WORDS, HARDSUB_WORDS, _internals: { tokensOf, readName, namesOf } };
