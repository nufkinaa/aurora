// Focusable: one focus move starts each animation ONCE.
//
// The element that loses focus can be told twice — by its own blur and by the
// registry clear the gaining element runs (the net for a dropped blur). The
// second telling used to start the same two animations to 0 again. Whatever
// the order of the events, every value must still end where it did before.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../src/focus', () => ({noteFocus: jest.fn(), noteFocusLost: jest.fn()}));

// every animation start, as [which value, where to]
const mockStarts: {value: unknown; to: number; kind: string}[] = [];
jest.mock('react-native', () => {
  const stub = jest.requireActual('./rn-stub.js');
  const rec = (kind: string) => (value: unknown, cfg: {toValue: number}) => ({
    start: () => {
      mockStarts.push({value, to: cfg.toValue, kind});
    },
  });
  return {
    ...stub,
    Pressable: 'Pressable',
    findNodeHandle: () => 1,
    Animated: {...stub.Animated, timing: rec('timing'), spring: rec('spring')},
  };
});

import Focusable from '../../src/components/Focusable';

type Handlers = {onFocus: () => void; onBlur: () => void};
const mountTwo = () => {
  const seen: Record<string, boolean[]> = {a: [], b: []};
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <>
        <Focusable onFocusChange={f => seen.a.push(f)}>{null}</Focusable>
        <Focusable onFocusChange={f => seen.b.push(f)}>{null}</Focusable>
      </>,
    );
  });
  const [a, b] = r.root.findAll(n => (n.type as unknown) === 'Pressable').map(n => n.props as Handlers);
  return {a, b, seen, unmount: () => act(() => r.unmount())};
};

// where each animated value was last sent
const ends = () => {
  const m = new Map<unknown, number>();
  for (const s of mockStarts) m.set(s.value, s.to);
  return [...m.values()].sort();
};

beforeEach(() => {
  mockStarts.length = 0;
});

test('blur first, then focus (the usual order): 2 starts down, 2 up — as before', () => {
  const {a, b, seen, unmount} = mountTwo();
  act(() => a.onFocus());
  mockStarts.length = 0;
  act(() => {
    a.onBlur();
    b.onFocus();
  });
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:0', 'spring:0', 'timing:1', 'spring:1']);
  expect(seen).toEqual({a: [true, false], b: [true]});
  unmount();
});

test('focus first, then the blur: the element going down is started once, not twice', () => {
  const {a, b, seen, unmount} = mountTwo();
  act(() => a.onFocus());
  mockStarts.length = 0;
  act(() => {
    b.onFocus(); // clears a through the registry, then lights b
    a.onBlur(); // a is already on its way down
  });
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:0', 'spring:0', 'timing:1', 'spring:1']);
  // a's two values end at 0, b's two at 1
  expect(ends()).toEqual([0, 0, 1, 1]);
  // the caller is still told about the blur
  expect(seen).toEqual({a: [true, false], b: [true]});
  unmount();
});

test('a dropped blur: the gaining element still clears the one that was lit', () => {
  const {a, b, unmount} = mountTwo();
  act(() => a.onFocus());
  mockStarts.length = 0;
  act(() => b.onFocus());
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:0', 'spring:0', 'timing:1', 'spring:1']);
  expect(ends()).toEqual([0, 0, 1, 1]);
  unmount();
});

test('focus coming back to an element that was cleared lights it again, and its next blur takes it down', () => {
  const {a, b, unmount} = mountTwo();
  act(() => a.onFocus());
  act(() => b.onFocus()); // a cleared by the registry
  act(() => b.onBlur());
  mockStarts.length = 0;
  act(() => a.onFocus());
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:1', 'spring:1']);
  mockStarts.length = 0;
  act(() => a.onBlur());
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:0', 'spring:0']);
  unmount();
});

test('a blur for an element that was never lit starts nothing, and still reports', () => {
  const {a, seen, unmount} = mountTwo();
  act(() => a.onBlur());
  expect(mockStarts).toEqual([]);
  expect(seen.a).toEqual([false]);
  unmount();
});

test('a second focus event on the lit element is passed through unchanged', () => {
  const {a, unmount} = mountTwo();
  act(() => a.onFocus());
  mockStarts.length = 0;
  act(() => a.onFocus());
  expect(mockStarts.map(s => `${s.kind}:${s.to}`)).toEqual(['timing:1', 'spring:1']);
  unmount();
});
