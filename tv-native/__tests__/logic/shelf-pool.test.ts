// The recycling shelf's slot rule (src/shelfPool.ts), walked over the real window
// (src/rowWindow.ts) the way a remote walks a shelf: whatever the press pattern, every
// card of the window has exactly one slot, a card keeps its slot while it stays, the
// focused card never loses its slot, and at most SPARES cards that left stay mounted.
import {assignSlots, outside, SPARES, Slots} from '../../src/shelfPool';
import {heldWindow, rowWindow, restWindow, Dir, MARGINS, RowGeom} from '../../src/rowWindow';

const GEOM: RowGeom = {step: 138, cardW: 124, contentLeft: 84, viewportW: 960, lead: 1};
const key = (i: number) => `t${i}`;
const idx = (k: string) => Number(k.slice(1));

type Shelf = {slots: Slots; win: {from: number; to: number}; keep: {from: number; to: number} | null; f: number; dir: Dir};

function check(prev: Shelf, next: Shelf, n: number) {
  const want = new Set<string>();
  for (let i = next.win.from; i < next.win.to; i++) want.add(key(i));
  const seen = new Map<string, number>();
  next.slots.forEach((k, s) => {
    if (k == null) return;
    expect(seen.has(k)).toBe(false); // one slot per card
    seen.set(k, s);
  });
  for (const k of want) expect(seen.has(k)).toBe(true); // the whole window is mounted
  // a card that was in a slot and is still wanted kept that slot
  prev.slots.forEach((k, s) => {
    if (k != null && want.has(k)) expect(next.slots[s]).toBe(k);
  });
  // the focused card never moved
  const fk = key(next.f);
  const before = prev.slots.indexOf(fk);
  if (before >= 0) expect(next.slots[before]).toBe(fk);
  // spares: cards out of the window, at most SPARES, all still on the shelf
  const spares = [...seen.keys()].filter(k => !want.has(k));
  expect(spares.length).toBeLessThanOrEqual(SPARES + (want.has(fk) || before < 0 ? 0 : 1));
  for (const k of spares) expect(idx(k)).toBeLessThan(n);
  // no trailing empty slot
  if (next.slots.length) expect(next.slots[next.slots.length - 1]).not.toBeNull();
}

function step(s: Shelf, f: number, n: number, held: boolean): Shelf {
  const dir: Dir = f === s.f ? s.dir : f > s.f ? 1 : -1;
  const rest = rowWindow(f, dir, n, GEOM, MARGINS);
  const keep = held ? heldWindow(s.keep || s.win, rest, dir) : null;
  const win = keep ? {from: Math.min(keep.from, rest.from), to: Math.max(keep.to, rest.to)} : rest;
  const want: string[] = [];
  for (let i = win.from; i < win.to; i++) want.push(key(i));
  const slots = assignSlots(s.slots, want, k => outside(idx(k), win.from, win.to), key(s.f));
  return {slots, win, keep, f, dir};
}

const start = (n: number): Shelf => {
  const win = restWindow(n, GEOM);
  const want: string[] = [];
  for (let i = win.from; i < win.to; i++) want.push(key(i));
  return {slots: assignSlots([], want, () => Infinity), win, keep: null, f: 0, dir: 1};
};

test('a fresh shelf: the cards that show, in slots 0…', () => {
  const s = start(24);
  expect(s.slots).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
});

test('a held RIGHT to the end and LEFT back, then single presses: the rules hold at every step', () => {
  const n = 40;
  let s = start(n);
  let made = s.slots.filter(Boolean).length;
  const walk: Array<[number, boolean]> = [];
  for (let f = 1; f < n; f++) walk.push([f, true]);
  walk.push([n - 1, false]); // the remote rests: cut back
  for (let f = n - 2; f >= 0; f--) walk.push([f, true]);
  walk.push([0, false]);
  for (let f = 1; f <= 6; f++) walk.push([f, false]);
  let rebinds = 0;
  for (const [f, held] of walk) {
    const next = step(s, f, n, held);
    check(s, next, n);
    next.slots.forEach((k, i) => {
      if (k == null) return;
      if (i >= s.slots.length || s.slots[i] == null) made++;
      else if (s.slots[i] !== k) rebinds++;
    });
    s = next;
  }
  // past HELD_MAX the held window drops a card and adds one in the same commit: rebinds
  expect(rebinds).toBeGreaterThan(0);
  // and fewer slots were ever created than cards were shown
  expect(made).toBeLessThan(n * 2);
});

test('the spares are the nearest to the window, and they are handed on first', () => {
  // window 10..17 after a cut back from 4..20: 4..9 and 18..19 left
  const prev = Array.from({length: 16}, (_, i) => key(i + 4));
  const want = Array.from({length: 8}, (_, i) => key(i + 10));
  const s1 = assignSlots(prev, want, k => outside(idx(k), 10, 18));
  const kept = s1.filter((k): k is string => k != null && !want.includes(k)).map(idx).sort((a, b) => a - b);
  expect(kept).toEqual([8, 9, 18]);
  // the next window wants 18 (already there, as a spare) and 19, 20: the two other spares
  // are handed to them — no slot is created
  const want2 = Array.from({length: 11}, (_, i) => key(i + 10));
  const s2 = assignSlots(s1, want2, k => outside(idx(k), 10, 21));
  expect(s2.indexOf('t18')).toBe(s1.indexOf('t18'));
  expect(s2.length).toBe(s1.length);
  expect(s2.filter(k => k != null).sort()).toEqual([...want2].sort());
});

test('a re-read that reorders the shelf keeps every card in its slot (Continue Watching)', () => {
  const s1 = assignSlots([], ['a', 'b', 'c', 'd'], () => Infinity);
  const s2 = assignSlots(s1, ['c', 'a', 'b', 'd'], () => Infinity);
  expect(s2).toEqual(s1);
  // one removed: its slot empties (no spare: it is no longer on the shelf)
  const s3 = assignSlots(s2, ['a', 'c', 'd'], k => (k === 'b' ? Infinity : 0));
  expect(s3).toEqual(['a', null, 'c', 'd']);
  // one added fills the hole
  expect(assignSlots(s3, ['e', 'a', 'c', 'd'], () => 0)).toEqual(['a', 'e', 'c', 'd']);
});

test('the focused card keeps its slot even when a late window leaves it out', () => {
  const s1 = assignSlots([], ['t0', 't1', 't2', 't3'], () => Infinity);
  const s2 = assignSlots(s1, ['t4', 't5', 't6', 't7'], k => outside(idx(k), 4, 8), 't1', 0);
  expect(s2[1]).toBe('t1');
  expect(s2.filter(k => k != null && k !== 't1').sort()).toEqual(['t4', 't5', 't6', 't7']);
});
