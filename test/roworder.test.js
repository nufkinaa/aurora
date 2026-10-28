// The home-row composer's per-profile merge. Two hard contracts from the
// prompt-08 spec: a stored order must NEVER drop rows it doesn't know
// (generated ids like liked-<genre> appear after an update), and "upcoming"
// (unreleased titles) must never land first — the TV heroes rows[0].items[0].
const test = require("node:test");
const assert = require("node:assert");

const { orderRows } = require("../src/routes/api")._internals;

const R = (id) => ({ id, title: id, items: [{ id: id + "-item" }] });
const ids = (rows) => rows.map((r) => r.id);

const BASE = [R("continue"), R("mylist"), R("trending-stream"), R("liked-Drama"), R("upcoming")];

test("no prefs → the default order, untouched", () => {
  assert.deepEqual(ids(orderRows(BASE)), ids(orderRows(BASE, null)));
});

test("stored order applies; unknown rows keep their place at the end", () => {
  const out = orderRows(BASE, { order: ["mylist", "continue"], hidden: [] });
  assert.deepEqual(ids(out).slice(0, 2), ["mylist", "continue"]);
  assert.ok(ids(out).includes("liked-Drama"), "generated row survives an order that predates it");
  assert.equal(out.length, BASE.length, "nothing dropped");
});

test("hidden rows are removed; everything else survives", () => {
  const out = orderRows(BASE, { order: [], hidden: ["trending-stream"] });
  assert.ok(!ids(out).includes("trending-stream"));
  assert.equal(out.length, BASE.length - 1);
});

test("'upcoming' can never be first, whatever the stored order says", () => {
  const out = orderRows(BASE, { order: ["upcoming", "continue"], hidden: [] });
  assert.notEqual(out[0].id, "upcoming");
  assert.ok(ids(out).includes("upcoming"), "still present, just not the hero source");
});

test("an order full of stale ids degrades to the default sequence", () => {
  const out = orderRows(BASE, { order: ["gone-1", "gone-2"], hidden: [] });
  assert.equal(out.length, BASE.length);
});

test("hiding everything except 'upcoming' fails closed — empty beats an unreleased hero", () => {
  const out = orderRows(BASE, {
    order: [],
    hidden: ["continue", "mylist", "trending-stream", "liked-Drama"],
  });
  assert.deepEqual(ids(out), []);
});

test("the recommender's generated rows sit with Recommended, in reading order; the stretch row comes later", () => {
  const rows = [R("trending-stream"), R("stretch"), R("person-525"), R("theme-heist"), R("because-tt1"), R("next-watch"), R("recommended"), R("continue")];
  const out = ids(orderRows(rows));
  assert.deepEqual(out, ["continue", "recommended", "because-tt1", "theme-heist", "person-525", "trending-stream", "next-watch", "stretch"]);
  // a stored order that predates these rows never drops them
  const stored = ids(orderRows(rows, { order: ["continue", "trending-stream"], hidden: ["stretch"] }));
  assert.ok(stored.includes("theme-heist") && stored.includes("person-525") && stored.includes("because-tt1"));
  assert.ok(!stored.includes("stretch"), "and a hidden one stays hidden");
});

test("'Recommended by your household' sits right under Recommended for You by default", () => {
  const rows = [R("continue"), R("recommended"), R("because-tt1"), R("trending-stream"), R("household"), R("mylist")];
  assert.deepEqual(ids(orderRows(rows)).slice(0, 3), ["continue", "recommended", "household"]);
  // no Recommended row (a kids profile, little history): it takes that place
  const noRec = ids(orderRows([R("trending-stream"), R("household"), R("continue"), R("mylist")]));
  assert.deepEqual(noRec.slice(0, 2), ["continue", "household"]);
});

test("a stored order that predates the household row keeps it under Recommended, wherever that went", () => {
  const rows = [R("continue"), R("recommended"), R("because-tt1"), R("trending-stream"), R("household"), R("mylist")];
  const out = ids(orderRows(rows, { order: ["mylist", "trending-stream", "recommended", "continue", "because-tt1"], hidden: [] }));
  assert.deepEqual(out, ["mylist", "trending-stream", "recommended", "household", "continue", "because-tt1"]);
  // Recommended hidden: after Continue Watching (its default neighbour above)
  const hid = ids(orderRows(rows, { order: ["mylist", "continue", "trending-stream"], hidden: ["recommended"] }));
  assert.deepEqual(hid.slice(0, 3), ["mylist", "continue", "household"]);
  // the person placed it themselves: it stays where they put it
  const placed = ids(orderRows(rows, { order: ["continue", "recommended", "mylist", "household"], hidden: [] }));
  assert.deepEqual(placed.slice(0, 4), ["continue", "recommended", "mylist", "household"]);
  // hidden: hidden
  assert.ok(!ids(orderRows(rows, { order: ["continue"], hidden: ["household"] })).includes("household"));
});
