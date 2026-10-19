// Voice search's rules, the same on the website and the TV app:
//   public/js/voicelogic.js     the website's (an ES module, imported as is)
//   tv-native/src/voiceLogic.ts its mirror — transpiled here with the TV app's
//                               own TypeScript and run through the very same
//                               assertions (skipped when tv-native/node_modules
//                               is absent)
// The language to listen in, every moment of one voice search from the
// recogniser's events (permission refused, no recogniser, partial and final
// results, cancel), and the words the person is told.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const loadWeb = () => import("../public/js/voicelogic.js");
let tvFile;
const loadTv = async () => {
  let ts;
  try {
    ts = require("../tv-native/node_modules/typescript");
  } catch {
    return null;
  }
  if (!tvFile) {
    const src = fs.readFileSync(path.join(__dirname, "../tv-native/src/voiceLogic.ts"), "utf8");
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    tvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora-voice-")), "voiceLogic.mjs");
    fs.writeFileSync(tvFile, out);
  }
  return import(pathToFileURL(tvFile).href);
};
const both = (name, fn) => {
  test(`${name} (web)`, async () => fn(await loadWeb()));
  test(`${name} (tv)`, async (t) => {
    const m = await loadTv();
    if (!m) return t.skip("tv-native/node_modules/typescript is not installed");
    return fn(m);
  });
};
const run = (m, events, from) => events.reduce((s, e) => m.voiceReduce(s, e), from || m.VOICE_IDLE);

both("the language: the person's choice, else the device's", ({ voiceLangFor, bcp47, otherLang, VOICE_PREFS }) => {
  assert.deepEqual(VOICE_PREFS, ["auto", "he", "en"]);
  assert.equal(voiceLangFor("he", "en-US"), "he");
  assert.equal(voiceLangFor("en", "he-IL"), "en");
  assert.equal(voiceLangFor("auto", "he-IL"), "he");
  assert.equal(voiceLangFor("auto", "iw_IL"), "he", "Android's old code for Hebrew");
  assert.equal(voiceLangFor(undefined, "he"), "he");
  assert.equal(voiceLangFor("auto", "en-GB"), "en");
  assert.equal(voiceLangFor("auto", "ru-RU"), "en", "a language voice search does not listen in: English");
  assert.equal(voiceLangFor("ru", "hello"), "en");
  assert.equal(voiceLangFor(null, null), "en");
  assert.equal(bcp47("he"), "he-IL");
  assert.equal(bcp47("en"), "en-US");
  assert.equal(otherLang("he"), "en");
  assert.equal(otherLang("en"), "he");
});

both("a voice search: start, words as they come, the final words", (m) => {
  let s = m.voiceReduce(m.VOICE_IDLE, { type: "start", lang: "he" });
  assert.deepEqual(s, { phase: "starting", lang: "he", interim: "", text: "", error: null });
  assert.equal(m.voiceActive(s), true);
  assert.equal(m.voiceMessage(s), "Starting the microphone…");
  s = m.voiceReduce(s, { type: "ready" });
  assert.equal(s.phase, "listening");
  assert.equal(m.voiceMessage(s, "tv"), "Listening in Hebrew… say a title");
  s = m.voiceReduce(s, { type: "partial", text: "breaking" });
  assert.equal(s.interim, "breaking");
  assert.equal(m.voiceMessage(s), "", "the words themselves are on screen");
  s = m.voiceReduce(s, { type: "partial", text: "  breaking   bad " });
  assert.equal(s.interim, "breaking bad");
  s = m.voiceReduce(s, { type: "partial", text: "" });
  assert.equal(s.interim, "breaking bad", "an empty partial keeps what was there");
  s = m.voiceReduce(s, { type: "final", text: "Breaking Bad" });
  assert.deepEqual(s, { phase: "heard", lang: "he", interim: "Breaking Bad", text: "Breaking Bad", error: null });
  assert.equal(m.voiceActive(s), false);
  // what comes after the answer changes nothing
  assert.deepEqual(m.voiceReduce(s, { type: "end" }), s);
  assert.deepEqual(m.voiceReduce(s, { type: "error", code: 7 }), s);
  assert.deepEqual(m.voiceReduce(s, { type: "partial", text: "x" }), s);
  // the search ran: back to rest, the language kept
  assert.deepEqual(m.voiceReduce(s, { type: "done" }), { ...m.VOICE_IDLE, lang: "he" });
  // a partial straight after start (no "ready" from that recogniser) is listening too
  s = run(m, [{ type: "start", lang: "en" }, { type: "partial", text: "dune" }]);
  assert.equal(s.phase, "listening");
});

both("permission refused, refused for good, and no recogniser on the device", (m) => {
  let s = run(m, [{ type: "start", lang: "en" }, { type: "permission", granted: true }]);
  assert.equal(s.phase, "starting");
  s = run(m, [{ type: "start", lang: "en" }, { type: "permission", granted: false }]);
  assert.deepEqual([s.phase, s.error], ["error", "denied"]);
  assert.equal(m.voiceMessage(s, "tv"), "Aurora isn't allowed to use the microphone. Press the mic again and choose Allow.");
  assert.equal(m.voiceMessage(s, "web"), m.voiceMessage(s, "tv"));
  s = run(m, [{ type: "start", lang: "en" }, { type: "permission", granted: false, never: true }]);
  assert.equal(s.error, "blocked");
  assert.match(m.voiceMessage(s, "tv"), /Settings → Apps → Aurora → Permissions/);
  assert.match(m.voiceMessage(s, "web"), /site settings/);
  s = run(m, [{ type: "start", lang: "en" }, { type: "unavailable" }]);
  assert.equal(s.error, "unavailable");
  assert.match(m.voiceMessage(s, "tv"), /no speech recognition/);
  // the browser's own "not allowed"
  s = run(m, [{ type: "start", lang: "en" }, { type: "error", code: "not-allowed" }]);
  assert.equal(s.error, "denied");
  s = run(m, [{ type: "start", lang: "en" }, { type: "error", code: "service-not-allowed" }]);
  assert.equal(s.error, "blocked");
  // Android's ERROR_INSUFFICIENT_PERMISSIONS
  s = run(m, [{ type: "start", lang: "en" }, { type: "error", code: 9 }]);
  assert.equal(s.error, "denied");
});

both("nothing heard, nothing understood — unless words were already on screen", (m) => {
  let s = run(m, [{ type: "start", lang: "en" }, { type: "ready" }, { type: "error", code: "no-speech" }]);
  assert.deepEqual([s.phase, s.error], ["error", "no-speech"]);
  assert.equal(m.voiceMessage(s), "Didn't hear anything. Press the mic and say a title.");
  s = run(m, [{ type: "start", lang: "en" }, { type: "ready" }, { type: "error", code: 7 }]);
  assert.equal(s.error, "no-match");
  s = run(m, [{ type: "start", lang: "en" }, { type: "ready" }, { type: "final", text: "  " }]);
  assert.equal(s.error, "no-match");
  s = run(m, [{ type: "start", lang: "en" }, { type: "ready" }, { type: "end" }]);
  assert.equal(s.error, "no-speech", "stopped without a word");
  // Android often ends a phrase with NO_MATCH after showing partial words: they stand
  s = run(m, [{ type: "start", lang: "en" }, { type: "partial", text: "the office" }, { type: "error", code: 7 }]);
  assert.deepEqual([s.phase, s.text], ["heard", "the office"]);
  s = run(m, [{ type: "start", lang: "en" }, { type: "partial", text: "the office" }, { type: "end" }]);
  assert.deepEqual([s.phase, s.text], ["heard", "the office"]);
  // …but a real failure throws the half-heard words away
  s = run(m, [{ type: "start", lang: "en" }, { type: "partial", text: "the off" }, { type: "error", code: "network" }]);
  assert.deepEqual([s.phase, s.error, s.interim], ["error", "network", ""]);
});

both("cancel: the person pressed Back or the mic again; the recogniser's own 'aborted' is quiet too", (m) => {
  let s = run(m, [{ type: "start", lang: "he" }, { type: "partial", text: "פאו" }, { type: "cancel" }]);
  assert.deepEqual(s, { ...m.VOICE_IDLE, lang: "he" });
  assert.equal(m.voiceMessage(s), "");
  s = run(m, [{ type: "start", lang: "en" }, { type: "error", code: "aborted" }]);
  assert.deepEqual(s, { ...m.VOICE_IDLE, lang: "en" });
  // a late event from the cancelled session changes nothing
  assert.deepEqual(m.voiceReduce(s, { type: "final", text: "late" }), s);
  assert.deepEqual(m.voiceReduce(s, { type: "permission", granted: false }), s);
  // a new start after an error
  s = run(m, [{ type: "start", lang: "en" }, { type: "error", code: 2 }, { type: "start", lang: "he" }]);
  assert.deepEqual(s, { phase: "starting", lang: "he", interim: "", text: "", error: null });
});

both("every error the recognisers name has words, and a language that cannot be heard offers the other", (m) => {
  const codes = ["not-allowed", "service-not-allowed", "no-speech", "audio-capture", "network", "language-not-supported", "bad-grammar",
    "denied", "blocked", "unavailable", "no-match", "busy", "audio", "language", "client", "server", "failed",
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, "something new"];
  for (const code of codes) {
    for (const platform of ["web", "tv"]) {
      const s = run(m, [{ type: "start", lang: "en" }, { type: "error", code }]);
      assert.equal(s.phase, "error", String(code));
      assert.ok(m.voiceMessage(s, platform).length > 10, `${code} on ${platform}: ${m.voiceMessage(s, platform)}`);
    }
  }
  const s = run(m, [{ type: "start", lang: "he" }, { type: "error", code: 12 }]);
  assert.equal(m.voiceMessage(s, "tv"), "Listening in Hebrew isn't available here. Switch to English.");
  assert.equal(m.voiceError("something new"), "failed");
});

test("the two builds say the same words, moment by moment", async (t) => {
  const web = await loadWeb();
  const tv = await loadTv();
  if (!tv) return t.skip("tv-native/node_modules/typescript is not installed");
  const states = [web.VOICE_IDLE];
  for (const lang of ["he", "en"]) {
    states.push(web.voiceReduce(web.VOICE_IDLE, { type: "start", lang }));
    states.push(run(web, [{ type: "start", lang }, { type: "ready" }]));
    for (const code of ["not-allowed", "service-not-allowed", "no-speech", 3, 7, 8, 2, 12, "x", "unavailable"]) {
      states.push(run(web, [{ type: "start", lang }, { type: "error", code }]));
    }
  }
  for (const s of states) {
    for (const p of ["web", "tv"]) assert.equal(tv.voiceMessage(s, p), web.voiceMessage(s, p), JSON.stringify(s));
  }
  assert.deepEqual(tv.LANG_SELF, web.LANG_SELF);
  assert.deepEqual(tv.LANG_NAME, web.LANG_NAME);
});
