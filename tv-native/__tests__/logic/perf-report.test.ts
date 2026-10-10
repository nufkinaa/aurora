// perfTier's frame report: a screen visited briefly is kept and merged, not
// thrown away; and the two-minute timer stops once the session's few events
// have been sent.
type Stats = {frames: number; p50: number; p90: number; jank: number};

type FakeNative = {
  queue: Record<string, Stats>[];
  setFrameScreen: jest.Mock;
  glRenderer: jest.Mock;
  takeFrameStats: jest.Mock;
  clearMemoryCaches: jest.Mock;
};
// (made inside the factory: jest.mock is hoisted above everything in this file)
jest.mock('react-native', () => {
  const queue: Record<string, unknown>[] = [];
  const AuroraDevice = {
    queue,
    setFrameScreen: jest.fn(),
    glRenderer: jest.fn(async () => 'Mali-G52'),
    takeFrameStats: jest.fn(async () => queue.shift() || {}),
    clearMemoryCaches: jest.fn(),
  };
  return {...jest.requireActual('./rn-stub.js'), NativeModules: {AuroraDevice}};
});
const mockTrack = jest.fn();
jest.mock('../../src/usage', () => ({track: (...a: unknown[]) => mockTrack(...a)}));

import {NativeModules} from 'react-native';
import {frameScreen, _perfInternals} from '../../src/perfTier';

const mockNative = NativeModules.AuroraDevice as unknown as FakeNative;

const s = (frames: number, p90 = 20): Stats => ({frames, p50: 12, p90, jank: 1});
const perfEvents = () => mockTrack.mock.calls.filter(c => c[0] === 'perf').map(c => c[1] as {screen: string; frames: number; p90: number});

beforeEach(() => {
  mockTrack.mockClear();
  mockNative.queue.length = 0;
  for (const k of Object.keys(_perfInternals.pending)) delete _perfInternals.pending[k];
});
afterAll(() => _perfInternals.stop());

test('a screen with enough frames is reported and its counts start over', async () => {
  mockNative.queue.push({home: s(400, 31)});
  await _perfInternals.report();
  expect(perfEvents()).toEqual([expect.objectContaining({screen: 'home', frames: 400, p90: 31})]);
  expect(_perfInternals.pending.home).toBeUndefined();
});

test('a brief visit is kept, and reported once the visits add up', async () => {
  mockNative.queue.push({search: s(12)}, {search: s(25, 44)});
  await _perfInternals.report();
  expect(perfEvents()).toEqual([]);
  expect(_perfInternals.pending.search.frames).toBe(12); // kept (it used to be deleted here)
  await _perfInternals.report();
  // 12 + 25 frames; the percentiles are the larger sample's
  expect(perfEvents()).toEqual([expect.objectContaining({screen: 'search', frames: 37, p90: 44})]);
  expect(_perfInternals.pending.search).toBeUndefined();
});

test('the timer stops when the quota of events is spent, and nothing more is sent', async () => {
  frameScreen('home'); // starts the two-minute timer
  expect(_perfInternals.timerRunning()).toBe(true);
  // (two events were sent by the tests above; the session's quota is six)
  mockNative.queue.push({a: s(100), b: s(100), c: s(100), d: s(100), e: s(100), f: s(100)});
  await _perfInternals.report();
  expect(perfEvents()).toHaveLength(4);
  expect(_perfInternals.timerRunning()).toBe(false);
  mockNative.queue.push({home: s(900)});
  const takes = mockNative.takeFrameStats.mock.calls.length;
  await _perfInternals.report();
  expect(perfEvents()).toHaveLength(4);
  expect(mockNative.takeFrameStats.mock.calls.length).toBe(takes); // not even read
});
