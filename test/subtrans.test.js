// Translating a subtitle's cues (media/subtrans.js, the pure half of
// "Hebrew subtitles for anything"): what goes to the model, what comes back,
// and the cue that is made of it — timing never touched, lines readable,
// tags and right-to-left text right. Cue reading and writing for the formats
// the translation starts from (SRT, WebVTT, SubStation) is pinned here too.
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../src/media/subtrans");
const subsync = require("../src/media/subsync");
const websubs = require("../src/media/websubs");

const RLM = "‏";

// ---------- cues in and out ----------

test("SRT, WebVTT (settings, tags, no hours) and SubStation read to the same cues, and SRT writes them back exactly", () => {
  const srt = "1\n00:00:01,500 --> 00:00:03,000\n<i>Hello there.</i>\n\n2\n00:01:02,250 --> 00:01:04,004\n- Who?\n- Me.\n";
  const vtt = "WEBVTT\n\nNOTE made by hand\n\n00:01.500 --> 00:03.000 align:start position:10%\n<i>Hello there.</i>\n\ncue-2\n01:02.250 --> 01:04.004 line:90%\n- Who?\n- Me.\n";
  const ass = [
    "[Script Info]", "ScriptType: v4.00+", "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hello there.{\\i0}",
    "Dialogue: 0,0:01:02.25,0:01:04.00,Default,,0,0,0,,- Who?\\N- Me.",
  ].join("\n");
  const a = subsync.parse(srt);
  const b = subsync.parse(vtt);
  const c = subsync.parse(websubs._internals.toSrt(ass));
  assert.deepEqual(a.map((x) => [x.start, x.end]), [[1.5, 3], [62.25, 64.004]]);
  assert.deepEqual(b.map((x) => [x.start, x.end, x.text]), a.map((x) => [x.start, x.end, x.text]));
  // (SubStation keeps centiseconds; its override tags are dropped on the way in)
  assert.deepEqual(c.map((x) => [x.start, x.end, x.text]), [[1.5, 3, "Hello there."], [62.25, 64, "- Who?\n- Me."]]);
  assert.deepEqual(subsync.parse(subsync.toSrt(a)), a);
  // to the millisecond, every time
  const odd = [{ start: 3599.999, end: 3600.001, text: "x" }, { start: 7322.017, end: 7325.1, text: "y" }];
  assert.deepEqual(subsync.parse(subsync.toSrt(odd)), odd);
});

// ---------- what is sent ----------

test("prepare: tags kept or dropped, the whole-cue italic and the position remembered, nothing-to-say cues skipped", () => {
  assert.deepEqual(T.prepare("<i>I know.</i>"), { send: "I know.", pos: "", italic: true, dialogue: false, skip: false, source: "I know." });
  const two = T.prepare("<i>Line one</i>\n<i>line two.</i>");
  assert.equal(two.italic, true);
  assert.equal(two.send, "Line one\nline two.");
  // part of a cue in italics: the tag goes along, inside the text
  assert.equal(T.prepare("He said <i>never</i>.").send, "He said <i>never</i>.");
  // <font>, <c.yellow>, <v Name>, SubStation overrides: out; {\an8} remembered
  const p = T.prepare('{\\an8}<font color="#ffff00"><v Bob>Up here!</v></font>');
  assert.equal(p.send, "Up here!");
  assert.equal(p.pos, "{\\an8}");
  // entities and stray direction marks
  assert.equal(T.prepare("Tom &amp; Jerry &lt;3‎").send, "Tom & Jerry <3");
  assert.equal(T.prepare("- Hi.\n- Hello.").dialogue, true);
  assert.equal(T.prepare("Hi.\n- Hello.").dialogue, false);
  for (const s of ["♪", "...", "  ", "<i></i>", "♪ ♪"]) assert.equal(T.prepare(s).skip, true, JSON.stringify(s));
  // an unclosed tag is closed, a stray closing one dropped
  assert.equal(T.cleanTags("<i>open"), "<i>open</i>");
  assert.equal(T.cleanTags("close</i> me"), "close me");
  assert.equal(T.cleanTags("<B>bold</B> <u></u>"), "<b>bold</b> ");
});

test("batches: by count and by length, every cue once and in order, with the lines before as context", () => {
  const items = Array.from({ length: 95 }, (_, i) => ({ id: i + 1, send: i === 50 ? "x".repeat(900) : `Line number ${i + 1}.` }));
  const b = T.batches(items, { size: 40, chars: 1200, context: 3 });
  assert.deepEqual(b.flatMap((x) => x.items.map((y) => y.id)), items.map((x) => x.id));
  for (const x of b) {
    assert.ok(x.items.length <= 40);
    assert.ok(x.items.reduce((n, y) => n + y.send.length, 0) <= 1200 || x.items.length === 1);
  }
  assert.deepEqual(b[0].context, []);
  const first = b[1].items[0].id;
  assert.deepEqual(b[1].context, items.slice(first - 4, first - 1).map((x) => x.send));
  // the request: ids as keys, the context under "before", the language named
  const m = T.messagesFor(b[1], "en");
  assert.match(m[0].content, /from English into Hebrew/);
  const body = JSON.parse(m[1].content);
  assert.deepEqual(Object.keys(body.lines), b[1].items.map((x) => String(x.id)));
  assert.equal(body.before.length, 3);
  assert.match(T.messagesFor(b[0], "fr")[0].content, /from French/);
  assert.equal("before" in JSON.parse(T.messagesFor(b[0], "en")[1].content), false);
});

// ---------- what comes back ----------

test("parseReply: plain JSON, a fenced reply, the request's own shape, and the whole pairs of a cut-off one", () => {
  assert.deepEqual(T.parseReply('{"1":"שלום","2":"להתראות"}'), { 1: "שלום", 2: "להתראות" });
  assert.deepEqual(T.parseReply('Here you go:\n```json\n{"7": "כן"}\n```'), { 7: "כן" });
  assert.deepEqual(T.parseReply('{"lines": {"3": "לא"}}'), { 3: "לא" });
  assert.deepEqual(T.parseReply('{"1": "אחד", "2": "שת\\"יים\\nשורה", "3": "של'), { 1: "אחד", 2: 'שת"יים\nשורה' });
  assert.deepEqual(T.parseReply(""), {});
  assert.deepEqual(T.parseReply("sorry, I can't"), {});
});

test("acceptable: Hebrew for anything with words; a name or a number may stay; nothing runaway", () => {
  assert.equal(T.acceptable("אני יודע.", "I know that."), true);
  assert.equal(T.acceptable("I know that.", "I know that."), false); // handed back untranslated
  assert.equal(T.acceptable("Sarah!", "Sarah!"), true); // one word: a name
  assert.equal(T.acceptable("1999", "1999"), true);
  assert.equal(T.acceptable("", "Hello there."), false);
  assert.equal(T.acceptable(undefined, "Hello there."), false);
  assert.equal(T.acceptable("א".repeat(200), "Hi there."), false);
});

test("finish: two lines at most and about 40 characters each, one line per speaker, italics back, no {\\an8} printed as text", () => {
  const long = "אני לא חושב שזה רעיון טוב ללכת לשם עכשיו בלילה בלי אף אחד";
  const out = T.finish(long, T.prepare("I don't think it's a good idea to go there now at night without anyone."));
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.length <= 40, `${l.length}: ${l}`);
  assert.equal(lines.join(" "), long);
  // short stays on one line, even when the model broke it
  assert.equal(T.finish("כן,\nבטח.", T.prepare("Yes, sure.")), "כן, בטח.");
  // dialogue: one line per speaker, each with its dash — also when the model joined them
  const dlg = T.prepare("- Who's there?\n- Me.");
  assert.equal(T.finish("- מי שם?\n- אני.", dlg), "- מי שם?\n- אני.");
  assert.equal(T.finish("- מי שם? - אני.", dlg), "- מי שם?\n- אני.");
  assert.equal(T.finish("מי שם?\nאני.", dlg), "- מי שם?\n- אני.");
  // a cue italic as a whole: italic again, line by line
  assert.equal(T.finish("אני יודע.", T.prepare("<i>I know.</i>")), "<i>אני יודע.</i>");
  // a tag the model kept inside: kept; one it invented: dropped
  assert.equal(T.finish("הוא אמר <i>אף פעם</i>.", T.prepare("He said <i>never</i>.")), "הוא אמר <i>אף פעם</i>.");
  assert.equal(T.finish('<font color="red">שלום</font> <script>x</script>', T.prepare("Hello")), "שלום x");
  assert.equal(T.finish("למעלה!", T.prepare("{\\an8}Up here!")), "למעלה!");
  // a "<" that is no tag would break the WebVTT
  assert.equal(T.finish("אני <3 אותך", T.prepare("I <3 you")), "אני 3 אותך");
});

test("right to left: a mark in front of a Hebrew line that starts with a Latin word or a name, nothing on one that starts in Hebrew", () => {
  assert.equal(T.rtlLine("שלום, מה שלומך?"), "שלום, מה שלומך?");
  assert.equal(T.rtlLine("OK, בוא נלך."), `${RLM}OK, בוא נלך.`);
  assert.equal(T.rtlLine("- FBI! תפתחו!"), `${RLM}- FBI! תפתחו!`);
  assert.equal(T.rtlLine("<i>Ted</i> אמר כן."), `${RLM}<i>Ted</i> אמר כן.`);
  // a number first is no strong letter: Hebrew decides
  assert.equal(T.rtlLine("3 אנשים מתו."), "3 אנשים מתו.");
  // no Hebrew at all (a name, a song left in English): left as it is
  assert.equal(T.rtlLine("New York"), "New York");
  // through finish(), each line on its own; the model's own marks are not doubled
  const out = T.finish("‏OK, בוא נלך עכשיו לפני שמישהו יראה אותנו כאן", T.prepare("OK, let's go now before anyone sees us here."));
  assert.equal(out.split("\n")[0].startsWith(`${RLM}OK`), true);
  assert.equal(out.split(RLM).length, 2);
  // the punctuation stays where Hebrew writes it (the end of the sentence, logical order)
  assert.equal(T.finish("מה?", T.prepare("What?")), "מה?");
  // and the file's "reversed punctuation" repair never sees such a file as one to fix
  const file = Array.from({ length: 30 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\n${T.finish(i % 2 ? "מה קורה?" : "OK, בוא.", T.prepare("x y"))}\n`).join("\n");
  assert.equal(subsync.fixRtlPunctuation(file).changed, 0);
});

test("estimate: grows with the text and the number of calls; a film is cents", () => {
  const film = Array.from({ length: 1500 }, () => ({ send: "I don't think we should be here right now." }));
  const e = T.estimate(film, { batchCount: 38 });
  assert.ok(e.usd > 0.02 && e.usd < 0.2, `a 1,500-line film estimated at $${e.usd}`);
  const ep = T.estimate(film.slice(0, 450), { batchCount: 12 });
  assert.ok(ep.usd < e.usd / 2.5);
  assert.ok(T.estimate(film, { batchCount: 76 }).inTok > e.inTok);
});

test("the AI track's file and name", () => {
  assert.equal(T.AI_LABEL, "עברית (AI)");
  assert.equal(T.isAiFile("Heat (1995).Hebrew (AI).srt"), true);
  assert.equal(T.isAiFile("Heat (1995).hebrew (ai).SRT"), true);
  assert.equal(T.isAiFile("Heat (1995).Hebrew.srt"), false);
  assert.equal(T.isAiFile("Heat (1995).Hebrew 2.srt"), false);
  assert.equal(T.isAiFile("Hebrew (AI).txt"), false);
});
