// Home's shelves: a re-render of the screen must not re-render the cards.
//
// Row and Card are React.memo; they only hold when every prop keeps its
// identity. Home used to hand each Row an arrow written inside renderRow
// (`it => { toRow(i); warmItem(it); }`), so every Home render — the hero
// rotating, a shelf being reached, a party list arriving — re-rendered every
// mounted card. It now passes ONE function plus `rowIndex`.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const mockSeen = {renders: 0, focus: {} as Record<string, (item: HeroItem, index: number) => void>};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  const Card = R.memo((p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void}) => {
    mockSeen.renders++;
    mockSeen.focus[p.item.id] = p.onFocus;
    return null;
  });
  return {__esModule: true, default: Card, CARD_W: 124, CARD_H: 186, FRAME_W: 224, FRAME_H: 140};
});

import Row from '../../src/components/Row';

const items = (row: number): HeroItem[] => Array.from({length: 4}, (_, i) => ({id: `r${row}c${i}`, title: `t${i}`}));
const ROWS = [items(0), items(1), items(2)];
const onSelect = () => {};

function Screen({tick, stable, seen}: {tick: number; stable: boolean; seen: (item: HeroItem, row: number) => void}) {
  // what Home does now
  const one = React.useCallback((it: HeroItem, rowIndex: number) => seen(it, rowIndex), [seen]);
  return (
    <>
      {ROWS.map((r, i) =>
        stable ? (
          <Row key={i} title={`row ${i}`} items={r} onSelect={onSelect} onItemFocus={one} rowIndex={i} showKind />
        ) : (
          // what Home did before: a new function per row per render
          <Row key={i} title={`row ${i}`} items={r} onSelect={onSelect} onItemFocus={it => seen(it, i)} showKind />
        ),
      )}
    </>
  );
}

const mount = (stable: boolean, seen: (item: HeroItem, row: number) => void) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Screen tick={0} stable={stable} seen={seen} />);
  });
  return r;
};

beforeEach(() => {
  mockSeen.renders = 0;
});

test('one stable onItemFocus + rowIndex: a screen re-render renders no card', () => {
  const seen = jest.fn();
  const r = mount(true, seen);
  expect(mockSeen.renders).toBe(12);
  for (let t = 1; t <= 5; t++) act(() => r.update(<Screen tick={t} stable seen={seen} />));
  expect(mockSeen.renders).toBe(12);
});

test('the old shape (an arrow per row per render) re-rendered every card each time', () => {
  const seen = jest.fn();
  const r = mount(false, seen);
  expect(mockSeen.renders).toBe(12);
  for (let t = 1; t <= 5; t++) act(() => r.update(<Screen tick={t} stable={false} seen={seen} />));
  expect(mockSeen.renders).toBe(12 + 5 * 12);
});

test('the row index reaches the caller with the focused item', () => {
  const seen = jest.fn();
  mount(true, seen);
  act(() => mockSeen.focus.r2c1(ROWS[2][1], 1));
  expect(seen).toHaveBeenLastCalledWith(ROWS[2][1], 2);
  act(() => mockSeen.focus.r0c3(ROWS[0][3], 3));
  expect(seen).toHaveBeenLastCalledWith(ROWS[0][3], 0);
});
