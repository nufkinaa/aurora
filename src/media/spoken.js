// SPOKEN SEARCH: what a microphone heard, made into what the search reads.
//
// The website (Web Speech API) and the TV app (Android's speech recognition)
// both send the words they heard to /api/search?v=2&voice=1 — the same search
// as typing. This file is the one place that tidies them, so the two clients
// can never read the same sentence two ways.
//
// What a recogniser hands over is a sentence, not a query:
//   "search for the movie Inception"          the command and the kind: Inception
//   "hey Aurora, play Breaking Bad season two episode three"
//                                              Breaking Bad (season 2, episode 3)
//   "Ocean's 11" / "oceans eleven"             numbers: either spelling may be
//                                              the title's, both are tried
//   "nineteen eighty four", "twenty twenty one" years: 1984, 2021
//   "תחפש את הסדרה פאודה עונה שנייה"            Hebrew: the same rules
//
// normalize(text) is PURE (test/spoken.test.js runs it as it is):
//   → { heard, q, candidates: [{ q, via }], season, episode, hebrew }
//   q            the query to search: the title, numbers as digits
//   candidates   the spellings worth asking, best first ("digits", "words",
//                "as-said" — the whole sentence, for a title that starts with
//                a command word: "Show Me a Hero", "Play It Again, Sam")
//   season / episode   what was said about one ("season two episode three");
//                null when nothing was
//
// search(text, opts) asks the engine for each candidate (side by side) and
// keeps the answer whose first card matches best; ties go to the earlier
// spelling. A Hebrew title the library and the catalogues do not know (they
// are in English) is looked up once on the Hebrew Wikipedia, whose page links
// to the English one — "הארי פוטר" → "Harry Potter", "פאודה" → "Fauda" — and
// the English name is searched too (on a budget; remembered for a day).
"use strict";

const HEB = /[א-ת]/;
const NIQQUD = /[֑-ׇ]/g;

// ---------- numbers ----------
const EN_UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_ORD = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};
const EN_WORD = Object.fromEntries(Object.entries(EN_UNITS).map(([w, n]) => [n, w]));
for (const [w, n] of Object.entries(EN_TENS)) if (w !== "fourty") EN_WORD[n] = w;
// 0-99 in words ("11" → "eleven", "21" → "twenty one")
const enWords = (n) => {
  if (EN_WORD[n] != null) return EN_WORD[n];
  if (n > 20 && n < 100) return `${EN_WORD[n - (n % 10)]} ${EN_WORD[n % 10]}`;
  return null;
};

// Hebrew, both genders, and the ordinals ("עונה שנייה"). Read as numbers only
// after a word that wants one (season, episode, part): "שבע" is also "full",
// "שני" is also "Monday".
const HE_NUM = {
  "אחת": 1, "אחד": 1, "ראשון": 1, "ראשונה": 1,
  "שתיים": 2, "שתים": 2, "שניים": 2, "שנים": 2, "שתי": 2, "שני": 2, "שנייה": 2, "שניה": 2,
  "שלוש": 3, "שלושה": 3, "שלישי": 3, "שלישית": 3,
  "ארבע": 4, "ארבעה": 4, "רביעי": 4, "רביעית": 4,
  "חמש": 5, "חמישה": 5, "חמישי": 5, "חמישית": 5,
  "שש": 6, "שישה": 6, "שישי": 6, "שישית": 6,
  "שבע": 7, "שבעה": 7, "שביעי": 7, "שביעית": 7,
  "שמונה": 8, "שמיני": 8, "שמינית": 8,
  "תשע": 9, "תשעה": 9, "תשיעי": 9, "תשיעית": 9,
  "עשר": 10, "עשרה": 10, "עשירי": 10, "עשירית": 10,
  "עשרים": 20,
};

// a token as compared: lower case, the punctuation a recogniser adds around it gone
const core = (t) => t.toLowerCase().replace(NIQQUD, "").replace(/^[("'“”‘’]+|[)"'“”‘’.,!?;:]+$/g, "");
const isDigits = (w) => /^\d{1,4}$/.test(w);

// An English number spoken as words, from words[i]: { value, end } or null.
//   "seven" 7 · "twenty one" / "twenty-one" 21 · "three hundred (and) two" 302
//   "two thousand (and) nineteen" 2019 · years: "nineteen eighty four" 1984,
//   "twenty twenty one" 2021, "twenty ten" 2010, "nineteen oh five" 1905
const small = (w, i) => {
  const a = w[i];
  if (a == null) return null;
  if (EN_UNITS[a] != null) return { value: EN_UNITS[a], end: i + 1 };
  if (EN_TENS[a] != null) {
    const u = EN_UNITS[w[i + 1]];
    if (u != null && u >= 1 && u <= 9) return { value: EN_TENS[a] + u, end: i + 2 };
    return { value: EN_TENS[a], end: i + 1 };
  }
  return null;
};
const hundreds = (w, i) => {
  const s = small(w, i);
  if (!s) return null;
  if (w[s.end] !== "hundred" || s.value < 1 || s.value > 9) return s;
  let value = s.value * 100;
  let end = s.end + 1;
  const at = w[end] === "and" ? end + 1 : end;
  const rest = small(w, at);
  if (rest && rest.value >= 1) { value += rest.value; end = rest.end; }
  return { value, end };
};
const enNumber = (w, i) => {
  const h = hundreds(w, i);
  if (!h) return null;
  if (w[h.end] === "thousand" && h.value >= 1 && h.value < 1000) {
    let value = h.value * 1000;
    let end = h.end + 1;
    const at = w[end] === "and" ? end + 1 : end;
    const rest = hundreds(w, at);
    if (rest && rest.value >= 1) { value += rest.value; end = rest.end; }
    return { value, end };
  }
  // a year said in two halves
  if (h.value >= 11 && h.value <= 20 && h.end === (small(w, i) || {}).end) {
    if (w[h.end] === "oh" || w[h.end] === "o") {
      const u = EN_UNITS[w[h.end + 1]];
      if (u != null && u >= 1 && u <= 9) return { value: h.value * 100 + u, end: h.end + 2 };
    }
    const b = small(w, h.end);
    if (b && b.value >= 10 && b.value <= 99) return { value: h.value * 100 + b.value, end: b.end };
  }
  return h;
};

// The number a keyword is followed by: digits, English words or an ordinal,
// or (Hebrew) a number word. → { value, end } or null
const numberAt = (lw, i) => {
  const w = lw[i];
  if (w == null) return null;
  if (/^\d{1,3}$/.test(w)) return { value: Number(w), end: i + 1 };
  const ord = /^(\d{1,3})(st|nd|rd|th)$/.exec(w);
  if (ord) return { value: Number(ord[1]), end: i + 1 };
  if (EN_ORD[w] != null) return { value: EN_ORD[w], end: i + 1 };
  const en = enNumber(lw, i);
  if (en) return en;
  const he = w.replace(/^ה(?=[א-ת]{2})/, ""); // "העונה השנייה"
  if (HE_NUM[w] != null || HE_NUM[he] != null) {
    let value = HE_NUM[w] != null ? HE_NUM[w] : HE_NUM[he];
    let end = i + 1;
    // "אחת עשרה" 11 … "תשע עשרה" 19, "עשרים ואחת" 21
    const next = lw[end];
    if (value < 10 && (next === "עשרה" || next === "עשר")) { value += 10; end++; }
    else if (value === 20 && next && /^ו/.test(next) && HE_NUM[next.slice(1)] != null && HE_NUM[next.slice(1)] < 10) { value += HE_NUM[next.slice(1)]; end++; }
    return { value, end };
  }
  return null;
};

// ---------- the words around the title ----------
// Said before the title, in any order, any number of them (longest first).
const LEAD = [
  "hey aurora", "hi aurora", "ok aurora", "okay aurora", "aurora",
  "can you please", "could you please", "can you", "could you", "would you", "please",
  "i want to watch", "i wanna watch", "i would like to watch", "i'd like to watch", "let's watch", "lets watch", "let us watch",
  "search for", "search", "look for", "look up", "find me", "find", "show me", "play me", "play", "put on", "watch", "open",
  "the tv show", "the tv series", "the movie", "the film", "the series", "the show", "tv show", "tv series", "movie", "film", "series",
  // Hebrew
  "היי אורורה", "הי אורורה", "אורורה",
  "אני רוצה לראות", "אני רוצה לצפות", "בוא נראה", "בואו נראה", "בוא נצפה", "בואו נצפה",
  "תחפש לי", "תחפשי לי", "תחפש", "תחפשי", "חפש לי", "חפש", "חפשי", "חיפוש",
  "תמצא לי", "תמצאי לי", "תמצא", "תמצאי", "מצא לי", "מצא",
  "תראה לי", "תראי לי", "הראה לי", "תפעיל", "תפעילי", "הפעל", "תנגן", "תנגני", "נגן", "תשים", "תשימי", "שים",
  "תפתח", "תפתחי", "פתח", "בבקשה", "את",
  "הסרט", "הסדרה", "סרט", "סדרה", "סדרת", "סדרת הטלוויזיה",
].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
// Cutting these says nothing about the title: no "as said" spelling for them.
const SOFT = new Set([
  "hey aurora", "hi aurora", "ok aurora", "okay aurora", "aurora", "can you please", "could you please", "can you",
  "could you", "would you", "please", "היי אורורה", "הי אורורה", "אורורה", "בבקשה", "את",
]);
const TAIL = ["please", "thanks", "thank you", "בבקשה", "תודה"].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
const startsWith = (lw, at, phrase) => phrase.every((p, k) => lw[at + k] === p);

const SEASON = /^(?:season|series|[ובה]?עונה|[ובה]?עונת|העונה)$/;
const EPISODE = /^(?:episode|ep|[ובה]?פרק|הפרק)$/;
const OF = new Set(["of", "from", "in", "של", "מ", "מתוך"]);

// ---------- normalize ----------
const normalize = (input) => {
  const heard = String(input == null ? "" : input).replace(NIQQUD, "").replace(/\s+/g, " ").trim().slice(0, 200);
  // "twenty-one", "spider-man": a hyphen between two number words is a space
  const tokens = heard
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/gi, "$1 $2")
    .split(" ")
    .filter(Boolean);
  let lw = tokens.map(core);
  let tk = tokens.slice();
  const said = tk.slice();
  let telling = false; // something that may be part of a title was cut
  const cut = (from, to) => {
    lw = [...lw.slice(0, from), ...lw.slice(to)];
    tk = [...tk.slice(0, from), ...tk.slice(to)];
  };

  // 1. season and episode: "… season two episode three", "s2e3", "עונה 2 פרק 3"
  let season = null;
  let episode = null;
  for (let i = 0; i < lw.length; i++) {
    const se = /^s(\d{1,2})\s*e(\d{1,3})$/.exec(lw[i]);
    if (se) {
      season = Number(se[1]);
      episode = Number(se[2]);
      cut(i, i + 1);
      i--;
      continue;
    }
    const isSeason = SEASON.test(lw[i]);
    if (!isSeason && !EPISODE.test(lw[i])) continue;
    // "the second season" / "העונה השנייה": the number may come first in English
    let n = numberAt(lw, i + 1);
    let from = i;
    let to = n ? n.end : i + 1;
    if (!n && i > 0 && EN_ORD[lw[i - 1]] != null) {
      n = { value: EN_ORD[lw[i - 1]], end: i + 1 };
      from = i - 1 > 0 && lw[i - 2] === "the" ? i - 2 : i - 1;
      to = i + 1;
    }
    if (!n || n.value < 1 || n.value > 99) continue;
    // a season / an episode in the middle of the title is still one when the
    // title goes on with "of": "season 2 of Fauda" → "Fauda"
    telling = true;
    if (isSeason) season = n.value;
    else episode = n.value;
    if (from === 0 && OF.has(lw[to])) to++;
    if (from > 0 && OF.has(lw[from - 1]) && to >= lw.length) from--;
    cut(from, to);
    i = from - 1;
  }

  // 2. the command and the kind, before the title; courtesy after it
  for (let guard = 0; guard < 8; guard++) {
    const p = LEAD.find((ph) => ph.length < lw.length && startsWith(lw, 0, ph));
    if (!p) break;
    cut(0, p.length);
    if (!SOFT.has(p.join(" "))) telling = true;
    // "לצפות בפאודה": the preposition is glued to the title
    if (/^(?:לצפות|נצפה)$/.test(p[p.length - 1]) && /^ב[א-ת]{2}/.test(lw[0] || "")) {
      lw[0] = lw[0].slice(1);
      tk[0] = tk[0].replace(/^([^א-ת]*)ב/, "$1");
    }
  }
  for (let guard = 0; guard < 3; guard++) {
    const p = TAIL.find((ph) => ph.length < lw.length && startsWith(lw, lw.length - ph.length, ph));
    if (!p) break;
    cut(lw.length - p.length, lw.length);
  }
  const stripped = telling;

  // 3. numbers: words → digits (the query), digits → words (the other spelling)
  const digitsOf = (words, lower) => {
    const out = [];
    for (let i = 0; i < words.length; ) {
      const n = HEB.test(lower[i]) ? null : enNumber(lower, i);
      if (n) {
        // keep what was glued to the last word ("eleven's" stays a word)
        const last = words[n.end - 1];
        const trail = /[.,!?;:]+$/.exec(last);
        out.push(String(n.value) + (trail ? trail[0] : ""));
        i = n.end;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    return out;
  };
  // (1-10 the engine reads both ways itself; 11-99 it does not: "Ocean's 11")
  const wordsOf = (words) =>
    words.map((w) => {
      const c = core(w);
      if (!isDigits(c) || c.length > 2 || (Number(c) >= 1 && Number(c) <= 10)) return w;
      const s = enWords(Number(c));
      return s || w;
    });
  const clean = (words) => words.join(" ").replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, "").replace(/\s+/g, " ").trim();
  const q = clean(digitsOf(tk, lw));
  // the title as it was said (number words as words: the catalogues know
  // "Seven" better than "7"), and digits 11-99 in words
  const words = clean(wordsOf(tk));
  const asSaid = stripped ? clean(digitsOf(said, said.map(core))) : "";

  const candidates = [];
  const add = (text, via) => {
    if (!text || candidates.some((c) => c.q.toLowerCase() === text.toLowerCase())) return;
    candidates.push({ q: text.slice(0, 80), via });
  };
  add(q, "digits");
  add(words, "words");
  // (a whole sentence of commands — "search", "play" — is not a title to try)
  if (asSaid && q) add(asSaid, "as-said");
  return { heard, q: q.slice(0, 80), candidates: candidates.slice(0, 3), season, episode, hebrew: HEB.test(q) };
};

// ---------- the Hebrew name of an English title ----------
// One call: Wikipedia's search on the Hebrew site, each page's link to the
// English one. "(film)", "(2010 film)", "(TV series)" are Wikipedia's, not
// the title's. The page taken: the one named exactly what was said ("הארי
// פוטר ואבן החכמים (סרט)" for "הארי פוטר ואבן החכמים"), else the search's
// first — never a later one (for "פאודה" the third is its lead actor).
// (lllimit=max: with a generator the limit counts across ALL the pages —
// lllimit=1 gave one page its link and left the rest without.)
const lazy = require("../lib/lazy");
const upstreamLib = lazy(require, "../lib/upstream");
const UA = { "User-Agent": "Aurora/1.0 (personal media server)" };
let fetchJson = (url, opts) => upstreamLib().json(url, { headers: UA, timeoutMs: 5000, ...opts });
const HE_TTL = 24 * 3600 * 1000;
const HE_BUDGET = 2500;
const heMemo = new Map(); // query → { at, title } (title null: nothing found)
const HE_MAX = 500;
const WIKI_SUFFIX = /\s*\((?:[^()]*\b(?:film|movie|series|miniseries|serial|show|franchise|programme|program|sitcom|season)\b[^()]*)\)\s*$/i;

const englishTitleCached = (q) => {
  const hit = heMemo.get(q);
  return hit && Date.now() - hit.at < HE_TTL ? hit : null;
};
const englishTitle = async (q) => {
  const hit = englishTitleCached(q);
  if (hit) return hit.title;
  const url =
    "https://he.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1" +
    `&generator=search&gsrlimit=4&gsrsearch=${encodeURIComponent(q)}&prop=langlinks&lllang=en&lllimit=max`;
  let title = null;
  try {
    const data = await fetchJson(url, { deadlineMs: HE_BUDGET, ttlMs: HE_TTL });
    const pages = ((data && data.query && data.query.pages) || []).filter((p) => p && typeof p.title === "string");
    const same = (t) => t.replace(NIQQUD, "").replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+/g, " ").trim() === q;
    const page = pages.find((p) => same(p.title)) || pages.find((p) => p.index === 1) || null;
    const link = page && page.langlinks && page.langlinks[0] && (page.langlinks[0].title || page.langlinks[0]["*"]);
    if (link) title = String(link).replace(WIKI_SUFFIX, "").trim() || null;
  } catch {
    return null; // not remembered: the next ask tries again
  }
  if (heMemo.size >= HE_MAX) heMemo.delete(heMemo.keys().next().value);
  heMemo.set(q, { at: Date.now(), title });
  return title;
};

// ---------- search ----------
const STRONG = 900; // the first card's title starts with what was said, or is it
const topTier = (r) => (r && r.results && r.results[0] && r.results[0].match ? r.results[0].match.tier || 0 : 0);
// The better answer: its first card matches better. Two exact names: the
// spoken numbers over the digits, the longer one ("show me a hero" over "a
// hero"). Otherwise the earlier spelling.
// And the sentence as it was said, when a title really starts with it
// ("Star Wars episode 1", "Show Me a Hero"): the words that were cut were
// the title's.
const better = (t, best) => {
  const a = topTier(t.r);
  const b = topTier(best.r);
  if (t.c.via === "as-said" && a >= STRONG && a >= b - 100) return true;
  if (a !== b) return a > b;
  // the same title either way ("seven samurai" / "7 samurai"): the words as
  // they were said, which is how the title is written
  if (a >= 1000 && t.c.via === "words" && best.c.via === "digits") return true;
  return a >= 1000 && t.c.q.split(" ").length > best.c.q.split(" ").length;
};

const search = async (text, opts = {}) => {
  const engine = opts.engine || require("./search");
  const n = normalize(text);
  const spoken = { heard: n.heard, q: n.q, season: n.season, episode: n.episode, via: null };
  if (!n.q) {
    const empty = await engine.search("", opts);
    return { ...empty, q: "", spoken };
  }
  const ask = (c) => Promise.resolve(engine.search(c.q, opts)).then((r) => ({ c, r }), () => null);
  const tries = (await Promise.all(n.candidates.map(ask))).filter(Boolean);
  if (!tries.length) throw new Error("search failed");
  let best = tries[0];
  for (const t of tries) if (better(t, best)) best = t;

  // Hebrew the search does not know: its English name, from Wikipedia
  // (without `wait`: a candidate the catalogue has not answered yet may still
  // win, so the waiting call is owed)
  let pending = tries.some((t) => t.r.pending);
  if (n.hebrew && topTier(best.r) < STRONG) {
    const cached = englishTitleCached(n.q);
    let en = cached ? cached.title : undefined;
    if (en === undefined && opts.wait) en = await englishTitle(n.q);
    else if (en === undefined) pending = true; // the waiting call asks
    if (en && !HEB.test(en)) {
      const t = await ask({ q: en.slice(0, 80), via: "hebrew-title" });
      if (t && better(t, best)) best = t;
      if (t && t.r.pending) pending = true;
    }
  }
  spoken.q = best.c.q;
  spoken.via = best.c.via;
  return { ...best.r, q: best.c.q, pending: opts.wait ? !!best.r.pending : pending, spoken };
};

module.exports = {
  normalize, search,
  _internals: {
    enNumber, numberAt, englishTitle, englishTitleCached,
    _setFetch: (fn) => { fetchJson = fn; heMemo.clear(); },
    _reset: () => heMemo.clear(),
  },
};
