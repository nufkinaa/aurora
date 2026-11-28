// A title picked in the launcher's Aurora row (homeScreen.ts useHomeScreenLinks):
// the player's item is asked for AT ONCE (warm), and the title is pushed once
// Home has drawn — not a fixed 600 ms after Home's mount (streaming round 2:
// that wait was half a second of every start from the row).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

const LINK = 'aurora://open?a=play&d=%7B%22id%22%3A%22a1%22%2C%22title%22%3A%22X%22%2C%22type%22%3A%22movie%22%7D';
let mockInitial: string | null = LINK;
let mockUrlListener: ((e: {url: string}) => void) | null = null;
jest.mock('react-native', () => ({
  ...jest.requireActual('./rn-stub.js'),
  Linking: {
    getInitialURL: () => Promise.resolve(mockInitial),
    addEventListener: (_: string, fn: (e: {url: string}) => void) => {
      mockUrlListener = fn;
      return {remove: () => (mockUrlListener = null)};
    },
  },
}));

import {LINK_OPEN_AFTER_FRAME_MS, noteAppRun, useHomeScreenLinks} from '../../src/homeScreen';

type Call = {what: 'warm' | 'open'; action: string; id: string; at: number};
let calls: Call[] = [];
function HomeLike() {
  useHomeScreenLinks(
    (action, item) => calls.push({what: 'open', action, id: item.id, at: Date.now()}),
    (action, item) => calls.push({what: 'warm', action, id: item.id, at: Date.now()}),
  );
  return null;
}

beforeEach(() => {
  jest.useFakeTimers();
  calls = [];
  (globalThis as any).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 16);
});
afterEach(() => jest.useRealTimers());

test('the item is warmed at once, the title opened one frame and a moment later — well inside the old 600 ms', async () => {
  noteAppRun();
  mockInitial = LINK;
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<HomeLike />);
  });
  // (getInitialURL's promise has settled inside act)
  expect(calls.map(c => c.what)).toEqual(['warm']);
  expect(calls[0]).toMatchObject({action: 'play', id: 'a1'});
  await act(async () => {
    jest.advanceTimersByTime(16 + LINK_OPEN_AFTER_FRAME_MS);
  });
  expect(calls.map(c => c.what)).toEqual(['warm', 'open']);
  expect(calls[1].at - calls[0].at).toBeLessThan(600);
  act(() => r!.unmount());
});

test('Home gone before the frame: nothing is pushed', async () => {
  noteAppRun();
  mockInitial = LINK + '&n=2';
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<HomeLike />);
  });
  act(() => r!.unmount());
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(calls.map(c => c.what)).toEqual(['warm']);
});

test('a link that arrives while the app is open: warmed, then opened', async () => {
  noteAppRun();
  mockInitial = null;
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<HomeLike />);
  });
  expect(calls).toEqual([]);
  act(() => mockUrlListener!({url: LINK}));
  expect(calls.map(c => c.what)).toEqual(['warm', 'open']);
  act(() => r!.unmount());
});
