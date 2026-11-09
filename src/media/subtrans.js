// Translating a subtitle's cues with a language model — the PURE half of
// "Hebrew subtitles for anything" (media/subai.js does the I/O: which track,
// the model call, the file, the queue).
//
// What it must not break, and how:
//   TIMING   every cue keeps its start and end exactly: the model only ever
//            sees text keyed by the cue's number, and its answer is put back
//            on the same cue. A cue it left out is asked for again, alone;
//            still missing, it keeps the source text (counted: too many and
//            the whole translation is thrown away, media/subai.js).
//   LINES    at most two lines of LINE_MAX characters; a two-speaker cue
//            ("- Hi.\n- Hello.") keeps one line per speaker.
//   TAGS     <i> <b> <u> are kept (a cue that is italic as a whole comes back
//            italic as a whole); anything else — <font>, <c.x>, <v Name>,
//            SubStation {\…} overrides — is dropped, except a leading {\anN}
//            position, which is put back in front.
//   RTL      a Hebrew line that would START with a Latin word ("OK, בוא נלך")
//            is laid out left-to-right by every renderer that takes the
//            direction from the first strong letter (browsers' WebVTT, Android),
//            and its punctuation lands at the wrong end. Such a line gets a
//            RIGHT-TO-LEFT MARK in front; a line that starts in Hebrew needs
//            nothing and gets nothing.
//
// PURE: no requires of the server, no I/O (test/subtrans.test.js).
"use strict";

const LINE_MAX = 40;
// What the translated track is called, on every device (the library's label),
// and the file it is kept in beside the video ("<video>.Hebrew (AI).srt").
const AI_LABEL = "עברית (AI)";
const AI_FILE_LABEL = "Hebrew (AI)";
const isAiFile = (name) => /\.hebrew \(ai\)\.(?:srt|vtt)$/i.test(String(name || ""));
const RLM = "‏";
const HEB = /[֐-׿]/;
const LETTER = /\p{L}/u;
// a strong right-to-left / left-to-right letter
const STRONG = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

// ---------- the source text, ready to be sent ----------

const decodeEntities = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&lrm;|&rlm;/g, "").replace(/&amp;/g, "&");

const KEEP_TAG = /^<\/?[ibu]>$/i;

// Only <i> <b> <u>, lower case, balanced (an unclosed one is closed at the end,
// a stray closing one dropped).
const cleanTags = (s) => {
  const open = [];
  let out = "";
  const re = /<[^>]*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index);
    last = re.lastIndex;
    const tag = m[0].toLowerCase().replace(/\s+/g, "");
    if (!KEEP_TAG.test(tag)) continue;
    const name = tag.replace(/[<>/]/g, "");
    if (tag[1] === "/") {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      // close what was opened inside it too
      for (let k = open.length - 1; k >= at; k--) out += `</${open[k]}>`;
      const reopen = open.slice(at + 1);
      open.length = at;
      for (const r of reopen) { out += `<${r}>`; open.push(r); }
    } else {
      out += `<${name}>`;
      open.push(name);
    }
  }
  out += s.slice(last);
  for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`;
  // an empty pair is nothing
  return out.replace(/<([ibu])>(\s*)<\/\1>/g, "$2");
};

const plain = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "");

// One cue's text as it goes to the model, and what to put back afterwards.
//   -> { send, pos, italic, dialogue, skip }
//   send      the text to translate ("" when there is nothing to translate)
//   pos       a leading SubStation position ("{\an8}"), or ""
//   italic    the whole cue was in <i>…</i> (sent without it)
//   dialogue  two or more lines that each start with a dash (one per speaker)
//   skip      nothing to translate (no letters: "♪", "…", a blank cue)
const prepare = (text) => {
  let s = decodeEntities(String(text || "").replace(/\r/g, ""));
  s = s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
  const posM = /^\s*(\{\\an\d\})/.exec(s);
  const pos = posM ? posM[1] : "";
  s = s.replace(/\{[^}]*\}/g, "");
  s = cleanTags(s);
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l) => plain(l).trim()).join("\n");
  let italic = false;
  const whole = /^<i>([\s\S]*)<\/i>$/.exec(s);
  if (whole && !/<\/?i>/.test(whole[1])) { italic = true; s = whole[1]; }
  else if (s && s.split("\n").every((l) => /^<i>[^<]*<\/i>$/.test(l))) { italic = true; s = s.replace(/<\/?i>/g, ""); }
  const lines = s.split("\n");
  const dialogue = lines.length >= 2 && lines.every((l) => /^\s*(?:<[ibu]>)*\s*[-–—]/.test(l));
  const skip = !LETTER.test(plain(s));
  return { send: skip ? "" : s, pos, italic, dialogue, skip, source: s };
};

// ---------- the answer, made into a readable cue ----------

// Two lines at most, LINE_MAX each where a break can be found: the break goes
// at the space nearest the middle (the lower line may be the longer one).
const wrap = (text, max = LINE_MAX) => {
  const s = text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  if (plain(s).length <= max) return s;
  const spaces = [];
  for (let i = 0; i < s.length; i++) if (s[i] === " ") spaces.push(i);
  if (!spaces.length) return s;
  // never break inside a tag
  const inTag = (i) => s.lastIndexOf("<", i) > s.lastIndexOf(">", i);
  const ok = spaces.filter((i) => !inTag(i));
  if (!ok.length) return s;
  const mid = s.length / 2;
  let best = ok[0];
  for (const i of ok) if (Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return `${s.slice(0, best)}\n${s.slice(best + 1)}`;
};

// The first strong letter of a line (tags and marks aside) is Latin while the
// line has Hebrew in it: a mark in front makes every renderer lay it out
// right to left. A line that starts in Hebrew gets nothing.
const rtlLine = (line) => {
  const p = plain(line);
  if (!RTL_CHAR.test(p)) return line;
  const first = STRONG.exec(p);
  if (!first || RTL_CHAR.test(first[0])) return line;
  return RLM + line;
};

// The model's text for one cue -> the cue's new text.
//   prep: what prepare() said about the source cue
const finish = (answer, prep, { max = LINE_MAX } = {}) => {
  let s = decodeEntities(String(answer || "").replace(/\r/g, ""));
  s = s.replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\{[^}]*\}/g, "");
  // a "<" that is not one of the kept tags would break the WebVTT
  s = s.replace(/<(?!\/?[ibu]>)[^<>]*>/gi, "");
  s = s.split(/(<\/?[ibu]>)/i).map((part, i) => (i % 2 ? part : part.replace(/[<>]/g, ""))).join("");
  s = cleanTags(s);
  if (prep.italic) s = s.replace(/<\/?i>/g, "");
  let lines = s.split("\n").map((l) => l.trim()).filter((l) => plain(l).trim());
  if (prep.dialogue && lines.length >= 2) {
    // one line per speaker, each led by a dash
    lines = lines.map((l) => (/^(?:<[ibu]>)*\s*[-–—]/.test(l) ? l : `- ${l}`));
  } else if (prep.dialogue && lines.length === 1) {
    // the speakers came back on one line: split them at the second dash
    const m = /^(.*?\S)\s+([-–—]\s*\S.*)$/.exec(lines[0].replace(/^\s*[-–—]\s*/, ""));
    lines = m ? [`- ${m[1]}`, `- ${m[2].replace(/^[-–—]\s*/, "")}`] : [wrap(lines[0], max)];
    lines = lines.join("\n").split("\n");
  } else {
    lines = wrap(lines.join(" "), max).split("\n");
  }
  let out = lines.map(rtlLine).join("\n");
  if (prep.italic && out) out = out.split("\n").map((l) => `<i>${l}</i>`).join("\n");
  return (prep.pos || "") + out;
};

// ---------- batches ----------

// Cues to send, in batches of at most `size` cues and `chars` characters of
// text, each with the few lines before it as context (for meaning only — a
// pronoun's gender, who "he" is; they are not translated again).
//   items: [{ id, send }] (only the ones with text)
const batches = (items, { size = 40, chars = 2400, context = 3 } = {}) => {
  const out = [];
  let cur = [];
  let n = 0;
  const flush = (at) => {
    if (!cur.length) return;
    const first = at - cur.length;
    out.push({
      context: items.slice(Math.max(0, first - context), first).map((x) => x.send),
      items: cur,
    });
    cur = [];
    n = 0;
  };
  items.forEach((it, i) => {
    if (cur.length && (cur.length >= size || n + it.send.length > chars)) flush(i);
    cur.push(it);
    n += it.send.length;
  });
  flush(items.length);
  return out;
};

const LANG_NAMES = { en: "English", ru: "Russian", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ar: "Arabic", tr: "Turkish", nl: "Dutch", ja: "Japanese", ko: "Korean", zh: "Chinese" };
const langName = (code) => LANG_NAMES[String(code || "").toLowerCase()] || "the original language";

const SYSTEM = (from) =>
  `You translate film and TV subtitles from ${from} into Hebrew, the way a professional Israeli subtitler would: ` +
  "natural spoken Hebrew, short and easy to read, faithful to the meaning and the tone (jokes, swearing and slang included). " +
  "You get a JSON object with \"lines\": {id: text} and, sometimes, \"before\": the lines just before them, for meaning only. " +
  "Reply with ONLY a JSON object {id: hebrew text} with EVERY id of \"lines\" and nothing else — no prose, no markdown fence, no notes. " +
  "Rules: translate each id on its own, never merge or split ids; " +
  "at most two lines (\\n) of about 40 characters each; " +
  "a line that starts with \"-\" is a second speaker: keep one line per speaker, each starting with \"-\"; " +
  "keep <i>, <b>, <u> tags around the matching words; " +
  "keep names, and translate sounds in brackets ([laughs] -> [צוחק]); " +
  "use the right gender for the speaker and the listener when the lines tell it, else masculine; " +
  "write numbers as digits; keep song lyrics short and singable.";

// The messages for one batch.
const messagesFor = (batch, from) => [
  { role: "system", content: SYSTEM(langName(from)) },
  {
    role: "user",
    content: JSON.stringify({
      ...(batch.context && batch.context.length ? { before: batch.context } : {}),
      lines: Object.fromEntries(batch.items.map((x) => [String(x.id), x.send])),
    }),
  },
];

// The model's reply -> { id: text }. Models wrap JSON in a fence or prose
// however often they are told not to, and a cut-off reply still has whole
// pairs in it: those are kept.
const parseReply = (text) => {
  let raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  let obj = null;
  if (a >= 0 && b > a) { try { obj = JSON.parse(raw.slice(a, b + 1)); } catch {} }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    // {"lines": {...}} back as it was sent: the inner object
    if (obj.lines && typeof obj.lines === "object") obj = obj.lines;
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const out = {};
  const re = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw))) {
    try { out[m[1]] = JSON.parse(`"${m[2]}"`); } catch {}
  }
  return out;
};

// Is this answer a translation of `src` into Hebrew? (A model sometimes hands
// a line back untranslated, or answers about something else.)
const acceptable = (answer, src) => {
  if (typeof answer !== "string") return false;
  const p = plain(answer).trim();
  if (!p) return false;
  if (p.length > plain(src).length * 3 + 40) return false;
  // a line of names or a number may stay as it is; anything with words must be Hebrew
  const srcWords = (plain(src).match(/\p{L}{3,}/gu) || []).length;
  if (srcWords >= 2 && !HEB.test(p)) return false;
  return true;
};

// ---------- cost ----------

// What a translation of these cues should cost, before it is made.
// Measured on real films (docs/qa/subtitles-ai/REPORT.md): Hebrew output runs
// about 1.4 tokens per character of English source with the JSON keys; the
// prompt adds SYSTEM_TOKENS per batch.
const SYSTEM_TOKENS = 330;
const estimate = (items, { batchCount = 1, priceIn = 0.3, priceOut = 2.5 } = {}) => {
  const chars = items.reduce((n, x) => n + x.send.length + 12, 0);
  const inTok = Math.round(chars / 3.6 + batchCount * SYSTEM_TOKENS + chars / 3.6 * 0.08);
  const outTok = Math.round(chars * 0.62);
  const usd = (inTok * priceIn + outTok * priceOut) / 1e6;
  return { chars, inTok, outTok, usd: Math.round(usd * 10000) / 10000 };
};

module.exports = {
  AI_LABEL, AI_FILE_LABEL, isAiFile, LINE_MAX, RLM, prepare, finish, wrap, rtlLine, cleanTags, batches, messagesFor, parseReply, acceptable, estimate, langName, plain, SYSTEM,
};
