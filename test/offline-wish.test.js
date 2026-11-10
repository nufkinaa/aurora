// "Save it to this device too" before the server has it (src/media/offlinewish.js,
// docs/offline-wishes.md): the rules, with every dependency a fake — no
// server, no ffmpeg, no socket, no push. test/offline-wish-landing.test.js
// runs a real landing through downloads.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const wishes = require("../src/media/offlinewish");
const { setDeps, copyReady } = wishes._internals;

const DEV = "web-0123456789abcdef";
const DEV2 = "web-fedcba9876543210";
let T = 1_800_000_000_000;
let world;
const fresh = ({ library = {}, options = null, live = [] } = {}) => {
  world = {
    store: { data: { wishes: [] }, saves: 0, save() { this.saves++; } },
    sent: [], pushes: [], prepared: [], cancelled: [], logs: [], timers: [],
    library, // "tt|s|e" -> { id, title }
    paths: {}, // destPath -> library id
    probed: new Set(),
    live,
    options: options || ((id) => ({ options: ["original", "1080", "720", "480"].map((quality) => ({ quality })) })),
    prepState: "queued",
  };
  setDeps({
    store: world.store,
    now: () => T,
    log: (m) => world.logs.push(m),
    warn: (m) => world.logs.push(m),
    setTimeout: (fn, ms) => { world.timers.push({ fn, ms }); return world.timers.length; },
    offline: {
      options: (id, caps) => world.options(id, caps),
      prepare: (id, q, caps, opts) => { world.prepared.push({ id, q, caps, opts }); return { state: world.prepState, quality: q }; },
      cancel: (id, q) => { world.cancelled.push({ id, q }); return { cancelled: true }; },
      status: (id, q) => ({ state: world.prepState, progress: world.prepState === "ready" ? 1 : 0.25 }),
    },
    idForPath: (p) => world.paths[p] || null,
    probed: (id) => world.probed.has(id),
    findLibraryPlayable: (w) => world.library[`${w.imdbId}|${w.season ?? ""}|${w.episode ?? ""}`] || null,
    liveJobs: () => world.live,
    broadcast: (profileId, msg) => world.sent.push({ profileId, msg }),
    push: (profileId, key, msg) => world.pushes.push({ profileId, key, msg }),
    profileExists: (id) => id !== "gone",
  });
};
const runTimers = () => { while (world.timers.length) world.timers.shift().fn(); };
const film = (over = {}) => ({ deviceId: DEV, type: "movie", imdbId: "tt1000001", title: "A Film", quality: "720", ...over });
const ep = (over = {}) => ({ deviceId: DEV, type: "show", imdbId: "tt2000002", title: "S1 E2", showTitle: "A Show", season: 1, episode: 2, quality: "original", ...over });
const job = (over = {}) => ({ id: "aaaaaaaaaaaa", type: "movie", imdbId: "tt1000001", title: "A Film", status: "done", ...over });

test("a wish is checked: device id, quality, a show's season and episode, a title or download id", () => {
  fresh();
  assert.match(wishes.add("p1", film({ deviceId: "x" })).error, /device/);
  assert.match(wishes.add("p1", film({ quality: "4k" })).error, /quality/);
  assert.match(wishes.add("p1", film({ imdbId: null })).error, /title id or a download id/);
  assert.match(wishes.add("p1", film({ imdbId: "nope" })).error, /title id/);
  assert.match(wishes.add("p1", ep({ season: null })).error, /season/);
  assert.match(wishes.add("p1", ep({ episode: null })).error, /number/);
  assert.match(wishes.add("p1", film({ scope: "season" })).error, /only a show/);
  assert.ok(wishes.add("p1", ep({ scope: "season", episode: null })).wish, "a season wish needs no episode");
  assert.ok(wishes.add("p1", film({ imdbId: null, jobId: "abcdef123456" })).wish, "a download id alone is enough");
});

test("the same device asking again is ONE wish (quality updated); another device is another wish; lists are per device", () => {
  fresh();
  const a = wishes.add("p1", film()).wish;
  assert.equal(a.state, "waiting");
  const b = wishes.add("p1", film({ quality: "480" })).wish;
  assert.equal(b.id, a.id);
  assert.equal(b.quality, "480");
  const c = wishes.add("p1", film({ deviceId: DEV2 })).wish;
  assert.notEqual(c.id, a.id);
  assert.equal(wishes.list("p1", DEV).length, 1);
  assert.equal(wishes.list("p1").length, 2);
  assert.equal(wishes.list("p2").length, 0, "another profile sees none of them");
  // every change went to the profile's sockets
  assert.ok(world.sent.every((s) => s.profileId === "p1" && s.msg.type === "offline_wish"));
});

test("a title already in the library is ready at once, and its copy is started as a person's request kept for days", () => {
  fresh({ library: { "tt1000001||": { id: "lib1", title: "A Film" } } });
  const w = wishes.add("p1", film({ hevc: true })).wish;
  assert.equal(w.state, "ready");
  assert.equal(w.libraryId, "lib1");
  assert.equal(world.prepared.length, 1);
  assert.deepEqual(world.prepared[0].caps, { hevc: true });
  assert.equal(world.prepared[0].opts.person, true);
  assert.ok(world.prepared[0].opts.keepMs >= 24 * 3600 * 1000);
  assert.equal(w.copy.state, "queued");
});

test("landing: the wish waits until the file is indexed and probed, then is ready, its copy prepared and the device told", () => {
  fresh();
  const w = wishes.add("p1", film()).wish;
  world.sent.length = 0;
  wishes.landed(job(), "/lib/A Film (2020)/A Film.mkv");
  assert.equal(wishes.list("p1")[0].state, "waiting", "not indexed yet");
  assert.equal(world.timers.length, 1, "looked for again shortly");
  world.paths["/lib/A Film (2020)/A Film.mkv"] = "lib9";
  world.timers.shift().fn(); // indexed, not probed
  assert.equal(wishes.list("p1")[0].state, "waiting");
  world.probed.add("lib9");
  world.timers.shift().fn();
  const r = wishes.list("p1")[0];
  assert.equal(r.id, w.id);
  assert.equal(r.state, "ready");
  assert.equal(r.libraryId, "lib9");
  assert.equal(r.readyQuality, "720");
  assert.deepEqual(world.prepared.map((p) => [p.id, p.q]), [["lib9", "720"]]);
  assert.ok(world.sent.some((s) => s.msg.type === "offline_wish" && s.msg.wish.state === "ready"));
});

test("landing gives up waiting for the probe after a few minutes (ready anyway); never found at all = failed with a sentence", () => {
  fresh();
  wishes.add("p1", film());
  world.paths["/f.mkv"] = "lib2";
  wishes.landed(job(), "/f.mkv");
  T += wishes._internals.LAND_WAIT_MS + 1;
  runTimers();
  assert.equal(wishes.list("p1")[0].state, "ready");
  fresh();
  wishes.add("p1", film());
  wishes.landed(job(), "/nowhere.mkv");
  T += wishes._internals.LAND_WAIT_MS + 1;
  runTimers();
  const w = wishes.list("p1")[0];
  assert.equal(w.state, "failed");
  assert.match(w.error, /could not find it in the library/);
});

test("a download of something else, or another episode, does not touch the wish", () => {
  fresh();
  wishes.add("p1", ep());
  world.paths["/x.mkv"] = "libx";
  world.probed.add("libx");
  wishes.landed(job({ type: "show", imdbId: "tt2000002", season: 1, episode: 3 }), "/x.mkv");
  wishes.landed(job({ type: "movie", imdbId: "tt2000002" }), "/x.mkv");
  wishes.landed(job({ type: "show", imdbId: "tt9999999", season: 1, episode: 2 }), "/x.mkv");
  assert.equal(wishes.list("p1")[0].state, "waiting");
  assert.equal(world.prepared.length, 0);
});

test("a wish made against a download id matches that download even without a title id", () => {
  fresh();
  wishes.add("p1", film({ imdbId: null, jobId: "bbbbbbbbbbbb" }));
  world.paths["/y.mkv"] = "liby";
  world.probed.add("liby");
  wishes.landed(job({ id: "bbbbbbbbbbbb", imdbId: null }), "/y.mkv");
  assert.equal(wishes.list("p1")[0].libraryId, "liby");
});

test("Original this device can't play → the best re-encode, said in words; a size above the file's → the next one down", () => {
  fresh({ options: () => ({ options: [{ quality: "720" }, { quality: "480" }] }) });
  wishes.add("p1", film({ quality: "original" }));
  world.paths["/z.mkv"] = "libz";
  world.probed.add("libz");
  wishes.landed(job(), "/z.mkv");
  const w = wishes.list("p1")[0];
  assert.equal(w.readyQuality, "720");
  assert.match(w.note, /can't play the original's picture — it is saved at 720p/);
  fresh({ options: () => ({ options: [{ quality: "original" }, { quality: "720" }, { quality: "480" }] }) });
  wishes.add("p1", film({ quality: "1080" }));
  world.paths["/z.mkv"] = "libz";
  world.probed.add("libz");
  wishes.landed(job(), "/z.mkv");
  assert.equal(wishes.list("p1")[0].readyQuality, "720");
  assert.match(wishes.list("p1")[0].note, /no 1080p/);
});

test("a season wish: every episode that lands becomes its own ready wish; the season wish keeps waiting; saving one ends only that one", () => {
  fresh();
  const s = wishes.add("p1", ep({ scope: "season", episode: null, quality: "480" })).wish;
  for (const e of [1, 2]) {
    world.paths[`/e${e}.mkv`] = `ep${e}`;
    world.probed.add(`ep${e}`);
    wishes.landed(job({ id: `job00000000${e}`, type: "show", imdbId: "tt2000002", season: 1, episode: e, title: `Episode ${e}` }), `/e${e}.mkv`);
  }
  // the same episode landing twice (a second copy) is not a second wish
  wishes.landed(job({ id: "job000000009", type: "show", imdbId: "tt2000002", season: 1, episode: 2 }), "/e2.mkv");
  // another season is not this wish's
  world.paths["/s2.mkv"] = "s2e1";
  world.probed.add("s2e1");
  wishes.landed(job({ id: "job000000010", type: "show", imdbId: "tt2000002", season: 2, episode: 1 }), "/s2.mkv");
  const all = wishes.list("p1", DEV);
  const kids = all.filter((w) => w.parentId === s.id);
  assert.deepEqual(kids.map((k) => [k.episode, k.state, k.libraryId, k.quality]).sort(), [[1, "ready", "ep1", "480"], [2, "ready", "ep2", "480"]]);
  assert.equal(all.find((w) => w.id === s.id).state, "waiting");
  assert.equal(wishes.remove("p1", kids[0].id, { saved: true }).ok, true);
  assert.equal(wishes.list("p1").length, 2, "the season wish and the other episode stay");
  // Cancel on the season wish takes its unsaved episodes with it — and stops their copies on the server
  world.prepState = "queued";
  wishes.remove("p1", s.id);
  assert.equal(wishes.list("p1").length, 0);
  assert.ok(world.cancelled.some((c) => c.id === "ep2" && c.q === "480"));
});

test("a failed / cancelled / declined download fails the wish with a sentence — unless another download of that title is still coming", () => {
  fresh();
  wishes.add("p1", film());
  world.live = [job({ id: "cccccccccccc", status: "downloading" })];
  wishes.ended(job({ id: "aaaaaaaaaaaa", status: "error", error: "no peers" }), "error");
  assert.equal(wishes.list("p1")[0].state, "waiting", "the other copy may still land");
  world.live = [];
  wishes.ended(job({ status: "canceled" }), "canceled");
  let w = wishes.list("p1")[0];
  assert.equal(w.state, "failed");
  assert.match(w.error, /cancelled — there is nothing to save/);
  for (const [how, re] of [["declined", /declined/], ["error", /failed \(disk full\)/], ["removed", /taken off the list/]]) {
    fresh();
    wishes.add("p1", film());
    wishes.ended(job({ error: "disk full" }), how);
    assert.match(wishes.list("p1")[0].error, re);
  }
  // a season wish is never failed by one episode
  fresh();
  wishes.add("p1", ep({ scope: "season", episode: null }));
  wishes.ended(job({ type: "show", imdbId: "tt2000002", season: 1, episode: 4 }), "error");
  assert.equal(wishes.list("p1")[0].state, "waiting");
});

test("a failed wish lands after all if the title comes later; asking again starts it waiting again", () => {
  fresh();
  wishes.add("p1", film());
  wishes.ended(job(), "canceled");
  assert.equal(wishes.list("p1")[0].state, "failed");
  assert.equal(wishes.add("p1", film()).wish.state, "waiting");
  wishes.ended(job(), "canceled");
  world.paths["/late.mkv"] = "late";
  world.probed.add("late");
  wishes.landed(job({ id: "dddddddddddd" }), "/late.mkv");
  assert.equal(wishes.list("p1")[0].state, "ready");
});

test("the copy being ready pushes to the ONE browser that asked, once; no pushKey, no push", () => {
  fresh();
  const key = "a".repeat(64);
  wishes.add("p1", film({ pushKey: key }));
  wishes.add("p1", film({ deviceId: DEV2 })); // no push for this one
  world.paths["/p.mkv"] = "libp";
  world.probed.add("libp");
  wishes.landed(job(), "/p.mkv");
  assert.equal(world.pushes.length, 0, "not before the copy is made");
  copyReady("libp", "720");
  copyReady("libp", "720");
  assert.equal(world.pushes.length, 1);
  assert.equal(world.pushes[0].key, key);
  assert.equal(world.pushes[0].profileId, "p1");
  assert.match(world.pushes[0].msg.body, /Ready to save on this device/);
  assert.equal(world.pushes[0].msg.url, "/#/saved");
  // a copy that is ready at once (an MP4 served as it is) pushes right away
  fresh({ library: { "tt1000001||": { id: "lib1" } } });
  world.prepState = "ready";
  wishes.add("p1", film({ pushKey: key }));
  assert.equal(world.pushes.length, 1);
});

test("Cancel stops the copy the server was preparing for the wish; Dismiss of a failed one asks nothing of the server; other profiles can't touch it", () => {
  fresh({ library: { "tt1000001||": { id: "lib1" } } });
  const w = wishes.add("p1", film()).wish;
  assert.equal(wishes.remove("p2", w.id).error, "not found");
  assert.equal(wishes.remove("p1", w.id).ok, true);
  assert.deepEqual(world.cancelled, [{ id: "lib1", q: "720" }]);
  assert.ok(world.sent.some((s) => s.msg.type === "offline_wish_removed" && s.msg.id === w.id));
  fresh();
  const f = wishes.add("p1", film()).wish;
  wishes.ended(job(), "error");
  wishes.remove("p1", f.id);
  assert.equal(world.cancelled.length, 0);
});

test("bounded per person: the oldest failed wish makes room; live ones are never pushed out", () => {
  fresh();
  const M = wishes.MAX_PER_PROFILE;
  world.store.data.wishes = Array.from({ length: M }, (_, i) => ({ id: `w${i}`, profileId: "p1", deviceId: DEV, scope: "title", type: "movie", imdbId: `tt3${String(i).padStart(6, "0")}`, quality: "720", state: i === 7 ? "failed" : "waiting", createdAt: T }));
  const r = wishes.add("p1", film());
  assert.ok(r.wish);
  assert.equal(world.store.data.wishes.length, M);
  assert.ok(!world.store.data.wishes.some((w) => w.id === "w7"));
  const again = wishes.add("p1", film({ imdbId: "tt4000000" }));
  assert.match(again.error, /already waiting/);
  assert.equal(wishes.list("p9").length, 0);
});

test("wishes of a profile that is gone are pruned", () => {
  fresh();
  wishes.add("gone", film());
  wishes.add("p1", film());
  assert.equal(wishes.prune(), 1);
  assert.equal(world.store.data.wishes.length, 1);
});

test("a whole-show wish (round 2): every episode that lands, of any season, is its own ready wish; the show wish waits on; checked like the others", () => {
  fresh();
  assert.match(wishes.add("p1", film({ scope: "show" })).error, /only a show/);
  assert.match(wishes.add("p1", ep({ scope: "show", imdbId: null, jobId: "abcdef123456", season: null, episode: null })).error, /title id/);
  const s = wishes.add("p1", ep({ scope: "show", season: null, episode: null, quality: "720" })).wish;
  assert.equal(s.scope, "show");
  assert.equal(s.season, null);
  assert.equal(wishes.add("p1", ep({ scope: "show", season: 3, episode: 9, quality: "480" })).wish.id, s.id, "one show wish per device");
  for (const [se, e] of [[1, 2], [2, 2], [5, 1]]) {
    world.paths[`/s${se}e${e}.mkv`] = `s${se}e${e}`;
    world.probed.add(`s${se}e${e}`);
    wishes.landed(job({ id: `jb${se}${e}aaaaaaaaa`.slice(0, 12), type: "show", imdbId: "tt2000002", season: se, episode: e, title: `S${se}E${e}` }), `/s${se}e${e}.mkv`);
  }
  // another show is not this wish's
  world.paths["/other.mkv"] = "other";
  world.probed.add("other");
  wishes.landed(job({ id: "otherotherxx", type: "show", imdbId: "tt7777777", season: 1, episode: 1 }), "/other.mkv");
  const kids = wishes.list("p1").filter((w) => w.parentId === s.id);
  assert.deepEqual(kids.map((k) => [k.season, k.episode, k.libraryId, k.quality]).sort(), [[1, 2, "s1e2", "480"], [2, 2, "s2e2", "480"], [5, 1, "s5e1", "480"]]);
  assert.equal(wishes.list("p1").find((w) => w.id === s.id).state, "waiting");
  // a failed episode download does not fail the show wish
  wishes.ended(job({ type: "show", imdbId: "tt2000002", season: 6, episode: 1 }), "error");
  assert.equal(wishes.list("p1").find((w) => w.id === s.id).state, "waiting");
});
