// BACK from a title page after a long visit to Home landed on the billboard
// (2026-10-18): Home re-reads /api/home on its way back (its last read 15 s
// old or more), the fresh answer had the pressed title at another index, and
// the shelf's window — derived from the INDEX focus was on — unmounted the
// card that Android had just given focus back to. shelfPin.ts holds the
// focused title at its index across the re-read.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {HeroItem} from '../../src/api';
import {pinFocused} from '../../src/shelfPin';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// Which titles have a mounted card, and at which index; the focus handler by index.
const mockSeen = {
  at: new Map<string, number>(),
  unmounted: [] as string[],
  focus: {} as Record<number, (item: HeroItem, index: number) => void>,
  item: {} as Record<number, HeroItem>,
  remove: {} as Record<number, ((item: HeroItem) => void) | undefined>,
  focused: [] as string[], // requestTVFocus calls, by title
};
jest.mock('../../src/components/Card', () => {
  const R = require('react');
  const Card = R.memo((p: {item: HeroItem; index: number; onFocus: (item: HeroItem, index: number) => void; onRemove?: (item: HeroItem) => void; ref?: (el: unknown) => void}) => {
    mockSeen.focus[p.index] = p.onFocus;
    mockSeen.remove[p.index] = p.onRemove;
    const self = p.item.id!;
    R.useLayoutEffect(() => {
      if (typeof p.ref !== 'function') return;
      p.ref({requestTVFocus: () => mockSeen.focused.push(self)});
      return () => p.ref!(null);
    }, [p.ref, self]);
    mockSeen.item[p.index] = p.item;
    mockSeen.at.set(p.item.id!, p.index);
    const id = p.item.id!;
    R.useEffect(
      () => () => {
        mockSeen.at.delete(id);
        mockSeen.unmounted.push(id);
      },
      [id],
    );
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

beforeEach(() => {
  jest.useFakeTimers();
  mockSeen.at.clear();
  mockSeen.unmounted = [];
  mockSeen.focus = {};
  mockSeen.item = {};
  mockSeen.remove = {};
  mockSeen.focused = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('pinFocused', () => {
  const key = (s: string) => s;
  test('moves the pinned title back to its index, the rest in the new order', () => {
    expect(pinFocused(['a', 'b', 'x', 'c', 'd', 'e'], key, {key: 'e', index: 1})).toEqual(['a', 'e', 'b', 'x', 'c', 'd']);
    expect(pinFocused(['e', 'a', 'b', 'c'], key, {key: 'e', index: 3})).toEqual(['a', 'b', 'c', 'e']);
  });
  test('the same array when nothing has to move, or there is no pin', () => {
    const l = ['a', 'b', 'c'];
    expect(pinFocused(l, key, {key: 'b', index: 1})).toBe(l);
    expect(pinFocused(l, key, null)).toBe(l);
  });
  test('a title that has left the shelf is not brought back without the title itself', () => {
    const l = ['a', 'b', 'c'];
    expect(pinFocused(l, key, {key: 'z', index: 1})).toBe(l);
  });
  test('a title the re-read dropped is held where focus is, when the pin carries it', () => {
    expect(pinFocused(['a', 'b', 'c'], key, {key: 'z', index: 1, item: 'z'})).toEqual(['a', 'z', 'b', 'c']);
    expect(pinFocused(['a', 'b'], key, {key: 'z', index: 9, item: 'z'})).toEqual(['a', 'b', 'z']);
  });
  test('an index beyond a shorter shelf: its last place', () => {
    expect(pinFocused(['b', 'a', 'c'], key, {key: 'b', index: 12})).toEqual(['a', 'c', 'b']);
  });
});

// Long visit: focus walked out to card 12 and rested, the card was pressed,
// Home was re-read on the way back with eight new titles in front of it.
const reread = () => mk([...Array.from({length: 8}, (_, i) => `n${i}`), ...ITEMS.map(i => i.id!)].slice(0, 30));

test('BACK after a re-read: the focused card stays mounted, at the index focus was on', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="Drama" items={ITEMS} onSelect={onSelect} rowIndex={4} />);
  });
  for (let f = 0; f <= 12; f++) press(f);
  rest();
  expect(mockSeen.at.get('c12')).toBe(12);
  const next = reread();
  // the server has it at 20 now — outside the window built around 12
  expect(next.findIndex(i => i.id === 'c12')).toBe(20);
  mockSeen.unmounted = [];
  act(() => {
    r.update(<Row title="Drama" items={next} onSelect={onSelect} rowIndex={4} />);
  });
  rest();
  expect(mockSeen.unmounted).not.toContain('c12');
  expect(mockSeen.at.get('c12')).toBe(12);
  // around it, the server's order
  expect(mockSeen.item[11].id).toBe(next[11].id);
  expect(mockSeen.item[13].id).toBe(next[12].id);
  // the device line
  expect((console.log as jest.Mock).mock.calls.map(c => String(c[0]))).toContain('[row] reread row=4 card=c12 at=12 server=20 kept=yes');
  // and the shelf goes on from there: RIGHT is the title after it
  press(13);
  expect(mockSeen.item[13].id).toBe(next[12].id);
});

test('a re-read in the same order hands the shelf nothing new to place', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="x" items={ITEMS} onSelect={onSelect} />);
  });
  for (let f = 0; f <= 5; f++) press(f);
  rest();
  const before = new Map(mockSeen.at);
  mockSeen.unmounted = [];
  act(() => {
    r.update(<Row title="x" items={ITEMS.map(i => ({...i}))} onSelect={onSelect} />);
  });
  expect(mockSeen.at).toEqual(before);
  expect(mockSeen.unmounted).toEqual([]);
});

test('a shelf that does not hold focus takes the server order as it is', () => {
  let a!: TestRenderer.ReactTestRenderer;
  act(() => {
    a = TestRenderer.create(<Row title="a" items={ITEMS} onSelect={onSelect} />);
  });
  press(0);
  press(1);
  rest();
  // focus moves on to another shelf
  const other = mk(['o0', 'o1', 'o2']);
  let b!: TestRenderer.ReactTestRenderer;
  act(() => {
    b = TestRenderer.create(<Row title="b" items={other} onSelect={onSelect} />);
  });
  press(0); // (the last mounted shelf's card 0 handler is b's)
  rest();
  const swapped = [ITEMS[1], ITEMS[0], ...ITEMS.slice(2)];
  act(() => {
    a.update(<Row title="a" items={swapped} onSelect={onSelect} />);
  });
  expect(mockSeen.at.get('c1')).toBe(0);
  expect(mockSeen.at.get('c0')).toBe(1);
  act(() => b.unmount());
});

// The device pass (Mi TV, 2026-10-18): every write of the profile re-ranks the
// recommendation shelves, and the pressed title had often LEFT its shelf in the
// re-read — `kept=no`, the card unmounted, focus on the billboard.
test('BACK after a re-read that dropped the focused title: it is held, mounted, where focus was', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="Recommended" items={ITEMS} onSelect={onSelect} rowIndex={1} />);
  });
  for (let f = 0; f <= 6; f++) press(f);
  rest();
  const next = mk(Array.from({length: 24}, (_, i) => `r${i}`)); // c6 is not in it
  mockSeen.unmounted = [];
  act(() => {
    r.update(<Row title="Recommended" items={next} onSelect={onSelect} rowIndex={1} />);
  });
  rest();
  expect(mockSeen.unmounted).not.toContain('c6');
  expect(mockSeen.at.get('c6')).toBe(6);
  expect(mockSeen.item[5].id).toBe('r5');
  expect(mockSeen.item[7].id).toBe('r6');
  expect((console.log as jest.Mock).mock.calls.map(c => String(c[0]))).toContain('[row] reread row=1 card=c6 at=6 server=-1 kept=held');
});

test('the focused title removed (the ✕ on Continue Watching): not brought back', () => {
  let r!: TestRenderer.ReactTestRenderer;
  let items = ITEMS.slice(0, 6);
  const onRemove = (item: HeroItem) => {
    items = items.filter(i => i.id !== item.id);
    r.update(<Row title="cw" items={items} onSelect={onSelect} wide onRemove={onRemove} />);
  };
  act(() => {
    r = TestRenderer.create(<Row title="cw" items={items} onSelect={onSelect} wide onRemove={onRemove} />);
  });
  press(0);
  press(1);
  press(2);
  rest();
  act(() => mockSeen.remove[2]!(mockSeen.item[2]));
  expect(mockSeen.at.has('c2')).toBe(false);
  expect(mockSeen.at.get('c3')).toBe(2);
  // and focus goes to the card that took its place (not to the billboard)
  rest();
  expect(mockSeen.focused).toEqual(['c3']);
});

test('the last card removed: focus goes to the one before it', () => {
  let r!: TestRenderer.ReactTestRenderer;
  let items = ITEMS.slice(0, 3);
  const onRemove = (item: HeroItem) => {
    items = items.filter(i => i.id !== item.id);
    r.update(<Row title="cw" items={items} onSelect={onSelect} wide onRemove={onRemove} />);
  };
  act(() => {
    r = TestRenderer.create(<Row title="cw" items={items} onSelect={onSelect} wide onRemove={onRemove} />);
  });
  press(0);
  press(1);
  press(2);
  rest();
  act(() => mockSeen.remove[2]!(mockSeen.item[2]));
  rest();
  expect(mockSeen.focused).toEqual(['c1']);
});

test('a re-read that is not a removal moves no focus by hand', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Row title="x" items={ITEMS} onSelect={onSelect} />);
  });
  press(0);
  press(1);
  rest();
  act(() => {
    r.update(<Row title="x" items={ITEMS.slice(1)} onSelect={onSelect} />);
  });
  rest();
  expect(mockSeen.focused).toEqual([]);
});
