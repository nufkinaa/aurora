// HEBREW FOR THE SEARCH: what a Hebrew speaker types for an English title.
//
// The library and the catalogues name their titles in English. Someone here
// types "הארי פוטר", "ספיידרמן" or "בריקינג בד" — and before this file found
// nothing. Three things a Hebrew query can be, all pure and sync here (the
// official Hebrew names, fetched from TMDB, are media/hetitles.js):
//
//   1. the English title SPELLED IN HEBREW LETTERS ("פרנדס" = Friends):
//      both sides become a string of SOUNDS, and the two strings are compared
//      with the vowels left out (Hebrew writes few of them). Each sound is a
//      set (a bit mask): ב is b OR v, ש is sh OR s, ח is ch/h/k, a ו in the
//      middle of a word is a v OR a vowel (so it may be left out for free),
//      י likewise y or a vowel, א and ע are vowels (no sound at all). Two
//      sounds match when their sets share a bit. On the English side the
//      spelling becomes its sounds the same way: "ph" is f, "c" is k or s by
//      the next letter, "x" is k+s, a "y" between consonants is a vowel, a
//      silent "gh"/"kn"/"wr" is nothing.
//   2. HEBREW TYPED ON AN ENGLISH KEYBOARD ("vtrh" = "הארי") and English
//      typed on a Hebrew one ("ןמאקרדאקךךשר" = "interstellar"): the keys as
//      the other layout reads them (the Israeli standard layout, SI-1452).
//   3. a Hebrew title: compared as letters, the way English titles are — with
//      the final letters folded (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ: "ספיידרמ" while
//      typing is the start of "ספיידרמן"), the vowel points and the geresh
//      dropped (fold()).
"use strict";

const HEB_LETTER = /[א-ת]/;
const LATIN_LETTER = /[a-z]/i;
const POINTS = /[֑-ֽֿ-ׇ]/g; // cantillation + vowel points (the maqaf U+05BE is a hyphen)
const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const GERESH = /['’׳`]/; // what follows ג/ז/צ/ת to make j / zh / ch / th

const hasHebrew = (s) => HEB_LETTER.test(String(s || ""));
const hebrewCount = (s) => (String(s || "").match(/[א-ת]/g) || []).length;

// Hebrew letters as the search compares them: no points, no geresh/gershayim,
// the maqaf a space, final letters folded. Latin text passes through as it is.
const fold = (s) =>
  String(s == null ? "" : s)
    .replace(POINTS, "")
    .replace(/־/g, " ")
    .replace(/[׳״]/g, "")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c]);

// ---------- keyboard layouts ----------
// The Israeli standard layout: each Latin key and the Hebrew letter it types.
const KEYS_EN = "qwertyuiopasdfghjkl;'zxcvbnm,./";
const KEYS_HE = "/'קראטוןםפשדגכעיחלךף,זסבהנמצתץ.";
const EN_TO_HE = new Map([...KEYS_EN].map((k, i) => [k, KEYS_HE[i]]));
const HE_TO_EN = new Map([...KEYS_HE].filter((c) => HEB_LETTER.test(c)).map((c) => [c, KEYS_EN[KEYS_HE.indexOf(c)]]));

// Latin keys → the Hebrew they type. Null unless the text is ONLY keys of the
// layout (letters and the , . ; keys that are letters there) — a digit or a
// capital is someone writing English on purpose.
const latinToHebrew = (s) => {
  const text = String(s || "").trim();
  if (!text || !/^[a-z;,.' ]+$/.test(text) || !LATIN_LETTER.test(text)) return null;
  let out = "";
  for (const ch of text) out += ch === " " ? " " : EN_TO_HE.get(ch) || "";
  out = out.replace(/\s+/g, " ").trim();
  // a final letter inside a word is not Hebrew (the i, o, l keys type ן ם ך:
  // "interstellar" read as Hebrew keys starts "ןמא…") — English typed on purpose
  if (/[ךםןףץ][א-ת]/.test(out)) return null;
  return hebrewCount(out) >= 3 ? out : null;
};
// Hebrew letters → the Latin keys they sit on. Null unless the text is all
// Hebrew letters and spaces (a geresh or a digit: Hebrew written on purpose).
const hebrewToLatin = (s) => {
  const text = String(s || "").trim().replace(POINTS, "");
  if (!text || !/^[א-ת ]+$/.test(text)) return null;
  let out = "";
  for (const ch of text) out += ch === " " ? " " : HE_TO_EN.get(ch) || "";
  out = out.replace(/\s+/g, " ").trim();
  return /[a-z]{3}/.test(out.replace(/ /g, "")) ? out : null;
};

// ---------- sounds ----------
// One bit per sound class; digits get one each (bits 22-31).
const S = {
  B: 1 << 0, V: 1 << 1, G: 1 << 2, J: 1 << 3, D: 1 << 4, Z: 1 << 5, ZH: 1 << 6, H: 1 << 7,
  X: 1 << 8, T: 1 << 9, Y: 1 << 10, K: 1 << 11, L: 1 << 12, M: 1 << 13, N: 1 << 14, S: 1 << 15,
  SH: 1 << 16, P: 1 << 17, F: 1 << 18, TS: 1 << 19, CH: 1 << 20, R: 1 << 21,
};
const DIGIT = (d) => 1 << (22 + d);

// A sound string: masks, which sounds may be left out for free (opt), where
// each word starts, and how many sounds are NOT optional (req).
// `lead`: per word, does it begin with a vowel ("v"), a consonant ("c") or
// cannot say (null) — Hebrew writes a word's first vowel (א, ע: "אינספשן"),
// so a Hebrew word and an English one that disagree here are not the same word.
const mkKey = () => ({ m: [], o: [], starts: [], lead: [], req: 0 });
const push = (k, mask, opt = false) => {
  k.m.push(mask);
  k.o.push(opt ? 1 : 0);
  if (!opt) k.req++;
};
const finish = (k) => ({ m: Int32Array.from(k.m), o: Uint8Array.from(k.o), starts: k.starts, lead: k.lead, req: k.req, all: k.m.reduce((a, b) => a | b, 0) });
const englishLead = (w) => (/^[aeiou]/.test(w) ? "v" : /^[bcdfgjklmnpqrstvxz]/.test(w) ? "c" : null);
// (ו and י may be a consonant or a vowel; ה may be the article)
const hebrewLead = (w) => (/^[אע]/.test(w) ? "v" : /^[בגדזחטכלמנסעפצקרשת]/.test(w) ? "c" : null);

const VOWEL = new Set(["a", "e", "i", "o", "u"]);
const isVowel = (c) => VOWEL.has(c);

// One English word (a-z0-9 only, already normalised) → its sounds.
const englishWord = (k, w) => {
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1] || "";
    const n2 = w[i + 2] || "";
    const p = i > 0 ? w[i - 1] : "";
    if (c >= "0" && c <= "9") { push(k, DIGIT(c.charCodeAt(0) - 48)); continue; }
    if (isVowel(c)) continue;
    // a doubled consonant is one sound ("potter", "harry")
    if (c === n && c !== "c") continue;
    switch (c) {
      case "y":
        if ((i === 0 && isVowel(n)) || (isVowel(p) && isVowel(n))) push(k, S.Y | S.J);
        break;
      case "w":
        if (i === 0 && n === "r") break; // "wr": the w is silent
        if (isVowel(n) || n === "h") push(k, S.V);
        if (n === "h") i++;
        break;
      case "h":
        if (isVowel(n) || n === "y") push(k, S.H | S.X);
        break;
      case "c":
        if (n === "h") { push(k, S.CH | S.K | S.X | S.SH); i++; }
        else if (n === "k" || n === "c" || n === "q") { push(k, S.K); i++; }
        else if (n === "e" || n === "i" || n === "y") push(k, S.S | S.TS);
        else push(k, S.K);
        break;
      case "s":
        if (n === "c" && n2 === "h") { push(k, S.SH | S.S); push(k, S.K, true); i += 2; }
        else if (n === "h") { push(k, S.SH); i++; }
        else push(k, S.S | S.Z);
        break;
      case "t":
        if (n === "h") { push(k, S.T | S.D); i++; }
        else if (n === "c" && n2 === "h") { push(k, S.CH); i += 2; }
        else if (i > 0 && n === "i" && (n2 === "o" || n2 === "a")) { push(k, S.SH); i++; }
        else if (n === "z") { push(k, S.TS | S.Z); i++; }
        else push(k, S.T);
        break;
      case "p":
        if (n === "h") { push(k, S.F | S.P); i++; }
        else if (i === 0 && n === "s") break; // "ps": the p is silent
        else push(k, S.P);
        break;
      case "g":
        if (n === "h") { if (i === 0) push(k, S.G); i++; }
        else if (i === 0 && n === "n") break; // "gn": silent g
        else if (n === "e" || n === "i" || n === "y") push(k, S.G | S.J);
        else push(k, S.G);
        break;
      case "k":
        if (!(i === 0 && n === "n")) push(k, S.K); // "kn": silent k
        break;
      case "q":
        push(k, S.K);
        if (n === "u") { push(k, S.V, true); i++; }
        break;
      case "x":
        if (i === 0) push(k, S.Z | S.S);
        else { push(k, S.K); push(k, S.S | S.Z); }
        break;
      case "z":
        // (a z is written ז, or צ as in pizza — never ס: "שרק" is not Ozark)
        push(k, S.Z | S.TS);
        break;
      case "d":
        if (n === "g") { push(k, S.J); i++; } else push(k, S.D);
        break;
      case "j": push(k, S.J | S.Y | S.ZH); break;
      case "b":
        if (p === "m" && i === w.length - 1) break; // "lamb", "climb"
        push(k, S.B);
        break;
      case "v": push(k, S.V); break;
      case "f": push(k, S.F); break;
      case "l": push(k, S.L); break;
      case "m": push(k, S.M); break;
      case "n": push(k, S.N); break;
      case "r": push(k, S.R); break;
      default: break;
    }
  }
};

// One Hebrew word (letters, digits, a geresh after a letter) → its sounds.
const hebrewWord = (k, raw) => {
  const w = [...raw];
  const last = w.length - 1;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c >= "0" && c <= "9") { push(k, DIGIT(c.charCodeAt(0) - 48)); continue; }
    if (!HEB_LETTER.test(c)) continue;
    const g = i < last && GERESH.test(w[i + 1]);
    const next = w[i + 1];
    const end = i === last || (g && i + 1 === last);
    switch (c) {
      case "א": case "ע": break; // a vowel, or nothing
      case "ב": push(k, S.B | S.V); break;
      case "ג": push(k, g ? S.J | S.G : S.G); break;
      case "ד": push(k, g ? S.T | S.D : S.D); break;
      case "ה":
        // a vowel at the end ("פאודה"); at the start the article ("המטריקס",
        // "ההוביט") — unless a vowel letter follows: that is an h ("הארי", "הוביט")
        push(k, S.H | S.X, end || (i === 0 && !"אועי".includes(next || "")));
        break;
      case "ו":
        if (next === "ו") { push(k, S.V); i++; }
        else push(k, S.V, i !== 0);
        break;
      case "ז": push(k, g ? S.ZH | S.J | S.Z : S.Z); break;
      case "ח": push(k, S.X | S.H | S.K); break;
      case "ט": push(k, S.T); break;
      case "י":
        if (next === "י") { push(k, S.Y | S.J, true); i++; }
        else push(k, S.Y | S.J, i !== 0);
        break;
      case "כ": case "ך": push(k, S.K | S.X); break;
      case "ל": push(k, S.L); break;
      case "מ": case "ם": push(k, S.M); break;
      case "נ": case "ן": push(k, S.N); break;
      case "ס": push(k, S.S); break;
      case "פ": case "ף": push(k, S.P | S.F); break;
      case "צ": case "ץ": push(k, g ? S.CH : S.TS | S.Z); break;
      case "ק": push(k, S.K); break;
      case "ר": push(k, S.R); break;
      case "ש": push(k, S.SH | S.S); break;
      case "ת": push(k, g ? S.T | S.D : S.T); break;
      default: break;
    }
    if (g) i++;
  }
};

const ARTICLE = new Set(["the", "a", "an"]);
// An English title (normalised words) → its sound key. `starts` lists where
// each word begins; `body` is where the title begins without its article.
const englishKey = (words) => {
  const k = mkKey();
  let body = 0;
  words.forEach((w, i) => {
    k.starts.push(k.m.length);
    k.lead.push(englishLead(w));
    englishWord(k, w);
    if (i === 0 && ARTICLE.has(w) && words.length > 1) body = -1;
  });
  const out = finish(k);
  out.body = body === -1 ? out.starts[1] : 0;
  return out;
};
// A query in Hebrew letters (as typed: geresh and final letters intact) → its
// sound key, or null when it has too few Hebrew letters to say anything.
const hebrewKey = (text) => {
  const t = String(text || "").replace(POINTS, "").replace(/[־\-–]/g, " ");
  if (hebrewCount(t) < 2) return null;
  const k = mkKey();
  for (const word of t.split(/[^א-ת0-9'’׳`]+/).filter(Boolean)) {
    k.starts.push(k.m.length);
    k.lead.push(hebrewLead(word));
    hebrewWord(k, word.replace(/^['’׳`]+/, ""));
  }
  const out = finish(k);
  out.body = 0;
  return out.req >= 2 ? out : null;
};

// ---------- comparing two sound strings ----------
// Edit distance between the query's sounds and the title's from `from`:
// a sound matches a sound it shares a bit with; an optional sound on either
// side may be left out for free. `prefix`: the query may end anywhere in the
// title (still typing). Returns the distance, or max + 1 once it is over.
const ROW_A = new Int16Array(128);
const ROW_B = new Int16Array(128);
const distance = (q, t, from, max, prefix) => {
  const n = q.m.length;
  const end = t.m.length;
  if (n === 0 || n > 120) return max + 1;
  // the title's part that can be matched: never more than the query could
  // still reach (each query sound takes one title sound, the optional ones none)
  let limit = end;
  if (prefix) limit = Math.min(end, from + n + max + 3);
  const width = limit - from;
  if (width <= 0 || width > 120) return max + 1;
  let prev = ROW_A;
  let cur = ROW_B;
  prev[0] = 0;
  for (let j = 1; j <= width; j++) prev[j] = prev[j - 1] + (t.o[from + j - 1] ? 0 : 1);
  for (let i = 1; i <= n; i++) {
    const qm = q.m[i - 1];
    const qdel = q.o[i - 1] ? 0 : 1;
    cur[0] = prev[0] + qdel;
    let rowMin = cur[0];
    for (let j = 1; j <= width; j++) {
      const tj = from + j - 1;
      let v = prev[j - 1] + ((qm & t.m[tj]) !== 0 ? 0 : 1);
      const del = prev[j] + qdel;
      if (del < v) v = del;
      const ins = cur[j - 1] + (t.o[tj] ? 0 : 1);
      if (ins < v) v = ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const x = prev;
    prev = cur;
    cur = x;
  }
  if (!prefix) return Math.min(prev[width], max + 1);
  let best = prev[0];
  for (let j = 1; j <= width; j++) if (prev[j] < best) best = prev[j];
  return Math.min(best, max + 1);
};

// How a Hebrew sound key matches an English title's — the tier search.js
// gives it, or 0. A typo allowance grows with the length: none up to three
// sounds ("שרק" must be Shrek, not every s-r-k), one from four, two from seven.
const SOUND_WHOLE = 870; // the whole title, sound for sound   (פרנדס → Friends)
const SOUND_START = 850; // the start of the title, while typing (ספייד → Spider-Man)
const SOUND_WORD = 780; // a later word of the title             (פוטר → Harry Potter)
const SOUND_SLIP = 640; // the whole title with a slip           (ספיידרמאן)
const SOUND_SLIP_START = 600; // the start of it with a slip
const slipBudget = (req) => (req >= 7 ? 2 : req >= 4 ? 1 : 0);
// The first word begins with a vowel on one side and a consonant on the other
// ("אלאדין" / The Lowdown, "שרק" / Ozark): the sounds may agree, the words do not.
const LEAD_COST = 60;
const leadsDiffer = (q, t, from) => {
  const w = t.starts.indexOf(from);
  const a = q.lead[0];
  const b = w === -1 ? null : t.lead[w];
  return !!a && !!b && a !== b;
};
// `strong`: only the whole title or its start, sound for sound (cheaper: the
// keyboard-layout reading of a query wants nothing looser)
const soundTier = (q, t, strong = false) => {
  if (!q || !t || !t.m.length) return 0;
  const req = q.req;
  const b = strong ? 0 : slipBudget(req);
  // a sound the title does not have at all, more often than the budget allows
  if (b === 0 || req >= 3) {
    let missing = 0;
    for (let i = 0; i < q.m.length; i++) if (!q.o[i] && (q.m[i] & t.all) === 0 && ++missing > b) return 0;
  }
  const heads = t.body ? [0, t.body] : [0];
  let best = 0;
  for (const from of heads) {
    const cost = leadsDiffer(q, t, from) ? LEAD_COST : 0;
    const whole = distance(q, t, from, b, false);
    let got = 0;
    if (whole === 0) got = SOUND_WHOLE;
    else if (req >= 3 && distance(q, t, from, 0, true) === 0) got = SOUND_START;
    else if (whole <= b && req >= 4) got = SOUND_SLIP;
    else if (req >= 5 && b && distance(q, t, from, b, true) <= b) got = SOUND_SLIP_START;
    if (got && got - cost > best) best = got - cost;
  }
  if (best >= SOUND_START || strong) return best;
  if (req >= 3) {
    for (let w = 1; w < t.starts.length; w++) {
      const from = t.starts[w];
      if (from === t.body || from >= t.m.length) continue;
      if (!leadsDiffer(q, t, from) && SOUND_WORD > best && distance(q, t, from, 0, true) === 0) return SOUND_WORD;
    }
  }
  return best;
};

module.exports = {
  hasHebrew, hebrewCount, fold, latinToHebrew, hebrewToLatin, englishKey, hebrewKey, soundTier,
  TIERS: { SOUND_WHOLE, SOUND_START, SOUND_WORD, SOUND_SLIP, SOUND_SLIP_START },
  _internals: { distance, S, englishWord, hebrewWord, slipBudget },
};
