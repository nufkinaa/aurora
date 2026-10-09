// Mark watched is not watching (Mi TV QA, 2026-10-09): "Mark season watched"
// on Silo S3 queued real downloads (smartdl read the full-duration progress
// POSTs as "finished an episode, fetch the next"), and "Mark season
// unwatched" deleted every row, so E1-E4 lost their resume points. The pure
// halves (markTitle / restoreTitle over a state + key resolver) and the two
// routes, with profiles.json and the download engine stubbed out.
const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const identity = require("../src/media/identity");
const { markTitle, restoreTitle, foldTitles } = profiles._internals;

// ep1..ep4 are S3E1..S3E4 of tt9 on disk; stream keys resolve on their own.
const libKeys = new Map([["ep1", "tt9:3:1"], ["ep2", "tt9:3:2"], ["ep3", "tt9:3:3"], ["ep4", "tt9:3:4"], ["mv", "tt5"]]);
const keyFor = (itemId, meta) => {
  if (itemId.startsWith("torrent|") || itemId.startsWith("stream|")) return identity.titleKeyFor(itemId, meta);
  return libKeys.get(itemId) || null;
};
const blank = () => ({ progress: {}, streamItems: {}, titles: {} });
const row = (position, duration, updatedAt, finished = false) => ({ position, duration, finished, updatedAt });

test("mark: a new row is finished but carries no fresh stamp, and unmark removes it", () => {
  const s = blank();
  markTitle(s, "ep3", true, { duration: 3000, now: 5000 }, keyFor);
  const r = s.progress.ep3;
  assert.equal(r.finished, true);
  assert.equal(r.position, 3000);
  assert.equal(r.updatedAt, 0, "a mark is not 'watched just now'");
  assert.equal(r.marked, true);
  assert.equal(r.prior, null);
  assert.equal(s.titles["tt9:3:3"].finished, true);
  assert.equal(s.titles["tt9:3:3"].updatedAt, 0);
  markTitle(s, "ep3", false, {}, keyFor);
  assert.equal(s.progress.ep3, undefined);
  assert.equal(s.titles["tt9:3:3"], undefined);
});

test("mark + unmark: a half-watched episode gets its resume point and stamp back", () => {
  const s = blank();
  s.progress.ep2 = row(900, 3000, 1234);
  s.titles["tt9:3:2"] = { ...row(900, 3000, 1234), itemId: "ep2" };
  markTitle(s, "ep2", true, { duration: 3000, now: 9999 }, keyFor);
  assert.equal(s.progress.ep2.finished, true);
  assert.equal(s.progress.ep2.updatedAt, 1234, "the stamp Continue Watching sorts on is untouched");
  assert.deepEqual(s.progress.ep2.prior, { position: 900, duration: 3000, finished: false, updatedAt: 1234 });
  markTitle(s, "ep2", false, {}, keyFor);
  assert.deepEqual(s.progress.ep2, row(900, 3000, 1234));
  assert.equal(s.titles["tt9:3:2"].position, 900);
  assert.equal(s.titles["tt9:3:2"].finished, false);
  assert.equal(s.titles["tt9:3:2"].prior, undefined);
});

test("mark reaches every alias of the title and unmark restores each", () => {
  const s = blank();
  const meta = { imdbId: "tt9", season: 3, episode: 1, title: "Silo" };
  s.progress["torrent|abc|0"] = row(600, 3000, 2000);
  s.streamItems["torrent|abc|0"] = meta;
  s.titles["tt9:3:1"] = { ...row(600, 3000, 2000), itemId: "torrent|abc|0" };
  markTitle(s, "ep1", true, { duration: 3000, now: 9 }, keyFor);
  assert.equal(s.progress["torrent|abc|0"].finished, true, "the streamed alias is ticked too");
  assert.equal(s.progress.ep1.updatedAt, 2000, "a created row takes the title's stamp");
  assert.equal(s.titles["tt9:3:1"].finished, true);
  markTitle(s, "ep1", false, {}, keyFor);
  assert.equal(s.progress.ep1, undefined, "the row the mark made goes");
  assert.deepEqual(s.progress["torrent|abc|0"], row(600, 3000, 2000));
  assert.equal(s.titles["tt9:3:1"].position, 600);
  assert.equal(s.titles["tt9:3:1"].finished, false);
});

test("unmark without a mark: finished from real watching loses the flag, keeps the position (credits go to 0)", () => {
  const s = blank();
  s.progress.ep1 = row(2990, 3000, 100, true); // watched to the credits
  s.progress.ep2 = row(2700, 3000, 200, true); // finished at 90% (a stream marked done elsewhere)
  markTitle(s, "ep1", false, {}, keyFor);
  markTitle(s, "ep2", false, {}, keyFor);
  assert.deepEqual(s.progress.ep1, row(0, 3000, 100, false));
  assert.deepEqual(s.progress.ep2, row(2700, 3000, 200, false));
});

test("restore: the client's snapshot wins for its own row; a null snapshot falls back to the server rule", () => {
  const s = blank();
  markTitle(s, "ep4", true, { duration: 3000, now: 1 }, keyFor);
  restoreTitle(s, "ep4", { position: 1500, duration: 3000, finished: false, updatedAt: 777 }, {}, keyFor);
  assert.deepEqual(s.progress.ep4, row(1500, 3000, 777));
  assert.equal(s.titles["tt9:3:4"].position, 1500);
  assert.equal(s.titles["tt9:3:4"].itemId, "ep4");

  const t = blank();
  markTitle(t, "ep4", true, { duration: 3000, now: 1 }, keyFor);
  restoreTitle(t, "ep4", null, {}, keyFor);
  assert.equal(t.progress.ep4, undefined);
  assert.equal(t.titles["tt9:3:4"], undefined);
});

test("the Silo case: season mark then unmark leaves E1-E4 exactly as they were", () => {
  const s = blank();
  const before = { ep1: row(2950, 3000, 10, true), ep2: row(1200, 3000, 50), ep3: row(300, 3000, 40) };
  for (const [id, r] of Object.entries(before)) {
    s.progress[id] = { ...r };
    s.titles[libKeys.get(id)] = { ...r, itemId: id };
  }
  const stream5 = "stream|tt9|3|5";
  const meta5 = { imdbId: "tt9", season: 3, episode: 5, title: "Silo" };
  for (const id of ["ep2", "ep3", "ep4"]) markTitle(s, id, true, { duration: 3000, now: 99 }, keyFor);
  markTitle(s, stream5, true, { duration: 1, meta: meta5, now: 99 }, keyFor);
  assert.ok(["ep1", "ep2", "ep3", "ep4", stream5].every((id) => s.progress[id].finished));
  for (const id of ["ep2", "ep3", "ep4", stream5]) markTitle(s, id, false, {}, keyFor);
  assert.deepEqual(s.progress.ep2, before.ep2);
  assert.deepEqual(s.progress.ep3, before.ep3);
  assert.deepEqual(s.progress.ep1, before.ep1, "a row the season mark skipped (already finished) is untouched");
  assert.equal(s.progress.ep4, undefined);
  assert.equal(s.progress[stream5], undefined);
  assert.equal(s.streamItems[stream5], undefined);
  assert.equal(s.titles["tt9:3:5"], undefined);
});

test("real progress after a mark replaces the row (the mark goes with it)", () => {
  const s = blank();
  markTitle(s, "ep2", true, { duration: 3000, now: 1 }, keyFor);
  // what setProgress / writeTitle write: a whole new row
  s.progress.ep2 = row(100, 3000, 5000);
  markTitle(s, "ep2", false, {}, keyFor);
  assert.deepEqual(s.progress.ep2, row(100, 3000, 5000));
});

test("a fold never re-stamps a mark-made row as 'just now'", () => {
  const s = blank();
  s.progress.ep3 = { position: 1, duration: 1, finished: true, updatedAt: 0, marked: true, prior: null };
  foldTitles(s, keyFor);
  assert.equal(s.titles["tt9:3:3"].updatedAt, 0);
});

// ---------- the routes ----------
const router = require("../src/routes/profiles");
const handlerFor = (path, method) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path} exists`);
  const st = layer.route.stack;
  return st[st.length - 1].handle; // past the gate
};
const fakeRes = () => {
  const res = { code: 200, body: null };
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
};
const withStubs = async (fn) => {
  const smartdl = require("../src/media/smartdl");
  const smartclean = require("../src/media/smartclean");
  const saved = {
    dl: smartdl.onProgress, clean: smartclean.onProgress,
    set: profiles.setProgress, mark: profiles.markProgress,
  };
  const calls = { dl: [], clean: [], set: [], mark: [] };
  smartdl.onProgress = async (...a) => { calls.dl.push(a); };
  smartclean.onProgress = async (...a) => { calls.clean.push(a); return { cleaned: [] }; };
  profiles.setProgress = (...a) => { calls.set.push(a); };
  profiles.markProgress = (...a) => { calls.mark.push(a); };
  try {
    await fn(calls);
  } finally {
    smartdl.onProgress = saved.dl;
    smartclean.onProgress = saved.clean;
    profiles.setProgress = saved.set;
    profiles.markProgress = saved.mark;
  }
};

test("route: /progress/mark marks a whole season in one write and never calls smart downloads", async () => {
  await withStubs(async (calls) => {
    const h = handlerFor("/api/profiles/:id/progress/mark", "post");
    const res = fakeRes();
    h({ params: { id: "p1" }, body: { items: [
      { itemId: "ep2", watched: true, duration: 3000 },
      { itemId: "stream|tt9|3|5", watched: true, duration: 1, item: { imdbId: "tt9", season: 3, episode: 5 } },
    ] } }, res);
    await new Promise((r) => setImmediate(r));
    assert.equal(res.code, 200);
    assert.equal(res.body.count, 2);
    assert.equal(calls.mark.length, 1);
    assert.equal(calls.mark[0][1].length, 2);
    assert.equal(calls.mark[0][1][1].meta.imdbId, "tt9");
    assert.equal(calls.dl.length, 0, "smartdl.onProgress is not called for a mark");
    assert.equal(calls.clean.length, 0);
    assert.equal(calls.set.length, 0);
  });
});

test("route: an unwatched entry carries its restore snapshot through; a bad id is refused", async () => {
  await withStubs(async (calls) => {
    const h = handlerFor("/api/profiles/:id/progress/mark", "post");
    const res = fakeRes();
    h({ params: { id: "p1" }, body: { itemId: "ep2", watched: false, restore: { position: 900, duration: 3000 } } }, res);
    assert.deepEqual(calls.mark[0][1][0].restore, { position: 900, duration: 3000 });
    const res2 = fakeRes();
    h({ params: { id: "p1" }, body: { itemId: "ep2", watched: false, restore: null } }, res2);
    assert.equal(calls.mark[1][1][0].restore, null);
    assert.ok("restore" in calls.mark[1][1][0]);
    const bad = fakeRes();
    h({ params: { id: "p1" }, body: { items: [{ itemId: "__proto__", watched: true }] } }, bad);
    assert.equal(bad.code, 400);
    const none = fakeRes();
    h({ params: { id: "p1" }, body: { items: [] } }, none);
    assert.equal(none.code, 400);
    assert.equal(calls.mark.length, 2);
  });
});

test("route: a progress POST flagged `marked` takes the mark path, a plain one still feeds smart downloads", async () => {
  await withStubs(async (calls) => {
    const h = handlerFor("/api/profiles/:id/progress", "post");
    const marked = fakeRes();
    h({ params: { id: "p1" }, body: { itemId: "ep2", position: 3000, duration: 3000, finished: true, marked: true } }, marked);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.mark.length, 1);
    assert.equal(calls.mark[0][1][0].watched, true);
    assert.equal(calls.dl.length, 0);
    assert.equal(calls.set.length, 0);

    const plain = fakeRes();
    h({ params: { id: "p1" }, body: { itemId: "ep2", position: 2900, duration: 3000 } }, plain);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.set.length, 1);
    assert.equal(calls.dl.length, 1, "real watching still queues the next episode");
    assert.deepEqual(calls.dl[0].slice(0, 4), ["p1", "ep2", 2900, 3000]);
    assert.equal(calls.clean.length, 1);
  });
});
