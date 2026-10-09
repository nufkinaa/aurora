// The healer's "TV trailers" check (src/lib/healer-checks/stats.js): the TVs
// report every trailer that failed, the server counts what Apple and Wikidata
// answered, and the check names the fix — for YouTube, "update the TV's
// trailer extractor".
const test = require("node:test");
const assert = require("node:assert");
const stats = require("../src/lib/healer-checks/stats");
const signals = require("../src/lib/signals");
const { CHECKS } = require("../src/lib/healer")._internals;
const S = stats._internals;

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const none = { ytResolve: 0, ytPlay: 0, appleResolve: 0, applePlay: 0, appleApi: new Map() };

test("quiet days give no finding", () => {
  assert.deepEqual(S.judgeTrailers(none), []);
  assert.deepEqual(S.judgeTrailers({ ...none, ytResolve: S.TRAILER_MIN - 1, ytPlay: 2, applePlay: 1 }), []);
});

test("YouTube resolve failures name the fix: update the TV's trailer extractor", () => {
  const f = S.judgeTrailers({ ...none, ytResolve: 12 });
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "warn");
  assert.equal(f[0].title, "Trailers failing on TVs: 12 in 24 h (YouTube resolve) — update the TV's trailer extractor");
  assert.match(f[0].setting, /NewPipeExtractor in tv-native\/android\/app\/build\.gradle/);
});

test("play failures and Apple's catalogue moving are their own findings", () => {
  const f = S.judgeTrailers({ ...none, ytPlay: 6, applePlay: 5, appleApi: new Map([["apple:shape", 2], ["apple:403", 1], ["wikidata:503", 1]]) });
  const titles = f.map((x) => x.title);
  assert.ok(titles.includes("YouTube trailers stop playing on TVs: 6 in 24 h"));
  assert.ok(titles.includes("Apple trailers fail on TVs: 5 in 24 h"));
  const apple = f.find((x) => x.title === "Apple's trailer catalogue answers differently");
  assert.ok(apple);
  assert.match(apple.text, /shape ×2, 403 ×1/);
  assert.match(apple.setting, /APPLE_QS in src\/media\/trailers\.js/);
});

test("the check reads the TVs' reports from the last 24 h only", async () => {
  signals._reset();
  for (let i = 0; i < 6; i++) signals.hit("trailer-fail", "youtube:resolve", NOW - i * HOUR);
  signals.hit("trailer-fail", "youtube:resolve", NOW - 30 * HOUR); // too old
  signals.hit("trailer-fail", "apple:play", NOW - HOUR);
  signals.hit("trailer-apple", "wikidata:timeout", NOW - HOUR);
  const r = await stats.checkTrailers({ now: NOW, signals });
  assert.equal(r.status, "warn");
  assert.equal(r.findings[0].title, "Trailers failing on TVs: 6 in 24 h (YouTube resolve) — update the TV's trailer extractor");
  assert.match(r.summary, /6 YouTube resolve and 0 YouTube play failures, 1 Apple failures · 1 Apple\/Wikidata lookup errors/);
  signals._reset();
  const calm = await stats.checkTrailers({ now: NOW, signals });
  assert.equal(calm.status, "ok");
  assert.deepEqual(calm.findings, []);
});

test("the check is armed in the healer, in the Playback group", () => {
  const row = CHECKS.find((c) => c[0] === "trailers");
  assert.ok(row);
  assert.equal(row[2], "Playback");
  assert.equal(row[3], stats.checkTrailers);
});
