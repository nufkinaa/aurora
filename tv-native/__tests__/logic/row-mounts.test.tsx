// The shelf itself: walking along it mounts one card per press, ahead of the
// viewport, and renders no card that was already there.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const mockSeen = {
  renders: 0,
  mounted: new Set<number>(),
  focus: {} as Record<number, (item: HeroItem, index: number) => void>,
};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  const Card = R.memo((p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void}) => {
    mockSeen.renders++;
    mockSeen.focus[p.index] = p.onFocus;
    R.useEffect(() => {
      mockSeen.mounted.add(p.index);
      return () => {
        mockSeen.mounted.delete(p.index);
      };
    }, [p.index]);
    return null;
  });
  return {__esModule: true, default: Card, CARD_W: 124, CARD_H: 186, FRAME_W: 224, FRAME_H: 140};
});

import Row from '../../src/components/Row';

const ITEMS: HeroItem[] = Array.from({length: 30}, (_, i) => ({id: `c${i}`, title: `t${i}`}) as HeroItem);
const onSelect = () => {};
const range = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => a + i);
const mountedList = () => [...mockSeen.mounted].sort((a, b) => a - b);
const focus = (i: number) => act(() => mockSeen.focus[i](ITEMS[i], i));

beforeEach(() => {
  mockSeen.renders = 0;
  mockSeen.mounted.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('poster shelf: 7 at rest, then one card per press, always two beyond the last one on screen', () => {
  act(() => {
    TestRenderer.create(<Row title="r" items={ITEMS} onSelect={onSelect} />);
  });
  // unfocused: exactly what shows (0 … 6 — the seventh is the 48dp at the right edge)
  expect(mountedList()).toEqual(range(0, 6));
  focus(0);
  expect(mountedList()).toEqual(range(0, 8));
  for (let f = 1; f <= 20; f++) {
    const before = mockSeen.renders;
    const had = new Set(mockSeen.mounted);
    focus(f);
    const lastOnScreen = f === 0 ? 6 : f + 5;
    expect(mountedList()).toEqual(range(Math.max(0, f - 3), lastOnScreen + 2));
    const added = mountedList().filter(i => !had.has(i));
    expect(added.length).toBeLessThanOrEqual(1);
    // the cards already there did not render again
    expect(mockSeen.renders - before).toBe(added.length);
  }
  // and back: the window flips to lead LEFT, one card per press again
  focus(19);
  expect(mountedList()).toEqual(range(19 - 4, 19 + 6));
  for (let f = 18; f >= 0; f--) {
    const had = new Set(mockSeen.mounted);
    focus(f);
    expect(mountedList().filter(i => !had.has(i)).length).toBeLessThanOrEqual(1);
    for (const i of range(Math.max(0, f - 2), f === 0 ? 6 : f + 5)) expect(mockSeen.mounted.has(i)).toBe(true);
  }
  // never, on the way, was a card of the focused viewport missing at the press
  expect((console.log as jest.Mock).mock.calls.filter(c => String(c[0]).startsWith('[row] behind'))).toEqual([]);
});

test('Continue Watching (frame cards): 4 at rest, at most 8 mounted', () => {
  act(() => {
    TestRenderer.create(<Row title="r" items={ITEMS} onSelect={onSelect} wide />);
  });
  expect(mountedList()).toEqual(range(0, 3));
  for (let f = 0; f <= 12; f++) {
    focus(f);
    expect(mockSeen.mounted.size).toBeLessThanOrEqual(8);
    for (const i of range(Math.max(0, f - 2), f === 0 ? 3 : f + 2)) expect(mockSeen.mounted.has(i)).toBe(true);
  }
});
