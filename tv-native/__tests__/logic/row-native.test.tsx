// A shelf with the render switches `row` + `card` + `pool` on (render.ts; off in every other
// test): the track is the native AuroraRow with the shelf's geometry, JS does not start the
// slide, the window of cards is exactly the keyed shelf's, and a card that leaves the
// window hands its views to one that comes in instead of being unmounted.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../src/render', () => ({
  nativeOn: {focusable: false, card: true, row: true, hero: false, rail: false},
  fixOn: {cardlayer: false, cull: false, shadowcache: false, unstuff: false, unstuffq: false, pool: true},
}));

// What each mounted card instance shows, by instance (a pooled card is one instance
// showing several titles over its life).
const mockSeen = {
  mounts: 0,
  unmounts: 0,
  showing: new Map<number, number>(), // instance id -> index shown
  focus: {} as Record<number, (item: HeroItem, index: number) => void>,
};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  let next = 1;
  const Card = R.memo((p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void}) => {
    const id = R.useRef(0);
    if (!id.current) id.current = next++;
    mockSeen.focus[p.index] = p.onFocus;
    mockSeen.showing.set(id.current, p.index);
    R.useEffect(() => {
      mockSeen.mounts++;
      const me = id.current;
      return () => {
        mockSeen.unmounts++;
        mockSeen.showing.delete(me);
      };
    }, []);
    return null;
  });
  return {__esModule: true, default: Card, CARD_W: 124, CARD_H: 186, FRAME_W: 224, FRAME_H: 140};
});

import {Animated} from 'react-native';
import Row from '../../src/components/Row';

const ITEMS: HeroItem[] = Array.from({length: 40}, (_, i) => ({id: `c${i}`, title: `t${i}`}) as HeroItem);
const onSelect = () => {};
const range = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => a + i);
const shown = () => [...new Set(mockSeen.showing.values())].sort((a, b) => a - b);
const rest = () => act(() => void jest.advanceTimersByTime(1000));
const press = (i: number) => act(() => mockSeen.focus[i](ITEMS[i], i));

beforeEach(() => {
  jest.useFakeTimers();
  mockSeen.mounts = 0;
  mockSeen.unmounts = 0;
  mockSeen.showing.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('the native track carries the geometry; JS starts no slide', () => {
  const spring = jest.spyOn(Animated, 'spring');
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="r" items={ITEMS} onSelect={onSelect} />);
  });
  const track = r.root.findAll(n => (n.type as unknown) === 'AuroraNative');
  expect(track.length).toBe(1);
  expect(track[0].props).toEqual(expect.objectContaining({step: 138, lead: 1, contentLeft: expect.any(Number), count: 40, initialIndex: 0}));
  expect(track[0].props.style).not.toEqual(expect.arrayContaining([expect.objectContaining({transform: expect.anything()})]));
  press(0);
  press(1);
  press(2);
  rest();
  expect(spring).not.toHaveBeenCalled();
});

test('the same cards are on show as on the keyed shelf; cards that left are handed on, not unmounted', () => {
  act(() => {
    TestRenderer.create(<Row title="r" items={ITEMS} onSelect={onSelect} />);
  });
  expect(shown()).toEqual(range(0, 6));
  // held RIGHT to the end
  for (let f = 0; f < 40; f++) {
    press(f);
    // the window is the keyed shelf's (row-mounts.test.tsx): it only grows while held …
    for (const i of range(Math.max(0, f - 2), Math.min(39, f + 5))) expect(shown()).toContain(i);
  }
  rest();
  // … and rests on the focused viewport (+ margins), plus at most SPARES (3) spares
  const at = shown();
  for (const i of range(36, 39)) expect(at).toContain(i);
  expect(at.length).toBeLessThanOrEqual(13 + 3);
  // held LEFT back to the start, then rest
  for (let f = 38; f >= 0; f--) press(f);
  rest();
  for (const i of range(0, 6)) expect(shown()).toContain(i);
  // 80 presses over a 40-card shelf: a keyed shelf mounts every card it shows at least
  // once per pass (40 + 33 after the cut-backs); the pool hands cards on instead
  // (measured on this walk: keyed 76 mounts / 68 unmounts, pooled 53 / 42)
  expect(mockSeen.mounts).toBeLessThan(60);
  // never two instances on one title
  const vals = [...mockSeen.showing.values()];
  expect(new Set(vals).size).toBe(vals.length);
});

test('Continue Watching re-read in another order: every mounted card keeps its title', () => {
  let r!: TestRenderer.ReactTestRenderer;
  const items = ITEMS.slice(0, 6);
  act(() => {
    r = TestRenderer.create(<Row title="r" items={items} onSelect={onSelect} wide />);
  });
  const before = new Map(mockSeen.showing);
  const mounts = mockSeen.mounts;
  const reordered = [items[3], items[0], items[1], items[2], items[4], items[5]];
  act(() => {
    r.update(<Row title="r" items={reordered} onSelect={onSelect} wide />);
  });
  expect(mockSeen.mounts).toBe(mounts);
  for (const [inst, idx] of before) {
    // same instance, same title (at its new place)
    expect(reordered[mockSeen.showing.get(inst)!].id).toBe(items[idx].id);
  }
});

// tv-next's held-key lead (rowWindow.ts runMargins) is the window's rule, not
// the track's: it holds with the native track and the pool exactly as on the
// keyed shelf (row-mounts.test.tsx has the same walk with the switches off).
test('a held key leads further with the native track too — RIGHT and LEFT — and rests on the plain margins', () => {
  act(() => {
    TestRenderer.create(<Row title="r" items={ITEMS} onSelect={onSelect} />);
  });
  press(0);
  rest();
  // held RIGHT to card 12: two more ahead than at rest (12 + 5 on screen + 2 + HELD_EXTRA 2)
  for (let f = 1; f <= 12; f++) press(f);
  for (const i of range(0, 12 + 5 + 2 + 2)) expect(shown()).toContain(i);
  rest();
  for (const i of range(12 - 3, 12 + 5 + 2)) expect(shown()).toContain(i);
  // out to 14 at rest, then held LEFT to the start: the left-edge card is always there
  press(13);
  rest();
  press(14);
  rest();
  for (let f = 13; f >= 0; f--) {
    press(f);
    for (const i of range(Math.max(0, f - 2), f === 0 ? 6 : f + 5)) expect(shown()).toContain(i);
  }
  expect((console.log as jest.Mock).mock.calls.filter(c => String(c[0]).startsWith('[row] behind'))).toEqual([]);
  rest();
  for (const i of range(0, 6)) expect(shown()).toContain(i);
});
