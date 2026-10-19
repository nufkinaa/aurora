// Fresh Home data merged in without moving what the viewer is looking at
// (public/js/homeMerge.js — the rule is written out there; the TV runs a port,
// tv-native/src/homeMerge.ts, held to the same answers by
// tv-native/__tests__/logic/home-merge.test.ts).
//
// Three layers:
//   1. each rule, by hand, on a small Home;
//   2. every rule checked independently on 530 before/after answers (30 named
//      in test/home-merge-cases.json, 500 drawn from a seeded generator —
//      tools/home-merge-cases.js): shelves reordered, dropped, added, renamed,
//      cards reshuffled, re-ranked, removed, updated in place, a new
//      billboard; every mode; viewports at the top and deep in the page;
//      with and without focus;
//   3. the answers themselves, recorded, so the TV's port can be held to them.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const cases = require("./home-merge-cases.json");
const gen = require("../tools/home-merge-cases.js");

const load = () => import("../public/js/homeMerge.js");

const it = (id, v = 1, extra = {}) => ({ id, title: id.toUpperCase(), v, ...extra });
const row = (id, keys, title = id) => ({ id, title, items: keys.map((k) => (typeof k === "string" ? it(k) : k)) });
const keys = (items) => items.map((x) => x.id);
const clone = (x) => JSON.parse(JSON.stringify(x));
const home = () => ({
  hero: [it("h1"), it("h2"), it("h3")],
  rows: [
    row("continue", ["c1", "c2", "c3", "c4"]),
    row("recs", ["a", "b", "c", "d", "e", "f", "g", "h"]),
    row("new", ["n1", "n2", "n3", "n4", "n5"]),
    row("genre", ["g1", "g2", "g3", "g4", "g5", "g6"]),
  ],
});
// The top of Home: the billboard, Continue Watching whole, six cards of the next shelf.
const atTop = { rows: [{ id: "continue", from: 0, to: 4 }, { id: "recs", from: 0, to: 6 }], above: 0, focus: null, heroVisible: true, heroIndex: 1 };
const merge = async (mode, shown, fresh, look) => {
  const m = await load();
  return m.mergeHome(shown, fresh, m.locksFor(mode, look, (shown && shown.rows) || []));
};

// ---------- 1. the rules, by hand ----------

test("the same answer again changes nothing — the very same object comes back", async () => {
  const shown = home();
  const r = await merge("quiet", shown, clone(shown), atTop);
  assert.equal(r.home, shown);
  assert.equal(r.pending, false);
});

test("a shelf on screen that the server reordered: its visible cards hold, the part past the edge follows", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[1].items.reverse(); // h g f e d c b a
  const r = await merge("quiet", shown, fresh, atTop);
  assert.deepEqual(keys(r.home.rows[1].items), ["a", "b", "c", "d", "e", "f", "h", "g"]);
  assert.equal(r.pending, true, "the rest waits for a natural moment");
  // the untouched shelves are the same objects
  assert.equal(r.home.rows[0], shown.rows[0]);
  assert.equal(r.home.rows[2], shown.rows[2]);
  // idle: the slots take the new order, in place; nothing is pending any more
  const idle = await merge("idle", r.home, fresh, atTop);
  assert.deepEqual(keys(idle.home.rows[1].items), ["h", "g", "f", "e", "d", "c", "b", "a"]);
  assert.equal(idle.pending, false);
});

test("Continue Watching's progress and a NEW tag change in place — same slot, new data", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[0].items[1].progress = { position: 900, duration: 1800 };
  fresh.rows[1].items[0].badge = { text: "NEW", tone: "new" };
  const r = await merge("quiet", shown, fresh, atTop);
  assert.deepEqual(keys(r.home.rows[0].items), ["c1", "c2", "c3", "c4"]);
  assert.deepEqual(r.home.rows[0].items[1].progress, { position: 900, duration: 1800 });
  assert.deepEqual(r.home.rows[1].items[0].badge, { text: "NEW", tone: "new" });
  assert.equal(r.home.rows[0].items[0], shown.rows[0].items[0], "an unchanged card keeps its object");
  assert.equal(r.pending, false);
});

test("a new shelf the server put at the top lands below the viewport — and takes the top once Home is away", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows.unshift(row("party", ["p1", "p2"]));
  const r = await merge("quiet", shown, fresh, atTop);
  assert.deepEqual(r.home.rows.map((x) => x.id), ["continue", "recs", "party", "new", "genre"]);
  assert.equal(r.pending, true);
  // away, focus up on the billboard, nothing above the viewport: the new order
  const away = await merge("away", r.home, fresh, { rows: atTop.rows, above: 0, focus: null, heroVisible: true, heroIndex: 1 });
  assert.deepEqual(away.home.rows.map((x) => x.id), ["party", "continue", "recs", "new", "genre"]);
  assert.equal(away.pending, false);
});

test("a shelf on screen that the answer dropped is held while it is on screen, and goes when it is not", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows.splice(1, 1); // "recs" gone
  for (const mode of ["quiet", "idle"]) {
    const r = await merge(mode, shown, fresh, atTop);
    assert.deepEqual(r.home.rows.map((x) => x.id), ["continue", "recs", "new", "genre"], mode);
    assert.equal(r.pending, true);
  }
  // scrolled on: "recs" is above the viewport now — still holds its place (it would shove the page)
  const below = { rows: [{ id: "new", from: 0, to: 5 }], above: 2, focus: null, heroVisible: false, heroIndex: 0 };
  assert.deepEqual((await merge("quiet", shown, fresh, below)).home.rows.map((x) => x.id), ["continue", "recs", "new", "genre"]);
  // back at the top with only Continue Watching on screen: it goes
  const top = { rows: [{ id: "continue", from: 0, to: 4 }], above: 0, focus: null, heroVisible: true, heroIndex: 0 };
  assert.deepEqual((await merge("quiet", shown, fresh, top)).home.rows.map((x) => x.id), ["continue", "new", "genre"]);
});

test("the focused card keeps its place and its title, in every mode — held when the answer dropped it", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[1].items = fresh.rows[1].items.filter((x) => x.id !== "c").reverse();
  const look = { ...atTop, focus: { rowId: "recs", key: "c", index: 2 }, heroVisible: false };
  for (const mode of ["quiet", "idle", "away"]) {
    const r = await merge(mode, shown, fresh, look);
    assert.equal(r.home.rows[1].items[2].id, "c", mode);
    assert.equal(r.pending, true, mode);
  }
  // the server MOVED it (first place now): it stays at index 2 all the same
  const moved = clone(shown);
  const recs = moved.rows[1].items;
  recs.unshift(recs.splice(2, 1)[0]);
  for (const mode of ["idle", "away"]) {
    const r = await merge(mode, shown, moved, look);
    assert.equal(r.home.rows[1].items[2].id, "c", mode);
  }
});

test("the billboard keeps the slide on show: its list holds while it is on screen, then follows with the pick pinned", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.hero = [it("h9"), it("h2", 2), it("h8"), it("h7")];
  const on = await merge("quiet", shown, fresh, atTop);
  assert.deepEqual(keys(on.home.hero), ["h1", "h2", "h3"]);
  assert.equal(on.home.hero[1].v, 2, "the pick on show takes its new data in place");
  assert.equal(on.heroIndex, 1);
  const off = await merge("quiet", shown, fresh, { ...atTop, heroVisible: false });
  assert.deepEqual(keys(off.home.hero), ["h9", "h2", "h8", "h7"]);
  assert.equal(off.heroIndex, 1);
  // the pick on show is gone from a shorter list: it is held, and the index says where
  const gone = clone(shown);
  gone.hero = [it("h7")];
  const r = await merge("away", shown, gone, { ...atTop, heroIndex: 2 });
  assert.equal(r.home.hero[r.heroIndex].id, "h3");
});

test("deep in the page, everything reversed: nothing above or on screen moves", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows.reverse();
  for (const r of fresh.rows) r.items.reverse();
  const deep = { rows: [{ id: "new", from: 0, to: 5 }, { id: "genre", from: 2, to: 6 }], above: 2, focus: { rowId: "genre", key: "g4", index: 3 }, heroVisible: false, heroIndex: 0 };
  const m = await load();
  const r = await merge("quiet", shown, fresh, deep);
  assert.deepEqual(r.home.rows.map((x) => x.id), ["continue", "recs", "new", "genre"]);
  assert.equal(m.visibleMoves(shown, r.home, deep), 0);
  // shelves above the viewport take their new cards (nobody sees them)
  assert.deepEqual(keys(r.home.rows[0].items), ["c4", "c3", "c2", "c1"]);
});

test("idle never makes a shelf on screen shorter than what shows: held cards fill it until it is off screen", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[1].items = [it("b"), it("z")];
  const r = await merge("idle", shown, fresh, atTop);
  assert.deepEqual(keys(r.home.rows[1].items), ["b", "z", "a", "c", "d", "e"]);
  assert.equal(r.pending, true);
  const later = await merge("quiet", r.home, fresh, { rows: [{ id: "continue", from: 0, to: 4 }], above: 0, heroVisible: true, heroIndex: 0 });
  assert.deepEqual(keys(later.home.rows[1].items), ["b", "z"]);
});

test("an empty shelf inside the viewport stays empty — it would grow under the viewer", async () => {
  const shown = home();
  shown.rows.splice(1, 0, row("empty", []));
  const fresh = clone(shown);
  fresh.rows[1].items = [it("e1")];
  const r = await merge("quiet", shown, fresh, atTop);
  assert.equal(r.home.rows[1].items.length, 0);
  assert.equal(r.pending, true);
});

test("a shelf on screen keeps its heading until the viewer is idle", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[1].title = "Because you watched X";
  assert.equal((await merge("quiet", shown, fresh, atTop)).home.rows[1].title, "recs");
  assert.equal((await merge("idle", shown, fresh, atTop)).home.rows[1].title, "Because you watched X");
});

test("cards scrolled off to the LEFT of a visible shelf hold too: they set where the shelf is scrolled", async () => {
  const shown = home();
  const fresh = clone(shown);
  fresh.rows[1].items[0] = it("x");
  const look = { rows: [{ id: "recs", from: 3, to: 7 }], above: 1, focus: null, heroVisible: false, heroIndex: 0 };
  const r = await merge("quiet", shown, fresh, look);
  assert.deepEqual(keys(r.home.rows[1].items).slice(0, 7), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("first paint and no answer", async () => {
  const shown = home();
  assert.equal((await merge("quiet", null, shown, atTop)).home, shown);
  assert.equal((await merge("quiet", shown, null, atTop)).home, shown);
});

// ---------- 2. every rule, on every case ----------

const allCases = () => {
  const named = cases.named.map((c) => ({ ...c, recorded: c.expect }));
  const drawn = gen.generated(cases.generated, cases.seed).map((c, i) => ({ ...c, fingerprint: cases.fingerprints[i] }));
  return [...named, ...drawn];
};

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((x) => {
    const k = x.id || x.imdbId || x.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

test("530 before/after answers: every rule holds on every one", async () => {
  const m = await load();
  const all = allCases();
  assert.equal(all.length, 530);
  let checked = 0;
  for (const c of all) {
    const at = `${c.name} (${c.mode})`;
    if (!c.shown || !c.fresh) continue;
    const locks = m.locksFor(c.mode, c.look, c.shown.rows);
    const r = m.mergeHome(c.shown, c.fresh, locks);
    const next = r.home;
    const sRows = c.shown.rows;
    const nIndex = new Map(next.rows.map((x, i) => [x.id, i]));
    // no shelf twice, no card twice in a shelf
    assert.equal(nIndex.size, next.rows.length, `${at}: a shelf twice`);
    for (const x of next.rows) assert.equal(new Set(keys(x.items)).size, x.items.length, `${at}: a card twice in ${x.id}`);
    // rule 1: the shelves that hold the layout keep their places
    for (let i = 0; i < locks.keepRows; i++) assert.equal(next.rows[i].id, sRows[i].id, `${at}: shelf ${i} moved`);
    // rule 2 (quiet): visible cards hold, up to the last visible one; headings too
    if (c.mode === "quiet") {
      for (const v of c.look.rows) {
        const s = sRows.find((x) => x.id === v.id);
        const n = next.rows[nIndex.get(v.id)];
        assert.deepEqual(keys(n.items).slice(0, v.to), keys(s.items).slice(0, v.to), `${at}: visible cards of ${v.id} moved`);
        assert.equal(n.title, s.title, `${at}: heading of ${v.id}`);
      }
      assert.equal(m.visibleMoves(c.shown, next, c.look), 0, `${at}: something on screen moved`);
    }
    // idle: no visible shelf shorter than what shows
    if (c.mode === "idle") {
      for (const v of c.look.rows) {
        const s = sRows.find((x) => x.id === v.id);
        const n = next.rows[nIndex.get(v.id)];
        assert.ok(n.items.length >= Math.min(v.to, s.items.length), `${at}: ${v.id} got shorter than what shows`);
      }
    }
    // rule 3: the focused card
    if (c.look.focus) {
      const f = c.look.focus;
      const n = next.rows[nIndex.get(f.rowId)];
      assert.ok(n, `${at}: the focused shelf is gone`);
      assert.equal(n.items[f.index] && n.items[f.index].id, f.key, `${at}: the focused card moved`);
    }
    // rule 4: the billboard
    const hi = Math.min(c.look.heroIndex || 0, Math.max(0, c.shown.hero.length - 1));
    if (c.shown.hero.length) {
      assert.equal(next.hero[r.heroIndex].id, c.shown.hero[hi].id, `${at}: the slide on show changed`);
      if (locks.hero.hold) assert.deepEqual(keys(next.hero), keys(c.shown.hero), `${at}: the billboard's list changed on screen`);
    }
    // every card is either the answer's or one held from what was shown, in the same shelf
    for (const n of next.rows) {
      const f = c.fresh.rows.find((x) => x.id === n.id);
      const s = sRows.find((x) => x.id === n.id);
      const allowed = new Set([...(f ? keys(f.items) : []), ...(s ? keys(s.items) : [])]);
      for (const k of keys(n.items)) assert.ok(allowed.has(k), `${at}: ${k} in ${n.id} came from nowhere`);
      assert.ok(f || s, `${at}: shelf ${n.id} came from nowhere`);
    }
    // a card that did not change keeps its object (memoised cards do not redraw)
    for (const n of next.rows) {
      const s = sRows.find((x) => x.id === n.id);
      if (!s) continue;
      for (const x of n.items) {
        const old = s.items.find((y) => y.id === x.id);
        if (old && m.sameItem(old, x)) assert.equal(x, old, `${at}: ${x.id} in ${n.id} is a new object for the same data`);
      }
    }
    // stable: asked again with the same view, nothing changes (no flicker between two answers)
    const again = m.mergeHome(next, c.fresh, m.locksFor(c.mode, c.look, next.rows));
    assert.equal(again.home, next, `${at}: a second merge changed it again`);
    // it converges: away, with nothing on screen and nothing focused, it IS the answer
    const done = m.mergeHome(next, c.fresh, m.locksFor("away", { rows: [], above: 0, focus: null, heroVisible: false, heroIndex: r.heroIndex }, next.rows));
    const want = { ...c.fresh, rows: c.fresh.rows.map((x) => ({ ...x, items: dedupe(x.items) })) };
    // (the pick on show is pinned even then — held if the answer has dropped it)
    const pickGone = c.shown.hero.length && !c.fresh.hero.some((h) => h.id === next.hero[r.heroIndex].id);
    if (!pickGone) {
      assert.deepEqual(done.home.rows.map((x) => [x.id, keys(x.items)]), want.rows.map((x) => [x.id, keys(x.items)]), `${at}: never converges`);
    }
    checked++;
  }
  assert.ok(checked >= 525, `${checked} cases checked`);
});

// ---------- 3. the recorded answers (what the TV's port must give) ----------

test("the recorded answers are still what the merge gives (regenerate: node tools/home-merge-cases.js)", async () => {
  const m = await load();
  for (const c of allCases()) {
    const got = gen.expectOf(m, c);
    if (c.recorded) assert.deepEqual(got, c.recorded, c.name);
    else assert.equal(gen.fingerprint(got), c.fingerprint, `${c.name}: ${JSON.stringify(got).slice(0, 400)}`);
  }
});

test("the TV's port is the same algorithm, line for line in its rules", async () => {
  // A guard against the two drifting apart silently: every exported name of
  // the website's merge exists in the port (the TV test runs the cases).
  const fs = require("fs");
  const web = fs.readFileSync(path.join(__dirname, "..", "public", "js", "homeMerge.js"), "utf8");
  const tv = fs.readFileSync(path.join(__dirname, "..", "tv-native", "src", "homeMerge.ts"), "utf8");
  const names = [...web.matchAll(/^export const (\w+)/gm)].map((x) => x[1]);
  assert.ok(names.length >= 6, names.join(","));
  for (const n of names) assert.match(tv, new RegExp(`export (const|function) ${n}\\b`), `${n} missing from the TV's port`);
});
