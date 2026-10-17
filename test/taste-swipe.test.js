// The swipe taste picker (2026-10-17):
//   src/media/tastedeck.js   which title to ask about next — well-known,
//                            varied, bent by the answers so far
//   src/profiles.js          the three answers, stored per profile
//   src/routes/profiles.js   /taste/deck and /taste/answer (kids gate included)
//   src/media/recs/person.js "Not for me" as a small negative signal
// Pure where it can be: a synthetic catalogue, a stubbed store, no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const deck = require("../src/media/tastedeck");
const profiles = require("../src/profiles");
const person = require("../src/media/recs/person");

// ---------- a synthetic well-known list ----------
// 8 genres x films and series, decades 1970..2020, popularity rank k per type
const GENRES = ["Horror", "Comedy", "Drama", "Science Fiction", "Animation", "Crime", "Romance", "Documentary"];
const KNOWN = [];
{
  let n = 1;
  const k = { movie: 0, show: 0 };
  for (let i = 0; i < 400; i++) {
    const type = i % 3 === 2 ? "show" : "movie";
    const g = GENRES[i % GENRES.length];
    const second = GENRES[(i * 3 + 1) % GENRES.length];
    KNOWN.push({
      imdbId: `tt${String(n++).padStart(7, "0")}`, type, title: `${g} ${type} ${i}`,
      year: 1970 + ((i * 7) % 55), poster: `https://images.metahub.space/poster/small/tt${i}/img`,
      rating: 6 + (i % 30) / 10, genres: second === g ? [g] : [g, second], cast: ["A Actor", "B Actor"], director: ["C Director"],
      k: k[type]++,
    });
  }
}
const POOL = deck.buildPool({ known: KNOWN, library: [], describe: () => null });
const byId = new Map(POOL.map((c) => [c.imdbId, c]));
const primary = (c) => c.genres[0];

test("pool: well-known only (the catalogue's list, not its long tail), one entry per title, library merged in", () => {
  const deep = { ...KNOWN[0], imdbId: "tt9999990", k: 5000, title: "Obscure" };
  const pool = deck.buildPool({
    known: [...KNOWN, deep, { ...KNOWN[0] }],
    library: [
      { id: "lib-1", imdbId: KNOWN[0].imdbId, type: "movie", title: KNOWN[0].title, cover: "/img/abc.jpg" },
      { id: "lib-2", imdbId: "tt8888880", type: "show", title: "Home Video", cover: "/img/def.jpg", genres: ["Comedy"], synopsis: "A family films everything. Then more happens." },
      { id: "lib-3", type: "movie", title: "No id", cover: "/img/x.jpg" },
    ],
  });
  assert.equal(pool.filter((c) => c.imdbId === KNOWN[0].imdbId).length, 1);
  assert.ok(!pool.some((c) => c.imdbId === "tt9999990"), "past the well-known depth");
  const merged = pool.find((c) => c.imdbId === KNOWN[0].imdbId);
  assert.equal(merged.id, "lib-1", "Love on it lands on the playable library title");
  const own = pool.find((c) => c.imdbId === "tt8888880");
  assert.ok(own && own.lib && own.poster === "/img/def.jpg");
  assert.equal(own.line, "A family films everything.", "the line: the synopsis' first sentence");
  assert.equal(merged.line, "C Director, with A Actor and B Actor", "no synopsis: who made it");
  assert.ok(!pool.some((c) => c.title === "No id"));
  // genres are the recommender's canonical names
  assert.ok(pool.find((c) => c.genres.includes("Sci-Fi")), JSON.stringify(pool.slice(0, 5).map((c) => c.genres)));
});

test("the line is short: one sentence, cut at a word", () => {
  const { firstSentence } = deck._internals;
  assert.equal(firstSentence("A thief who steals secrets through dreams is offered a chance. More text."), "A thief who steals secrets through dreams is offered a chance.");
  const long = firstSentence("word ".repeat(80));
  assert.ok(long.length <= 141 && long.endsWith("…"), long);
});

test("a fresh deck is varied: genres, decades, films AND series — and starts with the famous", () => {
  const cards = deck.pick({ pool: POOL, n: 24, seed: "s1" });
  assert.equal(cards.length, 24);
  assert.equal(new Set(cards.map((c) => c.imdbId)).size, 24, "no title twice");
  const genres = new Set(cards.flatMap((c) => c.genres));
  assert.ok(genres.size >= 7, `only ${genres.size} genres in 24 cards`);
  const prim = new Map();
  for (const c of cards) prim.set(primary(c), (prim.get(primary(c)) || 0) + 1);
  assert.ok(Math.max(...prim.values()) <= 6, `one genre leads ${Math.max(...prim.values())} of 24 cards`);
  const decades = new Set(cards.map((c) => Math.floor(c.year / 10)));
  assert.ok(decades.size >= 4, `${decades.size} decades`);
  const shows = cards.filter((c) => c.type === "show").length;
  assert.ok(shows >= 5 && shows <= 13, `${shows} series of 24`);
  // the first six: the very best known
  for (const c of cards.slice(0, 6)) assert.ok(c.rank < 250, `${c.title} (rank ${c.rank}) among the first six`);
});

test("same seed, same cards; another day, another deck", () => {
  const a = deck.pick({ pool: POOL, n: 10, seed: "day1" }).map((c) => c.imdbId);
  const b = deck.pick({ pool: POOL, n: 10, seed: "day1" }).map((c) => c.imdbId);
  const c = deck.pick({ pool: POOL, n: 10, seed: "day2" }).map((x) => x.imdbId);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("adapts: after three horror 'no's, no more horror; a loved genre comes back more often", () => {
  const horror = POOL.filter((c) => c.genres.includes("Horror")).slice(0, 3);
  const answers = horror.map((c) => ({ imdbId: c.imdbId, verdict: "nope" }));
  const next = deck.pick({ pool: POOL, answers, n: 20, seed: "s2" });
  assert.equal(next.filter((c) => c.genres.includes("Horror")).length, 0, next.map((c) => c.title).join(", "));
  // two "no"s are not yet a rule
  const two = deck.pick({ pool: POOL, answers: answers.slice(0, 2), n: 30, seed: "s2" });
  assert.ok(two.some((c) => c.genres.includes("Horror")), "two answers do not shut a genre");
  // loves: comedy shows up more than in a deck with no answers
  const comedies = POOL.filter((c) => primary(c) === "Comedy").slice(0, 5).map((c) => ({ imdbId: c.imdbId, verdict: "love" }));
  const others = POOL.filter((c) => primary(c) === "Drama").slice(0, 5).map((c) => ({ imdbId: c.imdbId, verdict: "skip" }));
  const count = (cards) => cards.filter((c) => c.genres.includes("Comedy")).length;
  const loved = count(deck.pick({ pool: POOL, answers: [...comedies, ...others], n: 20, seed: "s3" }));
  const neutral = count(deck.pick({ pool: POOL, answers: [...POOL.filter((c) => primary(c) === "Romance").slice(0, 5), ...POOL.filter((c) => primary(c) === "Drama").slice(0, 5)].map((c) => ({ imdbId: c.imdbId, verdict: "skip" })), n: 20, seed: "s3" }));
  assert.ok(loved > neutral, `comedy: ${loved} after five comedy loves vs ${neutral} without`);
});

test("a genre they keep loving can carry a banned one back in (horror-comedy for a comedy lover)", () => {
  const { shut, } = deck._internals;
  const read = deck.readAnswers([
    ...POOL.filter((c) => c.genres.includes("Horror") && !c.genres.includes("Comedy")).slice(0, 4).map((c) => ({ imdbId: c.imdbId, verdict: "nope" })),
    ...POOL.filter((c) => c.genres.includes("Comedy") && !c.genres.includes("Horror")).slice(0, 4).map((c) => ({ imdbId: c.imdbId, verdict: "love" })),
  ], (id) => byId.get(id));
  assert.ok(read.banned.has("Horror") && read.strong.has("Comedy"));
  assert.equal(shut({ genres: ["Horror"] }, read), true);
  assert.equal(shut({ genres: ["Horror", "Comedy"] }, read), false);
  assert.equal(shut({ genres: ["Drama"] }, read), false);
});

test("many 'haven't seen's lean the deck towards the most famous", () => {
  const skips = POOL.filter((c) => c.rank > 60).slice(0, 12).map((c) => ({ imdbId: c.imdbId, verdict: "skip" }));
  const mean = (cards) => cards.reduce((n, c) => n + c.rank, 0) / cards.length;
  const after = mean(deck.pick({ pool: POOL, answers: skips, n: 12, seed: "s4" }));
  const loves = mean(deck.pick({ pool: POOL, answers: skips.map((a) => ({ ...a, verdict: "love" })), n: 12, seed: "s4" }));
  assert.ok(after < loves, `mean rank ${after} after skips vs ${loves} after loves`);
});

test("series that never land fade; a series lover gets more of them", () => {
  const shows = POOL.filter((c) => c.type === "show");
  const films = POOL.filter((c) => c.type === "movie");
  const share = (answers) => deck.pick({ pool: POOL, answers, n: 20, seed: "s5" }).filter((c) => c.type === "show").length;
  const noShows = share([...shows.slice(0, 6).map((c) => ({ imdbId: c.imdbId, verdict: "nope" })), ...films.slice(0, 6).map((c) => ({ imdbId: c.imdbId, verdict: "love" }))]);
  const yesShows = share([...shows.slice(0, 6).map((c) => ({ imdbId: c.imdbId, verdict: "love" })), ...films.slice(0, 6).map((c) => ({ imdbId: c.imdbId, verdict: "nope" }))]);
  assert.ok(noShows < yesShows, `${noShows} series vs ${yesShows}`);
});

test("never asks about what is watched, rated, listed, answered or already queued; kids see only what they may", () => {
  const ex = new Set(POOL.slice(0, 50).map((c) => c.imdbId));
  const answers = POOL.slice(50, 60).map((c) => ({ imdbId: c.imdbId, verdict: "skip" }));
  const queued = POOL.slice(60, 62).map((c) => c.imdbId);
  const cards = deck.pick({ pool: POOL, exclude: ex, answers, queued, n: 40, seed: "s6" });
  for (const c of cards) {
    assert.ok(!ex.has(c.imdbId) && !answers.some((a) => a.imdbId === c.imdbId) && !queued.includes(c.imdbId), c.title);
  }
  const kidsCards = deck.pick({ pool: POOL, n: 20, allow: (c) => c.genres.includes("Animation"), seed: "s6" });
  assert.ok(kidsCards.length > 0 && kidsCards.every((c) => c.genres.includes("Animation")));
  // a pool that runs dry hands out what it has, then nothing
  assert.equal(deck.pick({ pool: POOL.slice(0, 3), n: 10 }).length, 3);
  assert.equal(deck.pick({ pool: POOL.slice(0, 3), exclude: new Set(POOL.slice(0, 3).map((c) => c.imdbId)), n: 10 }).length, 0);
});

test("the card the clients get: what they draw, nothing more", () => {
  const card = deck.cardOf(POOL[0]);
  assert.deepEqual(Object.keys(card).sort(), ["genres", "imdbId", "line", "poster", "title", "type", "year"]);
});

// ---------- storage ----------
profiles._internals.store.save = () => {};
const withProfiles = (list, fn) => {
  const keep = profiles._internals.store.data;
  profiles._internals.store.data = { profiles: list, state: {}, pending: [], access: {} };
  try { return fn(); } finally { profiles._internals.store.data = keep; }
};

test("answers: one per title — Love is a liked title, Not for me and Haven't seen their own lists; null takes it back", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    const stamp0 = profiles.signalsStamp("p1");
    const t = { imdbId: "tt0111161", id: "lib-shaw", title: "The Shawshank Redemption" };
    assert.deepEqual(profiles.setTasteAnswer("p1", t, "love"), { verdict: "love", was: null });
    assert.deepEqual(profiles.getLikedTitles("p1"), [{ id: "lib-shaw", imdbId: "tt0111161", title: "The Shawshank Redemption" }]);
    assert.ok(profiles.signalsStamp("p1") > stamp0, "a love reshapes Home");
    // changing the answer moves it
    assert.deepEqual(profiles.setTasteAnswer("p1", t, "nope"), { verdict: "nope", was: "love" });
    assert.equal(profiles.getLikedTitles("p1").length, 0);
    assert.equal(profiles.getDislikedTitles("p1")[0].imdbId, "tt0111161");
    assert.deepEqual(profiles.setTasteAnswer("p1", t, "skip"), { verdict: "skip", was: "nope" });
    assert.equal(profiles.getDislikedTitles("p1").length, 0);
    assert.equal(profiles.getTasteSkipped("p1").length, 1);
    const stamp1 = profiles.signalsStamp("p1");
    profiles.setTasteAnswer("p1", { imdbId: "tt0000077", title: "X" }, "skip");
    assert.equal(profiles.signalsStamp("p1"), stamp1, "a skip says nothing about taste");
    // Undo: the answer it had before
    assert.deepEqual(profiles.setTasteAnswer("p1", t, null), { verdict: null, was: "skip" });
    assert.deepEqual(profiles.tasteCounts("p1"), { love: 0, nope: 0, skip: 1 });
    // a love that was picked in the old grid by LIBRARY id is found too
    profiles.setLikedTitles("p1", [{ id: "lib-shaw", title: "The Shawshank Redemption" }]);
    assert.equal(profiles.setTasteAnswer("p1", t, "nope").was, "love");
    assert.equal(profiles.getLikedTitles("p1").length, 0);
  });
});

test("answers: validated and bounded", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    assert.equal(profiles.setTasteAnswer("p1", { imdbId: "nope", title: "x" }, "love"), null);
    assert.equal(profiles.setTasteAnswer("p1", { imdbId: "tt0000001", title: "x" }, "maybe"), null);
    for (let i = 0; i < 130; i++) profiles.setTasteAnswer("p1", { imdbId: `tt${String(1000 + i).padStart(7, "0")}`, title: `T${i}` }, "love");
    assert.equal(profiles.getLikedTitles("p1").length, 100);
    assert.equal(profiles.getLikedTitles("p1")[99].title, "T129", "the newest stay, the oldest go");
    for (let i = 0; i < 320; i++) profiles.setTasteAnswer("p1", { imdbId: `tt${String(5000 + i).padStart(7, "0")}`, title: `N${i}` }, "nope");
    assert.equal(profiles.getDislikedTitles("p1").length, 300);
  });
});

test("the old list: picking a title as loved there clears its 'Not for me'", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    profiles.setTasteAnswer("p1", { imdbId: "tt0000042", title: "A" }, "nope");
    profiles.setLikedTitles("p1", [{ imdbId: "tt0000042", title: "A" }]);
    assert.equal(profiles.getDislikedTitles("p1").length, 0);
    assert.equal(profiles.getLikedTitles("p1").length, 1);
  });
});

// ---------- the routes ----------
const router = require("../src/routes/profiles");
const handlerOf = (path, method) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const st = layer.route.stack;
  return st[st.length - 1].handle; // past the gate
};
const fakeRes = () => {
  const r = { code: 200, body: undefined };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const wellknown = require("../src/media/wellknown");
const useKnown = (titles) => wellknown._internals.useStore({ data: { v: 1, at: Date.now(), tried: 0, titles }, save() {} });

test("routes: the deck, an answer with the next cards in its reply, Undo, and nothing answered comes back", () => {
  useKnown(KNOWN);
  withProfiles([{ id: "p1", name: "T" }], () => {
    profiles.stateOf("p1").titles = { [KNOWN[0].imdbId]: { position: 10, duration: 100, finished: true, updatedAt: Date.now() } };
    const res = fakeRes();
    handlerOf("/api/profiles/:id/taste/deck", "get")({ params: { id: "p1" }, query: { n: "6" } }, res);
    assert.equal(res.body.cards.length, 6);
    assert.equal(res.body.goal, deck.GOAL);
    assert.ok(!res.body.cards.some((c) => c.imdbId === KNOWN[0].imdbId), "a watched title is not asked about");
    const [first, second, third] = res.body.cards;
    const ans = fakeRes();
    handlerOf("/api/profiles/:id/taste/answer", "post")({ params: { id: "p1" }, body: { imdbId: first.imdbId, title: first.title, verdict: "love", queued: [second.imdbId, third.imdbId], n: 2 } }, ans);
    assert.equal(ans.body.verdict, "love");
    assert.equal(ans.body.was, null);
    assert.equal(ans.body.cards.length, 2);
    for (const c of ans.body.cards) assert.ok(![first.imdbId, second.imdbId, third.imdbId].includes(c.imdbId), "not the answered, not the queued");
    assert.deepEqual(ans.body.counts, { love: 1, nope: 0, skip: 0 });
    // Undo = the answer it had before
    const undo = fakeRes();
    handlerOf("/api/profiles/:id/taste/answer", "post")({ params: { id: "p1" }, body: { imdbId: first.imdbId, title: first.title, verdict: null } }, undo);
    assert.deepEqual(undo.body.counts, { love: 0, nope: 0, skip: 0 });
    assert.deepEqual(undo.body.cards, []);
    const bad = fakeRes();
    handlerOf("/api/profiles/:id/taste/answer", "post")({ params: { id: "p1" }, body: { imdbId: "x", verdict: "love" } }, bad);
    assert.equal(bad.code, 400);
    // GET /taste carries the answers
    profiles.setTasteAnswer("p1", { imdbId: second.imdbId, title: second.title }, "nope");
    const got = fakeRes();
    handlerOf("/api/profiles/:id/taste", "get")({ params: { id: "p1" } }, got);
    assert.deepEqual(got.body.disliked.map((t) => [t.imdbId, t.title]), [[second.imdbId, second.title]]);
    assert.equal(got.body.disliked[0].poster, second.poster, "with the picture the picker showed");
    assert.equal(got.body.counts.nope, 1);
  });
});

test("routes: a kids profile is only shown titles its age allows (unknown rating = not shown)", () => {
  useKnown(KNOWN);
  const discover = require("../src/media/discover");
  const keep = [discover.certificateCached, discover.certificateAge, discover.warmCertificate];
  // ratings for a handful: animation is "ALL", everything else 18, the rest unknown
  const rated = new Map();
  for (const r of KNOWN.slice(0, 120)) rated.set(r.imdbId, r.genres.includes("Animation") ? "ALL" : "18");
  discover.certificateCached = (id) => rated.get(id) || null;
  discover.certificateAge = (id) => (rated.has(id) ? (rated.get(id) === "ALL" ? 0 : 18) : null);
  discover.warmCertificate = () => false;
  try {
    withProfiles([{ id: "kid", name: "K", kids: { maxAge: 7 } }], () => {
      const res = fakeRes();
      handlerOf("/api/profiles/:id/taste/deck", "get")({ params: { id: "kid" }, query: { n: "12" } }, res);
      assert.ok(res.body.cards.length > 0, "something to show");
      for (const c of res.body.cards) assert.equal(rated.get(c.imdbId), "ALL", `${c.title} in a kids deck`);
    });
  } finally {
    [discover.certificateCached, discover.certificateAge, discover.warmCertificate] = keep;
  }
});

// ---------- the recommender ----------
test("'Not for me' is a small negative: below a 2-star rating and below giving up, and never recommended", () => {
  assert.ok(person.W.notForMe < 0);
  assert.ok(person.W.notForMe > person.W.rate2, "a poster judged is weaker than a film rated");
  assert.ok(Math.abs(person.W.notForMe) < person.W.loved / 2);
  const ev = person.collectEvents({ dislikedTitles: [{ imdbId: "tt0000005", title: "X", at: 1 }], likedTitles: [{ imdbId: "tt0000006", title: "Y" }] }, { now: Date.now() });
  const t = ev.titles.get("tt0000005");
  assert.equal(t.w, person.W.notForMe);
  assert.ok(t.kinds.has("notforme"));
  assert.ok(ev.seen.has("tt0000005"), "a title they said no to is not recommended back to them");
  // it is evidence on top of what they did: a finished film stays a positive
  const both = person.collectEvents({
    titles: { tt0000005: { position: 6000, duration: 6000, finished: true, updatedAt: Date.now() } },
    dislikedTitles: [{ imdbId: "tt0000005", title: "X", at: 1 }],
  }, { now: Date.now() }).titles.get("tt0000005");
  assert.ok(both.w > 0);
});

test("ALGO was bumped for the new signal (docs/recommender.md, the ALGO rule)", () => {
  const recs = require("../src/media/recs");
  assert.ok(recs.ALGO >= 2, `ALGO ${recs.ALGO}`);
});

test("'Not for me' moves the ranking sensibly: its neighbourhood sinks, the unrelated stays put (synthetic catalogue)", () => {
  const features = require("../src/media/recs/features");
  const rank = require("../src/media/recs/rank");
  const { fromTmdb } = require("../src/media/recs/titleindex")._internals;
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const KINDS = {
    heist: { genres: ["Crime", "Thriller"], kw: ["heist", "bank robbery", "con artist", "caper", "double cross"] },
    ghost: { genres: ["Horror", "Mystery"], kw: ["haunted house", "ghost", "supernatural horror", "possession", "demon"] },
    romcom: { genres: ["Comedy", "Romance"], kw: ["romcom", "wedding", "falling in love", "opposites attract", "feel good"] },
  };
  const recs = [];
  const by = {};
  let n = 1;
  for (const [kind, k] of Object.entries(KINDS)) {
    by[kind] = [];
    for (let i = 0; i < 25; i++) {
      const id = n++;
      const rec = fromTmdb({
        id, title: `${kind} ${i}`, release_date: `${1995 + (i % 28)}-05-01`, status: "Released",
        genres: k.genres.map((name, g) => ({ id: g, name })),
        keywords: { keywords: [0, 1, 2].map((j) => k.kw[(i + j) % 5]).map((name, x) => ({ id: x, name })) },
        credits: { crew: [{ id: 500 + (id % 9), name: `Director ${id % 9}`, job: "Director" }], cast: [{ id: 700 + (id % 13), name: "A", order: 0 }] },
        external_ids: { imdb_id: `tt${String(id).padStart(7, "0")}` },
        vote_average: 5.6 + ((i * 7) % 30) / 10, vote_count: 400 + ((i * 131) % 4000), poster_path: "/p.jpg", overview: `A ${kind} story number ${i}.`,
      }, "movie");
      recs.push(rec);
      by[kind].push(rec);
    }
  }
  const stats = features.buildStats(recs);
  const cands = recs.map((rec) => ({ id: rec.id, rec, v: features.vectorOf(rec, stats) }));
  const vOf = new Map(cands.map((c) => [c.id, c.v]));
  const kindOf = (id) => recs.find((r) => r.id === id).title.split(" ")[0];
  const finished = (list) => Object.fromEntries(list.map((r, i) => [r.id, { position: 6000, duration: 6000, finished: true, updatedAt: NOW - (2 + i * 4) * 86400000 }]));
  // likes heists and ghost stories
  const base = { titles: finished([...by.heist.slice(0, 5), ...by.ghost.slice(0, 5)]) };
  const order = (state) => {
    const ev = person.collectEvents(state, { now: NOW });
    const m = person.buildModel(ev, { vectorFor: (id) => vOf.get(id) || null, titleFor: () => "x", now: NOW });
    return rank.scoreAll(m, cands.filter((c) => !m.seen.has(c.id)), {}).map((s) => s.id);
  };
  const meanAt = (ids, kind) => {
    const xs = ids.map((id, i) => [id, i]).filter(([id]) => kindOf(id) === kind).map(([, i]) => i);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const before = order(base);
  const nopes = by.ghost.slice(5, 8).map((r) => ({ imdbId: r.id, title: r.title, at: NOW }));
  const after = order({ ...base, dislikedTitles: nopes });
  for (const t of nopes) assert.ok(!after.includes(t.imdbId), "a 'no' is never recommended back");
  assert.ok(meanAt(after, "ghost") > meanAt(before, "ghost") + 2, `ghost stories: mean place ${meanAt(before, "ghost")} -> ${meanAt(after, "ghost")}`);
  assert.ok(meanAt(after, "heist") <= meanAt(before, "heist"), "the loved, unrelated neighbourhood does not sink");
  // light: three 'no's against five finished ghost films leave ghost stories in the top 20
  // light: three 'no's against five finished ghost films sink ghost stories
  // below the heists, not below a genre they never touched
  assert.ok(meanAt(after, "ghost") < meanAt(after, "romcom"), "a genre they watch stays above one they never touched");
});
