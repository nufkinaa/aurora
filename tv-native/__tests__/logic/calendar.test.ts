// The Calendar's shared half (src/calendar.ts): the screen's words and the
// helpers the TV's and the phone's screens lay the server's calendar out with,
// and the two requests it makes.
const mockRequest = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/api', () => ({
  apiRequest: (...a: unknown[]) => mockRequest(...a),
  apiPost: (...a: unknown[]) => mockPost(...a),
}));

import {
  afterSave,
  canPlay,
  dayHeading,
  deviceLocale,
  emptyLine,
  entryLabel,
  firstTab,
  loadCalendar,
  saveFromCalendar,
  tabLabel,
  withEntry,
} from '../../src/calendar';
import type {Calendar, CalendarDay, CalendarEntry} from '../../src/calendar';

const entry = (over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  key: 'tt1:2:5',
  kind: 'episode',
  type: 'show',
  imdbId: 'tt1',
  title: 'The Show',
  year: 2024,
  poster: '/art/p.jpg',
  day: '2026-11-09',
  at: 0,
  what: 'New episode',
  detail: 'S2 E5 · The Long Night',
  why: 'In My List · Following',
  out: true,
  state: 'none',
  badge: null,
  canSave: true,
  save: {imdbId: 'tt1', type: 'show', season: 2, episode: 5},
  play: null,
  item: {id: 'disc:tt1', imdbId: 'tt1', type: 'show', title: 'The Show'} as never,
  ...over,
});
const day = (items: CalendarEntry[], over: Partial<CalendarDay> = {}): CalendarDay => ({day: '2026-11-09', label: 'Today', date: '9 Nov', items, ...over});
const cal = (over: Partial<Calendar> = {}): Calendar => ({
  tz: 'Europe/London',
  locale: 'en-GB',
  today: '2026-11-09',
  upcoming: [],
  recent: [],
  counts: {upcoming: 0, recent: 0, titles: 0},
  pending: 0,
  empty: {noTitles: 'Add titles to My List to see them here.', upcoming: 'Nothing coming up.', recent: 'Nothing out lately.', pending: null},
  ...over,
});

beforeEach(() => {
  mockRequest.mockReset();
  mockPost.mockReset();
});

test('tabLabel: the count only when there is one', () => {
  const c = cal({counts: {upcoming: 12, recent: 0, titles: 4}});
  expect(tabLabel(c, 'upcoming')).toBe('Coming up · 12');
  expect(tabLabel(c, 'recent')).toBe('Recently out');
  expect(tabLabel(null, 'upcoming')).toBe('Coming up');
});

test('dayHeading: the label and the date, or the label alone', () => {
  expect(dayHeading(day([]))).toBe('Today · 9 Nov');
  expect(dayHeading(day([], {label: 'Wednesday', date: '12 Nov'}))).toBe('Wednesday · 12 Nov');
  expect(dayHeading(day([], {label: 'Fri 28 Nov', date: null}))).toBe('Fri 28 Nov');
});

test('emptyLine: nothing while loading or when the tab has days; no titles at all; an empty tab', () => {
  expect(emptyLine(null, 'upcoming')).toBeNull();
  const none = cal();
  expect(emptyLine(none, 'upcoming')).toBe('Add titles to My List to see them here.');
  expect(emptyLine(none, 'recent')).toBe('Add titles to My List to see them here.');
  const some = cal({upcoming: [day([entry()])], counts: {upcoming: 1, recent: 0, titles: 3}});
  expect(emptyLine(some, 'upcoming')).toBeNull();
  expect(emptyLine(some, 'recent')).toBe('Nothing out lately.');
});

test('firstTab: Coming up, unless only Recently out has anything', () => {
  expect(firstTab(null)).toBe('upcoming');
  expect(firstTab(cal())).toBe('upcoming');
  expect(firstTab(cal({recent: [day([entry()])]}))).toBe('recent');
  expect(firstTab(cal({upcoming: [day([entry()])], recent: [day([entry()])]}))).toBe('upcoming');
});

test('entryLabel: title, what, detail and badge, the missing ones left out', () => {
  expect(entryLabel(entry({badge: 'On the server'}))).toBe('The Show, New episode, S2 E5 · The Long Night, On the server');
  expect(entryLabel(entry({detail: null, what: 'In cinemas', title: 'Film'}))).toBe('Film, In cinemas');
});

test('canPlay: only with something to play the server has (all of the day, or some)', () => {
  const play = {id: 'ep1', showId: 's1', season: 2, episode: 5};
  expect(canPlay(entry({play, state: 'have'}))).toBe(true);
  expect(canPlay(entry({play, state: 'partial'}))).toBe(true);
  expect(canPlay(entry({play, state: 'saving'}))).toBe(false);
  expect(canPlay(entry({play: null, state: 'have'}))).toBe(false);
});

test('afterSave: the new badge and no second Save — have, saving, waiting; a refusal or nothing changes nothing', () => {
  const e = entry();
  expect(afterSave(e, {ok: true, state: 'have', line: 'x'})).toMatchObject({state: 'have', badge: 'On the server', canSave: false});
  expect(afterSave(e, {ok: true, state: 'saving', line: 'x'})).toMatchObject({state: 'saving', badge: 'Saving', canSave: false});
  expect(afterSave(e, {ok: true, line: 'x'})).toMatchObject({state: 'saving', badge: 'Saving', canSave: false});
  expect(afterSave(e, {ok: true, state: 'waiting', line: 'x'})).toMatchObject({state: 'waiting', badge: 'Waiting for approval', canSave: false});
  expect(afterSave(e, {ok: false, why: 'none', line: 'No copy found.'})).toBe(e);
  expect(afterSave(e, null)).toBe(e);
});

test('withEntry: only the one key changes — the other entries and days stay the same objects', () => {
  const a = entry({key: 'a'});
  const b = entry({key: 'b'});
  const c = entry({key: 'c'});
  const d1 = day([a, b]);
  const d2 = day([c], {day: '2026-11-10', label: 'Tomorrow', date: '10 Nov'});
  const r1 = day([entry({key: 'r'})], {day: '2026-11-08', label: 'Yesterday'});
  const before = cal({upcoming: [d1, d2], recent: [r1]});
  const after = withEntry(before, 'b', e => ({...e, badge: 'Saving'}));
  expect(after).not.toBe(before);
  expect(after.upcoming[0].items[1].badge).toBe('Saving');
  expect(after.upcoming[0].items[0]).toBe(a);
  expect(after.upcoming[1]).toBe(d2);
  expect(after.recent[0]).toBe(r1);
  expect(before.upcoming[0].items[1].badge).toBeNull();
});

test('deviceLocale: the device’s, or en-GB when Intl has none', () => {
  expect(typeof deviceLocale()).toBe('string');
  const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
    throw new Error('no Intl');
  });
  expect(deviceLocale()).toBe('en-GB');
  spy.mockImplementation(() => ({resolvedOptions: () => ({locale: ''})}) as never);
  expect(deviceLocale()).toBe('en-GB');
  spy.mockImplementation(() => ({resolvedOptions: () => ({locale: 'he-IL'})}) as never);
  expect(deviceLocale()).toBe('he-IL');
  spy.mockRestore();
});

test('loadCalendar asks the profile’s calendar with the locale; saveFromCalendar posts the entry’s save', async () => {
  mockRequest.mockResolvedValue(cal());
  await loadCalendar('p 1', 'en-US', null);
  expect(mockRequest).toHaveBeenCalledWith('/api/profiles/p%201/calendar?grid=1&locale=en-US');
  // the device's zone: its days and its today on the month grid
  await loadCalendar('p 1', 'en-US', 'Asia/Jerusalem');
  expect(mockRequest).toHaveBeenLastCalledWith('/api/profiles/p%201/calendar?grid=1&locale=en-US&tz=Asia%2FJerusalem');
  mockPost.mockResolvedValue({ok: true, state: 'saving', line: 'Saving it.'});
  const e = entry();
  await expect(saveFromCalendar('p1', e)).resolves.toEqual({ok: true, state: 'saving', line: 'Saving it.'});
  expect(mockPost).toHaveBeenCalledWith('/api/profiles/p1/calendar/save', {imdbId: 'tt1', type: 'show', season: 2, episode: 5});
});
