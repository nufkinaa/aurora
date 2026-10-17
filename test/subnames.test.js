// What a subtitle / audio track is called (media/subnames.js) — the report
// "embedded tracks show up as track 1 and track 2 and not by language".
const test = require("node:test");
const assert = require("node:assert/strict");
const n = require("../src/media/subnames");

const label = (language, title, extra = {}, detected = null) => n.subtitleName({ language, title, ...extra }, detected, 0).label;

test("a language tag in any of its spellings is the language's name", () => {
  for (const tag of ["heb", "he", "iw", "HEB", "he-IL"]) assert.equal(label(tag, null), "Hebrew", tag);
  for (const tag of ["eng", "en", "en-US"]) assert.equal(label(tag, null), "English", tag);
  assert.equal(label("pt-BR", null), "Portuguese");
  assert.equal(label("zh-Hans", null), "Chinese");
  // languages the old table did not know (they were "Track N")
  for (const [tag, name] of [["cat", "Catalan"], ["baq", "Basque"], ["glg", "Galician"], ["nob", "Norwegian"], ["hrv", "Croatian"], ["fil", "Filipino"], ["may", "Malay"], ["ukr", "Ukrainian"], ["gre", "Greek"], ["cze", "Czech"], ["slo", "Slovak"], ["rum", "Romanian"]]) {
    assert.equal(label(tag, null), name, tag);
  }
});

test("the code a track carries for the players: ISO 639-1 where there is one", () => {
  assert.equal(n.subtitleName({ language: "heb" }).lang, "he");
  assert.equal(n.subtitleName({ language: "iw" }).lang, "he");
  assert.equal(n.subtitleName({ language: "fil" }).lang, "fil");
  assert.equal(n.subtitleName({ language: "und" }).lang, null);
});

test("titles that only add flags become (SDH) / (Forced) / (Commentary)", () => {
  assert.equal(label("eng", "SDH"), "English (SDH)");
  assert.equal(label("eng", "English (SDH)"), "English (SDH)");
  assert.equal(label("eng", "English - SDH"), "English (SDH)");
  assert.equal(label("eng", "Forced"), "English (Forced)");
  assert.equal(label("eng", "English [Forced]"), "English (Forced)");
  assert.equal(label("eng", "Signs & Songs"), "English (Forced)");
  assert.equal(label("eng", "Director's Commentary"), "English (Commentary)");
  // and the file's own dispositions say the same
  assert.equal(label("eng", null, { forced: true }), "English (Forced)");
  assert.equal(label("eng", null, { sdh: true }), "English (SDH)");
});

test("a region or script in the title is kept; boilerplate and group names are not", () => {
  assert.equal(label("spa", "Spanish (Latin America)"), "Spanish (Latin America)");
  assert.equal(label("spa", "Spanish (Spain) (SDH)"), "Spanish (Spain, SDH)");
  assert.equal(label("por", "Portuguese (Brazil) (SDH)"), "Portuguese (Brazil, SDH)");
  assert.equal(label("chi", "Chinese (Simplified)"), "Chinese (Simplified)");
  assert.equal(label("eng", "Subtitles (Kametsu)"), "English");
  assert.equal(label("eng", "English"), "English");
  assert.equal(label("eng", "Track 1"), "English");
  assert.equal(label("eng", "GalaxyRG - Inception.2010.1080p"), "English");
});

test("no tag: the title is read for a language, else the text's own language, else an honest unknown", () => {
  assert.equal(label(null, "Hebrew"), "Hebrew");
  assert.equal(label("und", null, {}, { lang: "heb" }), "Hebrew");
  assert.equal(label(null, null, {}, { lang: "eng", sdh: true }), "English (SDH)");
  assert.equal(label(null, null, {}, { lang: "spa", forced: true }), "Spanish (Forced)");
  assert.equal(label(null, null), "Unknown (track 1)");
  assert.equal(label("und", "Track 1"), "Unknown (track 1)");
  assert.equal(label(null, "Commentary"), "Commentary");
  // a code nobody has a name for is shown as itself, not as a guess
  assert.equal(label("xyz", null), "XYZ");
  // what the file says beats what the text suggests
  assert.equal(label("fre", null, {}, { lang: "eng" }), "French");
});

test("two tracks with one name are numbered", () => {
  const t = n.uniqueLabels([{ label: "English" }, { label: "English (SDH)" }, { label: "English" }, { label: "English" }]);
  assert.deepEqual(t.map((x) => x.label), ["English", "English (SDH)", "English 2", "English 3"]);
});

test("audio tracks: the language, what the title adds, never Stereo / 5.1 / an encoder string", () => {
  const a = (language, title, i = 0) => n.audioName({ language, title }, i).label;
  assert.equal(a("eng", null), "English");
  assert.equal(a("heb", null), "Hebrew");
  assert.equal(a("eng", "Surround 5.1"), "English");
  assert.equal(a("eng", "Stereo"), "English");
  assert.equal(a("eng", "GalaxyRG265 - Inception.2010.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265"), "English");
  assert.equal(a("eng", "Commentary with the director"), "English · Commentary");
  assert.equal(a("und", null, 1), "Track 2");
  assert.equal(a(null, "Russian"), "Russian");
});

// ---------- the language of a text ----------
const repeat = (s, k = 12) => Array(k).fill(s).join("\n");

test("scripts are told by their letters", () => {
  assert.equal(n.detectLanguage(repeat("שלום, מה שלומך? אני בסדר גמור, תודה רבה.")).lang, "heb");
  assert.equal(n.detectLanguage(repeat("مرحبا كيف حالك؟ أنا بخير شكرا جزيلا لك.")).lang, "ara");
  assert.equal(n.detectLanguage(repeat("Привет, как дела? Мы были здесь вчера, ты это знаешь.")).lang, "rus");
  assert.equal(n.detectLanguage(repeat("Привіт, як справи? Ми були тут вчора, і ти це знаєш.")).lang, "ukr");
  assert.equal(n.detectLanguage(repeat("Γεια σου, τι κάνεις; Είμαι καλά, ευχαριστώ πολύ.")).lang, "gre");
  assert.equal(n.detectLanguage(repeat("こんにちは、元気ですか？私は元気です、ありがとう。")).lang, "jpn");
  assert.equal(n.detectLanguage(repeat("안녕하세요, 잘 지내세요? 저는 잘 지내요, 감사합니다.")).lang, "kor");
  assert.equal(n.detectLanguage(repeat("你好，你好吗？我很好，谢谢你。我们走吧。")).lang, "chi");
});

test("Latin-script languages are told by their commonest words", () => {
  const cases = {
    eng: "I don't know what you want from me. It's not that I was there, you know. We have to go now, this is it.",
    spa: "No sé lo que quieres de mí. Eso no es lo que te dije, pero está bien. Vamos a ver si es verdad, por favor.",
    fre: "Je ne sais pas ce que tu veux. C'est pas ce que je t'ai dit, mais ça va. On va voir si c'est vrai.",
    ger: "Ich weiß nicht, was du von mir willst. Das ist nicht, was ich dir gesagt habe, aber es ist gut so.",
    ita: "Non so cosa vuoi da me. Non è quello che ti ho detto, ma va bene. Vediamo se è vero, per favore.",
    por: "Eu não sei o que você quer de mim. Isso não é o que eu te disse, mas está bem. Vamos ver se é verdade.",
    dut: "Ik weet niet wat je van me wilt. Dat is niet wat ik je heb gezegd, maar het is goed zo. We gaan nu.",
    pol: "Nie wiem, czego ode mnie chcesz. To nie jest to, co ci powiedziałem, ale jest dobrze. Już idziemy.",
    tur: "Benden ne istediğini bilmiyorum. Bu sana söylediğim şey değil ama iyi. Hadi gidelim, çok geç oldu.",
  };
  for (const [lang, text] of Object.entries(cases)) {
    const d = n.detectLanguage(repeat(text, 8));
    assert.ok(d, `${lang}: nothing detected`);
    assert.equal(d.lang, lang, `${lang} read as ${d && d.lang}`);
  }
});

test("too little text, or no clear winner, is no answer at all", () => {
  assert.equal(n.detectLanguage("Hello there."), null);
  assert.equal(n.detectLanguage(repeat("12345 67890 ... !!! ???")), null);
});

test("sound descriptions make a track SDH; a song mark alone does not", () => {
  const sdh = ["[door slams]", "JOHN: Where were you?", "(sighs)", "I was out.", "[phone ringing]", "Fine."];
  assert.ok(n.sdhShare(sdh) >= 0.1);
  const plain = ["Where were you?", "I was out.", "♪ la la la ♪", "Fine.", "Okay.", "Let's go."];
  assert.ok(n.sdhShare(plain) < 0.1);
});
