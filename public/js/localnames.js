// Files from THIS device (js/localplay.js): what a file's NAME says — the
// title under the release junk ("The.Matrix.1999.1080p.BluRay.x264-YIFY" →
// "The Matrix", 1999), the show, season and episode of an episode
// ("The.Office.US.S01E02", "Breaking Bad - 1x02", "שטיסל עונה 2 פרק 5"),
// and which video each subtitle file belongs to ("Film.mkv" + "Film.he.srt",
// "Film.Hebrew.srt", "Film.en.forced.srt", "Film.2.srt", an episode code when
// the names differ, a lone subtitle beside a lone video).
// PURE — no DOM, no imports: test/localnames.test.js runs it under Node.

const YEAR_MAX = new Date().getFullYear() + 2;
const isYear = (t) => /^(19|20)\d{2}$/.test(t) && +t <= YEAR_MAX;

// ---------- release junk ----------
// A HARD tag starts the junk wherever it stands (after the first word):
// resolutions, sources, codecs, audio, the release sites.
const HARD = new Set([
  "4k", "8k", "uhd", "bluray", "blu-ray", "bdrip", "brrip", "bdremux", "remux", "web-dl", "webdl", "webrip", "web-rip", "hdrip", "dvdrip",
  "dvdscr", "dvd5", "dvd9", "hdtv", "pdtv", "sdtv", "hdcam", "hdts", "telesync", "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx",
  "av1", "vp9", "10bit", "8bit", "10-bit", "hdr10", "hdr10+", "hdr10plus", "dovi", "atmos", "truehd", "dts", "dts-hd", "dts-x", "aac", "ac3",
  "eac3", "ddp", "dd", "ddp5", "dd5", "aac2", "mp3", "flac", "yify", "yts", "rarbg", "ettv", "eztv", "amzn", "nf", "dsnp", "hmax", "atvp",
  "pcok", "pmtp", "itunes", "nflx", "1080i",
]);
// A SOFT tag is junk only when another tag comes right after it ("Charlotte's
// Web" is a title, "Film.WEB.x264" is not).
const SOFT = new Set([
  "web", "hd", "sd", "cam", "ts", "tc", "r5", "dvd", "hdr", "dv", "sdr", "proper", "repack", "rerip", "extended", "unrated", "uncut",
  "remastered", "imax", "internal", "limited", "multi", "dual", "dubbed", "subbed", "hardsub", "hc", "complete", "directors", "dc",
  "theatrical", "opus", "dolby", "vision", "hulu", "max", "stan", "ma", "ita", "eng", "heb", "hebrew", "english", "russian", "rus",
]);
const RES = /^\d{3,4}[pi]$/;
const hard = (t) => {
  const l = t.toLowerCase();
  if (RES.test(l) || HARD.has(l)) return true;
  // "x265-RARBG", "HEVC-EVO", "WEB-DL": the part before the group's dash
  const head = l.split("-")[0];
  return head !== l && (RES.test(head) || HARD.has(head) || head === "web");
};
const soft = (t) => SOFT.has(t.toLowerCase());

const SMALL = new Set(["a", "an", "and", "of", "the", "in", "on", "at", "to", "for", "or", "vs", "with", "from", "by"]);
// all-lowercase Latin ("game of thrones") → "Game of Thrones"; anything that
// already has a capital, or another script, is left as written
const titleCase = (s) =>
  /[A-Z]/.test(s) || !/[a-z]/.test(s)
    ? s
    : s.split(" ").map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

const DOT = "․"; // (a one-dot leader: stands in for a dot inside a number)
const undot = (s) => s.split(DOT).join(".");
// The bits every name loses first: brackets of tags ("[YTS.MX]", "[1080p]"),
// a site in front ("www.Site.org - "), dotted codec names that would split.
const prep = (base) =>
  String(base || "")
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|me|to|mx|tv|ru|cc|se)\s+-\s+/i, "")
    .replace(/\[((?:19|20)\d{2})\]/g, " $1 ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b([hx])\.(26[45])\b/gi, "$1$2")
    .replace(/\b(aac|ac3|dd|ddp|eac3|dts|truehd|opus|flac)[ .]?([257])\.([01])\b/gi, "$1")
    .replace(/[()]/g, " ")
    // "Robot 2.0": a dot between two digits is part of the number, not a separator
    .replace(/\b(\d{1,2})\.(?=\d{1,2}\b)/g, `$1${DOT}`);

const tokensOf = (s) => s.split(/[\s._]+/).filter(Boolean);
// Where the junk starts in a list of words: the first HARD tag, a SOFT one with
// a tag after it, or the year (the last one, so "2001.A.Space.Odyssey.1968"
// keeps "2001") — never the first word.
const isTag = (x) => hard(x) || soft(x) || /^-+$/.test(x);
const cutAt = (toks) => {
  let cut = toks.length;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (hard(t) || (soft(t) && i + 1 < toks.length && (hard(toks[i + 1]) || soft(toks[i + 1])))) { cut = i; break; }
    // a year with nothing but tags after it ends the title
    if (isYear(t) && toks.slice(i + 1).every(isTag)) return { cut: i, year: +t };
  }
  // the year just before the tags ("Movie.2019.Directors.Cut.1080p")
  for (let i = cut - 1; i >= 1; i--) {
    if (isYear(toks[i])) {
      if (toks.slice(i + 1, cut).every((x) => isTag(x) || /^[a-z]+$/i.test(x)) && cut - i <= 3) return { cut: i, year: +toks[i] };
      break;
    }
  }
  for (let i = cut; i < toks.length; i++) if (isYear(toks[i])) return { cut, year: +toks[i] };
  return { cut, year: null };
};
const join = (toks) =>
  undot(toks.join(" ")).replace(/\s+-\s*$|^\s*-\s+/g, "").replace(/\s{2,}/g, " ").replace(/^[\s\-–—,:]+|[\s\-–—,:]+$/g, "").trim();

// A film's name → { title, year }
export const cleanTitle = (base) => {
  const toks = tokensOf(prep(base));
  if (!toks.length) return { title: String(base || "").trim(), year: null };
  const { cut, year } = cutAt(toks);
  const title = titleCase(join(toks.slice(0, cut)));
  return { title: title || join(toks) || String(base || "").trim(), year };
};

// ---------- episodes ----------
// The code and where it stands, in the name with its separators made spaces.
const EP_RULES = [
  // S01E02, S01 E02, S01E02E03, s1e2
  [/(?:^| )s(\d{1,2}) ?e(\d{1,3})(?:[ -]?e(\d{1,3}))?(?= |$)/i, (m) => [+m[1], +m[2], m[3] ? +m[3] : null]],
  // 1x02
  [/(?:^| )(\d{1,2})x(\d{2,3})(?= |$)/i, (m) => [+m[1], +m[2], null]],
  // Season 1 Episode 2
  [/(?:^| )season ?(\d{1,2})[ ,-]*(?:episode|ep|e) ?(\d{1,3})(?= |$)/i, (m) => [+m[1], +m[2], null]],
  // עונה 2 פרק 5
  [/(?:^| )עונה ?(\d{1,2})[ ,-]*פרק ?(\d{1,3})(?= |$)/, (m) => [+m[1], +m[2], null]],
  // Episode 2, Ep 02, E02, פרק 5
  [/(?:^| )(?:episode|ep|e(?=\d)) ?(\d{1,3})(?= |$)/i, (m) => [null, +m[1], null]],
  [/(?:^| )פרק ?(\d{1,3})(?= |$)/, (m) => [null, +m[1], null]],
  // "[Group] Show - 05 (1080p)": the numbered episodes of a season-less show
  [/ - (\d{2,3})(?:v\d)?(?= |$)/, (m) => [null, +m[1], null]],
];
const SEASON_DIR = /^(?:season|series|staffel|saison|temporada|s|עונה)[ ._-]?(\d{1,2})$/i;
const SUB_DIR = /^(?:subs?|subtitles?|כתוביות)$/i;
const dirParts = (dir) => String(dir || "").split("/").filter(Boolean);

// A video's name (and the folder it came from) → what it is:
//   { kind: "film", title, year }  or
//   { kind: "episode", show, season, episode, episode2, epTitle, year, title }
export const parseName = (fileName, dir = "") => {
  const base = String(fileName || "").replace(/\.[^.]+$/, "");
  const spaced = prep(base).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, pick] of EP_RULES) {
    const m = re.exec(spaced);
    if (!m) continue;
    let [season, episode, episode2] = pick(m);
    // "1917 - 2019" is no episode, nor is "Film - 1080" (the resolution)
    if (episode == null || isYear(String(episode))) continue;
    const before = spaced.slice(0, m.index);
    const after = spaced.slice(m.index + m[0].length);
    const { title: show0, year } = cleanTitle(before);
    let show = before.trim() ? show0 : "";
    const folders = dirParts(dir);
    // the season from its folder when the name has none ("Show/Season 2/Show - E05")
    if (season == null) {
      const sd = folders.slice().reverse().find((f) => SEASON_DIR.test(f));
      if (sd) season = +SEASON_DIR.exec(sd)[1];
    }
    if (!show) show = showFromDirs(folders);
    const at = tokensOf(after);
    const { cut } = cutAt(["_", ...at]);
    const epTitle = titleCase(join(at.slice(0, cut - 1))) || null;
    if (!show) break; // nothing to group it by: a film after all
    return { kind: "episode", show, season, episode, episode2, epTitle, year, title: epTitle };
  }
  // "Show/Season 1/03 - Pilot.mkv": the number in front, the season from the folder
  const folders = dirParts(dir);
  const sd = folders.slice().reverse().find((f) => SEASON_DIR.test(f));
  const lead = /^(\d{1,3})(?:[ ._-]+(.*))?$/.exec(spaced);
  if (sd && lead && !isYear(lead[1])) {
    const show = showFromDirs(folders);
    if (show) {
      const epTitle = lead[2] ? cleanTitle(lead[2]).title : null;
      return { kind: "episode", show, season: +SEASON_DIR.exec(sd)[1], episode: +lead[1], episode2: null, epTitle, year: null, title: epTitle };
    }
  }
  const { title, year } = cleanTitle(base);
  return { kind: "film", title, year };
};
// the show's folder: the nearest one that is not a season, a subtitle or a junk folder
const showFromDirs = (folders) => {
  for (let i = folders.length - 1; i >= 0; i--) {
    const f = folders[i];
    if (SEASON_DIR.test(f) || SUB_DIR.test(f) || /^(?:pick|drop):/.test(f)) continue;
    const t = cleanTitle(f).title;
    if (t) return t;
  }
  return "";
};

// A grouping key: case, accents and punctuation do not make another show.
export const normKey = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// "S1 E2", "S1 E2–E3", "E5"
export const episodeCode = (p) =>
  p && p.kind === "episode"
    ? `${p.season != null ? `S${p.season} ` : ""}E${p.episode}${p.episode2 ? `–E${p.episode2}` : ""}`
    : "";

// ---------- subtitle names ----------
// The words a subtitle file's name ends with that say its language
// (".he", ".Hebrew", "_heb", " - עברית"), or what kind of track it is
// (".forced", ".sdh", ".hi"), or which copy (".2").
const LANG_WORDS = {
  en: ["en", "eng", "english", "אנגלית"],
  he: ["he", "heb", "hebrew", "iw", "עברית", "עב"],
  ru: ["ru", "rus", "russian", "русский", "רוסית"],
  ar: ["ar", "ara", "arabic", "العربية", "ערבית"],
  fr: ["fr", "fre", "fra", "french", "français", "francais"],
  es: ["es", "spa", "esp", "spanish", "español", "espanol"],
  de: ["de", "ger", "deu", "german", "deutsch"],
  it: ["ita", "italian", "italiano"],
  pt: ["pt", "por", "portuguese", "português", "pt-br", "ptbr", "brazilian"],
  nl: ["nl", "dut", "nld", "dutch"],
  pl: ["pl", "pol", "polish"],
  tr: ["tr", "tur", "turkish"],
  ja: ["ja", "jpn", "japanese"],
  ko: ["ko", "kor", "korean"],
  zh: ["zh", "chi", "zho", "chinese", "chs", "cht"],
  el: ["el", "gre", "ell", "greek"],
  hu: ["hu", "hun", "hungarian"],
  cs: ["cs", "cze", "ces", "czech"],
  ro: ["ro", "rum", "ron", "romanian"],
  sv: ["sv", "swe", "swedish"],
  fi: ["fi", "fin", "finnish"],
  da: ["da", "dan", "danish"],
  no: ["nor", "nob", "norwegian"],
  uk: ["uk", "ukr", "ukrainian"],
  bg: ["bg", "bul", "bulgarian"],
  fa: ["fa", "per", "fas", "persian", "farsi"],
  th: ["th", "tha", "thai"],
  vi: ["vi", "vie", "vietnamese"],
};
const LANG_OF = new Map(Object.entries(LANG_WORDS).flatMap(([code, words]) => words.map((w) => [w, code])));
// (only the names and three-letter codes count inside a name; the two-letter
// codes only as the last words — "It.2017" is no Italian)
const LONG_LANG = new Map([...LANG_OF].filter(([w]) => w.length > 2 && !["ita"].includes(w)));
export const LANG_NAMES = {
  en: "English", he: "Hebrew", ru: "Russian", ar: "Arabic", fr: "French", es: "Spanish", de: "German", it: "Italian", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", tr: "Turkish", ja: "Japanese", ko: "Korean", zh: "Chinese", el: "Greek", hu: "Hungarian", cs: "Czech",
  ro: "Romanian", sv: "Swedish", fi: "Finnish", da: "Danish", no: "Norwegian", uk: "Ukrainian", bg: "Bulgarian", fa: "Persian", th: "Thai",
  vi: "Vietnamese",
};
const FORCED = new Set(["forced", "foreign", "signs", "songs"]);
const SDH = new Set(["sdh", "cc", "hi", "hoh"]);
const OTHER_FLAGS = new Set(["default", "full", "sub", "subs", "subtitle", "subtitles", "srt", "ext", "external", "dialog", "dialogue", "normal"]);
const SEP = /[._\s\-[\]()]+/;
const lastWord = /([._\s\-[\]()]+)([^._\s\-[\]()]+)[\])]*$/;

// "Film.2020.en.forced.srt" → { stems: ["Film.2020"], lang: "en", forced: true, sdh: false, n: null }
// stems: the name without its suffix words — with and without a trailing
// number ("Film.2.srt" is the second subtitle of "Film"; "Episode 2.srt" is
// not "Episode") — tried in that order.
export const subInfo = (fileName) => {
  let base = String(fileName || "").replace(/\.[^.]+$/, "");
  let lang = null;
  let forced = false;
  let sdh = false;
  let n = null;
  let withNumber = null;
  for (let guard = 0; guard < 8; guard++) {
    // a language with its region ("pt-BR", "zh-Hans", "en_US")
    const r = /[._\s]([a-z]{2,3})[-_]([a-z]{2,4})$/i.exec(base);
    if (r && r.index > 0 && LANG_OF.has(r[1].toLowerCase())) {
      if (!lang) lang = LANG_OF.get(r[1].toLowerCase());
      base = base.slice(0, r.index);
      continue;
    }
    const m = lastWord.exec(base);
    if (!m || m.index === 0) break;
    const w = m[2].toLowerCase();
    if (LANG_OF.has(w)) { if (!lang) lang = LANG_OF.get(w); }
    else if (FORCED.has(w)) forced = true;
    else if (SDH.has(w)) sdh = true;
    else if (OTHER_FLAGS.has(w)) { /* a word that says nothing */ }
    else if (/^\d{1,2}$/.test(w) && n == null) {
      // ".2" is a copy number only after a name, never after "Episode", "E", "Part"
      const before = base.slice(0, m.index);
      if (/(?:^|[._\s-])(?:episode|ep|e|part|pt|פרק|עונה|season|s)$/i.test(before.replace(/[._\s-]+$/, ""))) break;
      withNumber = base;
      n = +w;
    } else break;
    base = base.slice(0, m.index);
  }
  // a language word anywhere else ("Hebrew Film Subs") — names and long codes only
  if (!lang) {
    const words = String(fileName || "").replace(/\.[^.]+$/, "").toLowerCase().split(SEP).filter(Boolean);
    for (let i = words.length - 1; i >= 0; i--) if (LONG_LANG.has(words[i])) { lang = LONG_LANG.get(words[i]); break; }
  }
  // with its number first (a video called "Film.2" is that one), then without
  const stems = [withNumber, base].filter((s) => s && s.trim());
  return { stems: [...new Set(stems)], lang, forced, sdh, n };
};

// "English (forced)", "Hebrew SDH", "Hebrew 2", "Subtitles"
export const subLabel = (info, lang) => {
  const name = LANG_NAMES[lang || info.lang] || "Subtitles";
  return `${name}${info.forced ? " (forced)" : ""}${info.sdh ? " SDH" : ""}${info.n ? ` ${info.n}` : ""}`;
};

// ---------- which video each subtitle belongs to ----------
// videos: [{ key, name, dir }]   subs: [{ key, name, dir }]
//   dir: where the file sat — a folder path ("drop:3/Show/Season 1"), or the
//   one pick / drop it came in ("pick:2"): files picked together sit together.
// -> Map(subKey -> { video: videoKey, how: "name" | "title" | "episode" | "folder" | "only" })
// (an unmatched subtitle is left out)
export const matchSubs = (videos, subs) => {
  const out = new Map();
  const vs = videos.map((v) => {
    const base = String(v.name || "").replace(/\.[^.]+$/, "");
    return { ...v, base, norm: normKey(base), parsed: v.parsed || parseName(v.name, v.dir) };
  });
  const parentOf = (dir) => dirParts(dir).slice(0, -1).join("/");
  for (const s of subs) {
    const info = subInfo(s.name);
    const hit = (how, list) => {
      if (list.length !== 1) return false;
      out.set(s.key, { video: list[0].key, how });
      return true;
    };
    // 1. the same name, once its language and flags are off
    let done = false;
    for (const stem of info.stems) {
      const n = normKey(stem);
      if (n && hit("name", vs.filter((v) => v.norm === n))) { done = true; break; }
    }
    if (done) continue;
    // 2. one name the start of the other ("Film.2020.srt" for "Film.2020.1080p.x265-GRP.mkv")
    for (const stem of info.stems) {
      const n = normKey(stem);
      if (n.length < 3) continue;
      const list = vs.filter((v) => v.norm.startsWith(n + " ") || n.startsWith(v.norm + " "));
      if (hit("name", list)) { done = true; break; }
    }
    if (done) continue;
    const sp = parseName(info.stems[info.stems.length - 1] + ".x", s.dir);
    // 3. the same episode: by its code, then by its show
    if (sp.kind === "episode") {
      let list = vs.filter((v) => v.parsed.kind === "episode" && v.parsed.episode === sp.episode && (sp.season == null || v.parsed.season == null || v.parsed.season === sp.season));
      if (list.length > 1) {
        const same = list.filter((v) => normKey(v.parsed.show) === normKey(sp.show));
        if (same.length) list = same;
      }
      if (list.length > 1) {
        // the show sharing the most words with the subtitle's name
        const words = new Set(normKey(sp.show || info.stems[0]).split(" ").filter((w) => w.length > 1));
        const score = (v) => normKey(v.parsed.show).split(" ").filter((w) => words.has(w)).length;
        const best = Math.max(...list.map(score));
        const top = list.filter((v) => score(v) === best);
        if (best > 0) list = top;
      }
      if (hit("episode", list)) continue;
    } else if (sp.title) {
      // 4. the same film: its cleaned title (and year, when both have one)
      const t = normKey(sp.title);
      const list = vs.filter((v) => v.parsed.kind === "film" && normKey(v.parsed.title) === t && (!sp.year || !v.parsed.year || sp.year === v.parsed.year));
      if (t && hit("title", list)) continue;
    }
    // 5. the one video in its folder (or beside its "Subs" folder), or in its pick
    const dirs = [s.dir || ""];
    if (SUB_DIR.test(dirParts(s.dir).slice(-1)[0] || "")) dirs.push(parentOf(s.dir));
    if (dirs.some((d) => hit("folder", vs.filter((v) => (v.dir || "") === d)))) continue;
    // 6. there is only one video at all
    hit("only", vs);
  }
  return out;
};

// ---------- the order of a show's episodes ----------
export const byEpisode = (a, b) =>
  (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || String(a.name || "").localeCompare(String(b.name || ""));
