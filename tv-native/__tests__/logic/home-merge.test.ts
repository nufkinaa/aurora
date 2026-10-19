// The TV's Home merge (src/homeMerge.ts) gives the website's answers
// (public/js/homeMerge.js), case for case: the 30 named cases and the 500
// drawn ones of test/home-merge-cases.json (tools/home-merge-cases.js draws
// them again from the recorded seed). The rules themselves are checked on
// every case here too, so a failure says which rule broke, not only that the
// two ports differ.
import * as m from '../../src/homeMerge';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cases = require('../../../test/home-merge-cases.json');
// The generator, run as the plain Node script it is: through Jest's require
// it would be transformed, and babel's helpers (@babel/runtime) do not
// resolve from the repo root where it lives. It needs only Node built-ins.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
const GEN = path.join(__dirname, '../../../tools/home-merge-cases.js');
const gen = (() => {
  const mod: {exports: Record<string, any>} = {exports: {}};
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(GEN, 'utf8').replace(/^#!.*/, ''))(
    require,
    mod,
    mod.exports,
    path.dirname(GEN),
    GEN,
  );
  return mod.exports;
})();

type Case = {
  name: string;
  mode: m.Mode;
  shown: m.MergeHome | null;
  fresh: m.MergeHome | null;
  look: m.Look;
  recorded?: unknown;
  fingerprint?: string;
};

const all = (): Case[] => [
  ...cases.named.map((c: Case & {expect: unknown}) => ({...c, recorded: c.expect})),
  ...gen.generated(cases.generated, cases.seed).map((c: Case, i: number) => ({...c, fingerprint: cases.fingerprints[i]})),
];
const keys = (items: m.MergeItem[]) => items.map(x => m.itemKey(x));

test('530 cases: the same answers as the website', () => {
  const list = all();
  expect(list.length).toBe(530);
  for (const c of list) {
    const got = gen.expectOf(m, c);
    if (c.recorded) expect([c.name, got]).toEqual([c.name, c.recorded]);
    else expect([c.name, gen.fingerprint(got)]).toEqual([c.name, c.fingerprint]);
  }
});

test('530 cases: nothing on screen moves in "quiet", focus and the slide never move, a second merge is a no-op', () => {
  for (const c of all()) {
    if (!c.shown || !c.fresh) continue;
    const locks = m.locksFor(c.mode, c.look, c.shown.rows);
    const r = m.mergeHome(c.shown, c.fresh, locks);
    const next = r.home!;
    for (let i = 0; i < locks.keepRows; i++) expect([c.name, next.rows[i].id]).toEqual([c.name, c.shown.rows[i].id]);
    if (c.mode === 'quiet') expect([c.name, m.visibleMoves(c.shown, next, c.look)]).toEqual([c.name, 0]);
    const f = c.look.focus;
    if (f) {
      const row = next.rows.find(x => x.id === f.rowId)!;
      expect([c.name, m.itemKey(row.items[f.index])]).toEqual([c.name, f.key]);
    }
    if (c.shown.hero.length) {
      const hi = Math.min(c.look.heroIndex || 0, c.shown.hero.length - 1);
      expect([c.name, m.itemKey(next.hero[r.heroIndex])]).toEqual([c.name, m.itemKey(c.shown.hero[hi])]);
    }
    const again = m.mergeHome(next, c.fresh, m.locksFor(c.mode, c.look, next.rows));
    expect([c.name, again.home === next]).toEqual([c.name, true]);
  }
});

test('Home shape: the unchanged parts are the same objects (React.memo holds)', () => {
  const card = (id: string, v = 1) => ({id, title: id, v});
  const shown = {
    hero: [card('h1')],
    rows: [
      {id: 'continue', title: 'Continue Watching', items: [card('c1'), card('c2')]},
      {id: 'recs', title: 'Recommended', items: [card('a'), card('b'), card('c')]},
    ],
  };
  const fresh = JSON.parse(JSON.stringify(shown));
  fresh.rows[0].items[1].v = 2; // progress moved
  const r = m.mergeHome(shown, fresh, m.locksFor('quiet', {rows: [{id: 'continue', from: 0, to: 2}], heroVisible: true}, shown.rows));
  expect(r.home!.rows[1]).toBe(shown.rows[1]);
  expect(r.home!.rows[0].items[0]).toBe(shown.rows[0].items[0]);
  expect(r.home!.rows[0].items[1]).toEqual(card('c2', 2));
  expect(r.home!.hero).toBe(shown.hero);
  expect(keys(r.home!.rows[0].items)).toEqual(['c1', 'c2']);
  expect(r.pending).toBe(false);
});

// ---- the TV's view of Home, and a launch played through ----------------------
import {lookOf} from '../../src/homeLook';
import {layoutOf, restOffset} from '../../src/homeWindow';

// The Mi TV's canvas: 960×540 dp, the hero 66% of it, poster shelves 247 dp,
// Continue Watching 201 dp (homeWindow.ts EST_*), Row's geometry (Row.tsx shelfGeom).
const W = 960;
const H = 540;
const HERO_H = Math.round(H * 0.66);
const geomOf = (id: string) => ({step: (id === 'continue' ? 224 : 124) + 14, cardW: id === 'continue' ? 224 : 124, contentLeft: 84, viewportW: W, lead: 1});
const heights = (rows: {id: string; items: unknown[]}[]) => rows.map(r => (r.items.length ? (r.id === 'continue' ? 201 : 247) : 0));
const lookAt = (home: m.MergeHome, focusRow: number, lastCard = new Map<string, number>(), focusKey: string | null = null, heroIdx = 0) => {
  const L = layoutOf(HERO_H, heights(home.rows), 24, H, 27);
  const rest = focusRow < 0 ? 0 : restOffset(L.tops[focusRow], L.colH, H, 27);
  return lookOf({rows: home.rows, layout: L, rest, lastCard, focusRow, focusKey, geomOf, heroH: HERO_H, heroCount: home.hero.length, heroIdx});
};
const card = (id: string, v = 1) => ({id, title: id, v});
const shelf = (id: string, ids: string[]) => ({id, title: id, items: ids.map(x => card(x))});
const many = (prefix: string, n: number) => Array.from({length: n}, (_, i) => `${prefix}${i}`);

test('the TV at the top of Home: the billboard and the first shelf are on screen, nothing above', () => {
  const home = {hero: [card('h1'), card('h2')], rows: [shelf('continue', many('c', 6)), shelf('recs', many('r', 20)), shelf('new', many('n', 20))]};
  const look = lookAt(home, -1);
  expect(look.heroVisible).toBe(true);
  expect(look.above).toBe(0);
  expect(look.focus).toBeNull();
  expect(look.rows!.map(r => r.id)).toEqual(['continue']);
  expect(look.rows![0].from).toBe(0);
  expect(look.rows![0].to).toBeGreaterThanOrEqual(3); // three frame cards across 960 dp at least
});

test('the TV deep in Home: the focused shelf at the top, the ones above counted, focus where it was', () => {
  const rows = [shelf('continue', many('c', 6)), ...Array.from({length: 8}, (_, i) => shelf(`s${i}`, many(`s${i}x`, 20)))];
  const home = {hero: [card('h1')], rows};
  const last = new Map([['s3', 9]]);
  const look = lookAt(home, 4, last, 's3x9');
  expect(look.heroVisible).toBe(false);
  // the focused shelf rests 27 dp below the top: the foot of the one above
  // still shows there, so it counts as on screen (straddling the top)
  expect(look.rows!.map(x => x.id).slice(0, 2)).toEqual(['s2', 's3']);
  expect(look.above).toBe(3);
  expect(look.focus).toEqual({rowId: 's3', key: 's3x9', index: 9});
  const r = look.rows!.find(x => x.id === 's3')!;
  expect(r.from).toBeLessThanOrEqual(9);
  expect(r.to).toBeGreaterThan(9);
});

test('a launch, played through: the box’s copy paints, the server re-ranks everything, nothing on screen moves until the viewer is idle or away', () => {
  // the box's copy (yesterday's answer)
  const kept = {
    hero: [card('h1'), card('h2'), card('h3')],
    rows: [shelf('continue', many('c', 5)), shelf('recs', many('r', 20)), shelf('new', many('n', 20)), shelf('genre', many('g', 20))],
  };
  // today's: Continue Watching reordered after a film elsewhere, a new shelf
  // on top, the recommendations re-ranked, one title gone, progress moved,
  // a new billboard draw
  const fresh: m.MergeHome = JSON.parse(JSON.stringify(kept));
  fresh.rows[0].items.reverse();
  fresh.rows[0].items[0].v = 2;
  fresh.rows[1].items.sort(() => 0.5 - Math.random());
  fresh.rows[1].items = fresh.rows[1].items.filter(x => x.id !== 'r2');
  fresh.rows.unshift(shelf('party', ['p1', 'p2']));
  fresh.hero = [card('h9'), card('h2'), card('h8')];

  // 1. the answer lands while the viewer looks at the top of Home
  let shown: m.MergeHome = kept;
  let look = lookAt(shown, -1);
  let r = m.mergeHome(shown, fresh, m.locksFor('quiet', look, shown.rows));
  expect(m.visibleMoves(shown, r.home, look)).toBe(0);
  expect(r.pending).toBe(true);
  expect(r.home!.rows[0].id).toBe('continue');
  // only Continue Watching shows under the billboard: the new party shelf
  // goes straight under it, still below the screen's edge
  expect(r.home!.rows[1].id).toBe('party');
  expect(r.home!.hero.map(x => x.id)).toEqual(['h1', 'h2', 'h3']);
  shown = r.home!;

  // 2. the viewer goes down two shelves (focus on recs, card 4): the view
  //    settles there, "quiet" again — what is on screen still does not move
  const ri = shown.rows.findIndex(x => x.id === 'recs');
  const last = new Map([['recs', 4]]);
  look = lookAt(shown, ri, last, m.itemKey(shown.rows[ri].items[4]));
  const focused = shown.rows[ri].items[4].id;
  r = m.mergeHome(shown, fresh, m.locksFor('quiet', look, shown.rows));
  expect(m.visibleMoves(shown, r.home, look)).toBe(0);
  // the billboard is off screen now: it takes the new list, the slide on show pinned
  expect(r.home!.hero[r.heroIndex].id).toBe('h1');
  shown = r.home!;

  // 3. five seconds without a press: the shelves on screen update in place
  r = m.mergeHome(shown, fresh, m.locksFor('idle', look, shown.rows));
  expect(r.home!.rows[ri].items[4].id).toBe(focused); // the focused card, still
  for (let i = 0; i <= ri; i++) expect(r.home!.rows[i].id).toBe(shown.rows[i].id); // no shelf moved
  shown = r.home!;

  // 4. the viewer opens a title from the billboard (focus up there): Home is
  //    away, and it becomes today's answer — the party shelf on top
  look = lookAt(shown, -1);
  r = m.mergeHome(shown, fresh, m.locksFor('away', look, shown.rows));
  expect(r.home!.rows.map(x => x.id)).toEqual(['party', 'continue', 'recs', 'new', 'genre']);
  expect(r.home!.rows[2].items.some(x => x.id === 'r2')).toBe(false);
  expect(r.home!.rows[1].items[0]).toEqual(card('c4', 2));
  // the slide on show (h1, which today's draw dropped) is still held where it
  // is; once the billboard has turned to the next slide, it goes too
  expect(r.home!.hero[r.heroIndex].id).toBe('h1');
  expect(r.pending).toBe(true);
  shown = r.home!;
  const turned = lookAt(shown, -1, new Map(), null, r.heroIndex + 1);
  r = m.mergeHome(shown, fresh, m.locksFor('away', turned, shown.rows));
  // h1 is gone; the slide now on show stays where it is, the rest are today's
  expect(r.home!.hero.map(x => x.id).sort()).toEqual(['h2', 'h8', 'h9']);
  expect(r.home!.hero[r.heroIndex].id).toBe(shown.hero[turned.heroIndex!].id);
});
