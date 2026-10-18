// Title-page metadata (media/discover.js meta): stale while revalidate, one
// request in flight per title, failures remembered, the cache file written
// at most once a minute (server round, 2026-10-18).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const discover = require("../src/media/discover");
const { metaCache, metaInflight, metaFails, metaStats, metaStore, META_TTL, META_STALE_MAX, setFetchJson } = discover._internals;

const ID = "tt0099001";
const KEY = `movie|${ID}`;
let calls = 0;
let answer = () => ({ meta: { name: "First", releaseInfo: "2001", moviedb_id: null } });
const reset = () => {
  metaCache.delete(KEY);
  delete metaStore.data[KEY];
  metaInflight.clear();
  metaFails.clear();
  calls = 0;
};
setFetchJson(async (url) => {
  calls++;
  assert.ok(url.includes(ID));
  await new Promise((r) => setTimeout(r, 20));
  return answer();
});

test("one request in flight per title: two pages asking at once share it", async () => {
  reset();
  answer = () => ({ meta: { name: "First", releaseInfo: "2001" } });
  const [a, b] = await Promise.all([discover.meta("movie", ID), discover.meta("movie", ID)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.title, "First");
  // fresh: from memory, no request
  await discover.meta("movie", ID);
  assert.equal(calls, 1);
});

test("a stale answer is answered at once, and ONE refresh brings the new one", async () => {
  reset();
  answer = () => ({ meta: { name: "Old", releaseInfo: "2001" } });
  await discover.meta("movie", ID);
  const hit = metaCache.get(KEY);
  hit.at -= META_TTL + 1000; // older than fresh
  answer = () => ({ meta: { name: "New", releaseInfo: "2001" } });
  const t0 = Date.now();
  const got = await discover.meta("movie", ID);
  assert.equal(got.title, "Old", "the old answer, not a wait");
  assert.ok(Date.now() - t0 < 15, "no network wait");
  // a second visit during the refresh does not start another
  assert.equal((await discover.meta("movie", ID)).title, "Old");
  assert.equal(metaInflight.size, 1);
  await metaInflight.get(KEY);
  assert.equal(calls, 2, "one first fetch, one refresh");
  assert.equal((await discover.meta("movie", ID)).title, "New");
  // metaCached answers a stale entry too (and starts its refresh)
  metaCache.get(KEY).at -= META_TTL + 1000;
  assert.equal(discover.metaCached("movie", ID).title, "New");
  assert.equal(metaInflight.size, 1);
  await metaInflight.get(KEY);
  // past the stale limit: no answer from memory
  metaCache.get(KEY).at -= META_STALE_MAX;
  assert.equal(discover.metaCached("movie", ID), null);
});

test("a failure is remembered: no new request for a while, and a stale answer stays the answer", async () => {
  reset();
  answer = () => { throw new Error("503 cinemeta"); };
  await assert.rejects(discover.meta("movie", ID), /503/);
  assert.equal(calls, 1);
  // asked again at once: refused from memory, no request
  await assert.rejects(discover.meta("movie", ID), /not available/);
  assert.equal(calls, 1);
  assert.equal(discover.metaRecentlyFailed("movie", ID), true);
  // the back-off doubles
  const f = metaFails.get(KEY);
  assert.equal(f.n, 1);
  f.at -= 16 * 60 * 1000; // past the first 15 minutes
  await assert.rejects(discover.meta("movie", ID), /503/);
  assert.equal(calls, 2);
  assert.equal(metaFails.get(KEY).n, 2);
  // with an old answer on file, a failing refresh leaves it in place
  metaFails.clear();
  answer = () => ({ meta: { name: "Kept", releaseInfo: "2001" } });
  await discover.meta("movie", ID);
  metaCache.get(KEY).at -= META_TTL + 1000;
  answer = () => { throw new Error("timeout"); };
  assert.equal((await discover.meta("movie", ID)).title, "Kept");
  await metaInflight.get(KEY).catch(() => {});
  assert.equal((await discover.meta("movie", ID)).title, "Kept", "still the old answer");
  assert.equal(metaInflight.size, 0, "and no new refresh while the failure is remembered");
  assert.ok(metaStats.failed >= 3);
});

test("the cache file is written at most once a minute, but stamp() moves with every change", async () => {
  reset();
  const rev0 = metaStore.rev;
  const stamp0 = discover.stamp();
  answer = () => ({ meta: { name: "A", releaseInfo: "2001" } });
  await discover.meta("movie", ID);
  const stamp1 = discover.stamp();
  assert.notEqual(stamp1, stamp0, "what is built from the cache knows at once");
  metaCache.get(KEY).at -= META_TTL + 1000;
  await discover.meta("movie", ID);
  await metaInflight.get(KEY);
  assert.notEqual(discover.stamp(), stamp1);
  assert.equal(metaStore.rev, rev0, "nothing written yet: one write a minute at most");
});
