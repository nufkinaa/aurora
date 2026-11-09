// What a title page says while its title downloads — the website, the TV and
// the phone app the same, word for word (elia: "the same features and the same
// version of them on every platform"). A device pass (2026-11-09) found the
// phone's button saying "Saving 42%" with "Downloading · best source · 42%"
// under it, where the website's says "Downloading · 42%" and nothing under it.
//
// The website's words live in public/js/screens/discover-detail.js (saveState:
// the Save & watch button; epJobText: an episode card); the apps' in
// tv-native/src/detailLogic.ts (SAVE_WORDS / CARD_WORDS), which the TV's and
// the phone's title pages both use (tv-native __tests__/logic/download-words.test.ts
// holds the apps' rules). This reads both sources and compares them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const web = read("public/js/screens/discover-detail.js");
const apps = read("tv-native/src/detailLogic.ts");

// the text between `start` and the first `end` after it
const slice = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `found ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `found ${end} after ${start}`);
  return src.slice(a, b);
};
// every quoted string and template literal, a `${…}` read as N
const words = (src) =>
  [...src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]+\}/g, "N"))
    .filter((w) => /[A-Za-z]/.test(w) && !/^(pending|approved|downloading|copying|finding|starting)$/.test(w));

test("the Play button while it saves: the website's saveState words are the apps' SAVE_WORDS", () => {
  const site = slice(web, "const saveState = (job) => {", "saveBtn.title");
  const app = slice(apps, "export const SAVE_WORDS = {", "};");
  const w = words(site);
  assert.deepEqual(w, ["Waiting for approval", "Queued to download", "Almost there…", "Starting download…", "Downloading · N%"]);
  assert.deepEqual(new Set(words(app)), new Set(w));
  // and in the same places: pending, approved, the copy stage, the start
  assert.match(site, /job\.status === "pending" \? "Waiting for approval"/);
  assert.match(app, /pending: 'Waiting for approval'/);
  assert.match(site, /job\.status === "approved" \? "Queued to download"/);
  assert.match(app, /approved: 'Queued to download'/);
  assert.match(site, /job\.phase === "copying" \? "Almost there…"/);
  const rule = slice(apps, "export const saveText = ", "\n};");
  assert.match(rule, /job\.phase === 'copying'\) return SAVE_WORDS\.finishing/);
  assert.match(site, /job\.phase === "finding" \|\| job\.phase === "starting" \|\| !\(job\.progress > 0\) \? "Starting download…"/);
  assert.match(rule, /job\.phase === 'finding' \|\| job\.phase === 'starting' \|\| !\(\(job\.progress \|\| 0\) > 0\)\) return SAVE_WORDS\.starting/);
});

test("an episode card: the website's epJobText words are the apps' CARD_WORDS", () => {
  const site = slice(web, "const epJobText = (job) => {", "\n  };");
  const app = slice(apps, "export const CARD_WORDS = {", "};");
  const w = words(site);
  assert.deepEqual(w, ["Requested", "Starting", "Downloading N%"]);
  assert.deepEqual(new Set(words(app)), new Set(w));
});

test("the TV's and the phone's title pages say only those words, with no line under Play while it runs", () => {
  for (const f of ["tv-native/src/screens/Detail.tsx", "tv-native/src/phone/screens/Detail.tsx"]) {
    const src = read(f);
    assert.match(src, /saveText|heroDl\.label/, `${f} takes the button's words from detailLogic`);
    assert.doesNotMatch(src, /best source\s*·\s*\$\{/, `${f}: no "Downloading · best source · N%" line`);
    assert.doesNotMatch(src, /SAVING|`Saving \$\{(?:pct\}|p\}|Math\.round)/, `${f}: no "Saving N%"`);
    assert.doesNotMatch(src, /Getting it…|Finding the best source…/, `${f}: pressed, it says the website's "Starting download…"`);
  }
  // the old shared line is gone
  assert.doesNotMatch(apps, /best source  ·  \$\{pct\}%|SAVING \$\{pct\}%/);
});
