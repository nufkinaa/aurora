// The phone's D-pad on the TV (src/remote/target.ts → RemoteModule.kt →
// MainActivity.injectRemoteKey) is a REAL key press: a key-down and its key-up
// with the same uptime, through the activity's own dispatch. For the JS that
// decides what a key-up means (src/focus.ts pressMovedFocus / focusJustMoved,
// the NavRail's LEFT rule) the difference from the remote in the hand is one
// thing only: the focus move and the key-up of ONE press arrive in the same
// millisecond, in either order (the key-up can reach JS before the focus
// event does). These run focus.ts's real exports on both orders, and against
// the same press made by a hand, so "the rail opens by itself" cannot come
// back through the phone.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

type Evt = {eventType: string; eventKeyAction?: number};
let mockHandler: ((e: Evt) => void) | null = null;
jest.mock('react-native', () => ({
  useTVEventHandler: (h: (e: Evt) => void) => {
    mockHandler = h;
  },
}));
jest.mock('@react-navigation/native', () => ({NavigationContext: require('react').createContext(null)}));
jest.mock('../../src/settle', () => ({noteMove: () => {}}));

import {atLeftEdge, focusJustMoved, noteFocus, pressMovedFocus, useTVKeys} from '../../src/focus';
import {KEY_GAP_MS} from '../../src/remote/protocol';

// What the components ask, as they ask it: the NavRail's LEFT (open the rail
// from the edge), and the screens' "did this press arrive here?" (Home's hero
// UP, Search's grid, MyList's bands…).
const seen = {railOpened: 0, acted: 0, arrived: 0};
function Listener() {
  useTVKeys(e => {
    if (e.eventType === 'left' && atLeftEdge() && !focusJustMoved(120) && !pressMovedFocus()) seen.railOpened++;
    if (pressMovedFocus()) seen.arrived++;
    else seen.acted++;
  });
  return null;
}

// a shelf of cards: card 0 at the left edge
const cards = Array.from({length: 10}, (_, i) => ({id: i, requestTVFocus: () => {}}));
let at = 0;
const focusTo = (i: number) => {
  at = i;
  noteFocus(cards[i], i === 0);
};
let clock = 0;
const setT = (t: number) => {
  clock = t;
  jest.setSystemTime(1_000_000 + t);
};
const keyUp = (eventType: string) => act(() => mockHandler!({eventType, eventKeyAction: 1}));

/** A press from the phone: down and up in the same millisecond. `moveTo`: where the
 *  focus engine moved on the key-down (none at an edge). `keyFirst`: the key-up
 *  reached JS before the focus event. */
const injected = (t: number, key: string, moveTo: number | null, keyFirst: boolean) => {
  setT(t);
  if (keyFirst) {
    keyUp(key);
    if (moveTo != null) focusTo(moveTo);
  } else {
    if (moveTo != null) focusTo(moveTo);
    keyUp(key);
  }
};
/** The same press by a hand: focus moves on the key-down, JS hears the key-up `held` ms later. */
const hand = (t: number, key: string, moveTo: number | null, held = 150) => {
  setT(t);
  if (moveTo != null) focusTo(moveTo);
  setT(t + held);
  keyUp(key);
};

beforeEach(() => {
  jest.useFakeTimers();
  seen.railOpened = 0;
  seen.acted = 0;
  seen.arrived = 0;
  act(() => void TestRenderer.create(<Listener />));
  // settle from any earlier test: an old key, focus on card 5 long ago
  setT(-100_000);
  keyUp('down');
  focusTo(5);
  seen.acted = 0;
  seen.arrived = 0;
});
afterEach(() => jest.useRealTimers());

describe.each([
  ['the key-up reaches JS first', true],
  ['the focus event reaches JS first', false],
])('an injected press — %s', (_name, keyFirst) => {
  test('LEFT that ARRIVES at the edge does not open the rail; the next LEFT, made AT the edge, does', () => {
    focusTo(1);
    injected(1000, 'left', 0, keyFirst);
    expect(at).toBe(0);
    expect(seen.railOpened).toBe(0);
    // the next press from the phone, paced KEY_GAP_MS behind it (target.ts)
    injected(1000 + KEY_GAP_MS, 'left', null, keyFirst);
    expect(seen.railOpened).toBe(1);
  });

  test('the press after a moving press is read as itself — not as "arrived at the edge"', () => {
    focusTo(3);
    injected(1000, 'right', 4, keyFirst);
    // a press that moves nothing (the end of the shelf), 300 ms later: it ACTS
    seen.acted = 0;
    seen.arrived = 0;
    injected(1300, 'right', null, keyFirst);
    expect(seen).toMatchObject({acted: 1, arrived: 0});
  });

  test('a run of presses down a shelf to the edge, then one more: the rail opens on the extra one only', () => {
    focusTo(4);
    let t = 1000;
    for (let i = 3; i >= 0; i--, t += KEY_GAP_MS) injected(t, 'left', i, keyFirst);
    expect(at).toBe(0);
    expect(seen.railOpened).toBe(0);
    injected(t, 'left', null, keyFirst);
    expect(seen.railOpened).toBe(1);
  });
});

test('pressMovedFocus() answers an injected press exactly as it answers the same press by hand', () => {
  const answers = (press: (t: number, key: string, moveTo: number | null) => void) => {
    const out: boolean[] = [];
    const probe = () => out.push(pressMovedFocus());
    focusTo(2);
    // a moving press, then one that moves nothing, then a moving one, then nothing
    const steps: [string, number | null][] = [['left', 1], ['up', null], ['left', 0], ['left', null]];
    let t = 10_000 + clock;
    for (const [key, to] of steps) {
      press(t, key, to);
      probe();
      t += 400;
    }
    return out;
  };
  const byHand = answers((t, k, to) => hand(t, k, to));
  const keyFirst = answers((t, k, to) => injected(t, k, to, true));
  const focusFirst = answers((t, k, to) => injected(t, k, to, false));
  // (the probe runs after the press is over; the handler's own view is what the tests above pin)
  expect(keyFirst).toEqual(focusFirst);
  expect(byHand).toEqual([true, false, true, false]);
  // the injected press's own move is booked to it, so the press AFTER it is never "arrived"
  expect([keyFirst[1], keyFirst[3]]).toEqual([false, false]);
});

test('the rail, by hand, for comparison: a press that starts at the edge opens it, one that arrives does not', () => {
  focusTo(1);
  hand(1000, 'left', 0);
  expect(seen.railOpened).toBe(0);
  hand(1600, 'left', null);
  expect(seen.railOpened).toBe(1);
});
