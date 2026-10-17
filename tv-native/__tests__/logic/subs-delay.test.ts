// The subtitle delay, remembered per title and track on this box
// (playback/subDelay.ts).
import {
  delayKey,
  delaysForItem,
  loadDelays,
  MAX_DELAY_SEC,
  MAX_ENTRIES,
  readDelays,
  roundDelay,
  saveDelay,
  SUB_DELAY_KEY,
  withDelay,
} from '../../src/playback/subDelay';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const store: Map<string, string> = require('@react-native-async-storage/async-storage').__store;

beforeEach(() => store.clear());

describe('the rules', () => {
  test('tenths of a second, no float drift, no -0, bounded', () => {
    expect(roundDelay(0.1 + 0.2)).toBe(0.3);
    expect(roundDelay(-0.5 + 0.5)).toBe(0);
    expect(Object.is(roundDelay(-0.01), 0)).toBe(true);
    expect(roundDelay(2.25)).toBe(2.3);
    expect(roundDelay(99999)).toBe(MAX_DELAY_SEC);
    expect(roundDelay(-99999)).toBe(-MAX_DELAY_SEC);
    expect(roundDelay(NaN)).toBe(0);
  });

  test('a write moves the entry to the end; 0 removes it', () => {
    let m = withDelay({}, 'a|1', 2);
    m = withDelay(m, 'b|1', -1.5);
    m = withDelay(m, 'a|1', 2.5);
    expect(Object.entries(m)).toEqual([
      ['b|1', -1.5],
      ['a|1', 2.5],
    ]);
    m = withDelay(m, 'b|1', 0); // Reset
    expect(m).toEqual({'a|1': 2.5});
  });

  test('capped to the latest entries', () => {
    let m = {};
    for (let i = 0; i < MAX_ENTRIES + 25; i++) m = withDelay(m, `t${i}|u`, 1);
    const keys = Object.keys(m);
    expect(keys).toHaveLength(MAX_ENTRIES);
    expect(keys[0]).toBe('t25|u');
    expect(keys[keys.length - 1]).toBe(`t${MAX_ENTRIES + 24}|u`);
  });

  test('a stored blob is read defensively', () => {
    expect(readDelays(null)).toEqual({});
    expect(readDelays('not json')).toEqual({});
    expect(readDelays('[1,2]')).toEqual({});
    expect(readDelays(JSON.stringify({'x|/a': 1.25, 'x|/b': 'two', 'x|/c': 0, nokey: 3, 'x|/d': Infinity}))).toEqual({'x|/a': 1.3});
  });

  test('one title’s delays, by track url (urls may contain "|" too)', () => {
    const m = {[delayKey('42', '/stream/subtitle/abc')]: 1.5, [delayKey('42', '/stream/websub?p=os&r=a|b')]: -2, [delayKey('420', '/x')]: 9};
    expect(delaysForItem(m, '42')).toEqual({'/stream/subtitle/abc': 1.5, '/stream/websub?p=os&r=a|b': -2});
    expect(delaysForItem(m, 'torrent|abc|0')).toEqual({});
  });
});

describe('on this box', () => {
  test('saved, read back for the same title and track, Reset forgets it', async () => {
    await saveDelay('film1', '/stream/subtitle/he', 2.5);
    await saveDelay('film1', '/stream/subtitle/en', -1);
    await saveDelay('film2', '/stream/subtitle/he', 4);
    expect(delaysForItem(await loadDelays(), 'film1')).toEqual({'/stream/subtitle/he': 2.5, '/stream/subtitle/en': -1});
    await saveDelay('film1', '/stream/subtitle/he', 0);
    expect(delaysForItem(await loadDelays(), 'film1')).toEqual({'/stream/subtitle/en': -1});
    expect(JSON.parse(store.get(SUB_DELAY_KEY) as string)).toEqual({'film2|/stream/subtitle/he': 4, 'film1|/stream/subtitle/en': -1});
  });

  test('quick nudges land in order', async () => {
    const all = [0.5, 1, 1.5, 2, 2.5].map(v => saveDelay('f', '/s', v));
    await Promise.all(all);
    expect(await loadDelays()).toEqual({'f|/s': 2.5});
  });

  test('a damaged entry on disk reads as nothing', async () => {
    store.set(SUB_DELAY_KEY, '{oops');
    expect(await loadDelays()).toEqual({});
    await saveDelay('f', '/s', 1);
    expect(await loadDelays()).toEqual({'f|/s': 1});
  });
});
