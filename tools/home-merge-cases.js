#!/usr/bin/env node
// Writes test/home-merge-cases.json: the before/after Home answers that the
// website's merge (public/js/homeMerge.js) and the TV's port
// (tv-native/src/homeMerge.ts) must both answer the same way.
//
//   node tools/home-merge-cases.js          (re)write the file from the website's merge
//
// Hand-named cases first (each one a rule from homeMerge.js), then a few
// hundred drawn from a seeded generator: reordered, dropped and added
// shelves, reshuffled and re-ranked cards, new data on old cards, a new
// billboard, every mode, viewports at the top and deep in the page, with
// and without focus. The expected answer is what the website's merge says;
// test/home-merge.test.js checks the rules on every case independently, so
// a case only enters the file once it passes them, and the TV test then
// holds its port to the same answers.
"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const OUT = path.join(__dirname, "..", "test", "home-merge-cases.json");
const GENERATED = 500;
const SEED = 20261019;

// ---- a tiny seeded PRNG (mulberry32) ----
const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const it = (id, v = 1, extra = {}) => ({ id, title: id.toUpperCase(), v, ...extra });
const row = (id, keys, title = id) => ({ id, title, items: keys.map((k) => (typeof k === "string" ? it(k) : k)) });

// ---- the named cases ----
const named = () => {
  const base = {
    hero: [it("h1"), it("h2"), it("h3")],
    rows: [
      row("continue", ["c1", "c2", "c3", "c4"]),
      row("recs", ["a", "b", "c", "d", "e", "f", "g", "h"]),
      row("new", ["n1", "n2", "n3", "n4", "n5"]),
      row("genre", ["g1", "g2", "g3", "g4", "g5", "g6"]),
    ],
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const atTop = { rows: [{ id: "continue", from: 0, to: 4 }, { id: "recs", from: 0, to: 6 }], above: 0, focus: null, heroVisible: true, heroIndex: 1 };
  const cases = [];
  const add = (name, mode, shown, fresh, look) => cases.push({ name, mode, shown, fresh, look });

  // 1. nothing changed
  add("same answer: nothing moves, nothing pending", "quiet", base, clone(base), atTop);
  // 2. a visible shelf reordered
  {
    const f = clone(base);
    f.rows[1].items.reverse();
    add("visible shelf reordered: visible cards hold, the tail follows", "quiet", base, f, atTop);
    add("visible shelf reordered, idle: slots take the new order", "idle", base, f, atTop);
    add("visible shelf reordered, away: the new order", "away", base, f, atTop);
  }
  // 3. Continue Watching progress changes in place
  {
    const f = clone(base);
    f.rows[0].items[1].v = 3; // e.g. Continue Watching progress moved
    f.rows[0].items[2].v = 2;
    add("progress and data change in place on a visible shelf", "quiet", base, f, atTop);
  }
  // 4. a new shelf inserted at the top
  {
    const f = clone(base);
    f.rows.unshift(row("party", ["p1", "p2"]));
    add("a new shelf at the top goes below the viewport", "quiet", base, f, atTop);
    add("a new shelf at the top, away from the top of the page: it takes its place", "away", base, f, { rows: [], above: 0, focus: null, heroVisible: true, heroIndex: 0 });
  }
  // 5. a visible shelf removed
  {
    const f = clone(base);
    f.rows.splice(1, 1);
    add("a visible shelf the answer dropped is held", "quiet", base, f, atTop);
    add("...and held at idle too (still on screen)", "idle", base, f, atTop);
    add("...and goes once Home is away and it is not above the viewport", "away", base, f, { rows: [], above: 0, focus: null, heroVisible: false, heroIndex: 0 });
  }
  // 6. focused card gone from the answer
  {
    const f = clone(base);
    f.rows[1].items = f.rows[1].items.filter((x) => x.id !== "c");
    const look = { ...atTop, focus: { rowId: "recs", key: "c", index: 2 }, heroVisible: false };
    add("the focused card is held where it is, quiet", "quiet", base, f, look);
    add("the focused card is held where it is, idle", "idle", base, f, look);
    add("the focused card is held where it is, away", "away", base, f, look);
  }
  // 7. focused card moved by the server
  {
    const f = clone(base);
    const recs = f.rows[1].items;
    const [c] = recs.splice(2, 1);
    recs.unshift(c);
    const look = { rows: [{ id: "recs", from: 0, to: 6 }], above: 1, focus: { rowId: "recs", key: "c", index: 2 }, heroVisible: false, heroIndex: 0 };
    add("the focused card the server moved stays at its index (idle)", "idle", base, f, look);
    add("the focused card the server moved stays at its index (away)", "away", base, f, look);
  }
  // 8. billboard
  {
    const f = clone(base);
    f.hero = [it("h9"), it("h2", 2), it("h8"), it("h7")];
    add("billboard on screen keeps its list; the pick on show takes new data", "quiet", base, f, atTop);
    add("billboard off screen takes the new list, current pick pinned", "quiet", base, f, { ...atTop, heroVisible: false });
    add("billboard, away: the new list with the pick pinned", "away", base, f, atTop);
    const g = clone(base);
    g.hero = [it("h7")];
    add("billboard: the pick on show is gone and the list shrank (away)", "away", base, g, { ...atTop, heroIndex: 2 });
  }
  // 9. deep in the page
  {
    const f = clone(base);
    f.rows.reverse();
    const deep = { rows: [{ id: "new", from: 0, to: 5 }, { id: "genre", from: 2, to: 6 }], above: 2, focus: { rowId: "genre", key: "g4", index: 3 }, heroVisible: false, heroIndex: 0 };
    add("all shelves reversed, viewer deep in the page: nothing above or on screen moves", "quiet", base, f, deep);
    add("all shelves reversed, deep, away: shelves above and the focused one stay", "away", base, f, deep);
  }
  // 10. a visible shelf that the answer shortened below what is on screen
  {
    const f = clone(base);
    f.rows[1].items = [it("b"), it("z")];
    add("a visible shelf shortened, idle: held cards keep it as long as what shows", "idle", base, f, atTop);
  }
  // 11. an empty shelf that fills
  {
    const s = clone(base);
    s.rows.splice(1, 0, row("empty", []));
    const f = clone(s);
    f.rows[1].items = [it("e1"), it("e2")];
    add("an empty shelf inside the viewport stays empty (it would grow)", "quiet", s, f, { ...atTop, rows: [...atTop.rows] });
    add("an empty shelf below the viewport fills", "quiet", s, f, { rows: [{ id: "continue", from: 0, to: 4 }], above: 0, focus: null, heroVisible: true, heroIndex: 0 });
  }
  // 12. a renamed visible shelf
  {
    const f = clone(base);
    f.rows[1].title = "Because you watched X";
    add("a visible shelf keeps its heading until idle", "quiet", base, f, atTop);
    add("a visible shelf takes its new heading at idle", "idle", base, f, atTop);
  }
  // 13. first paint (nothing shown) and no answer
  add("nothing shown: the answer as it is", "quiet", null, clone(base), atTop);
  add("no answer: what is shown stays", "quiet", base, null, atTop);
  // 14. duplicate titles inside a fresh shelf
  {
    const f = clone(base);
    f.rows[2].items.push(it("n1"));
    add("a title twice in a new shelf is drawn once", "quiet", base, f, atTop);
  }
  // 15. scrolled sideways: cards to the left of the viewport also hold (they set the offset)
  {
    const f = clone(base);
    f.rows[1].items = [it("x"), ...f.rows[1].items.slice(1)];
    add("a card scrolled off to the left of a visible shelf holds (quiet)", "quiet", base, f, { rows: [{ id: "recs", from: 3, to: 7 }], above: 1, focus: null, heroVisible: false, heroIndex: 0 });
  }
  return cases;
};

// ---- the generated cases ----
const generated = (count, seed) => {
  const r = rng(seed);
  const pick = (n) => Math.floor(r() * n);
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = pick(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const universe = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const draw = (n) => shuffle(universe.slice()).slice(0, n);
  const cases = [];
  for (let c = 0; c < count; c++) {
    const nRows = 2 + pick(8);
    const rowIds = shuffle(["continue", ...Array.from({ length: 16 }, (_, i) => `r${i}`)]).slice(0, nRows);
    const shown = {
      hero: draw(1 + pick(8)).map((k) => it(k, 1 + pick(2))),
      rows: rowIds.map((id) => row(id, draw(pick(10) === 0 ? 0 : 1 + pick(14)).map((k) => it(k, 1 + pick(2))))),
    };
    const fresh = JSON.parse(JSON.stringify(shown));
    // shelves: reorder / drop / add / rename
    if (r() < 0.4) shuffle(fresh.rows);
    if (r() < 0.3) fresh.rows.splice(pick(fresh.rows.length), 1 + pick(2));
    if (r() < 0.35) fresh.rows.splice(pick(fresh.rows.length + 1), 0, row(`x${c}`, draw(1 + pick(12))));
    for (const fr of fresh.rows) {
      if (r() < 0.15) fr.title = fr.title + "*";
      if (r() < 0.35) shuffle(fr.items);
      if (r() < 0.3 && fr.items.length) fr.items.splice(pick(fr.items.length), 1 + pick(3));
      if (r() < 0.3) fr.items.splice(pick(fr.items.length + 1), 0, ...draw(1 + pick(3)).filter((k) => !fr.items.some((x) => x.id === k)).map((k) => it(k)));
      for (const x of fr.items) if (r() < 0.12) x.v += 1;
      if (r() < 0.05) fr.items = [];
    }
    if (r() < 0.4) fresh.hero = draw(1 + pick(8)).map((k) => it(k));
    else for (const h of fresh.hero) if (r() < 0.2) h.v += 1;
    // the viewport
    const above = pick(Math.max(1, shown.rows.length));
    const visible = [];
    for (let i = above; i < Math.min(shown.rows.length, above + 1 + pick(3)); i++) {
      const n = shown.rows[i].items.length;
      if (!n) continue;
      const from = pick(Math.max(1, Math.min(4, n)));
      visible.push({ id: shown.rows[i].id, from, to: Math.min(n, from + 3 + pick(5)) });
    }
    let focus = null;
    if (visible.length && r() < 0.6) {
      const v = visible[pick(visible.length)];
      const index = v.from + pick(Math.max(1, v.to - v.from));
      const row0 = shown.rows.find((x) => x.id === v.id);
      if (row0.items[index]) focus = { rowId: v.id, key: row0.items[index].id, index };
    }
    const look = { rows: visible, above, focus, heroVisible: above === 0 && !focus, heroIndex: pick(shown.hero.length) };
    const mode = ["quiet", "idle", "away"][pick(3)];
    cases.push({ name: `generated ${c}`, mode, shown, fresh, look });
  }
  return cases;
};

// The compact expected answer: "key@v" per card, so an in-place update shows.
const tag = (x) => `${x.id || x.imdbId || x.title}@${x.v}`;
const compact = (res) => ({
  hero: (res.home && res.home.hero ? res.home.hero : []).map(tag),
  rows: (res.home && res.home.rows ? res.home.rows : []).map((r) => [r.id, r.title, r.items.map(tag)]),
  pending: res.pending,
  heroIndex: res.heroIndex,
});

// Every case, inputs and all: the named ones, then GENERATED drawn from SEED.
// (The JSON stores the named ones whole and only a fingerprint of each
// generated answer — the inputs are drawn again, from the same seed, by both
// tests.)
const allCases = () => [...named(), ...generated(GENERATED, SEED)];

// What a merge answered, as the cases record it.
const expectOf = (m, c) => {
  const locks = m.locksFor(c.mode, c.look, (c.shown && c.shown.rows) || []);
  const res = m.mergeHome(c.shown, c.fresh, locks);
  return { ...compact(res), moved: m.visibleMoves(c.shown, res.home, c.look) };
};
const fingerprint = (expect) => require("crypto").createHash("sha1").update(JSON.stringify(expect)).digest("hex").slice(0, 16);

const main = async () => {
  const m = await import(pathToFileURL(path.join(__dirname, "..", "public", "js", "homeMerge.js")).href);
  const cases = allCases();
  const out = { about: "Written by tools/home-merge-cases.js from public/js/homeMerge.js; tv-native/src/homeMerge.ts must give the same answers.", seed: SEED, generated: GENERATED, named: [], fingerprints: [] };
  for (const c of cases) {
    const expect = expectOf(m, c);
    if (c.name.startsWith("generated ")) out.fingerprints.push(fingerprint(expect));
    else out.named.push({ ...c, expect });
  }
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(`${cases.length} cases -> ${path.relative(process.cwd(), OUT)}`);
};

module.exports = { named, generated, allCases, compact, expectOf, fingerprint, rng, GENERATED, SEED };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
