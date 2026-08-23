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
