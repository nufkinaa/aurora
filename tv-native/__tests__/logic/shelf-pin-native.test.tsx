// shelf-pin.test.tsx with the render switches `row` + `card` + `pool` on: the
// pooled shelf keeps the slot of the title at `lastIdx` (shelfPool.ts `keep`),
// so a re-read that moved the focused title used to keep the WRONG title's
// slot and hand the focused card's views to another title (or empty them).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../src/render', () => ({
  nativeOn: {focusable: false, card: true, row: true, hero: false, rail: false},
  fixOn: {cardlayer: false, cull: false, shadowcache: false, unstuff: false, unstuffq: false, pool: true},
}));

// What each card instance shows (a pooled instance shows several titles over its life).
const mockSeen = {
  showing: new Map<number, {id: string; index: number}>(),
  focus: {} as Record<number, (item: HeroItem, index: number) => void>,
  item: {} as Record<number, HeroItem>,
};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  let next = 1;
  const Card = R.memo((p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void}) => {
    const id = R.useRef(0);
    if (!id.current) id.current = next++;
    mockSeen.focus[p.index] = p.onFocus;
    mockSeen.item[p.index] = p.item;
    mockSeen.showing.set(id.current, {id: p.item.id!, index: p.index});
    R.useEffect(() => {
      const me = id.current;
      return () => {
        mockSeen.showing.delete(me);
      };
    }, []);
    return null;
  });
  return {__esModule: true, default: Card, CARD_W: 124, CARD_H: 186, FRAME_W: 224, FRAME_H: 140};
});

import Row from '../../src/components/Row';

const mk = (ids: string[]) => ids.map(id => ({id, title: id}) as HeroItem);
const ITEMS = mk(Array.from({length: 30}, (_, i) => `c${i}`));
const onSelect = () => {};
const rest = () => act(() => void jest.advanceTimersByTime(1000));
const press = (i: number) => act(() => mockSeen.focus[i](mockSeen.item[i], i));
const instanceOf = (id: string) => [...mockSeen.showing].find(([, v]) => v.id === id)?.[0];

beforeEach(() => {
  jest.useFakeTimers();
  mockSeen.showing.clear();
  mockSeen.focus = {};
  mockSeen.item = {};
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('pooled shelf, BACK after a re-read: the focused card instance still shows the focused title, at its index', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="Drama" items={ITEMS} onSelect={onSelect} rowIndex={4} />);
  });
  for (let f = 0; f <= 12; f++) press(f);
  rest();
  const inst = instanceOf('c12');
  expect(inst).toBeDefined();
  const next = mk([...Array.from({length: 8}, (_, i) => `n${i}`), ...ITEMS.map(i => i.id!)].slice(0, 30));
  act(() => {
    r.update(<Row title="Drama" items={next} onSelect={onSelect} rowIndex={4} />);
  });
  rest();
  // the instance that held focus is still there, on the same title, in the same place
  expect(mockSeen.showing.get(inst!)).toEqual({id: 'c12', index: 12});
  // never two instances on one title
  const ids = [...mockSeen.showing.values()].map(v => v.id);
  expect(new Set(ids).size).toBe(ids.length);
});
