// "What do we watch tonight?": the deck, the group score, and the sessions'
// rules (joining, leaving, adding titles, the timeouts) — pure, no server.
// The routes and their guard are pinned in grouppick-server.test.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const deck = require("../src/media/groupdeck");
const gp = require("../src/lib/grouppick");

// ---------- the group score ----------
test("group score: everyone yes beats any mix; one no pulls a title down hard", () => {
  const all = deck.groupScore(["yes", "yes", "yes"]);
  const maybes = deck.groupScore(["yes", "maybe", "maybe"]);
  const oneNo = deck.groupScore(["yes", "yes", "no"]);
  const twoYesMissing = deck.groupScore(["yes", "yes", undefined]);
  assert.equal(all.everyone, true);
  assert.ok(all.score > maybes.score);
  assert.ok(maybes.score > oneNo.score, "two maybes are fairer than one person's no");
  assert.ok(twoYesMissing.score > oneNo.score, "not answering is a shrug, not a no");
  assert.deepEqual([oneNo.yes, oneNo.no, oneNo.of], [2, 1, 3]);
  assert.equal(deck.groupScore([]).score, 0);
});

test("the why is counted, never named", () => {
  assert.equal(deck.whyOf(deck.groupScore(["yes", "yes", "yes"])), "3 of 3 said yes");
  assert.equal(deck.whyOf(deck.groupScore(["yes", "yes"])), "Both of you said yes");
  assert.equal(deck.whyOf(deck.groupScore(["yes", "maybe", "no"])), "1 of 3 said yes · 1 maybe · 1 no");
  assert.equal(deck.whyOf(deck.groupScore(["yes", "yes", undefined, "maybe"])), "2 of 4 said yes · 1 maybe · 1 didn't get to it");
  assert.equal(deck.whyOf(deck.groupScore(["yes"])), "You said yes");
});

test("results: everyone-yes first, then the fairest; nothing with no yes; method says which", () => {
  const cards = ["a", "b", "c", "d"].map((k, i) => ({ key: k, title: k.toUpperCase(), groupFit: 0.1 * i }));
  const ballots = new Map([
    ["p1", new Map([["a", "yes"], ["b", "yes"], ["c", "yes"], ["d", "no"]])],
    ["p2", new Map([["a", "yes"], ["b", "maybe"], ["c", "yes"], ["d", "no"]])],
    ["p3", new Map([["a", "no"], ["b", "maybe"], ["c", "yes"], ["d", "no"]])],
  ]);
  const r = deck.results({ deck: cards, voters: ["p1", "p2", "p3"], ballots });
  assert.equal(r.method, "everyone");
  assert.deepEqual(r.picks.map((p) => p.key), ["c", "b", "a"]);
  assert.equal(r.picks[0].why, "3 of 3 said yes");
  const none = deck.results({ deck: cards, voters: ["p1"], ballots: new Map([["p1", new Map([["a", "no"]])]]) });
  assert.equal(none.method, "none");
  assert.equal(none.picks.length, 0);
  const best = deck.results({ deck: cards, voters: ["p1", "p3"], ballots });
  assert.equal(best.method, "everyone"); // c: both yes
  const noUnanimous = deck.results({ deck: cards.slice(0, 2), voters: ["p1", "p2", "p3"], ballots });
  assert.equal(noUnanimous.method, "best");
  assert.equal(noUnanimous.picks[0].key, "b", "yes/maybe/maybe beats yes/yes/no");
});

// ---------- the deck ----------
const film = (n, extra = {}) => ({
  imdbId: `tt10000${String(n).padStart(2, "0")}`, type: "movie", title: `Film ${n}`, year: 2000 + n, poster: `/p/${n}.jpg`,
  genres: ["Drama"], rating: 7, lib: false, pop: 0.5, ...extra,
});

test("deck: the filters — kind, mood (genre or theme), length, the kids rule", () => {
  const pool = [
    film(1, { genres: ["Comedy"], runtime: 95 }),
    film(2, { genres: ["Horror"], runtime: 100 }),
    film(3, { genres: ["Comedy", "Horror"], runtime: 90 }), // a horror-comedy is not "funny" for a family night
    film(4, { genres: ["Drama"], themes: { "light-fun": 1 }, runtime: 150 }),
    { ...film(5, { genres: ["Comedy"] }), type: "show" },
    film(6, { genres: ["Comedy"], runtime: 130 }),
  ];
  const keys = (opts) => deck.buildDeck({ pool, voters: ["a"], ...opts }).map((c) => c.title).sort();
  assert.deepEqual(keys({ settings: { kind: "movie", mood: "funny" } }), ["Film 1", "Film 4", "Film 6"]);
  assert.deepEqual(keys({ settings: { kind: "show", mood: "funny" } }), ["Film 5"]);
  assert.deepEqual(keys({ settings: { kind: "both", mood: "funny", length: "120" } }), ["Film 1", "Film 5"]);
  assert.deepEqual(keys({ settings: { kind: "movie", mood: "scary" } }), ["Film 2", "Film 3"]);
  assert.deepEqual(keys({ settings: { kind: "movie", mood: "any" }, allow: (c) => c.title !== "Film 2" }).length, 4); // (Film 5 is a series)
  // unknown settings fall back to the defaults (films, anything, any length)
  assert.deepEqual(deck.cleanSettings({ kind: "x", mood: "y", length: 7 }), { kind: "movie", mood: "any", length: "any" });
});

test("deck: what everyone has seen is out, what some have seen goes lower and says so", () => {
  const pool = [film(1), film(2), film(3)];
  const seen = { a: new Set([pool[0].imdbId, pool[1].imdbId]), b: new Set([pool[0].imdbId]) };
  const d = deck.buildDeck({ pool, voters: ["a", "b"], seenOf: (pid) => seen[pid], settings: { kind: "movie" }, seed: "s" });
  const titles = d.map((c) => c.title);
  assert.ok(!titles.includes("Film 1"), "both saw it");
  const two = d.find((c) => c.title === "Film 2");
  assert.deepEqual(two.seenBy, ["a"]);
});

test("deck: prefers what is on the server, at least half the deck while the library lasts", () => {
  const pool = [];
  for (let i = 1; i <= 30; i++) pool.push(film(i, { rating: 8.5 }));
  for (let i = 31; i <= 45; i++) pool.push(film(i, { rating: 5, lib: true, id: `lib${i}` }));
  const d = deck.buildDeck({ pool, voters: ["a"], settings: { kind: "movie" }, n: 20, seed: "x" });
  assert.equal(d.length, 20);
  assert.ok(d.filter((c) => c.lib).length >= 10, `library cards: ${d.filter((c) => c.lib).length}`);
  // a library copy replaces its catalogue twin
  const twin = deck.buildDeck({ pool: [film(1), { ...film(1), id: "L1", lib: true }], voters: ["a"], settings: { kind: "movie" } });
  assert.equal(twin.length, 1);
  assert.equal(twin[0].id, "L1");
  assert.equal(twin[0].key, "lib:L1");
});

test("deck: fair fit — one person's strong dislike keeps a title out of the top", () => {
  const pool = [film(1), film(2), film(3), film(4), film(5), film(6)];
  // A loves 1 most; B hates 1. Both like 2 well enough.
  const fit = {
    a: { "Film 1": 10, "Film 2": 8, "Film 3": 1, "Film 4": 2, "Film 5": 3, "Film 6": 4 },
    b: { "Film 1": -10, "Film 2": 7, "Film 3": 2, "Film 4": 1, "Film 5": 4, "Film 6": 3 },
  };
  const d = deck.buildDeck({ pool, voters: ["a", "b"], fitOf: (pid, c) => fit[pid][c.title], settings: { kind: "movie" }, n: 6, seed: "q" });
  const byFit = [...d].sort((x, y) => y.groupFit - x.groupFit);
  assert.equal(byFit[0].title, "Film 2");
  const one = d.find((c) => c.title === "Film 1");
  assert.ok(one.groupFit < byFit[0].groupFit);
  // a big history does not outvote a small one: percentiles, not raw scores
  const p = deck._internals.percentiles([100, 1, 50, null]);
  assert.deepEqual(p, [1, 0, 0.5, null]);
});

test("deck: varied genres, n cards, deterministic for a seed", () => {
  const pool = [];
  for (let i = 1; i <= 20; i++) pool.push(film(i, { genres: ["Thriller"], rating: 8 }));
  for (let i = 21; i <= 30; i++) pool.push(film(i, { genres: ["Comedy"], rating: 7.5 }));
  const a = deck.buildDeck({ pool, voters: ["a"], settings: { kind: "movie" }, n: 10, seed: "z" });
  const b = deck.buildDeck({ pool, voters: ["a"], settings: { kind: "movie" }, n: 10, seed: "z" });
  assert.deepEqual(a.map((c) => c.key), b.map((c) => c.key));
  assert.equal(a.length, 10);
  assert.ok(a.filter((c) => c.genres.includes("Comedy")).length >= 3, "not ten thrillers");
});

// ---------- the sessions ----------
let t0 = 1_700_000_000_000;
let clockNow = t0;
const notes = [];
const fresh = () => {
  gp._internals.reset();
  clockNow = t0;
  notes.length = 0;
  gp.configure({ now: () => clockNow, notify: (code, rev) => notes.push({ code, rev }), lobbyMs: 20 * 60000, idleMs: 30 * 60000, awayMs: 75000, keepMs: 180000, limitSec: 180 });
};
const P = (id, name) => ({ profileId: id, name });
const cards = (n, prefix = "c") => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, imdbId: `tt20000${i}`, title: `Card ${i}`, type: "movie", groupFit: 0.5 }));

test("session: a TV starts it as the screen; phones join by code; the host deals", () => {
  fresh();
  const tv = gp.create(P("elia", "Elia"), { kind: "both", mood: "funny", length: "120", limitSec: 120 }, { device: "tv1", role: "screen", app: "tv" });
  const s = tv.session;
  assert.match(s.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(s.phase, "lobby");
  assert.deepEqual(s.settings, { kind: "both", mood: "funny", length: "120", limitSec: 120 });
  assert.equal(s.you.role, "screen");
  assert.equal(s.voters, 0);
  // nobody swiping yet: no deal
  assert.equal(gp.start(s.code, P("elia"), "tv1", cards(5)).status, 409);
  const j1 = gp.join(P("dana", "Dana"), s.code.toLowerCase(), { device: "ph1", app: "phone" });
  assert.equal(j1.session.you.role, "voter");
  gp.join(P("avi", "Avi"), s.code, { device: "web1", app: "web" });
  gp.join(P("elia", "Elia"), s.code, { device: "ph2", app: "phone" }); // the TV's person on their phone
  assert.equal(gp.get(s.code, P("elia"), "tv1").session.voters, 3);
  assert.ok(notes.length >= 3, "the room heard about each join");
  // only the host deals
  assert.equal(gp.start(s.code, P("dana"), "ph1", cards(5)).status, 403);
  const st = gp.start(s.code, P("elia"), "tv1", cards(5));
  assert.equal(st.session.phase, "swiping");
  assert.equal(st.session.deck.length, 5);
  assert.equal(st.session.deadline, clockNow + 120000);
  assert.equal(gp.start(s.code, P("elia"), "tv1", cards(5)).status, 409, "dealt once");
});

test("session: a wrong code is refused, and many wrong codes slow you down", () => {
  fresh();
  assert.equal(gp.join(P("dana", "Dana"), "ZZZZ", {}).status, 404);
  for (let i = 0; i < 11; i++) gp.join(P("dana", "Dana"), "ZZZZ", {});
  assert.equal(gp.join(P("dana", "Dana"), "ZZZZ", {}).status, 429);
  clockNow += 6 * 60000;
  assert.equal(gp.join(P("dana", "Dana"), "ZZZZ", {}).status, 404, "the window passed");
});

test("session: ballots are private until the result; a person on two devices is one voice", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen", app: "tv" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.join(P("dana", "Dana"), s.code, { device: "b" });
  gp.join(P("avi", "Avi"), s.code, { device: "c" });
  gp.start(s.code, P("elia"), "tv", cards(2));
  assert.equal(gp.vote(s.code, P("dana"), "a", "c0", "yes").ok, true);
  assert.equal(gp.vote(s.code, P("dana"), "b", "c0", "no").ok, true, "the latest answer counts");
  assert.equal(gp.vote(s.code, P("dana"), "a", "nope", "yes").status, 400);
  assert.equal(gp.vote(s.code, P("dana"), "a", "c0", "love").status, 400);
  assert.equal(gp.vote(s.code, P("elia"), "tv", "c0", "yes").status, 409, "the screen is not swiping");
  const avi = gp.get(s.code, P("avi"), "c").session;
  assert.deepEqual(avi.mine, {});
  assert.equal(avi.voters, 2);
  assert.equal(avi.members.find((m) => m.name === "Dana" && m.id.endsWith("|a")).answered, 1);
  assert.ok(!("ballots" in avi) && !JSON.stringify(avi).includes("\"no\""), "nobody else's answers");
  assert.deepEqual(gp.get(s.code, P("dana"), "a").session.mine, { c0: "no" });
});

test("session: the result comes the moment everyone here has answered everything", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen", app: "tv" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.join(P("avi", "Avi"), s.code, { device: "b" });
  gp.start(s.code, P("elia"), "tv", cards(3));
  for (const k of ["c0", "c1", "c2"]) gp.vote(s.code, P("dana"), "a", k, k === "c2" ? "no" : "yes");
  assert.equal(gp.get(s.code, P("elia"), "tv").session.phase, "swiping", "Avi is still swiping");
  gp.vote(s.code, P("avi"), "b", "c0", "maybe");
  gp.vote(s.code, P("avi"), "b", "c1", "yes");
  gp.vote(s.code, P("avi"), "b", "c2", "no");
  const r = gp.get(s.code, P("elia"), "tv").session;
  assert.equal(r.phase, "result");
  assert.equal(r.result.why, "done");
  assert.equal(r.result.method, "everyone");
  assert.equal(r.result.picks[0].key, "c1");
  assert.equal(r.result.picks[0].why, "Both of you said yes");
  // "Something else": anyone can move to the next; past the end is refused
  assert.deepEqual(r.result.picks.map((p) => p.key), ["c1", "c0"], "c2 had no yes");
  assert.equal(r.result.picks[1].why, "1 of 2 said yes · 1 maybe");
  assert.equal(gp.pickAt(s.code, P("dana"), "a", 1).session.result.index, 1);
  assert.equal(gp.pickAt(s.code, P("dana"), "a", 5).status, 409);
  // Play: the evening is decided, everyone sees it, the session goes later
  const ch = gp.choose(s.code, P("elia"), "tv", "c1");
  assert.equal(ch.session.phase, "chosen");
  assert.equal(ch.session.chosen.card.title, "Card 1");
  clockNow += 181000;
  gp.sweep();
  assert.equal(gp.get(s.code, P("elia"), "tv").status, 404);
});

test("session: the soft time limit — the host can add a minute or show the result early; time up deals the result", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), { limitSec: 180 }, { device: "ph" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.start(s.code, P("elia"), "ph", cards(4));
  gp.vote(s.code, P("elia"), "ph", "c0", "yes");
  gp.vote(s.code, P("dana"), "a", "c0", "yes");
  assert.equal(gp.extend(s.code, P("dana"), "a").status, 403);
  const ex = gp.extend(s.code, P("elia"), "ph");
  assert.equal(ex.session.deadline, t0 + 240000);
  clockNow = t0 + 239000;
  gp.sweep();
  assert.equal(gp.get(s.code, P("elia"), "ph").session.phase, "swiping");
  clockNow = t0 + 241000;
  gp.sweep();
  const r = gp.get(s.code, P("elia"), "ph").session;
  assert.equal(r.phase, "result");
  assert.equal(r.result.why, "time");
  assert.equal(r.result.picks[0].why, "Both of you said yes");
  // early: another session, the host's "Show the result now"
  const { session: s2 } = gp.create(P("avi", "Avi"), {}, { device: "x" });
  gp.start(s2.code, P("avi"), "x", cards(3));
  assert.equal(gp.finish(s2.code, P("avi"), "x").session.phase, "result");
  assert.equal(gp.get(s2.code, P("avi"), "x").session.result.method, "none");
});

test("session: someone away does not hold up the result; someone leaving takes their ballot", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.join(P("avi", "Avi"), s.code, { device: "b" });
  gp.join(P("ben", "Ben"), s.code, { device: "c" });
  gp.watch(s.code, "avi", "b", +1);
  gp.watch(s.code, "dana", "a", +1);
  gp.start(s.code, P("elia"), "tv", cards(2));
  gp.vote(s.code, P("avi"), "b", "c0", "yes");
  gp.vote(s.code, P("avi"), "b", "c1", "yes");
  gp.vote(s.code, P("dana"), "a", "c0", "yes");
  gp.vote(s.code, P("dana"), "a", "c1", "no");
  // Ben's phone went quiet (no socket, nothing asked for 75 s): away
  clockNow += 76000;
  gp.tick();
  const r = gp.get(s.code, P("avi"), "b").session;
  assert.equal(r.phase, "result");
  assert.equal(r.result.picks[0].why, "2 of 3 said yes · 1 didn't get to it");
  // leaving: another session
  const { session: s2 } = gp.create(P("elia", "Elia"), {}, { device: "tv2", role: "screen" });
  gp.join(P("dana", "Dana"), s2.code, { device: "a" });
  gp.join(P("avi", "Avi"), s2.code, { device: "b" });
  gp.start(s2.code, P("elia"), "tv2", cards(1));
  gp.vote(s2.code, P("avi"), "b", "c0", "no");
  assert.equal(gp.leave(s2.code, P("avi"), "b").ok, true);
  assert.equal(gp.get(s2.code, P("avi"), "b").status, 403, "not a member any more");
  gp.vote(s2.code, P("dana"), "a", "c0", "yes");
  const r2 = gp.get(s2.code, P("dana"), "a").session;
  assert.equal(r2.phase, "result");
  assert.equal(r2.result.picks[0].why, "You said yes", "Avi's no left with him");
});

test("session: the host leaving hands it on; the host ending it ends it for everyone", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.leave(s.code, P("elia"), "tv");
  const d = gp.get(s.code, P("dana"), "a").session;
  assert.equal(d.host.name, "Dana");
  assert.equal(d.you.host, true);
  assert.equal(gp.end(s.code, P("dana"), "a").ok, true);
  assert.equal(gp.get(s.code, P("dana"), "a").session.phase, "ended");
  assert.equal(gp.get(s.code, P("dana"), "a").session.ended.reason, "Dana ended it");
  assert.equal(gp.join(P("avi", "Avi"), s.code, {}).status, 404);
  // the last one out ends it
  const { session: s2 } = gp.create(P("avi", "Avi"), {}, { device: "z" });
  gp.leave(s2.code, P("avi"), "z");
  assert.equal(gp.get(s2.code, P("avi"), "z").status, 403);
});

test("session: rejoining on the same device takes the same place (a reload, a lost connection)", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.start(s.code, P("elia"), "tv", cards(2));
  gp.vote(s.code, P("dana"), "a", "c0", "yes");
  const again = gp.join(P("dana", "Dana"), s.code, { device: "a" });
  assert.equal(again.rejoined, true);
  assert.deepEqual(again.session.mine, { c0: "yes" });
  assert.equal(again.session.members.length, 2);
});

test("adding titles: in the lobby they go in early and count as the adder's yes; during swiping they join the end", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  gp.join(P("avi", "Avi"), s.code, { device: "b" });
  const mine = { key: "lib:x1", id: "x1", title: "Our Film", type: "movie", lib: true };
  assert.equal(gp.add(s.code, P("dana"), "a", mine).ok, true);
  assert.equal(gp.add(s.code, P("avi"), "b", { ...mine }).already, true, "already added");
  const lobby = gp.get(s.code, P("avi"), "b").session;
  assert.deepEqual(lobby.added.map((a) => [a.title, a.by]), [["Our Film", "Dana"]]);
  gp.start(s.code, P("elia"), "tv", cards(4));
  const sw = gp.get(s.code, P("dana"), "a").session;
  assert.equal(sw.deck.findIndex((c) => c.key === "lib:x1"), 1, "second card");
  assert.equal(sw.deck[1].addedBy, "Dana");
  assert.deepEqual(sw.mine, { "lib:x1": "yes" });
  // during swiping: at the end of everyone's deck
  assert.equal(gp.add(s.code, P("avi"), "b", { key: "tt777", imdbId: "tt777", title: "Late Add", type: "movie" }).ok, true);
  const later = gp.get(s.code, P("dana"), "a").session;
  assert.equal(later.deck[later.deck.length - 1].title, "Late Add");
  assert.equal(gp.get(s.code, P("avi"), "b").session.mine.tt777, "yes");
  // the same title by imdbId again is "already" — and a yes for whoever adds it
  assert.equal(gp.add(s.code, P("dana"), "a", { key: "tt777", imdbId: "tt777", title: "Late Add", type: "movie" }).already, true);
  assert.equal(gp.get(s.code, P("dana"), "a").session.mine.tt777, "yes");
  // a limit per person per round
  for (let i = 0; i < 10; i++) gp.add(s.code, P("avi"), "b", { key: `tt9${i}`, imdbId: `tt9${i}`, title: `X${i}`, type: "movie" });
  assert.equal(gp.add(s.code, P("avi"), "b", { key: "tt99", title: "Y", type: "movie" }).status, 409);
  assert.equal(gp.add(s.code, P("avi"), "b", null).status, 400);
});

test("timeouts: an unstarted code expires; an idle session ends; an evening has an end", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  assert.equal(s.expiresAt, t0 + 20 * 60000);
  clockNow = t0 + 20 * 60000 + 1;
  gp.sweep();
  const e = gp.get(s.code, P("elia"), "tv").session;
  assert.equal(e.phase, "ended");
  assert.equal(e.ended.reason, "The code expired");
  assert.equal(gp.join(P("dana", "Dana"), s.code, {}).status, 404);
  clockNow += 181000;
  gp.sweep();
  assert.equal(gp.get(s.code, P("elia"), "tv").status, 404, "gone after the keep time");
  // idle: dealt, then nobody looks for 30 min
  const { session: s2 } = gp.create(P("elia", "Elia"), { limitSec: 300 }, { device: "tv" });
  gp.start(s2.code, P("elia"), "tv", cards(2));
  gp.finish(s2.code, P("elia"), "tv");
  clockNow += 30 * 60000 + 1;
  gp.sweep();
  assert.equal(gp.get(s2.code, P("elia"), "tv").session.phase, "ended");
  // starting a new one ends your old one
  fresh();
  const a = gp.create(P("elia", "Elia"), {}, { device: "tv" }).session;
  const b = gp.create(P("elia", "Elia"), {}, { device: "tv" }).session;
  assert.notEqual(a.code, b.code);
  assert.equal(gp.get(a.code, P("elia"), "tv").session.ended.reason, "A new session was started");
});

test("another round: a fresh deck, the old cards remembered, ballots cleared", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "ph" });
  gp.start(s.code, P("elia"), "ph", cards(2));
  gp.vote(s.code, P("elia"), "ph", "c0", "no");
  gp.vote(s.code, P("elia"), "ph", "c1", "no");
  assert.equal(gp.get(s.code, P("elia"), "ph").session.result.method, "none");
  assert.deepEqual([...gp.shownOf(s.code)].sort(), ["c0", "c1"]);
  const r = gp.again(s.code, P("elia"), "ph", cards(3, "n"));
  assert.equal(r.session.phase, "swiping");
  assert.equal(r.session.round, 2);
  assert.deepEqual(r.session.mine, {});
  assert.deepEqual([...gp.shownOf(s.code)].sort(), ["c0", "c1", "n0", "n1", "n2"]);
  assert.equal(gp.again(s.code, P("elia"), "ph", cards(1)).status, 409, "only from a result");
});

test("settings: only the host, only in the lobby", () => {
  fresh();
  const { session: s } = gp.create(P("elia", "Elia"), {}, { device: "tv", role: "screen" });
  gp.join(P("dana", "Dana"), s.code, { device: "a" });
  assert.equal(gp.setSettings(s.code, P("dana"), "a", { mood: "scary" }).status, 403);
  const r = gp.setSettings(s.code, P("elia"), "tv", { mood: "scary", limitSec: 300 });
  assert.equal(r.session.settings.mood, "scary");
  assert.equal(r.session.settings.limitSec, 300);
  assert.equal(r.session.settings.kind, "movie", "the rest is kept");
  // the TV can swipe too
  assert.equal(gp.setRole(s.code, P("elia"), "tv", "voter").session.you.role, "voter");
  gp.start(s.code, P("elia"), "tv", cards(1));
  assert.equal(gp.setSettings(s.code, P("elia"), "tv", { mood: "funny" }).status, 409);
});
