// A shelf that is mounted AGAIN (Home's vertical window had replaced it with a
// spacer) comes back as it was left: slid to the card focus was on, the same
// cards mounted, and its focus guide pointed at that card until focus has
// come in once. A shelf given no memory is what it always was.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const mockSeen = {
  mounted: new Set<number>(),
  focus: {} as Record<number, (item: HeroItem, index: number) => void>,
};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  const Card = R.memo(
    (p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void; ref?: {current: unknown}}) => {
      mockSeen.focus[p.index] = p.onFocus;
      // the host node a real Card forwards its ref to
      if (p.ref) p.ref.current = {card: p.index};
      R.useEffect(() => {
        mockSeen.mounted.add(p.index);
        return () => {
          mockSeen.mounted.delete(p.index);
        };
      }, [p.index]);
      return null;
    },
  );
  return {__esModule: true, default: Card, CARD_W: 124, CARD_H: 186, FRAME_W: 224, FRAME_H: 140};
});

import Row, {ShelfMemory} from '../../src/components/Row';
import {MARGINS, rowWindow, slideFor} from '../../src/rowWindow';

const ITEMS: HeroItem[] = Array.from({length: 30}, (_, i) => ({id: `c${i}`, title: `t${i}`}) as HeroItem);
const GEOM = {step: 124 + 14, cardW: 124, contentLeft: 84, viewportW: 960, lead: 1};
const onSelect = () => {};
const range = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => a + i);
const mountedList = () => [...mockSeen.mounted].sort((a, b) => a - b);
const focus = (i: number) => act(() => mockSeen.focus[i](ITEMS[i], i));

// the focus guide's host node, as react-native-tvos hands it out
const guide = {setDestinations: jest.fn()};
const createNodeMock = (el: {type: unknown}) => (el.type === 'TVFocusGuideView' ? guide : null);

const slideOf = (r: TestRenderer.ReactTestRenderer): number => {
  const track = r.root.findAll(n => (n.type as unknown) === 'Animated.View')[0];
  const style = Object.assign({}, ...[].concat(track.props.style as never).flat(9));
  return (style.transform[0].translateX as {v: number}).v;
};

beforeEach(() => {
  mockSeen.mounted.clear();
  mockSeen.focus = {};
  guide.setDestinations.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the geometry this file assumes is the shelf\'s', () => {
  // (spacing.md is the gap; if the theme changes, so must GEOM)
  const {shelfGeom} = require('../../src/components/Row');
  expect(shelfGeom(false, 960)).toEqual(GEOM);
});

test('mounted again with focus last on card 12: slid there, the same cards, the guide aimed at card 12', () => {
  const store = new Map<string, ShelfMemory>([['drama', {f: 12, dir: 1}]]);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="Drama" items={ITEMS} onSelect={onSelect} store={store} storeKey="drama" />, {createNodeMock});
  });
  // in its FIRST commit: no travel, no second mount
  expect(slideOf(r)).toBe(-slideFor(12, GEOM));
  const w = rowWindow(12, 1, ITEMS.length, GEOM, MARGINS);
  expect(mountedList()).toEqual(range(w.from, w.to - 1));
  expect(mockSeen.mounted.has(12)).toBe(true);
  // a new focus guide has no memory: it is pointed at the card
  expect(guide.setDestinations).toHaveBeenCalledTimes(1);
  expect(guide.setDestinations).toHaveBeenCalledWith([{card: 12}]);

  // focus comes back in, on card 12: the pointer is taken away (the guide
  // remembers by itself from here), nothing is mounted, nothing slides
  focus(12);
  expect(guide.setDestinations).toHaveBeenCalledTimes(2);
  expect(guide.setDestinations).toHaveBeenLastCalledWith([]);
  expect(mountedList()).toEqual(range(w.from, w.to - 1));
  expect((console.log as jest.Mock).mock.calls.filter(c => String(c[0]).startsWith('[row] behind'))).toEqual([]);

  // and on: the memory follows focus, the guide is left alone
  focus(13);
  focus(14);
  focus(13);
  expect(store.get('drama')).toEqual({f: 13, dir: -1});
  expect(guide.setDestinations).toHaveBeenCalledTimes(2);
});

test('travelling LEFT when it was left: the window leads left, as it did', () => {
  const store = new Map<string, ShelfMemory>([['x', {f: 9, dir: -1}]]);
  act(() => {
    TestRenderer.create(<Row title="x" items={ITEMS} onSelect={onSelect} store={store} storeKey="x" />, {createNodeMock});
  });
  const w = rowWindow(9, -1, ITEMS.length, GEOM, MARGINS);
  expect(mountedList()).toEqual(range(w.from, w.to - 1));
});

test('the shelf got shorter while it was away: the nearest card that still exists', () => {
  const store = new Map<string, ShelfMemory>([['cw', {f: 12, dir: 1}]]);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="cw" items={ITEMS.slice(0, 5)} onSelect={onSelect} store={store} storeKey="cw" />, {createNodeMock});
  });
  expect(slideOf(r)).toBe(-slideFor(4, GEOM));
  expect(mockSeen.mounted.has(4)).toBe(true);
  expect(guide.setDestinations).toHaveBeenCalledWith([{card: 4}]);
});

test('a store with nothing kept for this shelf: a fresh shelf, and it starts remembering', () => {
  const store = new Map<string, ShelfMemory>();
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="n" items={ITEMS} onSelect={onSelect} store={store} storeKey="n" />, {createNodeMock});
  });
  expect(slideOf(r)).toBe(0);
  expect(mountedList()).toEqual(range(0, 6));
  expect(guide.setDestinations).not.toHaveBeenCalled();
  focus(0);
  focus(1);
  expect(store.get('n')).toEqual({f: 1, dir: 1});
  expect(guide.setDestinations).not.toHaveBeenCalled();
});

test('no store (every other screen, and Home with the window off): exactly the shelf it was', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="n" items={ITEMS} onSelect={onSelect} />, {createNodeMock});
  });
  expect(slideOf(r)).toBe(0);
  expect(mountedList()).toEqual(range(0, 6));
  focus(0);
  focus(1);
  expect(guide.setDestinations).not.toHaveBeenCalled();
});
