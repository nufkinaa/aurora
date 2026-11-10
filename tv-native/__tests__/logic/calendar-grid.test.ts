// The Calendar's month grid, the apps' half (src/calendar.ts): the weeks a
// month needs from the device's first day of the week, the day picked first,
// the day kept on a month change, a Save & watch answer reaching the grid,
// what a day says to talk-back, and the Month / List choice kept on the device.
// The website's twin (public/js/calgrid.js) is held to the same cases in
// test/calendar-grid-parity.test.js.
jest.mock('../../src/api', () => ({apiRequest: jest.fn(), apiPost: jest.fn()}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  afterSave,
  cellLabel,
  cellOf,
  firstPick,
  hasGrid,
  loadCalendarView,
  monthPick,
  monthWeeks,
  saveCalendarView,
  withEntry,
} from '../../src/calendar';
import type {Calendar, CalendarEntry} from '../../src/calendar';

const entry = (key: string, day: string, over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  key,
  kind: 'episode',
  type: 'show',
  imdbId: key.split(':')[0],
  title: `Show ${key}`,
  year: 2025,
  poster: null,
  day,
  at: Date.parse(`${day}T00:00:00Z`),
  what: 'New episode',
  detail: null,
  why: 'In My List',
  out: day <= '2026-11-09',
  state: 'none',
  badge: null,
  canSave: true,
  save: {imdbId: key.split(':')[0], type: 'show', season: 1, episode: 1},
  play: null,
  item: {id: `disc:${key}`} as never,
  ...over,
});
const cal = (items: CalendarEntry[]): Calendar => {
  const byDay: Record<string, {label: string; date: string | null; items: CalendarEntry[]}> = {};
  for (let t = Date.parse('2026-09-25T00:00:00Z'); t <= Date.parse('2027-02-14T00:00:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    byDay[d] = {label: d === '2026-11-09' ? 'Today' : d, date: d === '2026-11-09' ? '9 Nov' : null, items: []};
  }
  for (const e of items) byDay[e.day].items.push(e);
  const m = (key: string, last: string) => ({key, month: key, year: '2026', label: key, first: `${key}-01`, last, count: 0, line: null});
  return {
    tz: 'Asia/Jerusalem',
    locale: 'he-IL',
    today: '2026-11-09',
    upcoming: [],
    recent: [],
    counts: {upcoming: 0, recent: 0, titles: items.length},
    pending: 0,
    empty: {noTitles: 'none', upcoming: 'u', recent: 'r', pending: null, month: 'm', day: 'd'},
    grid: {v: 1, from: '2026-09-25', to: '2027-02-14', weekStart: 0, weekdays: [], months: [m('2026-10', '2026-10-31'), m('2026-11', '2026-11-30'), m('2026-12', '2026-12-31'), m('2027-01', '2027-01-31')], byDay},
  };
};

test('monthWeeks: as many weeks as the month needs, from the first day of the week', () => {
  // November 2026 starts on a Sunday: a Sunday-first week fits it in five, Monday-first needs six
  const sun = monthWeeks('2026-11', 0);
  expect(sun).toHaveLength(5);
  expect(sun[0][0]).toBe('2026-11-01');
  expect(sun[4][6]).toBe('2026-12-05');
  const mon = monthWeeks('2026-11', 1);
  expect(mon).toHaveLength(6);
  expect(mon[0][0]).toBe('2026-10-26');
  expect(mon[0][6]).toBe('2026-11-01'); // the 1st on the week's last day
  expect(mon[5][6]).toBe('2026-12-06');
  // February 2026: Sunday the 1st, 28 days — exactly four Sunday-first weeks
  expect(monthWeeks('2026-02', 0)).toHaveLength(4);
  // a Saturday-first week (Egypt): August 2026 starts on a Saturday
  expect(monthWeeks('2026-08', 6)[0][0]).toBe('2026-08-01');
  for (const w of monthWeeks('2026-08', 6)) expect(w).toHaveLength(7);
});

test('firstPick: today when it has something, else the next day that does, else today', () => {
  expect(firstPick(cal([entry('a:1:1', '2026-11-09'), entry('b:1:1', '2026-11-11')]))).toBe('2026-11-09');
  expect(firstPick(cal([entry('a:1:1', '2026-11-02'), entry('b:1:1', '2026-11-11')]))).toBe('2026-11-11');
  expect(firstPick(cal([entry('b:1:1', '2026-12-20')]))).toBe('2026-12-20'); // a later month
  expect(firstPick(cal([entry('a:1:1', '2026-11-02')]))).toBe('2026-11-09');
  expect(firstPick(null)).toBeNull();
});

test('monthPick: today in today’s month, else the same day of the month (the 31st: the month’s last)', () => {
  const g = cal([]).grid!;
  expect(monthPick(g, '2026-10-31', '2026-11', '2026-11-09')).toBe('2026-11-09');
  expect(monthPick(g, '2026-12-31', '2026-10', '2026-11-09')).toBe('2026-10-31');
  expect(monthPick(g, '2027-01-31', '2026-12', '2026-11-09')).toBe('2026-12-31');
  expect(monthPick(g, '2026-10-31', '2026-12', '2026-11-09')).toBe('2026-12-31');
  expect(monthPick({...g, months: g.months.map(m => (m.key === '2026-12' ? {...m, last: '2026-12-30'} : m))}, '2026-10-31', '2026-12', '2026-11-09')).toBe('2026-12-30');
});

test('cellOf and cellLabel: what a day is and what it says to talk-back', () => {
  const c = cal([entry('a:1:1', '2026-11-09', {title: 'Night Harbour'}), entry('b:2:1', '2026-11-09', {title: 'Low Orbit', what: 'Season 2 premiere'})]);
  const today = cellOf(c.grid, '2026-11-09', '2026-11', c.today);
  expect([today.n, today.inMonth, today.past, today.today, today.items.length]).toEqual([9, true, false, true, 2]);
  expect(cellLabel(c, today)).toBe('Today · 9 Nov: Night Harbour, New episode; Low Orbit, Season 2 premiere');
  const other = cellOf(c.grid, '2026-10-31', '2026-11', c.today);
  expect([other.inMonth, other.past, other.items]).toEqual([false, true, []]);
  expect(cellLabel(c, other)).toBe('2026-10-31');
});

test('withEntry: a Save & watch answer reaches the month grid too', () => {
  const e = entry('a:1:1', '2026-11-05');
  const c = {...cal([e]), recent: [{day: '2026-11-05', label: 'Thursday', date: '5 Nov', items: [e]}]};
  const after = withEntry(c, e.key, x => afterSave(x, {ok: true, state: 'waiting', line: 'Asked'}));
  expect(after.grid!.byDay['2026-11-05'].items[0]).toMatchObject({state: 'waiting', badge: 'Waiting for approval', canSave: false});
  expect(after.recent[0].items[0].badge).toBe('Waiting for approval');
  expect(c.grid!.byDay['2026-11-05'].items[0].state).toBe('none'); // (a new calendar, the old one untouched)
  // an older server's answer, without a grid: as before
  const old = {...c, grid: undefined};
  expect(withEntry(old, e.key, x => x).grid).toBeUndefined();
});

test('hasGrid: only an answer with months to draw', () => {
  expect(hasGrid(cal([]))).toBe(true);
  expect(hasGrid({...cal([]), grid: undefined})).toBe(false);
  expect(hasGrid({...cal([]), grid: {...cal([]).grid!, months: []}})).toBe(false);
  expect(hasGrid(null)).toBe(false);
});

test('the Month / List choice is kept on the device; Month until told otherwise', async () => {
  await AsyncStorage.removeItem('aurora.calendarView');
  expect(await loadCalendarView()).toBe('month');
  await saveCalendarView('list');
  expect(await loadCalendarView()).toBe('list');
  await saveCalendarView('month');
  expect(await loadCalendarView()).toBe('month');
});
