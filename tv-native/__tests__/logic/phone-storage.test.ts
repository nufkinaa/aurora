// The phone's storage rules (src/phone/offline/storage.ts): where copies go, what counts as
// watched (Remove watched, a press with Undo), the place's groups and lines, and "Keep the next
// episode ready" — which only ADDS. No space limit and no tidy-up any more: nothing leaves this
// device by itself, and there is no cap (elia, 2026-11-10/11).
import {
  Copy,
  copyLine,
  currentVolume,
  finishedFrom,
  GB,
  groupSaved,
  hasChoice,
  isWatched,
  readNext,
  roomLine,
  showLine,
  smartCandidates,
  STORAGE_DEFAULTS,
  usedBytes,
  volumeName,
  Volume,
  watchedCopies,
} from '../../src/phone/offline/storage';
import {fmtSize} from '../../src/phone/offline/rules';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
declare const __dirname: string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 12);
const copy = (id: string, o: Partial<Copy> = {}): Copy => ({id, profileId: 'p1', title: id, state: 'done', sizeBytes: 1 * GB, duration: 2700, at: NOW - 10 * DAY, ...o});

describe('the defaults: everything new is OFF', () => {
  test('no SD card choice, no keep-next — and no limit or tidy-up at all', () => {
    expect(STORAGE_DEFAULTS).toEqual({volume: null, keepNext: false, keepNextAt: 0});
    expect(Object.keys(STORAGE_DEFAULTS)).not.toContain('limitGb');
    expect(Object.keys(STORAGE_DEFAULTS)).not.toContain('tidyAfter');
  });
  test('nothing in the store removes a copy by itself: removal is only ever the person’s press', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/phone/offline/store.ts'), 'utf-8');
    expect(src).not.toMatch(/tidyUp|dueForTidy|makeRoom|limitGb\s*>/);
    // removeCopy (the file actually going) is reached only from removeOffline's Undo timer
    const calls = src.match(/removeCopy\(/g) || [];
    expect(calls.length).toBe(2); // the definition and the one call after Undo's 6 s
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

describe('watched, and Remove watched', () => {
  test('what is counted: done and on their way, every profile; a failed one is nothing', () => {
    expect(usedBytes([copy('a'), copy('b', {state: 'saving'}), copy('c', {state: 'failed'}), copy('d', {profileId: 'p2'})])).toBe(3 * GB);
  });
  test('watched = finished here, or past 95 %', () => {
    expect(isWatched(copy('a', {finishedAt: NOW}))).toBe(true);
    expect(isWatched(copy('a', {position: 2600}))).toBe(true);
    expect(isWatched(copy('a', {position: 2500}))).toBe(false);
  });
  test('Remove watched offers the profile’s own finished copies only — never another profile’s, never one on its way', () => {
    const all = [copy('w', {finishedAt: NOW}), copy('u'), copy('o', {profileId: 'p2', finishedAt: NOW}), copy('s', {state: 'saving', position: 2700})];
    expect(watchedCopies(all, 'p1').map(c => c.id)).toEqual(['w']);
  });
  test('finished as the server says it (the TV, the website, streamed)', () => {
    expect(finishedFrom({position: 2600, duration: 2700, updatedAt: NOW - DAY}, NOW)).toBe(NOW - DAY);
    expect(finishedFrom({finished: true}, NOW)).toBe(NOW);
    expect(finishedFrom({position: 100, duration: 2700}, NOW)).toBeNull();
    expect(finishedFrom(null, NOW)).toBeNull();
  });
  test('the room line', () => {
    expect(roomLine(6.2 * GB, 18 * GB, fmtSize)).toBe('6.2 GB saved here · room for ≈ 18.0 GB more');
    expect(roomLine(0, 18 * GB, fmtSize)).toBe('room for ≈ 18.0 GB more');
  });
});

describe('the place: films as rows, a show as one group', () => {
  test('groups, episodes in order, the next one not finished', () => {
    const all = [
      copy('f1', {savedAt: NOW - 3}),
      copy('e3', {showId: 's', showTitle: 'Show', season: 1, episode: 3, savedAt: NOW - 1}),
      copy('e1', {showId: 's', showTitle: 'Show', season: 1, episode: 1, finishedAt: NOW, savedAt: NOW - 2}),
      copy('e2', {showId: 's', showTitle: 'Show', season: 1, episode: 2}),
      copy('x', {state: 'saving'}),
    ];
    const g = groupSaved(all);
    expect(g.map(x => x.kind)).toEqual(['show', 'film']);
    const show = g[0] as Extract<(typeof g)[number], {kind: 'show'}>;
    expect(show.episodes.map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(show.next?.id).toBe('e2');
    expect(show.watched).toBe(1);
    expect(showLine(show, fmtSize)).toBe('3 episodes · 3.0 GB · 1 watched');
  });
  test('a film’s line (the site’s)', () => {
    expect(copyLine({...copy('f', {position: 1500, duration: 5820, quality: 'original'}), audioLabel: 'English'}, fmtSize)).toBe('1 h 12 min left · 1.0 GB · Original quality · English');
    expect(copyLine(copy('f', {duration: 2700, quality: '720'}), fmtSize)).toBe('45 min · 1.0 GB · 720p');
    expect(copyLine(copy('f', {finishedAt: NOW, quality: '720'}), fmtSize)).toBe('Watched · 1.0 GB · 720p');
  });
});

describe('Keep the next episode ready', () => {
  const ep = (id: string, o: Partial<Copy> = {}) => copy(id, {showId: 's', showTitle: 'Show', season: 1, episode: Number(id.slice(1)) || 1, ...o});
  test('only episodes saved here, finished AFTER it was turned on, once each', () => {
    const since = NOW - DAY;
    const all = [
      ep('e1', {finishedAt: NOW - 2 * DAY}), // finished before it was on: not a flood
      ep('e2', {finishedAt: NOW - 1000}),
      ep('e3', {position: 100}),
      copy('film', {finishedAt: NOW}), // a film has no next episode
      ep('e5', {profileId: 'p2', finishedAt: NOW}), // another profile's
      ep('e6', {state: 'saving', finishedAt: NOW}),
    ];
    expect(smartCandidates(all, 'p1', since, new Set()).map(c => c.id)).toEqual(['e2']);
    expect(smartCandidates(all, 'p1', since, new Set(['e2']))).toEqual([]);
  });
  test('finished as the server says it counts too (watched on the TV)', () => {
    const all = [ep('e3', {position: 100})];
    expect(smartCandidates(all, 'p1', NOW - DAY, new Set(), {e3: {position: 2650, duration: 2700, updatedAt: NOW}}).map(c => c.id)).toEqual(['e3']);
    expect(smartCandidates(all, 'p1', NOW - DAY, new Set(), {e3: {position: 2650, duration: 2700, updatedAt: NOW - 2 * DAY}})).toEqual([]);
  });
  test('the server’s answer: a library episode to save, or one on its way to wish for', () => {
    expect(readNext({next: {kind: 'library', id: 'ab12', season: 1, episode: 2}})).toEqual({kind: 'library', id: 'ab12'});
    expect(readNext({next: {kind: 'stream', imdbId: 'tt1', season: 2, episode: 1, title: 'Pilot'}})).toEqual({kind: 'stream', imdbId: 'tt1', season: 2, episode: 1, title: 'Pilot'});
    expect(readNext({next: null})).toBeNull();
    expect(readNext(null)).toBeNull();
    expect(readNext({next: {kind: 'stream'}})).toBeNull();
  });
});
