// Language codes, the two ways they arrive: ffprobe tags an audio stream in
// ISO 639-2 ("eng", "heb", "fre"/"fra"), TMDB says a title's original language
// in ISO 639-1 ("en", "he", "fr"). sameLanguage() says whether they agree, so a
// player can start a multi-dub file on the track in the title's own language
// (elia, 2026-10-07: "always prioritize the original language").
"use strict";

const TO_ISO1 = {
  eng: "en", heb: "he", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it",
  jpn: "ja", kor: "ko", rus: "ru", por: "pt", chi: "zh", zho: "zh", hin: "hi", ara: "ar",
  tur: "tr", pol: "pl", dut: "nl", nld: "nl", swe: "sv", nor: "no", nob: "no", nno: "no",
  dan: "da", fin: "fi", hun: "hu", cze: "cs", ces: "cs", gre: "el", ell: "el", tha: "th",
  vie: "vi", ind: "id", ukr: "uk", rum: "ro", ron: "ro", tam: "ta", tel: "te", ben: "bn",
  fil: "tl", tgl: "tl", may: "ms", msa: "ms", per: "fa", fas: "fa", cat: "ca", bul: "bg",
  hrv: "hr", srp: "sr", slo: "sk", slk: "sk", slv: "sl", lit: "lt", lav: "lv", est: "et",
  ice: "is", isl: "is", mal: "ml", kan: "kn", mar: "mr", guj: "gu", pan: "pa", urd: "ur",
  swa: "sw", afr: "af", baq: "eu", eus: "eu", glg: "gl", wel: "cy", cym: "cy", gle: "ga",
};

// "eng" → "en", "en-US" → "en", "pt_BR" → "pt"; null for nothing / "und".
const iso1 = (code) => {
  if (!code) return null;
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  if (c === "und" || c === "mis" || c === "zxx") return null;
  if (c.length === 2) return c;
  return TO_ISO1[c] || null;
};

const sameLanguage = (a, b) => {
  const x = iso1(a);
  const y = iso1(b);
  return !!x && !!y && x === y;
};

module.exports = { iso1, sameLanguage, TO_ISO1 };
