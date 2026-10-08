// What the player remembers about subtitles and dubs (2026-10-08): the
// LANGUAGE — Hebrew, English or Russian — not the track's label.
//   public/js/lang.js      the rule (an ES module, imported as net.test.js does)
//   tv-native/src/lang.ts  its mirror — transpiled here with the TV app's own
//                          TypeScript and run through the very same tables
//                          (skipped when tv-native/node_modules is absent)
//   src/profiles.js        the server's whitelist, which folds legacy values
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const profiles = require("../src/profiles");

const loadWeb = () => import("../public/js/lang.js");
let tvFile;
const loadTv = async () => {
  let ts;
  try {
    ts = require("../tv-native/node_modules/typescript");
  } catch {
    return null;
  }
  if (!tvFile) {
    const src = fs.readFileSync(path.join(__dirname, "../tv-native/src/lang.ts"), "utf8");
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    tvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lang-")), "lang.mjs");
    fs.writeFileSync(tvFile, out);
  }
  return import(pathToFileURL(tvFile).href);
};
// Every assertion below runs against both builds of the rule.
const both = (name, fn) => {
  test(`${name} (web)`, async () => fn(await loadWeb()));
  test(`${name} (tv)`, async (t) => {
    const m = await loadTv();
    if (!m) return t.skip("tv-native/node_modules/typescript is not installed");
    return fn(m);
  });
};

// One real file's subtitle menu, as the TV logged it.
const REAL = "English 2 | English 3 | English | Hebrew 2 | Hebrew | English 9 | English - SDH | Arabic | Track 4 | Chinese (Simplified) | German | Spanish (Latin America) | French (Canada) | Hebrew 3 | Hindi | Russian | Turkish"
  .split(" | ")
  .map((label, i) => ({ label, url: `/s/${i}` }));
const REAL_LANGS = ["en", "en", "en", "he", "he", "en", "en", null, null, null, null, null, null, "he", null, "ru", null];

both("langOf: every label of a real file", ({ langOf }) => {
  assert.deepEqual(REAL.map(langOf), REAL_LANGS);
});

both("langOf: labels in words, decorated, in their own script, as bare codes", ({ langOf }) => {
  const table = [
    ["Hebrew", "he"], ["hebrew", "he"], ["HEBREW", "he"], ["Hebrew 2", "he"], ["Hebrew [Forced]", "he"], ["Hebrew (SDH)", "he"],
    ["עברית", "he"], ["עברית 2", "he"], ["כתוביות בעברית", "he"], ["HEB", "he"], ["heb", "he"], ["Movie.2020.heb", "he"],
    ["he", "he"], ["iw", "he"],
    ["English", "en"], ["English - SDH", "en"], ["English [Forced]", "en"], ["English 9", "en"], ["english (cc)", "en"],
    ["English - Director's commentary", "en"], ["ENG", "en"], ["eng", "en"], ["ENG SDH", "en"], ["en", "en"],
    ["en-US", "en"], ["en_GB", "en"],
    ["Russian", "ru"], ["Russian 2", "ru"], ["Русский", "ru"], ["русский", "ru"], ["Русские субтитры", "ru"],
    ["RUS", "ru"], ["rus", "ru"], ["ru", "ru"],
    // not one of the three
    ["Arabic", null], ["Track 4", null], ["Chinese (Simplified)", null], ["German", null],
    ["Spanish (Latin America)", null], ["French (Canada)", null], ["Hindi", null], ["Turkish", null],
    ["Subtitles", null], ["", null], ["Belarusian", null], ["Ukrainian", null], ["Brussels", null], ["Length", null],
    ["Henge", null], ["fr", null], ["fre", null], ["pt-BR", null], ["rum", null], ["run", null], ["hi", null], ["und", null],
  ];
  for (const [label, want] of table) assert.equal(langOf({ label }), want, JSON.stringify(label));
});

both("langOf: the track's language tag decides when there is one", ({ langOf }) => {
  for (const [lang, want] of [
    ["he", "he"], ["heb", "he"], ["iw", "he"], ["HEB", "he"], ["he-IL", "he"],
    ["en", "en"], ["eng", "en"], ["en-US", "en"], ["en_GB", "en"], ["ENG", "en"],
    ["ru", "ru"], ["rus", "ru"], ["ru-RU", "ru"],
    ["fr", null], ["fre", null], ["pt_BR", null], ["ara", null], ["rum", null], ["hi", null],
    ["Hebrew", "he"], ["English", "en"],
  ]) {
    assert.equal(langOf({ lang }), want, lang);
    assert.equal(langOf({ language: lang }), want, `language: ${lang}`);
  }
  // a tag for another language is an answer, whatever the label says
  assert.equal(langOf({ lang: "fre", label: "English" }), null);
  // no tag, or "undetermined": the label is read
  assert.equal(langOf({ lang: "und", label: "Hebrew 2" }), "he");
  assert.equal(langOf({ lang: "", label: "English - SDH" }), "en");
  assert.equal(langOf({ lang: null, label: "Russian" }), "ru");
  // the fetched tracks' shape (routes/subtitles.js, media/websubs.js)
  assert.equal(langOf({ lang: "heb", label: "Hebrew", note: "WEB-DL" }), "he");
  assert.equal(langOf({ lang: "he", label: "Subtitles" }), "he");
  assert.equal(langOf(null), null);
  assert.equal(langOf(undefined), null);
  assert.equal(langOf({}), null);
});

both("normPick: what older builds stored is read as its language", ({ normPick }) => {
  for (const [stored, want] of [
    ["off", "off"], ["Off", "off"], ["he", "he"], ["en", "en"], ["ru", "ru"],
    ["Hebrew 2", "he"], ["Hebrew", "he"], ["heb", "he"], ["iw", "he"], ["עברית", "he"],
    ["eng", "en"], ["English - SDH", "en"], ["English 9", "en"], ["English [Forced]", "en"], ["en-US", "en"],
    ["rus", "ru"], ["Russian", "ru"], ["Русский", "ru"],
    ["Arabic", null], ["Track 4", null], ["fre", null], ["Chinese (Simplified)", null], ["", null], ["  ", null],
    [null, null], [undefined, null], [7, null],
  ]) assert.equal(normPick(stored), want, JSON.stringify(stored));
});

both("pickOf: off, one of the three languages, or not remembered at all", ({ pickOf }) => {
  assert.equal(pickOf(null), "off");
  assert.equal(pickOf({ label: "Hebrew 2" }), "he");
  assert.equal(pickOf({ label: "English - SDH" }), "en");
  assert.equal(pickOf({ lang: "rus", label: "Russian" }), "ru");
  assert.equal(pickOf({ label: "Arabic" }), null, "another language is a one-off");
  assert.equal(pickOf({ label: "Track 4" }), null, "a track nobody can place is a one-off");
});

both("bestTrackIndex: the first full track of the language", ({ bestTrackIndex }) => {
  const label = (lang) => {
    const i = bestTrackIndex(REAL, lang);
    return i < 0 ? null : REAL[i].label;
  };
  assert.equal(label("en"), "English 2", "the first listed — sidecars come before embedded streams");
  assert.equal(label("he"), "Hebrew 2");
  assert.equal(label("ru"), "Russian");
  assert.equal(bestTrackIndex(REAL, "off"), -1);
  assert.equal(bestTrackIndex(REAL, null), -1);
  assert.equal(bestTrackIndex([], "he"), -1);
  assert.equal(bestTrackIndex(null, "he"), -1);
  assert.equal(bestTrackIndex([{ label: "Arabic" }, { label: "Track 2" }], "he"), -1, "the title has none");
});

both("bestTrackIndex: full before SDH before forced, whatever the order", ({ bestTrackIndex, trackRank }) => {
  const pick = (labels, lang) => {
    const tracks = labels.map((label) => ({ label }));
    const i = bestTrackIndex(tracks, lang);
    return i < 0 ? null : labels[i];
  };
  assert.equal(pick(["English - SDH", "English [Forced]", "English 2", "English"], "en"), "English 2");
  assert.equal(pick(["English [Forced]", "English - SDH"], "en"), "English - SDH");
  assert.equal(pick(["Hebrew", "English - SDH"], "en"), "English - SDH", "SDH when it is the only one");
  assert.equal(pick(["English [Forced]", "Hebrew"], "en"), "English [Forced]", "forced when it is the only one");
  assert.equal(pick(["Hebrew (Forced)", "Hebrew 2", "Hebrew 3"], "he"), "Hebrew 2");
  assert.equal(pick(["English (CC)", "English - Commentary", "English 4"], "en"), "English 4");
  assert.equal(pick(["Signs & Songs - English", "English"], "en"), "English");
  assert.equal(pick(["Hebrew", "Hebrew 2", "Hebrew 3"], "he"), "Hebrew");
  // a tagged, fetched track and a label-only one are the same language
  const mixed = [{ label: "English" }, { lang: "heb", label: "Subtitles" }, { label: "Hebrew 2", embedded: true }];
  assert.equal(bestTrackIndex(mixed, "he"), 1);
  assert.deepEqual(
    ["English", "English - SDH", "English [Forced]", "ENG CC", "English 9"].map((label) => trackRank({ label })),
    [0, 1, 2, 1, 0],
  );
});

both("audio: the three languages are stored normalised, other dubs as their tag", ({ audioPick, sameAudio }) => {
  assert.equal(audioPick("heb"), "he");
  assert.equal(audioPick("eng"), "en");
  assert.equal(audioPick("en-US"), "en");
  assert.equal(audioPick("rus"), "ru");
  assert.equal(audioPick("fre"), "fre");
  assert.equal(audioPick("JPN"), "jpn");
  assert.equal(audioPick(""), null);
  assert.equal(audioPick(undefined), null);
  assert.ok(sameAudio("heb", "he"));
  assert.ok(sameAudio("he", "heb"), "what an older build remembered still matches");
  assert.ok(sameAudio("eng", "eng"));
  assert.ok(sameAudio("iw", "heb"));
  assert.ok(sameAudio("fre", "fre"));
  assert.ok(sameAudio("FRE", "fre"));
  assert.ok(!sameAudio("fre", "fra"), "other languages match by tag, as they always did");
  assert.ok(!sameAudio("eng", "he"));
  assert.ok(!sameAudio("", "he"));
  assert.ok(!sameAudio(undefined, undefined));
  assert.ok(!sameAudio("und", "und"));
  assert.ok(!sameAudio("eng", null));
});

// ---- the server's whitelist (profiles.update) ----
profiles._internals.store.save = () => {};
const withProfile = (prefs, fn) => {
  const keep = profiles._internals.store.data;
  profiles._internals.store.data = { profiles: [{ id: "p1", name: "T", prefs }], state: {}, pending: [], access: {} };
  try {
    return fn((patch) => {
      profiles.update("p1", { prefs: patch });
      return profiles._internals.store.data.profiles[0].prefs;
    });
  } finally {
    profiles._internals.store.data = keep;
  }
};

test("server: subPick is off | he | en | ru, and legacy values are folded to it", async () => {
  const { normPick } = await loadWeb();
  for (const [sent, want] of [
    ["off", "off"], ["he", "he"], ["en", "en"], ["ru", "ru"],
    ["Hebrew 2", "he"], ["eng", "en"], ["English - SDH", "en"], ["English [Forced]", "en"], ["English 9", "en"],
    ["heb", "he"], ["iw", "he"], ["עברית", "he"], ["Russian", "ru"], ["Русский", "ru"], ["rus", "ru"], ["en-US", "en"],
  ]) {
    withProfile({}, (send) => assert.equal(send({ subPick: sent }).subPick, want, sent));
    assert.equal(normPick(sent), want, `the players agree on ${sent}`);
  }
});

test("server: a pick in another language changes nothing; null clears", () => {
  for (const sent of ["Arabic", "Track 4", "fre", "Chinese (Simplified)", "", 7, {}, "x".repeat(200)]) {
    withProfile({ subPick: "he" }, (send) => assert.equal(send({ subPick: sent }).subPick, "he", String(sent)));
    withProfile({}, (send) => assert.equal("subPick" in send({ subPick: sent }), false, String(sent)));
  }
  withProfile({ subPick: "he" }, (send) => assert.equal("subPick" in send({ subPick: null }), false));
});

test("server: a label an older build left in the store is folded or dropped on the next write", () => {
  withProfile({ subPick: "Hebrew 2" }, (send) => assert.equal(send({ smartDownloads: true }).subPick, "he"));
  withProfile({ subPick: "English - SDH" }, (send) => assert.equal(send({ audioLang: "eng" }).subPick, "en"));
  withProfile({ subPick: "Track 4" }, (send) => assert.equal("subPick" in send({ smartDownloads: true }), false));
  withProfile({ subPick: "Hebrew 2" }, (send) => assert.equal(send({ subPick: "Arabic" }).subPick, "he"));
  withProfile({ subPick: "off" }, (send) => assert.equal(send({ smartDownloads: false }).subPick, "off"));
});

test("server: audioLang keeps its permissive shape", () => {
  for (const ok of ["he", "en", "ru", "eng", "heb", "fre", "pt-BR", "jpn"]) {
    withProfile({}, (send) => assert.equal(send({ audioLang: ok }).audioLang, ok));
  }
  withProfile({ audioLang: "he" }, (send) => assert.equal(send({ audioLang: "<script>" }).audioLang, "he"));
  withProfile({ audioLang: "he" }, (send) => assert.equal("audioLang" in send({ audioLang: null }), false));
});
