// Franchise order says the same words on the website, the TV and the phone
// (tv-native/src/franchiseRules.ts FR_WORDS is the apps' list; the website's
// are in public/js/franchise.js, screens/franchise.js and the player's end
// card; the server's sentences come from src/media/franchises/logic.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const tvWords = () => {
  const src = read("tv-native/src/franchiseRules.ts");
  const block = /export const FR_WORDS = \{([\s\S]*?)\} as const;/.exec(src);
  assert.ok(block, "FR_WORDS is in franchiseRules.ts");
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*(['"])(.*?)\2,/g)) out[m[1]] = m[3];
  return out;
};

test("every word the TV and the phone show is the website's", () => {
  const w = tvWords();
  const web = [read("public/js/franchise.js"), read("public/js/screens/franchise.js"), read("public/js/screens/player.js")].join("\n");
  const server = [read("src/media/franchises/logic.js"), read("src/routes/api.js")].join("\n");
  for (const [k, word] of Object.entries(w)) {
    if (k === "action") { assert.ok(server.includes(`"${word}"`), `the server sends "${word}"`); continue; }
    if (k === "row") { assert.ok(server.includes(`"${word}"`), `Home's row is called "${word}"`); continue; }
    assert.ok(web.includes(`"${word}"`) || web.includes(`>${word}<`) || web.includes(word.replace(/&/g, "&amp;")), `the website says "${word}" (${k})`);
  }
  assert.ok(Object.keys(w).length >= 12);
});

test("the order labels are the server's alone — no client spells them", () => {
  const { ORDER_LABELS } = require("../src/media/franchises/logic");
  assert.deepEqual(ORDER_LABELS, { release: "Release order", story: "Story order" });
  for (const f of ["public/js/screens/franchise.js", "tv-native/src/screens/Franchise.tsx", "tv-native/src/phone/screens/Franchise.tsx"]) {
    const code = read(f).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(" "); // (comments may name them)
    assert.doesNotMatch(code, /Release order|Story order/, `${f} shows the server's labels, not its own`);
  }
});

test("the one action per entry is the same rule on both sides", () => {
  const web = read("public/js/franchise.js");
  const tv = read("tv-native/src/franchiseRules.ts");
  // on the server: a film → Play, a show → Open; not on it: a film → Save & watch, a show → Choose episode
  assert.match(web, /e\.onServer[\s\S]*?"show"[\s\S]*?"Open"[\s\S]*?"Play"[\s\S]*?"Choose episode"[\s\S]*?"Save & watch"/);
  assert.match(tv, /if \(e\.onServer\) return show \? \{kind: 'open'[\s\S]*?\{kind: 'play'[\s\S]*?return show \? \{kind: 'choose'[\s\S]*?\{kind: 'save'/);
});
