// Which episode comes next (src/media/nextep.js) — the one rule the website's
// player and the TV app both ask the server for. The cases are the audit's:
// the TV jumped E4 → E8 because it took "the next file on disk".
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { decide, nextFor } = require("../src/media/nextep");

const NOW = Date.parse("2026-10-10T00:00:00Z");
const ep = (season, episode, extra = {}) => ({ id: `s${season}e${episode}`, season, episode, title: `Ep ${episode}`, ...extra });
const real = (map) =>
  Object.entries(map).map(([number, n]) => ({
    number: Number(number),
    episodes: (Array.isArray(n) ? n : Array.from({ length: n }, () => ({}))).map((e, i) => ({
      season: Number(number), episode: i + 1, title: `Real ${number}x${i + 1}`, released: "2020-01-01T00:00:00Z", ...e,
    })),
  }));
const show = { id: "show1" };

test("E4 with E1-E4 and E8 on disk: next is E5 (to choose), never the jump to E8", () => {
  const libFlat = [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4), ep(1, 8)];
  const r = decide({ cur: libFlat[3], libFlat, show, real: real({ 1: 10 }), imdbId: "tt100", now: NOW });
  assert.deepStrictEqual(r.next, { kind: "stream", imdbId: "tt100", season: 1, episode: 5, title: "Real 1x5", released: "2020-01-01T00:00:00Z" });
  assert.strictEqual(r.why, "not-owned");
});

test("the file right after this one is the next episode: answered without the catalogue", () => {
  const libFlat = [ep(1, 1), ep(1, 2)];
  const r = decide({ cur: libFlat[0], libFlat, show, real: null, imdbId: null, now: NOW });
  assert.deepStrictEqual(r, { next: { kind: "library", id: "s1e2", showId: "show1", season: 1, episode: 2, title: "Ep 2" }, why: "adjacent" });
});

test("a season boundary: after the last episode of season 1 comes S2E1, on disk or not", () => {
  const owned = [ep(1, 9), ep(1, 10), ep(2, 1)];
  const a = decide({ cur: owned[1], libFlat: owned, show, real: real({ 1: 10, 2: 8 }), imdbId: "tt100", now: NOW });
  assert.deepStrictEqual([a.next.kind, a.next.id, a.why], ["library", "s2e1", "owned"]);
  const notOwned = [ep(1, 9), ep(1, 10), ep(2, 3)];
  const b = decide({ cur: notOwned[1], libFlat: notOwned, show, real: real({ 1: 10, 2: 8 }), imdbId: "tt100", now: NOW });
  assert.deepStrictEqual([b.next.kind, b.next.season, b.next.episode], ["stream", 2, 1]);
});

test("the last episode of the series: nothing next, even with other files on disk after it", () => {
  const libFlat = [ep(2, 8), ep(3, 1)]; // a mis-numbered extra file
  const r = decide({ cur: libFlat[0], libFlat, show, real: real({ 1: 10, 2: 8 }), imdbId: "tt100", now: NOW });
  assert.deepStrictEqual(r, { next: null, why: "series-end" });
});

test("the next episode has not aired: nothing next", () => {
  const libFlat = [ep(1, 3)];
  const seasons = real({ 1: [{}, {}, {}, { released: "2026-12-01T00:00:00Z" }] });
  assert.deepStrictEqual(decide({ cur: libFlat[0], libFlat, show, real: seasons, imdbId: "tt100", now: NOW }), { next: null, why: "not-aired" });
});

test("specials are never next, and a special that is playing falls back to the next file", () => {
  const seasons = [{ number: 0, episodes: [{ season: 0, episode: 1, title: "Special" }] }, ...real({ 1: 3 })];
  // S1E3 is the last real one: the special listed in season 0 is not "next"
  const lib1 = [ep(1, 3)];
  assert.strictEqual(decide({ cur: lib1[0], libFlat: lib1, show, real: seasons, imdbId: "tt100", now: NOW }).next, null);
  // playing the special itself: the catalogue's order does not know it
  const lib2 = [ep(0, 1), ep(1, 1)];
  const r = decide({ cur: lib2[0], libFlat: lib2, show, real: seasons, imdbId: "tt100", now: NOW });
  assert.deepStrictEqual([r.next.id, r.why], ["s1e1", "unknown-episode"]);
});

test("no catalogue to ask (no id, unreachable, an episode it does not know): the next file on disk, as before", () => {
  const libFlat = [ep(1, 4), ep(1, 8)];
  for (const [args, why] of [
    [{ real: real({ 1: 10 }), imdbId: null }, "no-id"],
    [{ real: null, imdbId: "tt100" }, "no-catalogue"],
    [{ real: real({ 2: 3 }), imdbId: "tt100" }, "unknown-episode"],
  ]) {
    const r = decide({ cur: libFlat[0], libFlat, show, now: NOW, ...args });
    assert.deepStrictEqual([r.next && r.next.id, r.why], ["s1e8", why]);
  }
});

test("a STREAMED episode gets an Up next too: the real next one, to choose", () => {
  const r = decide({ cur: { season: 2, episode: 4 }, libFlat: null, real: real({ 1: 10, 2: 8 }), imdbId: "tt100", findOwned: () => null, now: NOW });
  assert.deepStrictEqual([r.next.kind, r.next.season, r.next.episode, r.next.imdbId], ["stream", 2, 5, "tt100"]);
});

test("and when that next episode has been downloaded meanwhile, it is the library copy (plays at once)", () => {
  const owned = { id: "lib25", showId: "showX", season: 2, episode: 5, title: "" };
  const r = decide({
    cur: { season: 2, episode: 4 }, libFlat: null, real: real({ 2: 8 }), imdbId: "tt100", now: NOW,
    findOwned: (s, e) => (s === 2 && e === 5 ? owned : null),
  });
  assert.deepStrictEqual(r.next, { kind: "library", id: "lib25", showId: "showX", season: 2, episode: 5, title: "Real 2x5" });
});

test("a streamed episode with no catalogue has no answer (and no crash)", () => {
  assert.deepStrictEqual(decide({ cur: { season: 1, episode: 1 }, libFlat: null, real: null, imdbId: "tt100", now: NOW }), { next: null, why: "no-catalogue" });
});

// ---- with the lookups (scanner / identity / discover stubbed) ----
const deps = (o = {}) => {
  const eps = o.eps || [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4), ep(1, 8)];
  const showItem = { id: "show1", type: "show", imdbId: o.noId ? null : "tt100", seasons: [{ number: 1, episodes: eps }] };
  const calls = { meta: 0 };
  return {
    calls,
    now: NOW,
    scanner: { findById: (id) => (id === "show1" ? showItem : eps.map((e) => ({ ...e, showId: "show1" })).find((e) => e.id === id) || null) },
    identity: { ensureStamped() {}, imdbIdFor: () => null, findLibraryPlayable: o.findLibraryPlayable || (() => null) },
    discover: {
      meta: async () => {
        calls.meta++;
        if (o.metaFails) throw new Error("catalogue down");
        return { seasons: real({ 1: 10 }) };
      },
    },
  };
};

test("nextFor by library id: the adjacent file costs no catalogue lookup; a gap asks it", async () => {
  const d = deps();
  const a = await nextFor({ id: "s1e2" }, d);
  assert.deepStrictEqual([a.next.id, a.why, d.calls.meta], ["s1e3", "adjacent", 0]);
  const b = await nextFor({ id: "s1e4" }, d);
  assert.deepStrictEqual([b.next.kind, b.next.episode, d.calls.meta], ["stream", 5, 1]);
});

test("nextFor: the catalogue being down never takes Up next away from a library episode", async () => {
  const r = await nextFor({ id: "s1e4" }, deps({ metaFails: true }));
  assert.deepStrictEqual([r.next.id, r.why], ["s1e8", "no-catalogue"]);
});

test("nextFor by identity (a streamed episode), and what is not an episode", async () => {
  const r = await nextFor({ imdbId: "tt1000", season: "1", episode: "9" }, deps());
  assert.deepStrictEqual([r.next.kind, r.next.episode], ["stream", 10]);
  assert.deepStrictEqual(await nextFor({ imdbId: "tt1000", season: "1", episode: "10" }, deps()), { next: null, why: "series-end" });
  assert.deepStrictEqual(await nextFor({ imdbId: "nope", season: 1, episode: 1 }, deps()), { next: null, why: "bad-request" });
  assert.deepStrictEqual(await nextFor({ id: "show1" }, deps()), { next: null, why: "not-an-episode" });
});
