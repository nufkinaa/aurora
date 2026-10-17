// The `keyrate` switch (android/.../ui/input/KeyRepeatGate.kt) against the JS that decides
// what a key-up means (src/focus.ts pressMovedFocus / focusJustMoved, the NavRail's LEFT rule,
// Home's UP rule): synthetic event streams in the order JS sees them.
//
// What JS hears on this react-native-tvos (ReactAndroidHWInputDeviceHelper): a D-pad key only
// when it comes UP — a tap as `left` (action 1); a hold as `longLeft` down once (at the first
// repeat that is ≥ 300 ms after the press) and `longLeft` up at the release. Focus moves come
// from the native focus engine, as focus events. The gate changes WHEN the held key's moves
// happen (at most one a frame, ~66.7 ms apart, none after the release) and nothing about which
// key events JS hears — the helper sees the gate's repeats as it saw the hardware's.
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

/** The NavRail's LEFT rule and Home's hero UP rule, as the components ask them. */
const seen = {railOpened: 0, heroUp: 0};
function Listener() {
  useTVKeys(e => {
    if (e.eventType === 'left' && atLeftEdge() && !focusJustMoved(120) && !pressMovedFocus()) seen.railOpened++;
    if (e.eventType === 'up' && !pressMovedFocus()) seen.heroUp++;
  });
  return null;
}

// a shelf of cards: node i, card 0 at the left edge
const cards = Array.from({length: 30}, (_, i) => ({id: i, requestTVFocus: () => {}}));
let at = 0;
const focusTo = (i: number) => {
  at = i;
  noteFocus(cards[i], i === 0);
};

type Step = [number, 'move' | 'key', number | Evt];
const run = (steps: Step[]) => {
  for (const [t, kind, what] of [...steps].sort((a, b) => a[0] - b[0])) {
    jest.setSystemTime(1_000_000 + t);
    if (kind === 'move') focusTo(what as number);
    else act(() => mockHandler!(what as Evt));
  }
};

/** A hold of LEFT from card `from`, `ms` long, as the gate makes it: the press moves at once,
 *  then one move every `gap` ms from the first repeat (400 ms) while the key is down; at card 0
 *  a move has nowhere to go (holdLeft) and focus stays. JS: `longLeft` down at the first
 *  repeat, `longLeft` up at the release. */
const gatedHold = (from: number, ms: number, gap = 66.7, t0 = 0): Step[] => {
  const out: Step[] = [];
  let card = from;
  const move = (t: number) => {
    if (card > 0) out.push([t0 + t, 'move', --card]);
  };
  move(5);
  for (let t = 400; t < ms; t += gap) move(t + 3);
  if (ms > 400) out.push([t0 + 401, 'key', {eventType: 'longLeft', eventKeyAction: 0}]);
  out.push([t0 + ms, 'key', {eventType: ms > 400 ? 'longLeft' : 'left', eventKeyAction: 1}]);
  return out;
};

/** The same hold today on a weak box: repeats every 50 ms, each move costing more than that,
 *  so the moves queue up and are still being worked off after the release (`lag` ms each). */
const backloggedHold = (from: number, ms: number, lag = 70): Step[] => {
  const out: Step[] = [];
  let card = from;
  let busyUntil = 0;
  const repeatAt = [5];
  for (let t = 400; t < ms; t += 50) repeatAt.push(t);
  for (const r of repeatAt) {
    const t = Math.max(r, busyUntil);
    busyUntil = t + lag;
    if (card > 0) out.push([t, 'move', --card]);
  }
  if (ms > 400) out.push([401, 'key', {eventType: 'longLeft', eventKeyAction: 0}]);
  out.push([ms, 'key', {eventType: ms > 400 ? 'longLeft' : 'left', eventKeyAction: 1}]);
  return out;
};

const tapLeft = (t: number, moves: boolean): Step[] => [
  ...(moves && at > 0 ? ([[t + 3, 'move', at - 1]] as Step[]) : []),
  [t + 90, 'key', {eventType: 'left', eventKeyAction: 1}],
];

beforeEach(() => {
  jest.useFakeTimers();
  seen.railOpened = 0;
  seen.heroUp = 0;
  act(() => void TestRenderer.create(<Listener />));
  // settle from any earlier test: a fresh key, then focus on card 5 a while ago
  jest.setSystemTime(900_000);
  act(() => mockHandler!({eventType: 'down', eventKeyAction: 1}));
  focusTo(5);
});
afterEach(() => jest.useRealTimers());

test('a held key never opens the rail by itself, however long, gated or not', () => {
  for (const ms of [450, 800, 1500, 3000]) {
    focusTo(6);
    run(gatedHold(6, ms, 66.7, 0).map(([t, k, w]) => [t + ms * 10, k, w] as Step));
    expect(seen.railOpened).toBe(0);
  }
});

test('gated: a hold that reaches the edge stops there; the next tap at the edge opens the rail', () => {
  focusTo(3);
  run(gatedHold(3, 1500));
  expect(at).toBe(0);
  expect(seen.railOpened).toBe(0);
  // the viewer taps LEFT 200 ms after letting go: a press that STARTS at the edge
  jest.setSystemTime(1_000_000 + 1700);
  run(tapLeft(1700, false));
  expect(seen.railOpened).toBe(1);
});

test('gated: nothing moves after the release, so the next tap is read as itself', () => {
  focusTo(20);
  const steps = gatedHold(20, 1200);
  const release = 1200;
  expect(steps.filter(([t, k]) => k === 'move' && t > release)).toEqual([]);
  run(steps);
  const stoppedAt = at;
  expect(stoppedAt).toBeGreaterThan(0);
  // a tap 150 ms later moves exactly one card and is not mistaken for anything
  run(tapLeft(release + 150, true));
  expect(at).toBe(stoppedAt - 1);
  expect(seen.railOpened).toBe(0);
});

test('today, on a weak box: the backlog runs on after the release and swallows the next tap at the edge', () => {
  // (the case the gate removes — kept as the reason it exists)
  focusTo(16);
  const steps = backloggedHold(16, 1200);
  const after = steps.filter(([t, k]) => k === 'move' && t > 1200);
  expect(after.length).toBeGreaterThan(0);
  run(steps);
  expect(at).toBe(0);
  // the viewer, who let go well before the edge, taps LEFT: focus is already at the edge and
  // the last move is younger than the release — pressMovedFocus() says "this press arrived"
  run(tapLeft(Math.max(...after.map(s => s[0])) + 50, false));
  expect(seen.railOpened).toBe(0);
});

test('the same hold, gated and not: where focus is at the release, and where it ends', () => {
  const where = (steps: Step[], release: number) => {
    const moves = steps.filter(s => s[1] === 'move');
    const atRelease = moves.filter(s => s[0] <= release).pop()![2] as number;
    const atEnd = moves[moves.length - 1][2] as number;
    return {atRelease, atEnd};
  };
  const today = where(backloggedHold(25, 1200), 1200);
  const gated = where(gatedHold(25, 1200), 1200);
  expect(today.atEnd).toBeLessThan(today.atRelease); // it ran on past where the viewer let go
  expect(gated.atEnd).toBe(gated.atRelease); // it stopped there
  expect(gated.atRelease).toBeGreaterThan(0);
});

test('a tap is untouched: UP from the first shelf lands on the hero and does nothing more', () => {
  // the press passes the gate at once (repeatCount 0), so the move precedes its key-up as before
  focusTo(4);
  run([
    [100, 'move', 0],
    [220, 'key', {eventType: 'up', eventKeyAction: 1}],
  ]);
  expect(seen.heroUp).toBe(0);
  // a second UP 300 ms later, made on the hero, is the hero's
  run([[520, 'key', {eventType: 'up', eventKeyAction: 1}]]);
  expect(seen.heroUp).toBe(1);
});
