// Files from THIS device, played in Aurora's own player (js/localplay.js):
// the pure half — subtitle text out of bytes, SRT / ASS / SSA turned into
// WebVTT (the only format a <track> takes), the language of a subtitle file,
// and what a video file carries (codecs, sniffed from its first and last
// bytes) so a file the browser refuses gets a sentence that says why.
// PURE — no DOM, no imports: test/localsubs.test.js runs it under Node.

// ---------- text out of bytes ----------
// Strict UTF-8 first (with or without a BOM), UTF-16 when a BOM says so, else
// the legacy code page whose letters the file is made of: Hebrew subtitles
// from the wild are Windows-1255 as often as UTF-8, Russian ones Windows-1251
// — the same bytes are one alphabet in one page and the other in the other
// (the server's rule, src/media/subtitles.js decodeSubtitle). A file name that
// says the language ("film.heb.srt") settles a tie; nothing of either
// alphabet: Windows-1252 (accented Latin).
const HEB = /[א-ת]/g;
const CYR = /[А-яёЁ]/g;
export const decodeSubtitle = (buf, name = "") => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const strip = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  if (b[0] === 0xff && b[1] === 0xfe) return strip(new TextDecoder("utf-16le").decode(b));
  if (b[0] === 0xfe && b[1] === 0xff) return strip(new TextDecoder("utf-16be").decode(b));
  try {
    return strip(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {}
  const hint = nameLang(name);
  const heb = new TextDecoder("windows-1255").decode(b);
  if (hint === "he") return heb;
  const rus = new TextDecoder("windows-1251").decode(b);
  if (hint === "ru") return rus;
  const h = (heb.match(HEB) || []).length;
  const r = (rus.match(CYR) || []).length;
  if (!h && !r) return new TextDecoder("windows-1252").decode(b);
  return r > h ? rus : heb;
};

// ---------- the language of a subtitle file ----------
const CODES = { he: "he", heb: "he", iw: "he", hebrew: "he", en: "en", eng: "en", english: "en", ru: "ru", rus: "ru", russian: "ru" };
export const LANG_NAME = { he: "Hebrew", en: "English", ru: "Russian" };
// "Film.2020.heb.srt", "film_Hebrew.srt", "film.en.forced.srt" → "he" / "en"
export const nameLang = (name) => {
  const words = String(name || "").replace(/\.[^.]+$/, "").toLowerCase().split(/[^a-zא-ת]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) if (CODES[words[i]]) return CODES[words[i]];
  return /עברית/.test(String(name || "")) ? "he" : null;
};
// From the words themselves when the name does not say: mostly Hebrew
// letters → he, mostly Cyrillic → ru, mostly Latin → en.
export const textLang = (text) => {
  const s = String(text || "").replace(/<[^>]*>|\{[^}]*\}|-->|\d/g, "");
  const h = (s.match(HEB) || []).length;
  const r = (s.match(CYR) || []).length;
  const l = (s.match(/[A-Za-z]/g) || []).length;
  const top = Math.max(h, r, l);
  if (top < 10) return null;
  return top === h ? "he" : top === r ? "ru" : "en";
};

// ---------- SRT → WebVTT ----------
const pad = (n, w = 2) => String(n).padStart(w, "0");
const vttTime = (h, m, s, frac) => `${pad(+h)}:${pad(+m)}:${pad(+s)}.${String(frac || "0").padEnd(3, "0").slice(0, 3)}`;
const TIME = /(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/g;
// Cue text as WebVTT allows it: <i> <b> <u> stay, <font …> and the ASS
// override blocks some SRT files carry ({\an8}, {\i1}) go.
const cleanSrtText = (line) => line.replace(/<\/?font[^>]*>/gi, "").replace(/\{\\[^}]*\}/g, "");
export const srtToVtt = (text) => {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = ["WEBVTT", ""];
  for (const raw of lines) {
    if (raw.includes("-->")) {
      out.push(raw.replace(TIME, (_, h, m, s, f) => vttTime(h, m, s, f)).replace(/\s*-->\s*/, " --> ").replace(/\s+(?:X1|x1):.*$/, ""));
    } else out.push(cleanSrtText(raw));
  }
  return out.join("\n");
};

// ---------- ASS / SSA → WebVTT ----------
// The [Events] section's Dialogue lines, in the order of its own Format line;
// override blocks ({\pos(…)}, {\i1}) dropped, \N a line break, \h a space.
// Vector drawings ({\p1} m 0 0 l …) are not words and are left out.
const assTime = (t) => {
  const m = /(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(t || "");
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4] / 10 ** m[4].length : 0);
};
const fmtSec = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};
export const assToVtt = (text) => {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let fields = null;
  const cues = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) { inEvents = /^\[events\]$/i.test(t); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(t)) { fields = t.replace(/^format\s*:/i, "").split(",").map((f) => f.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(t)) continue;
    const f = fields || ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const parts = t.replace(/^dialogue\s*:\s*/i, "").split(",");
    const head = parts.slice(0, f.length - 1);
    const body = parts.slice(f.length - 1).join(",");
    const at = (k) => head[f.indexOf(k)];
    const start = assTime(at("start"));
    const end = assTime(at("end"));
    if (start == null || end == null || end <= start) continue;
    if (/\{[^}]*\\p[1-9]/.test(body)) continue;
    const words = body.replace(/\{[^}]*\}/g, "").replace(/\\N/gi, "\n").replace(/\\h/g, " ").split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
    if (words) cues.push({ start, end, words });
  }
  cues.sort((a, b) => a.start - b.start);
  return ["WEBVTT", "", ...cues.map((c) => `${fmtSec(c.start)} --> ${fmtSec(c.end)}\n${c.words.replace(/-->/g, "→")}\n`)].join("\n");
};

// ---------- right-to-left lines ----------
const RTL_CHAR = /[֐-׿؀-ۿ]/;
const LEAD = /^([.,!?:;…]+)(\s*)(?=[֐-׿؀-ۿ"'])/;
// Files authored for players without bidi carry their punctuation at the
// START (".שלום"): put it back at the end when such lines are common — the
// server's repair (src/media/subsync.js fixRtlPunctuation), here for files
// that never reach it.
export const fixRtlPunctuation = (lines) => {
  const rtl = lines.filter((l) => RTL_CHAR.test(l));
  if (rtl.length < 20) return lines;
  const reversed = rtl.filter((l) => LEAD.test(l.replace(/<[^>]*>/g, "").trim()) || /[֐-׿؀-ۿ]\s*-\s*$/.test(l)).length;
  if (reversed < rtl.length * 0.2) return lines;
  return lines.map((line) => {
    if (!RTL_CHAR.test(line)) return line;
    const m = /^(\s*(?:<[^>]+>)*)(.*?)((?:<\/[^>]+>)*\s*)$/.exec(line);
    let [, pre, body, post] = m;
    const lead = LEAD.exec(body);
    if (lead) body = body.slice(lead[0].length) + lead[1];
    const dash = /\s*-\s*$/.exec(body);
    if (dash && RTL_CHAR.test(body.slice(0, dash.index).slice(-1))) body = "- " + body.slice(0, dash.index);
    return pre + body + post;
  });
};
// Every cue line with Hebrew or Arabic in it is held between two RIGHT-TO-LEFT
// MARKS: the line reads right to left with its full stop, question mark and
// dialogue dash where a Hebrew reader expects them — even when the cue opens
// with an English word or a number, or sits under an English line.
const RLM = "‏";
export const markRtl = (vtt) => {
  const lines = String(vtt).split("\n");
  const fixed = fixRtlPunctuation(lines);
  return fixed
    .map((l) => (RTL_CHAR.test(l) && !l.includes("-->") ? `${RLM}${l.replace(/^‏+|‏+$/g, "")}${RLM}` : l))
    .join("\n");
};

// ---------- any subtitle file → WebVTT ----------
export const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
export const toVtt = (text, name = "") => {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const kind = (ext || "").toLowerCase();
  const t = String(text || "").replace(/^﻿/, "");
  let vtt;
  if (kind === "ass" || kind === "ssa" || /^\s*\[script info\]/i.test(t)) vtt = assToVtt(t);
  else if (kind === "vtt" || /^WEBVTT/.test(t)) vtt = /^WEBVTT/.test(t) ? t.replace(/\r\n?/g, "\n") : `WEBVTT\n\n${t.replace(/\r\n?/g, "\n")}`;
  else vtt = srtToVtt(t);
  return markRtl(vtt);
};
// How many cues a WebVTT text holds (0: the file was not subtitles at all).
export const cueCount = (vtt) => (String(vtt).match(/-->/g) || []).length;

// ---------- what a video file carries ----------
// Read from its first and last megabyte (an MP4 keeps its index at one end or
// the other; an MKV names its codecs in the first kilobytes): enough to say
// "HEVC" or "AC-3" in the sentence a refused file gets. A guess from bytes —
// never used to refuse a file, only to explain a refusal.
const VIDEO = [
  ["HEVC", /V_MPEGH\/ISO\/HEVC|hvc1|hev1/],
  ["AV1", /V_AV1|av01/],
  ["VP9", /V_VP9|vp09/],
  ["MPEG-4 Part 2 (Xvid/DivX)", /V_MPEG4\/ISO\/(?:ASP|SP|AP)|mp4v|XVID|DIVX|DX50/],
  ["MPEG-2", /V_MPEG2|mp2v/],
  ["VC-1", /WVC1|V_MS\/VFW/],
  ["H.264", /V_MPEG4\/ISO\/AVC|avc1|avc3/],
  ["VP8", /V_VP8/],
];
const AUDIO = [
  ["TrueHD", /A_TRUEHD|mlpa/],
  ["DTS", /A_DTS|dtsc|dtsh|dtsl/],
  ["E-AC-3", /A_EAC3|ec-3/],
  ["AC-3", /A_AC3|ac-3/],
  ["AAC", /A_AAC|mp4a/],
  ["Opus", /A_OPUS|Opus/],
  ["MP3", /A_MPEG\/L3|\.mp3/],
  ["FLAC", /A_FLAC|fLaC/],
  ["Vorbis", /A_VORBIS/],
];
const PLAYS_EVERYWHERE = new Set(["H.264", "VP8", "VP9", "AV1", "AAC", "Opus", "MP3", "FLAC", "Vorbis"]);
export const sniffCodecs = (bytes, name = "") => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  let container = null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) container = /webm/.test(s.slice(0, 64)) ? "WebM" : "MKV";
  else if (s.slice(4, 8) === "ftyp") container = /^qt {2}/.test(s.slice(8, 12)) ? "MOV" : "MP4";
  else if (s.slice(0, 4) === "RIFF" && s.slice(8, 11) === "AVI") container = "AVI";
  else if (b[0] === 0x47 && b[188] === 0x47 && (b.length < 377 || b[376] === 0x47)) container = "MPEG-TS";
  else if (s.slice(0, 4) === "OggS") container = "Ogg";
  else if (/\.(avi)$/i.test(name)) container = "AVI";
  // the codecs the file names, a refused one first (a file that names H.264
  // and HEVC — a trailer and a film — is explained by the one that fails)
  const pick = (table) => {
    const found = table.filter(([, re]) => re.test(s)).map(([n]) => n);
    return found.find((n) => !PLAYS_EVERYWHERE.has(n)) || found[0] || null;
  };
  return { container, video: pick(VIDEO), audio: pick(AUDIO) };
};

// The sentence for a file the browser would not play. `what`: "file" (it
// refused the file outright), "video" (the sound plays, the picture does not)
// or "audio" (the picture plays, silently).
export const failureSentence = (what, info = {}) => {
  const { container, video, audio } = info || {};
  const mp4 = "a .mp4 with H.264 video and AAC sound plays in every browser";
  if (what === "audio") {
    return audio && !PLAYS_EVERYWHERE.has(audio)
      ? `No sound: this browser can't play this file's audio (${audio}). The picture plays — for sound, use a copy with AAC or stereo audio.`
      : "No sound: this browser can't play this file's audio, or the file has none.";
  }
  if (container === "AVI" || container === "MPEG-TS") {
    return `This browser can't open ${container} files. Convert it to .mp4 — ${mp4}.`;
  }
  if (video === "HEVC") return `This browser can't play this file's video (HEVC). Try Chrome or Edge on a device with HEVC support, or ${mp4}.`;
  if (video && !PLAYS_EVERYWHERE.has(video)) return `This browser can't play this file's video (${video}). Browsers don't decode it — ${mp4}.`;
  if (video === "AV1" || video === "VP9") return `This browser or device can't decode this file's video (${video}). A newer browser may — or ${mp4}.`;
  if (what === "video") return "This browser can't show this file's picture. Try Chrome or Edge, or " + mp4 + ".";
  if (audio && !PLAYS_EVERYWHERE.has(audio)) return `This browser can't play this file's sound (${audio}), so it won't open the file. Use a copy with AAC or stereo audio — ${mp4}.`;
  return `This browser can't play this file. ${mp4[0].toUpperCase()}${mp4.slice(1)}; .mkv and .webm play in Chrome and Edge.`;
};
