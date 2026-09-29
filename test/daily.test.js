// The daily round's clock, and what the metadata refresh considers due.
// Pure checks only: nothing here saves a store (the tests share data/ with
// a running server).
const test = require("node:test");
const assert = require("node:assert");
const { _internals: d } = require("../src/lib/daily");
const { _internals: online } = require("../src/media/online");

const H = 3600 * 1000;

test("a task is due when it has never run, or last finished about a day ago", () => {
  const name = `test-${process.pid}`;
  const now = Date.now();
  try {
    assert.equal(d.due(name, now), true, "never run");
    d.store.data[name] = { at: now - 2 * H };
    assert.equal(d.due(name, now), false, "ran two hours ago");
    d.store.data[name] = { at: now - 24 * H };
    assert.equal(d.due(name, now), true, "ran yesterday");
    d.store.data[name] = { at: now - 25 * H, failedAt: now - 10 * 60 * 1000 };
    assert.equal(d.due(name, now), false, "failed ten minutes ago: wait for the hourly retry");
    d.store.data[name] = { at: now - 25 * H, failedAt: now - 2 * H };
    assert.equal(d.due(name, now), true, "failed two hours ago: try again");
  } finally {
    delete d.store.data[name];
  }
});

test("metadata: airing shows are re-checked daily, everything else monthly, failures left to enrich", () => {
  const now = Date.now();
  const show = { type: "show" };
  const movie = { type: "movie" };
  assert.equal(online.refreshDue(show, { status: "Running", fetchedAt: now - 21 * H }, now), true);
  assert.equal(online.refreshDue(show, { status: "Running", fetchedAt: now - 2 * H }, now), false);
  assert.equal(online.refreshDue(show, { status: "Ended", fetchedAt: now - 21 * H }, now), false);
  assert.equal(online.refreshDue(show, { status: "Ended", fetchedAt: now - 31 * 24 * H }, now), true);
  assert.equal(online.refreshDue(show, { fetchedAt: now - 21 * H }, now), true, "no status yet (older entry): look once to learn it");
  assert.equal(online.refreshDue(movie, { fetchedAt: now - 21 * H }, now), false);
  assert.equal(online.refreshDue(show, { status: "Running", fetchedAt: now - 48 * H, checkedAt: now - H }, now), false, "a check with no change still counts");
  assert.equal(online.refreshDue(show, { failed: true, fetchedAt: 0 }, now), false);
});
