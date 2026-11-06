// "Tell me when it's ready" on the website (public/js/readyNotice.js) — and
// the TV's and the phone's side (tv-native/src/readyNotice.ts) saying the same
// words: the Settings row and the fallback sentence are compared to the letter,
// and the TV's own jest file (__tests__/logic/ready-notice.test.ts) runs the
// same cases as here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const web = () => import(pathToFileURL(path.join(REPO, "public", "js", "readyNotice.js")).href);
const done = { status: "done", mine: true, libraryId: "lib1", seenAt: null, smart: false, label: "Film", title: "Film" };
const LANG = "This copy doesn't say its language — report it again if it's wrong.";

test("the website: the server's sentence, else the fallback; the language line rides along, even switched off", async () => {
  const { readyText } = await web();
  assert.equal(readyText({ ...done, readyLine: "“Film” is ready to watch" }, true), "“Film” is ready to watch");
  assert.equal(readyText(done, true), "“Film” is ready to watch");
  assert.equal(readyText({ ...done, label: "Film — another version" }, true), "“Film” is ready to watch");
  assert.equal(readyText({ ...done, readyLine: "The new version of “Film” is in — ready to watch", langLine: LANG }, true), `The new version of “Film” is in — ready to watch. ${LANG}`);
  assert.equal(readyText({ ...done, langLine: LANG }, false), `“Film”: ${LANG}`);
  for (const [what, job, on] of [["off", done, false], ["not mine", { ...done, mine: false }, true], ["not done", { ...done, status: "downloading" }, true], ["no library id", { ...done, libraryId: null }, true], ["opened", { ...done, seenAt: "x" }, true], ["smart", { ...done, smart: true }, true], ["nothing", null, true]]) {
    assert.equal(readyText(job, on), null, what);
  }
});

test("the TV and the phone say the same words as the website", async () => {
  const w = await web();
  const tv = fs.readFileSync(path.join(REPO, "tv-native", "src", "readyNotice.ts"), "utf8");
  const quoted = (s) => [`"${s}"`, `'${s}'`];
  assert.ok(quoted(w.READY_LABEL).some((q) => tv.includes(q)), "the Settings label");
  assert.ok(quoted(w.READY_NOTE).some((q) => tv.includes(q)), "the Settings note");
  const webSrc = fs.readFileSync(path.join(REPO, "public", "js", "readyNotice.js"), "utf8");
  for (const bit of ["`“${name}” is ready to watch`", "`${ready}. ${lang}`", "`“${name}”: ${lang}`", "/ — another version$/"]) {
    assert.ok(webSrc.includes(bit) && tv.includes(bit), `both say ${bit}`);
  }
});

test("the server's sentences match the fallback the apps use", () => {
  const src = fs.readFileSync(path.join(REPO, "src", "media", "downloads.js"), "utf8");
  assert.ok(src.includes("`“${name}” is ready to watch`"), "publicJob readyLine says what the apps' fallback says");
  assert.equal(require("../src/media/langcheck").UNKNOWN_LINE, LANG);
});
