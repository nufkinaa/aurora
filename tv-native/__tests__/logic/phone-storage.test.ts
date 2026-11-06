// The phone's storage choices (src/phone/offline/storage.ts): where copies go, the space
// limit and what it offers to remove, tidy-up timing, keep-next picking and its Wi-Fi rule.
import {
  Copy,
  currentVolume,
  dueForTidy,
  finishedFrom,
  GB,
  hasChoice,
  isWatched,
  keepNextNow,
  keepNextQuality,
  limitLabel,
  makeRoom,
  nextToKeep,
  overLimit,
  STORAGE_DEFAULTS,
  TIDY_AFTER_MS,
  usedBytes,
  volumeName,
  Volume,
} from '../../src/phone/offline/storage';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12);
const copy = (id: string, o: Partial<Copy> = {}): Copy => ({id, profileId: 'p1', title: id, state: 'done', sizeBytes: 1 * GB, duration: 2700, at: NOW - 10 * DAY, ...o});

describe('the defaults: everything new is OFF', () => {
  test('no SD card choice, no limit, no tidy-up, no keep-next', () => {
    expect(STORAGE_DEFAULTS).toEqual({volume: null, limitGb: 0, tidyAfter: false, keepNext: false});
  });
});

describe('Save to (this phone / SD card)', () => {
  const phone: Volume = {path: '/storage/emulated/0/Android/data/com.aurora.phone/files', free: 9 * GB, total: 64 * GB, removable: false, primary: true, mounted: true};
  const sd: Volume = {path: '/storage/0000-0000/Android/data/com.aurora.phone/files', free: 30 * GB, total: 32 * GB, removable: true, primary: false, mounted: true};
  test('names', () => {
    expect(volumeName(phone)).toBe('This phone');
    expect(volumeName(sd, 1)).toBe('SD card');
  });
  test('the chosen card while it is there; the phone when it is taken out', () => {
    expect(currentVolume([phone, sd], sd.path)).toBe(sd);
    expect(currentVolume([phone, {...sd, mounted: false}], sd.path)).toBe(phone);
    expect(currentVolume([phone], sd.path)).toBe(phone);
    expect(currentVolume([phone, sd], null)).toBe(phone);
  });
  test('the picker only when there is a card', () => {
    expect(hasChoice([phone])).toBe(false);
    expect(hasChoice([phone, sd])).toBe(true);
    expect(hasChoice([phone, {...sd, mounted: false}])).toBe(false);
  });
});

describe('the space limit', () => {
  test('words', () => {
    expect(limitLabel(0)).toBe('No limit');
    expect(limitLabel(10)).toBe('At most 10 GB');
  });
  test('what is counted: done and on their way, every profile; a failed one is nothing', () => {
    expect(usedBytes([copy('a'), copy('b', {state: 'saving'}), copy('c', {state: 'failed'}), copy('d', {profileId: 'p2'})])).toBe(3 * GB);
  });
  test('no limit never says full', () => {
    expect(overLimit(100 * GB, 50 * GB, 0)).toBe(false);
    expect(overLimit(4 * GB, 1 * GB, 5)).toBe(false);
    expect(overLimit(4 * GB, 1.5 * GB, 5)).toBe(true);
  });
  test('fits already: nothing to remove', () => {
    expect(makeRoom([copy('a')], 'p1', 1 * GB, 5)).toEqual([]);
  });
  test('full: the OLDEST watched copy is offered, and only as many as it takes', () => {
    const all = [
      copy('new-watched', {finishedAt: NOW - 1 * DAY}),
      copy('old-watched', {finishedAt: NOW - 5 * DAY}),
      copy('unwatched', {position: 100}),
      copy('half', {position: 1300}),
    ];
    // 4 GB used, limit 4, adding 1: one has to go — the oldest watched
    expect(makeRoom(all, 'p1', 1 * GB, 4)!.map(c => c.id)).toEqual(['old-watched']);
    // adding 2: both watched ones
    expect(makeRoom(all, 'p1', 2 * GB, 4)!.map(c => c.id)).toEqual(['old-watched', 'new-watched']);
  });
  test('watched counts as the server does: past 95 %', () => {
    expect(isWatched({duration: 1000, position: 960})).toBe(true);
    expect(isWatched({duration: 1000, position: 900})).toBe(false);
    expect(isWatched({duration: 0, position: 0, finishedAt: NOW})).toBe(true);
  });
  test('not enough even with every watched copy gone: nothing offered (null)', () => {
    expect(makeRoom([copy('w', {finishedAt: NOW - DAY}), copy('u')], 'p1', 3 * GB, 2)).toBeNull();
  });
  test('never another profile’s copy, never one still on its way, never the one being saved', () => {
    const all = [copy('theirs', {profileId: 'p2', finishedAt: NOW - 9 * DAY}), copy('moving', {state: 'saving', finishedAt: NOW - 9 * DAY}), copy('self', {finishedAt: NOW - 9 * DAY}), copy('mine', {finishedAt: NOW - 2 * DAY})];
    expect(makeRoom(all, 'p1', 1 * GB, 4, 'self')!.map(c => c.id)).toEqual(['mine']);
  });
});

describe('tidy up after watching', () => {
  const ep = (id: string, o: Partial<Copy> = {}) => copy(id, {showId: 's1', season: 1, episode: 1, ...o});
  test('an episode goes a day after it is finished — not a minute before', () => {
    expect(dueForTidy([ep('e', {finishedAt: NOW - TIDY_AFTER_MS})], NOW).map(c => c.id)).toEqual(['e']);
    expect(dueForTidy([ep('e', {finishedAt: NOW - TIDY_AFTER_MS + 60000})], NOW)).toEqual([]);
  });
  test('never a film, never one not finished, never one still saving, never the one playing', () => {
    const all = [copy('film', {finishedAt: NOW - 3 * DAY}), ep('open'), ep('saving', {state: 'saving', finishedAt: NOW - 3 * DAY}), ep('playing', {finishedAt: NOW - 3 * DAY}), ep('due', {finishedAt: NOW - 3 * DAY})];
    expect(dueForTidy(all, NOW, 'playing').map(c => c.id)).toEqual(['due']);
  });
  test('finished, as the server tells it: its flag or past 95 %, at the time it last moved', () => {
    expect(finishedFrom({position: 10, duration: 100, finished: true, updatedAt: NOW - DAY}, NOW)).toBe(NOW - DAY);
    expect(finishedFrom({position: 97, duration: 100, updatedAt: NOW - 2 * DAY}, NOW)).toBe(NOW - 2 * DAY);
    expect(finishedFrom({position: 50, duration: 100, updatedAt: NOW - DAY}, NOW)).toBeNull();
    expect(finishedFrom(null, NOW)).toBeNull();
    // a server clock ahead of the phone's never puts it in the future
    expect(finishedFrom({finished: true, updatedAt: NOW + DAY}, NOW)).toBe(NOW);
  });
});

describe('keep the next episodes ready', () => {
  const eps = [
    {id: 's0e1', season: 0, episode: 1},
    {id: 's1e1', season: 1, episode: 1},
    {id: 's1e2', season: 1, episode: 2},
    {id: 's1e3', season: 1, episode: 3},
    {id: 's2e1', season: 2, episode: 1},
  ];
  test('the next 2 after the one watched, in order, across a season', () => {
    expect(nextToKeep(eps, {season: 1, episode: 1}, new Set()).map(e => e.id)).toEqual(['s1e2', 's1e3']);
    expect(nextToKeep(eps, {season: 1, episode: 3}, new Set()).map(e => e.id)).toEqual(['s2e1']);
    expect(nextToKeep([...eps].reverse(), {season: 1, episode: 2}, new Set()).map(e => e.id)).toEqual(['s1e3', 's2e1']);
  });
  test('the window stays 2: one already saved (or on its way) is not saved again, and nothing past the window is added', () => {
    expect(nextToKeep(eps, {season: 1, episode: 1}, new Set(['s1e2'])).map(e => e.id)).toEqual(['s1e3']);
    expect(nextToKeep(eps, {season: 1, episode: 1}, new Set(['s1e2', 's1e3']))).toEqual([]);
  });
  test('specials are left out, unless a special is what is being watched', () => {
    expect(nextToKeep(eps, {season: 1, episode: 3}, new Set()).some(e => e.season === 0)).toBe(false);
    expect(nextToKeep(eps, {season: 0, episode: 1}, new Set()).map(e => e.id)).toEqual(['s1e1', 's1e2']);
  });
  test('the last episode: nothing to keep', () => {
    expect(nextToKeep(eps, {season: 2, episode: 1}, new Set())).toEqual([]);
  });
  test('Wi-Fi only, and only when it is turned on', () => {
    expect(keepNextNow(true, 'wifi')).toBe(true);
    expect(keepNextNow(true, 'cellular')).toBe(false);
    expect(keepNextNow(true, 'other')).toBe(false);
    expect(keepNextNow(true, 'none')).toBe(false);
    expect(keepNextNow(false, 'wifi')).toBe(false);
  });
  test('the quality: the person’s, or 720p when they are asked each time', () => {
    expect(keepNextQuality('ask')).toBe('720');
    expect(keepNextQuality('480')).toBe('480');
    expect(keepNextQuality('original')).toBe('original');
  });
});
