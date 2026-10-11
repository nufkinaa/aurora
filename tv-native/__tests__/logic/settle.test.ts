// The one "at rest" clock (src/settle.ts) and the two things that read it in
// plain modules: the Detail warm-up on a dwell (prefetch.ts) and the pictures
// fetched ahead (artPrefetch.ts — its own file has the rest).
import {noteMove, whenSettled, isSettled, onMove, SETTLE_MS, _settleInternals} from '../../src/settle';
import {api, setBaseUrl, HeroItem} from '../../src/api';
import {warmItem, stopPrefetch, DWELL_MS} from '../../src/prefetch';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  _settleInternals.reset();
});
afterEach(() => {
  stopPrefetch();
  jest.useRealTimers();
});

test('runs once, after the rest, counted from the ask when nothing has moved', () => {
  const fn = jest.fn();
  whenSettled(fn);
  jest.advanceTimersByTime(SETTLE_MS - 1);
  expect(fn).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(fn).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(_settleInternals.armed()).toBe(false); // nothing waiting: no timer left running
});

test('a held key (a move every 110 ms) never lets it run; it runs SETTLE_MS after the last move', () => {
  const fn = jest.fn();
  whenSettled(fn);
  for (let i = 0; i < 40; i++) {
    jest.advanceTimersByTime(110);
    noteMove();
  }
  expect(fn).not.toHaveBeenCalled();
  jest.advanceTimersByTime(SETTLE_MS - 1);
  expect(fn).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('a move costs no timer: during a held key the clock re-arms once per rest, not once per press', () => {
  const set = jest.spyOn(globalThis, 'setTimeout');
  whenSettled(() => {});
  const before = set.mock.calls.length;
  for (let i = 0; i < 30; i++) {
    jest.advanceTimersByTime(50); // 1.5 s of key repeat
    noteMove();
  }
  // 1.5 s / 300 ms = 5 firings that found nothing due and re-armed
  expect(set.mock.calls.length - before).toBeLessThanOrEqual(6);
  set.mockRestore();
});

test('withdrawn before the rest: never runs', () => {
  const fn = jest.fn();
  const off = whenSettled(fn);
  jest.advanceTimersByTime(100);
  off();
  jest.advanceTimersByTime(5000);
  expect(fn).not.toHaveBeenCalled();
});

test('each ask has its own rest; a longer one is not run with a shorter one', () => {
  const short = jest.fn();
  const long = jest.fn();
  whenSettled(long, 450);
  whenSettled(short, 300);
  jest.advanceTimersByTime(300);
  expect(short).toHaveBeenCalledTimes(1);
  expect(long).not.toHaveBeenCalled();
  jest.advanceTimersByTime(150);
  expect(long).toHaveBeenCalledTimes(1);
});

test('an ask made from inside a settled callback waits for its own rest', () => {
  const second = jest.fn();
  whenSettled(() => whenSettled(second));
  jest.advanceTimersByTime(SETTLE_MS);
  expect(second).not.toHaveBeenCalled();
  jest.advanceTimersByTime(SETTLE_MS);
  expect(second).toHaveBeenCalledTimes(1);
});

test('isSettled follows the last move; onMove hears every move until withdrawn', () => {
  const heard = jest.fn();
  const off = onMove(heard);
  noteMove();
  expect(isSettled()).toBe(false);
  jest.advanceTimersByTime(SETTLE_MS);
  expect(isSettled()).toBe(true);
  noteMove();
  expect(heard).toHaveBeenCalledTimes(2);
  off();
  noteMove();
  expect(heard).toHaveBeenCalledTimes(2);
});

describe('the Detail warm-up on a dwell', () => {
  const card = (n: number) => ({id: `lib${n}`, imdbId: `tt000${n}`, title: `t${n}`, type: 'movie'}) as HeroItem;
  let meta: jest.SpyInstance;
  let item: jest.SpyInstance;
  beforeEach(() => {
    setBaseUrl('http://tv.test');
    meta = jest.spyOn(api, 'discoverMeta').mockResolvedValue({} as never);
    item = jest.spyOn(api, 'item').mockResolvedValue({} as never);
  });
  afterEach(() => {
    meta.mockRestore();
    item.mockRestore();
  });

  test('a card focus holds for DWELL_MS: its two reads are made, once', () => {
    noteMove();
    warmItem(card(1));
    jest.advanceTimersByTime(DWELL_MS - 1);
    expect(meta).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith('movie', 'tt0001');
    expect(item).toHaveBeenCalledTimes(1);
  });

  test('a run along a shelf reads nothing; only the card it stops on is read', () => {
    for (let i = 1; i <= 12; i++) {
      noteMove();
      warmItem(card(i));
      jest.advanceTimersByTime(110);
    }
    expect(meta).not.toHaveBeenCalled();
    jest.advanceTimersByTime(DWELL_MS);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith('movie', 'tt00012');
  });

  test('focus leaves for something that is not a card (a hero button, the rail): the card it left is not read', () => {
    noteMove();
    warmItem(card(3));
    jest.advanceTimersByTime(400);
    noteMove(); // focus went somewhere that never calls warmItem
    jest.advanceTimersByTime(5000);
    expect(meta).not.toHaveBeenCalled(); // (the old private timer fired at 450 regardless)
  });
});
