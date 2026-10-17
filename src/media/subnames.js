// What a subtitle or audio track is CALLED, everywhere the player lists one.
//
// The report this answers (2026-10, the admin inbox): "embedded tracks show up
// as track 1 and track 2 and not by language". Two causes, both measured on the
// live library:
//
//   1. Releases that carry no language tag at all. 209 of the library's
//      embedded text tracks had neither a language nor a title (a Silo episode:
//      42 untagged tracks in one file) — the scanner's only fallback was
//      "Track N". The language is now read off the text itself (detectLanguage,
//      run once per file in the background: media/sublang.js).
//   2. Tags this code did not know: only ~20 languages had names, so "cat",
//      "baq", "nob", "hrv", "fil"… fell through to "Track N" as well, and a
//      title that only says "SDH" or "Track 1" was printed as the name.
//
// PURE — no requires, no I/O — so the naming rules are tested as they are
// (test/subnames.test.js).

// [name, ISO 639-1 (or null), every tag that means it: 639-2/B, 639-2/T,
//  639-1, the obsolete codes still found in files ("iw", "in", "ji"), and the
//  name itself]
const LANGS = [
  ["English", "en", ["eng", "en"]],
  ["Hebrew", "he", ["heb", "he", "iw"]],
  ["Russian", "ru", ["rus", "ru"]],
  ["Arabic", "ar", ["ara", "ar"]],
  ["Spanish", "es", ["spa", "es", "esl", "esp"]],
  ["French", "fr", ["fre", "fra", "fr"]],
  ["German", "de", ["ger", "deu", "de"]],
  ["Italian", "it", ["ita", "it"]],
  ["Portuguese", "pt", ["por", "pt"]],
  ["Dutch", "nl", ["dut", "nld", "nl"]],
  ["Swedish", "sv", ["swe", "sv"]],
  ["Norwegian", "no", ["nor", "no", "nob", "nb", "nno", "nn"]],
  ["Danish", "da", ["dan", "da"]],
  ["Finnish", "fi", ["fin", "fi"]],
  ["Icelandic", "is", ["ice", "isl", "is"]],
  ["Polish", "pl", ["pol", "pl"]],
  ["Czech", "cs", ["cze", "ces", "cs"]],
  ["Slovak", "sk", ["slo", "slk", "sk"]],
  ["Slovenian", "sl", ["slv", "sl"]],
  ["Hungarian", "hu", ["hun", "hu"]],
  ["Romanian", "ro", ["rum", "ron", "ro", "mol"]],
  ["Bulgarian", "bg", ["bul", "bg"]],
  ["Croatian", "hr", ["hrv", "scr", "hr"]],
  ["Serbian", "sr", ["srp", "scc", "sr"]],
  ["Bosnian", "bs", ["bos", "bs"]],
  ["Macedonian", "mk", ["mac", "mkd", "mk"]],
  ["Albanian", "sq", ["alb", "sqi", "sq"]],
  ["Greek", "el", ["gre", "ell", "el"]],
  ["Turkish", "tr", ["tur", "tr"]],
  ["Ukrainian", "uk", ["ukr", "uk"]],
  ["Belarusian", "be", ["bel", "be"]],
  ["Lithuanian", "lt", ["lit", "lt"]],
  ["Latvian", "lv", ["lav", "lv"]],
  ["Estonian", "et", ["est", "et"]],
  ["Georgian", "ka", ["geo", "kat", "ka"]],
  ["Armenian", "hy", ["arm", "hye", "hy"]],
  ["Persian", "fa", ["per", "fas", "fa"]],
  ["Urdu", "ur", ["urd", "ur"]],
  ["Hindi", "hi", ["hin", "hi"]],
  ["Bengali", "bn", ["ben", "bn"]],
  ["Tamil", "ta", ["tam", "ta"]],
  ["Telugu", "te", ["tel", "te"]],
  ["Malayalam", "ml", ["mal", "ml"]],
  ["Kannada", "kn", ["kan", "kn"]],
  ["Marathi", "mr", ["mar", "mr"]],
  ["Punjabi", "pa", ["pan", "pa"]],
  ["Thai", "th", ["tha", "th"]],
  ["Vietnamese", "vi", ["vie", "vi"]],
  ["Indonesian", "id", ["ind", "id", "in"]],
  ["Malay", "ms", ["may", "msa", "ms"]],
  ["Filipino", "fil", ["fil", "tgl", "tl"]],
  ["Chinese", "zh", ["chi", "zho", "zh", "cmn", "yue"]],
  ["Japanese", "ja", ["jpn", "ja"]],
  ["Korean", "ko", ["kor", "ko"]],
  ["Catalan", "ca", ["cat", "ca"]],
  ["Basque", "eu", ["baq", "eus", "eu"]],
  ["Galician", "gl", ["glg", "gl"]],
  ["Welsh", "cy", ["wel", "cym", "cy"]],
  ["Irish", "ga", ["gle", "ga"]],
  ["Yiddish", "yi", ["yid", "yi", "ji"]],
  ["Latin", "la", ["lat", "la"]],
  ["Afrikaans", "af", ["afr", "af"]],
  ["Swahili", "sw", ["swa", "sw"]],
  ["Amharic", "am", ["amh", "am"]],
  ["Kurdish", "ku", ["kur", "ku"]],
  ["Mongolian", "mn", ["mon", "mn"]],
  ["Kazakh", "kk", ["kaz", "kk"]],
  ["Uzbek", "uz", ["uzb", "uz"]],
  ["Azerbaijani", "az", ["aze", "az"]],
  ["Khmer", "km", ["khm", "km"]],
  ["Lao", "lo", ["lao", "lo"]],
  ["Burmese", "my", ["bur", "mya", "my"]],
  ["Nepali", "ne", ["nep", "ne"]],
  ["Sinhala", "si", ["sin", "si"]],
];
const BY_TAG = new Map();
const BY_NAME = new Map();
for (const [name, code1, tags] of LANGS) {
  const entry = { name, code: code1 || tags[0], tag3: tags[0] };
  for (const t of tags) BY_TAG.set(t, entry);
  BY_NAME.set(name.toLowerCase(), entry);
}
// a few spellings a title or a file name uses for the name
for (const [alias, name] of [
  ["español", "Spanish"], ["castellano", "Spanish"], ["français", "French"], ["deutsch", "German"],
  ["italiano", "Italian"], ["português", "Portuguese"], ["brazilian", "Portuguese"], ["nederlands", "Dutch"],
  ["svenska", "Swedish"], ["norsk", "Norwegian"], ["dansk", "Danish"], ["suomi", "Finnish"], ["polski", "Polish"],
  ["čeština", "Czech"], ["magyar", "Hungarian"], ["română", "Romanian"], ["türkçe", "Turkish"],
  ["עברית", "Hebrew"], ["русский", "Russian"], ["العربية", "Arabic"], ["mandarin", "Chinese"],
  ["cantonese", "Chinese"], ["farsi", "Persian"], ["tagalog", "Filipino"], ["flemish", "Dutch"],
  ["bokmal", "Norwegian"], ["bokmål", "Norwegian"], ["nynorsk", "Norwegian"], ["greek", "Greek"],
]) BY_NAME.set(alias, BY_NAME.get(name.toLowerCase()));

const NO_LANGUAGE = /^(und|unknown|mis|mul|zxx|qaa|none|n\/a)$/i;

// A language tag as it arrives ("eng", "he", "iw", "pt-BR", "zh-Hans",
// "English") -> { name, code (ISO 639-1 when there is one), tag3 } | null.
const normLang = (tag) => {
  if (tag == null) return null;
  const raw = String(tag).trim().toLowerCase();
  if (!raw || NO_LANGUAGE.test(raw)) return null;
  const head = raw.split(/[-_ ]/)[0];
  return BY_TAG.get(raw) || BY_TAG.get(head) || BY_NAME.get(raw) || BY_NAME.get(head) || null;
};

// ---------- what a track title says ----------

const FORCED_RE = /\bforced\b|\bforce\b|\bsigns?\b(?:\s*(?:&|and|\/)\s*songs?)?|\bsongs?\s*(?:&|and)\s*signs?\b|\bforc[ée]s?\b/i;
const SDH_RE = /\bsdh\b|\bcc\b|\bhearing[ -]?impaired\b|\bhoh\b|\bclosed[ -]?captions?\b|\bdeaf\b/i;
const COMMENTARY_RE = /\bcommentar(?:y|ies)\b|\bcomment\b|\bdirector'?s? (?:track|commentary)\b/i;
// A title that names nothing: what muxers and rippers write by default.
const JUNK_RE = /^(?:track|stream|subtitles?|subs?|text|caption|captions|srt|subrip|ass|ssa|pgs|vobsub|sup|utf-?8|full|dialog(?:ue)?|default|normal|regular|complete|main|mixed|untitled|und|unknown|\d+(?:\.\d)?(?: ?ch)?|stereo|mono|surround(?: \d\.\d)?)(?:[ ._#-]*\d+)?$/i;
const isJunkTitle = (t) => !t || JUNK_RE.test(String(t).trim()) || !/\p{L}/u.test(String(t));

// Words a title adds that are worth keeping: a region, a script, an edition.
// Anything else left over after the language and the flags are taken out is
// kept too when it is short and real ("Latin America", "Simplified"), and
// dropped when it is clearly a release group or encoder string.
const REGION_RE = /\b(?:latin(?:o| america(?:n)?)?|latam|spain|castilian|castellano|european|europe|brazil(?:ian)?|portugal|simplified|traditional|hans|hant|cantonese|mandarin|hong ?kong|taiwan(?:ese)?|canad(?:a|ian)|qu[ée]bec|france|belgi(?:um|an)|swiss|mexic(?:o|an)|argentin(?:a|e|ian)|american|british|australian|us|usa|uk|bokm[aå]l|nynorsk|flemish|cyrillic|director'?s|extended|theatrical|songs?|lyrics|dubtitles?|narrative|descriptive)\b/i;
const GROUPISH =/[[\]{}]|\b(?:x26[45]|h\.?26[45]|hevc|web-?dl|webrip|bluray|bdrip|hdtv|1080p|720p|2160p|ddp?5\.1|aac|ac3|dts)\b|^[A-Z0-9]{2,}-[A-Z0-9]+$/i;

// { variant, forced, sdh, commentary } out of a track's title, relative to its
// language's name (so "English (SDH)" on an English track is just SDH).
const readTitle = (title, langName) => {
  const out = { variant: null, forced: false, sdh: false, commentary: false, name: null };
  if (!title) return out;
  let t = String(title).trim();
  out.forced = FORCED_RE.test(t);
  out.sdh = SDH_RE.test(t);
  out.commentary = COMMENTARY_RE.test(t);
  if (isJunkTitle(t)) return out;
  // a title that is a language name of its own (an untagged track titled "Hebrew")
  const titleLang = normLang(t) || normLang(t.split(/[\s(\[,.:;\/-]+/)[0]);
  if (titleLang) out.name = titleLang.name;
  // take out the language name(s), the flags and the generic words
  let rest = t;
  for (const n of [langName, titleLang && titleLang.name].filter(Boolean)) rest = rest.replace(new RegExp(`\\b${n}\\b`, "ig"), " ");
  rest = rest
    .replace(new RegExp(FORCED_RE.source, "ig"), " ")
    .replace(new RegExp(SDH_RE.source, "ig"), " ")
    .replace(new RegExp(COMMENTARY_RE.source, "ig"), " ")
    .replace(/\b(?:subtitles?|subs?|track|stream|full|complete|dialog(?:ue)?|text|captions?|only)\b/gi, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s*[-–—|:,;\/.]+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // What is left is kept when it is a region / script / edition word, or when
  // the title led with the language and then qualified it on purpose
  // ("English (Kametsu)"); "Subtitles (Kametsu)" is a group's signature.
  const ledWithLang = [langName, titleLang && titleLang.name].filter(Boolean)
    .some((n) => new RegExp(`^\\W*${n}\\b`, "i").test(t));
  if (rest && rest.length <= 28 && /\p{L}{2,}/u.test(rest) && !GROUPISH.test(rest) && !isJunkTitle(rest) && (REGION_RE.test(rest) || ledWithLang)) {
    out.variant = rest;
  }
  return out;
};

const flagsText = ({ variant, forced, sdh, commentary }) =>
  [variant, forced && "Forced", sdh && "SDH", commentary && "Commentary"].filter(Boolean);

// The name of one embedded subtitle stream.
//   stream: { language, title, forced?, sdh?, commentary? }   (dispositions as booleans)
//   detected: { lang, sdh?, forced? } from the text itself, when the file said nothing
// -> { label, lang (ISO 639-1 / 3-letter), forced, sdh, commentary }
const subtitleName = (stream, detected = null, idx = 0) => {
  const tagged = normLang(stream && stream.language);
  const fromText = !tagged && detected && detected.lang ? normLang(detected.lang) : null;
  const t = readTitle(stream && stream.title, (tagged || fromText || {}).name);
  const lang = tagged || (t.name && normLang(t.name)) || fromText;
  const forced = !!(stream && stream.forced) || t.forced || !!(!tagged && detected && detected.forced);
  const sdh = !!(stream && stream.sdh) || t.sdh || !!(!tagged && detected && detected.sdh);
  const commentary = !!(stream && stream.commentary) || t.commentary;
  const parts = flagsText({ variant: t.variant, forced, sdh, commentary });
  let base = lang ? lang.name : null;
  // a tag that is a language code this table does not know: the code, not a guess
  const odd = !lang && stream && /^[a-z]{2,3}$/i.test(String(stream.language || "").trim()) && !NO_LANGUAGE.test(String(stream.language).trim())
    ? String(stream.language).trim().toLowerCase() : null;
  if (!base && odd) base = odd.toUpperCase();
  if (!base) {
    // no language anywhere: a meaningful title is still a name
    const title = stream && stream.title && !isJunkTitle(stream.title) ? String(stream.title).trim() : null;
    if (title) return { label: title.slice(0, 40), lang: null, forced, sdh, commentary };
    base = "Unknown";
    parts.unshift(`track ${idx + 1}`);
  }
  return {
    label: parts.length ? `${base} (${parts.join(", ")})` : base,
    lang: lang ? lang.code : odd,
    forced, sdh, commentary,
  };
};

// The name of one audio stream: its language, then what the title adds
// ("Commentary", "Director's cut"), never "Stereo" / "5.1" / an encoder string.
const audioName = (stream, idx = 0) => {
  const lang = normLang(stream && stream.language);
  const t = readTitle(stream && stream.title, lang && lang.name);
  const l = lang || (t.name && normLang(t.name));
  const extra = [t.variant, (t.commentary || (stream && stream.commentary)) && "Commentary"].filter(Boolean);
  if (l) return { label: extra.length ? `${l.name} · ${extra.join(" · ")}` : l.name, lang: l.code };
  const title = stream && stream.title && !isJunkTitle(stream.title) && !GROUPISH.test(stream.title) ? String(stream.title).trim().slice(0, 40) : null;
  return { label: title || `Track ${idx + 1}`, lang: null };
};

// Two tracks with one name get numbers ("English", "English 2") — never two
// identical entries in a menu.
const uniqueLabels = (tracks) => {
  const taken = new Set();
  for (const t of tracks) {
    if (!taken.has(t.label)) {
      taken.add(t.label);
      continue;
    }
    let n = 2;
    while (taken.has(`${t.label} ${n}`)) n++;
    t.label = `${t.label} ${n}`;
    taken.add(t.label);
  }
  return tracks;
};

// ---------- what language a subtitle's TEXT is in ----------
//
// For tracks the file left untagged. Script first (Hebrew, Arabic, Cyrillic,
// Greek, CJK… are told by their letters alone, and within a script by the
// letters only one language uses), then — for Latin text — the share of the
// words that are each language's commonest function words. It answers only
// when it is sure: plenty of words, a clear winner; otherwise null, and the
// track keeps an honest "Unknown language".

const SCRIPTS = [
  ["heb", /[א-ת]/g],
  ["ara", /[ؠ-يٱ-ۓ]/g],
  ["cyr", /[Ѐ-ӿ]/g],
  ["gre", /[Ͱ-Ͽἀ-῿]/g],
  ["tha", /[฀-๿]/g],
  ["kor", /[가-힯ᄀ-ᇿ]/g],
  ["kana", /[぀-ヿ]/g],
  ["han", /[一-鿿]/g],
  ["hin", /[ऀ-ॿ]/g],
  ["ben", /[ঀ-৿]/g],
  ["tam", /[஀-௿]/g],
  ["tel", /[ఀ-౿]/g],
  ["mal", /[ഀ-ൿ]/g],
  ["kan", /[ಀ-೿]/g],
  ["geo", /[Ⴀ-ჿ]/g],
  ["arm", /[԰-֏]/g],
  ["lat", /[A-Za-zÀ-ɏ]/g],
];
const count = (text, re) => (text.match(re) || []).length;

const WORDS = {
  eng: "the you i to a and it is that of what me this in we don't know not be have your are on my i'm it's for he was just do can no all so there here get they like with",
  spa: "que de no el la y es en lo un por qué me se una te los con para mi está si pero las le del al eso como más bien aquí estoy esto usted tengo",
  por: "que não de o a e é um você eu se para uma com do da os me mas isso no na está em ele por como aqui meu bem vou tem ser muito sim",
  fre: "je de pas le la vous est que et à un tu il ne les c'est en une ce on pour qui des suis moi ça nous au mais avec dans sur oui bien",
  ger: "ich die und sie der das nicht du ist es zu ein wir was den ja mit mir auf sich eine habe dich mich kann noch ihr auch wie aber so hier",
  ita: "che non di è e il la un a per mi sono ho ti lo in una cosa ma si con le questo del bene sei io perché qui come sì",
  dut: "ik je de het een niet dat en is van wat we in op te zijn hij maar met voor ze er die mij wel hier nog dit heb jij",
  swe: "jag det att du inte är och en som på vi har med för han vad den till ett kan så om mig hon var här ska nu dig bara",
  nor: "jeg det er ikke du og at en på vi har til for med som deg meg hva han kan så skal vil den her hun var bare nå av noe",
  dan: "jeg det er ikke du og at en på vi har til for med som dig mig hvad han kan så skal vil den her hun var bare nu af noget",
  fin: "en ei on se että ja mitä minä sinä olen oli hän me no tämä kun mutta nyt sen jos niin kanssa vain täällä tiedän olet mä sä",
  pol: "nie to się jest że w na i co z jak mi tak ale ja do ty czy mnie już o tu jestem go wiem tylko może by cię ten",
  cze: "to je se na že a v ne jsem co si já ty mi tak ale jak tady jsi být bude mě už s by o z není tě k",
  slo: "to je sa na že a v nie som čo si ja ty mi tak ale ako tu byť bude ma už s by o z ťa k",
  slv: "je da se ne in v to sem kaj na ali jaz si mi ti ni za a tega bo s pa me te bi kako tako tukaj vse smo",
  hrv: "je da se ne i u to sam što na li ja si mi ti nije za a ovo će sa ali me te bi kako tako ovdje sve smo tko gdje",
  srp: "je da se ne i u to sam šta na li ja si mi ti nije za a ovo će sa ali me te bi kako tako ovde sve smo ko gde",
  hun: "a az nem hogy és egy is meg ez de van mi csak ne már el mit vagy jó nincs itt kell te én igen most ő azt mert",
  rum: "nu să de e și şi la în ce ai a o un mă ca pe cu am eu este te asta mai ești eşti sunt aici dar bine",
  tur: "bir ve bu ne de da ben için mi sen çok o var ama gibi ile şey daha değil yok evet iyi sana beni onu burada hayır neden nasıl",
  ind: "yang tidak aku kau ini itu dan kamu apa di ada akan saya dia ke untuk kita bisa dengan tak sudah mereka jika ya sini tahu saja karena nggak gak kalian bilang begitu sih banget",
  may: "yang tidak aku kau ini itu dan kamu apa di ada akan saya dia ke untuk kita boleh dengan tak sudah mereka jika ya sini tahu awak nak mahu kerana sahaja cakap macam",
  vie: "không tôi là của và có anh em một này được cho đi đó người những với ông chúng ta gì cô sẽ phải đã nó như rồi làm",
  cat: "que de no el la i és en ho un per què em es una et els amb meu està si però les li del al això com més bé aquí estic",
  baq: "da eta ez bat du dut zer ere hori ni zu hau baina dago naiz nire bai orain zure egin behar izan ba hemen",
  glg: "que de non o a e é un se por me unha te os con para meu está pero as lle do ao iso como máis ben aquí estou",
  fil: "ang ng sa na ko mo ako ka hindi ito mga at siya ba kung ay ikaw lang natin kami po din rin yan wala may",
  lit: "ir ne kad tai aš tu į yra kas su man jis bet kaip čia mes ką jūs jei taip dabar buvo labai gerai",
  lav: "un ir es tu ka ne kas to man ar tas vai mēs jūs viņš bet šeit tev kā jā nav būs labi kur",
  est: "ja ei on et see ma sa mis kas oli me nii aga mind sind siin kui ta nad mul väga tead ole jah hea",
  ice: "að ég er og þú ekki það á í við hann sem en til með hvað mig þig hér já nei vera var þetta ertu",
  alb: "të në dhe që një është me për nuk e i ti unë po ke jam se do çfarë mirë këtu",
};
const WORDSETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

// Plain words of a subtitle file's text (markup, sound descriptions, numbers out).
const wordsOf = (text) =>
  String(text || "")
    .replace(/<[^>]*>|\{[^}]*\}/g, " ")
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);

// -> { lang: "heb" | "eng" | …, sure: 0..1 } | null
const detectLanguage = (text) => {
  const s = String(text || "").replace(/<[^>]*>|\{[^}]*\}/g, " ");
  const counts = SCRIPTS.map(([k, re]) => [k, count(s, re)]);
  const letters = counts.reduce((a, [, n]) => a + n, 0);
  if (letters < 80) return null;
  counts.sort((a, b) => b[1] - a[1]);
  const [script, n] = counts[0];
  const share = n / letters;
  if (share < 0.5) return null;
  const sure = Math.round(share * 100) / 100;
  switch (script) {
    case "heb": return { lang: count(s, /[װ-ײ]/g) > n * 0.01 ? "yid" : "heb", sure };
    case "ara": {
      const fa = count(s, /[پچژگکی]/g);
      const ur = count(s, /[ٹڈڑںھے]/g);
      if (ur > n * 0.01) return { lang: "urd", sure };
      return { lang: fa > n * 0.015 ? "per" : "ara", sure };
    }
    case "cyr": {
      if (count(s, /[іїєґІЇЄҐ]/g) > n * 0.01) return { lang: "ukr", sure };
      if (count(s, /[ђћџљњјЂЋЏЉЊЈ]/g) > n * 0.005) return { lang: "srp", sure };
      if (count(s, /[ѓќѕЃЌЅ]/g) > n * 0.003) return { lang: "mac", sure };
      if (count(s, /[ўЎ]/g) > n * 0.005) return { lang: "bel", sure };
      const ru = count(s, /[ыэёЫЭЁ]/g);
      if (ru < n * 0.004 && count(s, /[ъ]/g) > n * 0.01) return { lang: "bul", sure };
      return { lang: "rus", sure };
    }
    case "gre": return { lang: "gre", sure };
    case "tha": return { lang: "tha", sure };
    case "kor": return { lang: "kor", sure };
    case "kana": return { lang: "jpn", sure };
    case "han": return { lang: count(s, /[぀-ヿ]/g) > n * 0.05 ? "jpn" : "chi", sure };
    case "hin": case "ben": case "tam": case "tel": case "mal": case "kan": case "geo": case "arm":
      return { lang: script, sure };
    default: break;
  }
  // Latin: the function words
  const words = wordsOf(s);
  if (words.length < 40) return null;
  const scores = Object.entries(WORDSETS).map(([k, set]) => {
    let hit = 0;
    for (const w of words) if (set.has(w)) hit++;
    return [k, hit / words.length];
  }).sort((a, b) => b[1] - a[1]);
  const [best, top] = scores[0];
  const second = scores[1][1];
  if (top < 0.12) return null;
  // close pairs (Norwegian/Danish, Czech/Slovak, Croatian/Serbian, Malay/
  // Indonesian…) share most of their lists: a clear winner is what the
  // words only one of them uses decide.
  if (second > 0 && top / second < 1.08) {
    // a near tie: the words only ONE of the two uses decide, or nothing does
    const [a, b] = [best, scores[1][0]];
    const only = (x, y) => words.filter((w) => WORDSETS[x].has(w) && !WORDSETS[y].has(w)).length;
    const na = only(a, b);
    const nb = only(b, a);
    if (Math.max(na, nb) < 5 || Math.max(na, nb) < Math.min(na, nb) * 2) return null;
    return { lang: na > nb ? a : b, sure: 0.5 };
  }
  return { lang: best, sure: Math.round(Math.min(1, top * 3) * 100) / 100 };
};

// Sound descriptions and speaker labels — what makes a track SDH — as a share
// of the cues.
const sdhShare = (cueTexts) => {
  const list = (cueTexts || []).filter(Boolean);
  if (!list.length) return 0;
  const hit = list.filter((t) => /\[[^\]]{2,}\]|\([A-Z][A-Za-z ,'-]{2,}\)|^[A-Z][A-Z .'-]{1,20}:\s|♪/m.test(t) && !/^\s*♪[^♪]*♪?\s*$/.test(t)).length;
  return hit / list.length;
};

module.exports = {
  LANGS, normLang, readTitle, isJunkTitle, subtitleName, audioName, uniqueLabels,
  detectLanguage, sdhShare, wordsOf,
};
