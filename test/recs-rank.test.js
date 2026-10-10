// Ranking and the home rows (src/media/recs/rank.js) on a synthetic
// catalogue: 150 titles in six neighbourhoods. Invariants, not golden lists —
// what must hold however the weights are tuned. Pure: no store, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const features = require("../src/media/recs/features");
const person = require("../src/media/recs/person");
const rank = require("../src/media/recs/rank");
const { fromTmdb } = require("../src/media/recs/titleindex")._internals;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86400000;

const KINDS = {
  heist: { genres: ["Crime", "Thriller"], kw: ["heist", "bank robbery", "con artist", "caper", "double cross"] },
  ghost: { genres: ["Horror", "Mystery"], kw: ["haunted house", "ghost", "supernatural horror", "possession", "demon"] },
  romcom: { genres: ["Comedy", "Romance"], kw: ["romcom", "wedding", "falling in love", "opposites attract", "feel good"] },
  space: { genres: ["Science Fiction", "Drama"], kw: ["space travel", "astronaut", "first contact", "alien", "slow burn"] },
  family: { genres: ["Animation", "Family"], kw: ["talking animal", "anthropomorphism", "found family", "children's adventure", "feel good"] },
  crime: { genres: ["Crime", "Drama"], kw: ["organized crime", "mafia", "gangster", "drug cartel", "anti hero"] },
};
let n = 1;
const RECS = [];
const BY_KIND = {};
for (const [kind, k] of Object.entries(KINDS)) {
  BY_KIND[kind] = [];
  for (let i = 0; i < 25; i++) {
    const id = n++;
    const rec = fromTmdb({
      id, title: `${kind} ${i}`, release_date: `${1995 + (i % 28)}-05-01`, status: "Released",
      genres: k.genres.map((name, g) => ({ id: g, name })),
      // every title carries three of its neighbourhood's five keywords
      keywords: { keywords: [0, 1, 2].map((j) => k.kw[(i + j) % 5]).map((name, x) => ({ id: x, name })) },
      credits: { crew: [{ id: 500 + (id % 9), name: `Director ${id % 9}`, job: "Director" }], cast: [{ id: 700 + (id % 13), name: "A", order: 0 }] },
      external_ids: { imdb_id: `tt${String(id).padStart(7, "0")}` },
      // quality varies inside every neighbourhood: 5.6 … 8.5
      vote_average: 5.6 + ((i * 7) % 30) / 10, vote_count: 400 + ((i * 131) % 4000),
      poster_path: "/p.jpg", overview: `A ${kind} story number ${i}.`,
      ...(i < 3 ? { belongs_to_collection: { id: 9000 + Object.keys(KINDS).indexOf(kind), name: `${kind} saga` } } : {}),
    }, "movie");
    RECS.push(rec);
    BY_KIND[kind].push(rec);
  }
}
const stats = features.buildStats(RECS);
const CANDS = RECS.map((rec) => ({ id: rec.id, rec, v: features.vectorOf(rec, stats) }));
const byId = new Map(CANDS.map((c) => [c.id, c]));
const kindOf = (id) => byId.get(id).rec.title.split(" ")[0];

const finished = (recs, daysAgoStart = 2) =>
  Object.fromEntries(recs.map((r, i) => [r.id, { position: 6000, duration: 6000, finished: true, updatedAt: NOW - (daysAgoStart + i * 4) * DAY }]));
const modelOf = (state) =>
  person.buildModel(person.collectEvents(state, { now: NOW }), { vectorFor: (id) => (byId.get(id) || {}).v || null, titleFor: (id) => byId.get(id).rec.title, now: NOW });
const fresh = (m) => CANDS.filter((c) => !m.seen.has(c.id));

const HEIST_FAN = { titles: finished(BY_KIND.heist.slice(5, 11)) };
const GHOST_FAN = { titles: finished(BY_KIND.ghost.slice(5, 11)) };

test("a heist fan's best matches are heists; a ghost-story fan's are ghost stories", () => {
  const h = modelOf(HEIST_FAN);
  const g = modelOf(GHOST_FAN);
  const hTop = rank.scoreAll(h, fresh(h), { seed: "a" }).slice(0, 10).map((s) => kindOf(s.id));
  const gTop = rank.scoreAll(g, fresh(g), { seed: "a" }).slice(0, 10).map((s) => kindOf(s.id));
  assert.ok(hTop.every((k) => k === "heist"), `heist fan got ${hTop}`);
  assert.ok(gTop.every((k) => k === "ghost"), `ghost fan got ${gTop}`);
});

test("sub-genre, not genre: crime DRAMA about the mob ranks below heists for a heist fan, though both are 'Crime'", () => {
  const m = modelOf(HEIST_FAN);
  const scored = rank.scoreAll(m, fresh(m), {});
  const mean = (kind) => {
    const xs = scored.filter((s) => kindOf(s.id) === kind).map((s) => s.fit);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  assert.ok(mean("heist") > mean("crime") * 1.5, `heist ${mean("heist")} vs mob ${mean("crime")}`);
  assert.ok(mean("crime") > mean("romcom"), "…but a mob drama is still closer than a romcom");
});

test("a negative signal pushes its neighbourhood down", () => {
  const liked = finished(BY_KIND.heist.slice(5, 9));
  const plain = modelOf({ titles: liked });
  const soured = modelOf({ titles: { ...liked, ...Object.fromEntries(BY_KIND.crime.slice(5, 8).map((r) => [r.id, { position: 700, duration: 6000, finished: false, updatedAt: NOW - 20 * DAY }])) } });
  const fitOf = (m, kind) => {
    const xs = rank.scoreAll(m, fresh(m), {}).filter((s) => kindOf(s.id) === kind).map((s) => s.fit);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  assert.ok(fitOf(soured, "crime") < fitOf(plain, "crime") - 0.05, "three abandoned mob dramas: fewer mob dramas");
  assert.ok(fitOf(soured, "crime") < 0, "now a net dislike");
  assert.ok(fitOf(soured, "heist") > 0.1, "what they like is still liked");
});

test("quality prior: at equal fit the better-made title wins, but fit comes first", () => {
  const m = modelOf(HEIST_FAN);
  const scored = rank.scoreAll(m, fresh(m), {});
  const heists = scored.filter((s) => kindOf(s.id) === "heist");
  const top = heists.slice(0, 5).reduce((a, s) => a + s.quality, 0) / 5;
  const bottom = heists.slice(-5).reduce((a, s) => a + s.quality, 0) / 5;
  assert.ok(top > bottom, "within the neighbourhood, quality sorts");
  const bestRomcom = scored.filter((s) => kindOf(s.id) === "romcom").sort((a, b) => b.quality - a.quality)[0];
  const worstHeist = heists[heists.length - 1];
  assert.ok(worstHeist.score > bestRomcom.score, "a mediocre heist still beats an excellent romcom for a heist fan");
});

test("re-rank: the diversity term spreads the row; it never invents a title", () => {
  const m = modelOf({ titles: { ...finished(BY_KIND.heist.slice(5, 9)), ...finished(BY_KIND.space.slice(5, 8), 3) } });
  const scored = rank.scoreAll(m, fresh(m), {});
  const ild = (list) => {
    let s = 0;
    let c = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { s += 1 - features.similarity(list[i].c.v, list[j].c.v); c++; }
    return s / c;
  };
  const plain = rank.rerank(scored, { size: 12, lambdaDiv: 0, lambdaCal: 0 });
  const diverse = rank.rerank(scored, { size: 12, lambdaDiv: 0.5, lambdaCal: 0 });
  assert.equal(plain.length, 12);
  assert.ok(ild(diverse) > ild(plain), `more spread: ${ild(diverse)} vs ${ild(plain)}`);
  const pool = new Set(scored.map((s) => s.id));
  assert.ok(diverse.every((s) => pool.has(s.id)));
  assert.equal(new Set(diverse.map((s) => s.id)).size, diverse.length, "no title twice in a row");
});

test("calibration: the row's genre mix follows the person's (Steck 2018)", () => {
  // three quarters heists, one quarter romcoms — in titles, so in the target
  const m = modelOf({ titles: { ...finished(BY_KIND.heist.slice(5, 14)), ...finished(BY_KIND.romcom.slice(5, 8), 3) } });
  const scored = rank.scoreAll(m, fresh(m), {});
  const mixOf = (list) => rank.genreMix(list);
  const plain = rank.rerank(scored, { size: 12, lambdaDiv: 0, lambdaCal: 0 });
  const calibrated = rank.rerank(scored, { size: 12, lambdaDiv: 0, target: m.genreShare }); // the default λ
  const klPlain = rank.klDivergence(m.genreShare, mixOf(plain));
  const klCal = rank.klDivergence(m.genreShare, mixOf(calibrated));
  assert.ok(klCal <= klPlain, `calibrated ${klCal} vs plain ${klPlain}`);
  const romcoms = calibrated.filter((s) => kindOf(s.id) === "romcom").length;
  assert.ok(romcoms >= 2 && romcoms <= 5, `about a quarter of twelve are romcoms (${romcoms})`);
  assert.ok(calibrated.filter((s) => kindOf(s.id) === "heist").length >= 6, "and most are still heists");
});

test("one per franchise in a row", () => {
  const m = modelOf({ titles: finished(BY_KIND.heist.slice(5, 11)) });
  const row = rank.rerank(rank.scoreAll(m, fresh(m), {}), { size: 20, lambdaCal: 0 });
  const cols = row.map((s) => s.c.rec.col && s.c.rec.col[0]).filter(Boolean);
  assert.equal(new Set(cols).size, cols.length);
});

// ---------- rows ----------
const rowsFor = (state, opts = {}) => rank.buildRows(modelOf(state), CANDS, { seed: "p1|20371", ...opts });
const flat = (built) => built.rows.flatMap((r) => r.items.map((s) => s.id));

test("rows: nothing watched, nothing twice across the whole set, every card says why", () => {
  const state = { titles: { ...finished(BY_KIND.heist.slice(5, 12)), ...finished(BY_KIND.space.slice(5, 9), 3) } };
  const built = rowsFor(state);
  const ids = flat(built);
  assert.ok(built.rows.length >= 3, `several rows (${built.rows.map((r) => r.id)})`);
  assert.equal(new Set(ids).size, ids.length, "no title repeated across rows");
  const watched = new Set(Object.keys(state.titles));
  assert.ok(ids.every((id) => !watched.has(id)), "nothing they have finished");
  for (const r of built.rows) {
    assert.ok(r.title && r.reason, `${r.id}: a title and a reason`);
    for (const s of r.items) assert.ok(typeof s.why === "string" && s.why.length > 8, `${r.id}/${s.id}: why`);
  }
});

test("rows: the kinds the owner asked for exist, and say what they are", () => {
  const state = { titles: { ...finished(BY_KIND.heist.slice(5, 12)), ...finished(BY_KIND.space.slice(5, 9), 3) } };
  // (a 150-title catalogue: short rows, so the neighbourhoods are not used up
  // before the later rows are built — in a real pool the default sizes fit)
  const built = rowsFor(state, { sizes: { recommended: 6, because: 5, theme: 6, person: 6, stretch: 8 } });
  const ids = built.rows.map((r) => r.id);
  assert.equal(ids[0], "recommended");
  const because = built.rows.find((r) => r.id.startsWith("because-"));
  assert.ok(because, "a 'Because you finished …' row");
  assert.match(because.title, /^Because you finished (heist|space) \d+$/);
  assert.equal(because.anchor.imdbId, because.id.slice(8));
  const theme = built.rows.find((r) => r.id.startsWith("theme-"));
  assert.ok(theme, "a 'More <theme>' row");
  assert.match(theme.title, /^More /);
  // every title in a theme row is solidly on that theme
  const slug = theme.id.slice(6);
  assert.ok(theme.items.every((s) => (s.c.v.themes[slug] || 0) >= 1));
  const stretch = built.rows.find((r) => r.id === "stretch");
  assert.ok(stretch, "the exploration row");
  assert.equal(stretch.title, "Something Different");
  // exploration means OUTSIDE the usual: no heists, no space films in it
  assert.ok(stretch.items.every((s) => !["heist", "space"].includes(kindOf(s.id))), `stretch got ${stretch.items.map((s) => kindOf(s.id))}`);
});

test("rows: 'From the director of …' needs a maker they keep returning to", () => {
  // six heists by ONE director (id 501) + the rest of that director's films exist in other neighbourhoods
  const sameDirector = RECS.filter((r) => r.dir[0][0] === 501);
  const liked = sameDirector.slice(0, 4);
  const built = rowsFor({ titles: finished(liked) });
  const row = built.rows.find((r) => r.id === "person-501");
  assert.ok(row, `a maker row (${built.rows.map((r) => r.id)})`);
  assert.match(row.title, /^From the director of /);
  assert.ok(row.items.every((s) => s.c.rec.dir[0][0] === 501));
  // one film by a director is not a relationship
  const single = rowsFor({ titles: finished([BY_KIND.heist[5]]) });
  assert.ok(!single.rows.some((r) => r.id.startsWith("person-")));
});

test("rows: stable within a day, different between profiles and between days", () => {
  const state = { titles: finished(BY_KIND.heist.slice(5, 12)) };
  const a1 = flat(rowsFor(state, { seed: "anna|20371" }));
  const a2 = flat(rowsFor(state, { seed: "anna|20371" }));
  const b = flat(rowsFor(state, { seed: "ben|20371" }));
  const tomorrow = flat(rowsFor(state, { seed: "anna|20372" }));
  assert.deepEqual(a1, a2, "same profile, same day: byte-for-byte the same rows");
  assert.notDeepEqual(a1, b, "two profiles with the same history still differ (the day's draw)");
  assert.notDeepEqual(a1, tomorrow, "and tomorrow is not a rerun");
  // different TASTE differs far more than the draw does
  const recOf = (st) => rowsFor(st, { seed: "anna|20371" }).rows[0].items.map((x) => x.id);
  const heist = recOf(state);
  const ghost = recOf({ titles: finished(BY_KIND.ghost.slice(5, 12)) });
  assert.equal(heist.filter((id) => ghost.includes(id)).length, 0, "a heist fan's and a ghost fan's Recommended share nothing");
});

test("rows: `used` titles (the hero, Continue Watching) are never placed", () => {
  const state = { titles: finished(BY_KIND.heist.slice(5, 12)) };
  const first = flat(rowsFor(state));
  const banned = new Set(first.slice(0, 6));
  const second = flat(rowsFor(state, { used: banned }));
  assert.ok(second.every((id) => !banned.has(id)));
});

test("cold start: no history → the Settings picks + the household + quality; nothing at all → no rows", () => {
  const nothing = rank.buildRows(modelOf({ titles: {} }), CANDS, { seed: "x" });
  assert.equal(nothing.cold, true);
  assert.equal(nothing.rows.length, 0, "nothing to go on: the caller keeps its generic rows");

  const picks = rank.buildRows(modelOf({ titles: {}, likedGenres: ["Horror", "Romance"] }), CANDS, { seed: "x" });
  assert.equal(picks.rows.length, 1);
  assert.equal(picks.rows[0].id, "recommended");
  const kinds = picks.rows[0].items.map((s) => kindOf(s.id));
  assert.ok(kinds.every((k) => k === "ghost" || k === "romcom"), `${kinds}`);
  assert.ok(kinds.includes("ghost") && kinds.includes("romcom"), "both picked genres are in the row");
  assert.ok(picks.rows[0].items.every((s) => /^You like (Horror|Romance|Comedy|Mystery)$/.test(s.why)));

  const household = new Map(BY_KIND.family.slice(0, 6).map((r) => [r.id, 2]));
  const borrowed = rank.buildRows(modelOf({ titles: {} }), CANDS, { seed: "x", household });
  assert.equal(borrowed.rows.length, 1);
  assert.ok(borrowed.rows[0].items.every((s) => household.has(s.id)));
  assert.ok(borrowed.rows[0].items.every((s) => s.why === "Popular in this household"));
});

test("a shared profile keeps both tastes in one row (the taste vector does not average them away)", () => {
  // two people on one profile, their viewing interleaved in time
  const a = BY_KIND.family.slice(5, 11);
  const b = BY_KIND.ghost.slice(5, 11);
  const mixed = [];
  for (let i = 0; i < a.length; i++) mixed.push(a[i], b[i]);
  const built = rowsFor({ titles: finished(mixed, 2) });
  const kinds = built.rows[0].items.map((s) => kindOf(s.id));
  const fam = kinds.filter((k) => k === "family").length;
  const gho = kinds.filter((k) => k === "ghost").length;
  assert.ok(fam >= 4 && gho >= 4, `family ${fam}, ghost ${gho} of ${kinds.length}`);
  assert.ok(fam + gho >= kinds.length - 2, "and little else");
});
