// Files from this device (public/js/localsubs.js): subtitle bytes → text in
// the right code page, SRT / ASS / VTT → WebVTT, Hebrew lines held right to
// left, the language of a file, and the sentence a refused video gets.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "js", "localsubs.js")).href);
const RLM = "‏";

// Hebrew letters in Windows-1255: U+05D0..U+05EA are bytes 0xE0..0xFA
const cp1255 = (text) => Uint8Array.from([...text].map((c) => {
  const u = c.codePointAt(0);
  if (u >= 0x5d0 && u <= 0x5ea) return 0xe0 + (u - 0x5d0);
  if (u < 0x80) return u;
  throw new Error(`not in the test's 1255 table: ${c}`);
}));
// Russian in Windows-1251: А..я are bytes 0xC0..0xFF
const cp1251 = (text) => Uint8Array.from([...text].map((c) => {
  const u = c.codePointAt(0);
  if (u >= 0x410 && u <= 0x44f) return 0xc0 + (u - 0x410);
  if (u < 0x80) return u;
  throw new Error(`not in the test's 1251 table: ${c}`);
}));

test("subtitle bytes: UTF-8 (with and without a BOM), Windows-1255 Hebrew, Windows-1251 Russian, UTF-16", async () => {
  const { decodeSubtitle } = await load();
  const he = "שלום עולם, מה שלומך?";
  assert.equal(decodeSubtitle(new TextEncoder().encode(he)), he);
  assert.equal(decodeSubtitle(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(he)])), he, "the BOM goes");
  assert.equal(decodeSubtitle(cp1255(he)), he, "ANSI Hebrew is read as Windows-1255");
  assert.equal(decodeSubtitle(cp1255(he), "film.heb.srt"), he);
  const ru = "Привет мир как дела";
  assert.equal(decodeSubtitle(cp1251(ru)), ru, "ANSI Russian is read as Windows-1251");
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello שלום", "utf16le")]);
  assert.equal(decodeSubtitle(new Uint8Array(u16)), "Hello שלום");
});

test("SRT becomes WebVTT: the timing written the VTT way, <font> and {\\an8} gone, <i> kept", async () => {
  const { srtToVtt, cueCount } = await load();
  const srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\n<font color=\"#fff\">Hello</font> {\\an8}<i>there</i>\r\n\r\n2\r\n0:00:04,5 --> 0:00:06,000 X1:10 X2:20\r\nSecond\r\n";
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /\n00:00:01\.500 --> 00:00:03\.000\n/);
  assert.match(vtt, /\n00:00:04\.500 --> 00:00:06\.000\n/, "short fields padded, coordinates dropped");
  assert.match(vtt, /\nHello <i>there<\/i>\n/);
  assert.equal(cueCount(vtt), 2);
});

test("ASS / SSA become WebVTT: Dialogue lines by the Format line, overrides dropped, \\N a new line, drawings left out", async () => {
  const { toVtt, cueCount } = await load();
  const ass = [
    "[Script Info]", "Title: test", "",
    "[V4+ Styles]", "Format: Name, Fontname, Fontsize", "Style: Default,Arial,20", "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\i1}Second{\\i0} line, with a comma\\Nand more",
    "Dialogue: 0,0:00:00.50,0:00:01.75,Default,,0,0,0,,First",
    "Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100",
  ].join("\n");
  const vtt = toVtt(ass, "film.ass");
  assert.equal(cueCount(vtt), 2, "the drawing is not a cue");
  assert.ok(vtt.indexOf("First") < vtt.indexOf("Second"), "in time order");
  assert.match(vtt, /00:00:00\.500 --> 00:00:01\.750\nFirst\n/);
  assert.match(vtt, /00:00:02\.000 --> 00:00:04\.500\nSecond line, with a comma\nand more\n/);
});

test("a .vtt passes through; a file of no cues counts 0", async () => {
  const { toVtt, cueCount } = await load();
  const vtt = toVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "a.vtt");
  assert.equal(cueCount(vtt), 1);
  assert.equal(cueCount(toVtt("just some text\nnot subtitles", "notes.srt")), 0);
});

test("Hebrew lines are held right to left (RLM on both ends); English lines are left alone", async () => {
  const { toVtt } = await load();
  const vtt = toVtt("1\n00:00:01,000 --> 00:00:02,000\nמה שלומך?\nHow are you?\n", "mixed.srt");
  const lines = vtt.split("\n");
  assert.ok(lines.includes(`${RLM}מה שלומך?${RLM}`), vtt);
  assert.ok(lines.includes("How are you?"));
});

test("files authored for players without bidi get their punctuation back at the end", async () => {
  const { toVtt } = await load();
  let srt = "";
  for (let i = 0; i < 24; i++) srt += `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\n?מה קורה\n\n`;
  const vtt = toVtt(srt, "film.he.srt");
  assert.ok(vtt.includes(`${RLM}מה קורה?${RLM}`), vtt.slice(0, 200));
});

test("the language of a subtitle file: from its name, else from its letters", async () => {
  const { nameLang, textLang } = await load();
  assert.equal(nameLang("The.Film.2020.heb.srt"), "he");
  assert.equal(nameLang("film_Hebrew.srt"), "he");
  assert.equal(nameLang("film.en.forced.srt"), "en");
  assert.equal(nameLang("film.rus.srt"), "ru");
  assert.equal(nameLang("film.srt"), null);
  assert.equal(nameLang("Heather.srt"), null, "a word that merely starts like a code is not one");
  assert.equal(textLang("00:00:01,000 --> 00:00:02,000\nשלום לכולם, מה נשמע היום"), "he");
  assert.equal(textLang("Hello everybody, how is it going today"), "en");
  assert.equal(textLang("Привет всем, как дела сегодня"), "ru");
});

test("what a video file carries, sniffed from its bytes, and the sentence a refusal gets", async () => {
  const { sniffCodecs, failureSentence } = await load();
  const mkv = (codecs) => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from(`....matroska....${codecs}....`)]);
  const hevc = sniffCodecs(mkv("V_MPEGH/ISO/HEVC A_AC3"));
  assert.deepEqual(hevc, { container: "MKV", video: "HEVC", audio: "AC-3" });
  assert.match(failureSentence("file", hevc), /can't play this file's video \(HEVC\)\. Try Chrome or Edge on a device with HEVC support/);
  assert.match(failureSentence("audio", hevc), /^No sound: this browser can't play this file's audio \(AC-3\)/);
  const mp4 = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom....moov....avc1....mp4a....")]);
  assert.deepEqual(sniffCodecs(mp4), { container: "MP4", video: "H.264", audio: "AAC" });
  const avi = Uint8Array.from(Buffer.from("RIFF\0\0\0\0AVI LIST....XVID"));
  assert.match(failureSentence("file", sniffCodecs(avi)), /can't open AVI files/);
  assert.match(failureSentence("file", sniffCodecs(Uint8Array.from([1, 2, 3, 4, 5]))), /^This browser can't play this file\. A \.mp4 with H\.264/);
  assert.match(failureSentence("audio", {}), /or the file has none/);
  assert.match(failureSentence("file", sniffCodecs(mkv("V_MPEG4/ISO/AVC A_DTS"))), /can't play this file's sound \(DTS\), so it won't open the file/);
});

test("the language of a subtitle's words: other scripts, and Latin by its little words", async () => {
  const { textLang } = await load();
  assert.equal(textLang("مرحبا بكم جميعا، كيف حالكم اليوم"), "ar");
  assert.equal(textLang("Γεια σας, τι κάνετε σήμερα φίλοι"), "el");
  assert.equal(textLang("こんにちは、元気ですか。今日はいい天気ですね"), "ja");
  assert.equal(textLang("안녕하세요 오늘 기분이 어떠세요 친구"), "ko");
  assert.equal(textLang("Je ne sais pas, c'est la vie et le monde est grand"), "fr");
  assert.equal(textLang("No sé qué es esto, pero está bien para mí"), "es");
  assert.equal(textLang("Ich weiß nicht, was das ist und wer du bist"), "de");
  assert.equal(textLang("Xyzzy plugh frobozz quux"), null, "Latin letters that say no language");
  assert.equal(textLang("12345"), null);
});
