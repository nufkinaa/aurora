// Franchise order — the rules (src/media/franchises/logic.js): which order,
// where a title sits ("12 of 34"), what comes next at the end of a film (with
// gaps: optional entries, titles not out yet, titles the server lacks), and
// what Home's "Continue the franchise" offers.
const test = require("node:test");
const assert = require("node:assert/strict");
const franchises = require("../src/media/franchises");
const logic = require("../src/media/franchises/logic");

const e = (n, date, extra = {}) => ({ imdbId: `tt000000${n}`, tmdbId: n, type: "movie", title: `F${n}`, year: Number(date.slice(0, 4)), date, ...extra });
// release order: F1, S2 (an optional series), F3, F4, F5 (not out until 2099)
const raw = {
  id: "saga", name: "Saga", the: true, priority: 10, sources: ["https://example.org/saga"],
  entries: [
    e(1, "2001-05-01"),
    e(2, "2002-05-01", { type: "series", optional: true }),
    e(3, "2003-05-01"),
    e(4, "2004-05-01"),
    e(5, "2099-05-01"),
  ],
  // story: F4 is a prequel
  story: ["tt0000004", "tt0000002", "tt0000001", "tt0000003", "tt0000005"],
};
const fr = franchises.build([raw]).byId.get("saga");
const NOW = Date.parse("2026-11-09");

test("an order the franchise lacks is its release order", () => {
  assert.equal(logic.orderName(fr, "story"), "story");
  assert.equal(logic.orderName(fr, "nonsense"), "release");
  assert.equal(logic.orderName(fr, null), "release");
  const single = franchises.build([{ ...raw, id: "one", story: undefined }]).byId.get("one");
  assert.equal(logic.orderName(single, "story"), "release");
  assert.deepEqual(logic.ordersOf(single).map((o) => o.id), ["release"]);
  assert.deepEqual(logic.ordersOf(fr), [{ id: "release", label: "Release order" }, { id: "story", label: "Story order" }]);
});

test("only main entries are counted, in the order asked for", () => {
  assert.deepEqual(logic.placeOf(fr, "tt0000003", "release"), { position: 2, total: 4, optional: false });
  assert.deepEqual(logic.placeOf(fr, "tt0000003", "story"), { position: 3, total: 4, optional: false });
  assert.deepEqual(logic.placeOf(fr, "tt0000002", "release"), { position: null, total: 4, optional: true });
  assert.equal(logic.placeOf(fr, "tt9999999", "release"), null);
});

test("the title page's line, in the same words everywhere", () => {
  const l = logic.lineFor(fr, "tt0000004", "release");
  assert.equal(l.line, "Part of the Saga · 3 of 4");
  assert.equal(l.action, "Watch in order");
  assert.equal(logic.lineFor(fr, "tt0000004", "story").line, "Part of the Saga · 1 of 4");
  assert.equal(logic.lineFor(fr, "tt0000002", "release").line, "Part of the Saga", "an optional entry has no number");
  const sw = franchises.build([{ ...raw, id: "sw", name: "Star Wars", the: false }]).byId.get("sw");
  assert.equal(logic.lineFor(sw, "tt0000001", "release").line, "Part of Star Wars · 1 of 4");
  assert.equal(logic.nextKicker(sw), "Next in Star Wars");
  assert.equal(logic.nextKicker(fr), "Next in the Saga");
});

test("next in order skips optional entries", () => {
  const n = logic.nextAfter(fr, "tt0000001", "release", NOW);
  assert.equal(n.entry.imdbId, "tt0000003", "the optional series between them is skipped");
  assert.equal(n.position, 2);
  assert.equal(n.total, 4);
});

test("next in order follows the person's order", () => {
  assert.equal(logic.nextAfter(fr, "tt0000004", "story", NOW).entry.imdbId, "tt0000001");
  assert.equal(logic.nextAfter(fr, "tt0000004", "release", NOW), null, "F5 is not out yet");
});

test("a next title that is not out yet ends the franchise for now", () => {
  assert.equal(logic.nextAfter(fr, "tt0000003", "story", NOW), null);
  // …and once it is out, it is the answer
  assert.equal(logic.nextAfter(fr, "tt0000004", "release", Date.parse("2100-01-01")).entry.imdbId, "tt0000005");
});

test("the last title, and a title not in the order, have no next", () => {
  const done = franchises.build([{ ...raw, id: "d", entries: raw.entries.slice(0, 4), story: undefined }]).byId.get("d");
  assert.equal(logic.nextAfter(done, "tt0000004", "release", NOW), null);
  assert.equal(logic.nextAfter(fr, "tt0000077", "release", NOW), null);
});

test("an optional entry's next is the main entry after it", () => {
  assert.equal(logic.nextAfter(fr, "tt0000002", "release", NOW).entry.imdbId, "tt0000003");
});

test("continue the franchise: the first unwatched main entry after the furthest watched", () => {
  const watched = new Set(["tt0000001"]);
  const stateOf = (x) => (watched.has(x.imdbId) ? "watched" : null);
  let c = logic.continueFor(fr, "release", { stateOf, now: NOW });
  assert.equal(c.entry.imdbId, "tt0000003");
  assert.equal(c.position, 2);
  // a gap the person left behind is theirs: watched F1 and F4 → nothing after F4 is out
  watched.add("tt0000004");
  assert.equal(logic.continueFor(fr, "release", { stateOf, now: NOW }), null);
  // in story order F4 comes first; F1 is the furthest watched → F3
  c = logic.continueFor(fr, "story", { stateOf, now: NOW });
  assert.equal(c.entry.imdbId, "tt0000003");
});

test("continue the franchise: nothing for an untouched franchise, a finished one, or one already playing", () => {
  assert.equal(logic.continueFor(fr, "release", { stateOf: () => null, now: NOW }), null);
  assert.equal(logic.continueFor(fr, "release", { stateOf: () => "watched", now: NOW }), null);
  const playing = (x) => (x.imdbId === "tt0000001" ? "watched" : x.imdbId === "tt0000003" ? "started" : null);
  assert.equal(logic.continueFor(fr, "release", { stateOf: playing, now: NOW }), null, "F3 is in Continue Watching");
  // an optional series watched alone does not start a franchise
  const series = (x) => (x.imdbId === "tt0000002" ? "watched" : null);
  assert.equal(logic.continueFor(fr, "release", { stateOf: series, now: NOW }), null);
});

test("continue the franchise: the moment it was last watched comes along (Home sorts by it)", () => {
  const c = logic.continueFor(fr, "release", { stateOf: (x) => (x.imdbId === "tt0000001" ? "watched" : null), lastAt: () => 42, now: NOW });
  assert.equal(c.at, 42);
});

test("the franchise page's summary counts main entries", () => {
  const onServer = (x) => x.imdbId === "tt0000001" || x.imdbId === "tt0000002";
  const stateOf = (x) => (x.imdbId === "tt0000003" ? "watched" : null);
  assert.equal(logic.summaryOf(fr, { onServer, stateOf }), "4 films · 1 optional · 1 on the server · 1 watched");
  const films = franchises.build([{ ...raw, id: "f", entries: raw.entries.filter((x) => x.type === "movie"), story: undefined }]).byId.get("f");
  assert.equal(logic.summaryOf(films, { onServer: () => false, stateOf: () => null }), "4 films · 0 on the server");
});
