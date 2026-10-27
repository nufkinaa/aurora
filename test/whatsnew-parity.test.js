// The "New" screen, website and TV (parity, 2026-10-19): the cards of the
// current round (since: ROUND) are the same on both — the same titles and
// the same "what" sentence, in the same order — and each carries a "how" and
// a "go" that leads somewhere real on its platform. The "how" may differ:
// it names each platform's own Settings path. A website card about something
// only a browser has (AirPlay from an iPhone, 2026-10-26) says
// `webOnly: true` before its `since` and is left out of the comparison — it
// still needs a "how" and a "go", and the TV may not have one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const web = fs.readFileSync(path.join(ROOT, "public", "js", "screens", "whatsnew.js"), "utf8");
const tv = fs.readFileSync(path.join(ROOT, "tv-native", "src", "screens", "WhatsNew.tsx"), "utf8");

// The round's cards: every object literal that says `since: ROUND` (or
// `webOnly: true, since: ROUND`).
const unq = (s) => s.slice(1, -1).replace(/\\(["'\\])/g, "$1");
const STR = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const roundCards = (src) => {
  const out = [];
  const re = /\{\s*(webOnly: true, )?since: ROUND,([\s\S]*?)\n\s*\},?\r?\n/g;
  for (const m of src.matchAll(re)) {
    const body = m[2];
    const field = (name) => { const f = new RegExp(`${name}: ${STR}`).exec(body); return f ? unq(f[1]) : null; };
    const go = /go: \{\s*label: ("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),\s*(?:to|act): ("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(body);
    out.push({ webOnly: !!m[1], title: field("title"), what: field("what"), how: field("how"), go: go ? { label: unq(go[1]), to: unq(go[2]) } : null });
  }
  return out;
};

test("the round's New cards are the same on the website and the TV", () => {
  const all = roundCards(web);
  const w = all.filter((c) => !c.webOnly);
  const t = roundCards(tv);
  assert.ok(w.length >= 2, `website round cards: ${w.length}`);
  assert.ok(t.every((c) => !c.webOnly), "a TV card is never web-only");
  // every `since: ROUND` on either side is a card this test read
  assert.equal(all.length, (web.match(/since: ROUND,/g) || []).length, "every website round card is read");
  assert.equal(t.length, (tv.match(/since: ROUND,/g) || []).length, "every TV round card is read");
  assert.deepEqual(t.map((c) => c.title), w.map((c) => c.title), "same titles, same order");
  assert.deepEqual(t.map((c) => c.what), w.map((c) => c.what), "same sentence under each title");
  for (const c of [...all, ...t]) {
    assert.ok(c.how && c.how.length > 5, `${c.title}: a "how"`);
    assert.ok(c.go && c.go.label && c.go.to, `${c.title}: a "go"`);
  }
});

test("only this round carries the New ribbon, from one constant per platform", () => {
  assert.match(web, /export const ROUND = "\d+\.\d+\.\d+";/);
  assert.match(web, /const NEW_FROM = ROUND;/);
  assert.match(tv, /export const ROUND = '\d+\.\d+\.\d+';/);
  assert.match(tv, /const NEW_FROM = ROUND;/);
  // every older card says an older release than ROUND on the website
  const round = /export const ROUND = "([\d.]+)"/.exec(web)[1].split(".").map(Number);
  const older = [...web.matchAll(/since: "([\d.]+)"/g)].map((m) => m[1].split(".").map(Number));
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; };
  for (const v of older) assert.ok(cmp(v, round) < 0, `a card from ${v.join(".")} would carry the ribbon`);
});

test("every go of the round leads somewhere that exists", () => {
  // website: a route the router knows
  const router = fs.readFileSync(path.join(ROOT, "public", "js", "main.js"), "utf8");
  for (const c of roundCards(web)) {
    const route = c.go.to.replace(/^#/, "");
    if (route === "/") continue;
    // the screen's own actions (Join a party opens the join sheet, as on the TV)
    if (route === "join-party" || route === "report") {
      assert.ok(web.includes(`f.go.to === "${route}"`), `website: the action ${route} is not handled`);
      continue;
    }
    assert.ok(router.includes(`route("${route}"`), `website: no route for ${c.go.to}`);
  }
  // TV: an act the screen handles
  const handled = /const act = \(a: string\) => \{([\s\S]*?)\n  \};/.exec(tv)[1];
  for (const c of roundCards(tv)) assert.ok(handled.includes(`'${c.go.to}'`), `TV: the act '${c.go.to}' is not handled`);
});
