// The Calendar — the TV's and the phone's shared half (screens/Calendar.tsx,
// phone/screens/Calendar.tsx). The server makes the calendar and its words
// (src/media/calendar.js: GET /api/profiles/:id/calendar), so all three apps
// print the same ones; this file only asks for it, says the few words of the
// screen itself, and turns a Save & watch answer into the card's new state.
// PURE apart from the two requests and the remembered view (tested in
// __tests__/logic/calendar.test.ts and calendar-grid.test.ts).
// The website's copy of these words: public/js/screens/calendar.js, and of the
// month grid's: public/js/calgrid.js (test/calendar-grid-parity.test.js keeps
// the two in step).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {apiPost, apiRequest} from './api';
import type {HeroItem} from './api';

export type CalendarTab = 'upcoming' | 'recent';
export type CalendarState = 'have' | 'partial' | 'saving' | 'waiting' | 'none';

export type CalendarEntry = {
  key: string;
  kind: 'episode' | 'premiere' | 'cinema' | 'home';
  type: 'show' | 'movie';
  imdbId: string;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop?: string | null;
  day: string;
  at: number;
  /** "Season 2 premiere", "New episode", "8 new episodes", "In cinemas", "Out to stream or buy" */
  what: string;
  /** "S2 E5 · The Long Night", "S3 E1–E8 · 8 episodes" (films: null) */
  detail: string | null;
  season?: number;
  episode?: number;
  /** "In My List · Following" */
  why: string;
  out: boolean;
  state: CalendarState;
  /** "On the server", "1 of 3 on the server", "Saving", "Waiting for approval" */
  badge: string | null;
  canSave: boolean;
  save: {imdbId: string; type: 'show' | 'movie'; season?: number; episode?: number} | null;
  /** on the server: the library item to play (an episode carries its showId) */
  play: {id: string; showId: string | null; season: number | null; episode: number | null} | null;
  /** what a press opens — the shared openItem's card shape */
  item: HeroItem;
};
export type CalendarDay = {day: string; label: string; date: string | null; items: CalendarEntry[]};
/** One day of the month grid: its heading ("Today" + "9 Nov", "Fri 28 Nov" + null) and its releases. */
export type CalendarGridDay = {label: string; date: string | null; items: CalendarEntry[]};
export type CalendarMonth = {key: string; month: string; year: string; label: string; first: string; last: string; count: number; line: string | null};
/** The month grid (server 1.15.27+): every day of the months a person can page through. */
export type CalendarGrid = {
  v: number;
  from: string;
  to: string;
  /** the device's first day of the week: 0 Sunday … 6 Saturday */
  weekStart: number;
  /** in the device's order */
  weekdays: {short: string; narrow: string}[];
  months: CalendarMonth[];
  byDay: Record<string, CalendarGridDay>;
};
export type CalendarNext = {key: string; day: string; title: string; what: string; kind: CalendarEntry['kind']; when: string};
export type Calendar = {
  tz: string;
  locale: string;
  today: string;
  upcoming: CalendarDay[];
  recent: CalendarDay[];
  counts: {upcoming: number; recent: number; titles: number};
  pending: number;
  empty: {noTitles: string; upcoming: string; recent: string; pending: string | null; month?: string; day?: string};
  /** an older server has neither: the list is all there is */
  grid?: CalendarGrid;
  next?: CalendarNext | null;
};
export type CalendarSaveResult = {ok: boolean; state?: 'have' | 'saving' | 'waiting'; why?: string; line: string};

// ---- the screen's own words (the website's are the same) ----
export const CALENDAR_TITLE = 'Calendar';
export const CALENDAR_TABS: {key: CalendarTab; label: string}[] = [
  {key: 'upcoming', label: 'Coming up'},
  {key: 'recent', label: 'Recently out'},
];
export const SAVE_WORD = 'Save & watch';
export const SAVING_WORD = 'Saving…';
export const PLAY_WORD = 'Play';
export const FAILED_LINE = "Couldn't load the calendar right now.";
export const RETRY_WORD = 'Try again';
export const SAVE_FAILED = "Couldn't ask for that download right now.";

/** "Coming up · 12" — the count only when there is one. */
export const tabLabel = (cal: Calendar | null, tab: CalendarTab) => {
  const label = CALENDAR_TABS.find(t => t.key === tab)!.label;
  const n = cal ? cal.counts[tab] : 0;
  return n > 0 ? `${label} · ${n}` : label;
};

/** "Today · 9 Nov", "Wednesday · 12 Nov", "Fri 28 Nov". */
export const dayHeading = (d: CalendarDay) => (d.date ? `${d.label} · ${d.date}` : d.label);

/** What the tab says when it has nothing, or null. */
export const emptyLine = (cal: Calendar | null, tab: CalendarTab): string | null => {
  if (!cal) return null;
  if ((cal[tab] || []).length) return null;
  if (!cal.counts.titles) return cal.empty.noTitles;
  return cal.empty[tab];
};

/** The tab to open on: Coming up, unless only Recently out has anything. */
export const firstTab = (cal: Calendar | null): CalendarTab =>
  cal && !cal.upcoming.length && cal.recent.length ? 'recent' : 'upcoming';

/** The one line a screen reader (and the TV's talk-back) says for a card. */
export const entryLabel = (e: CalendarEntry) =>
  [e.title, e.what, e.detail, e.badge].filter(Boolean).join(', ');

/** Play when the server has it (all of the day's episodes, or some). */
export const canPlay = (e: CalendarEntry) => !!e.play && (e.state === 'have' || e.state === 'partial');

/** The card once Save & watch answered: its new badge, no second Save. */
const BADGES: Record<string, string> = {have: 'On the server', saving: 'Saving', waiting: 'Waiting for approval'};
export const afterSave = (e: CalendarEntry, r: CalendarSaveResult | null): CalendarEntry => {
  if (!r || !r.ok) return e;
  const state = r.state === 'have' ? 'have' : r.state === 'waiting' ? 'waiting' : 'saving';
  return {...e, state, badge: BADGES[state], canSave: false};
};
/** The same, applied to the whole calendar (both tabs and the month grid: a key is on one day only). */
export const withEntry = (cal: Calendar, key: string, next: (e: CalendarEntry) => CalendarEntry): Calendar => {
  const map = (days: CalendarDay[]) => days.map(d => (d.items.some(i => i.key === key) ? {...d, items: d.items.map(i => (i.key === key ? next(i) : i))} : d));
  const out: Calendar = {...cal, upcoming: map(cal.upcoming), recent: map(cal.recent)};
  if (cal.grid) {
    const byDay: Record<string, CalendarGridDay> = {};
    for (const [k, d] of Object.entries(cal.grid.byDay)) byDay[k] = d.items.some(i => i.key === key) ? {...d, items: d.items.map(i => (i.key === key ? next(i) : i))} : d;
    out.grid = {...cal.grid, byDay};
  }
  return out;
};

/** The device's locale for the weekday and month names (the server formats them). */
export const deviceLocale = (): string => {
  try {
    const l = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof l === 'string' && l ? l : 'en-GB';
  } catch {
    return 'en-GB';
  }
};

/** The device's time zone (its days and its today on the month grid), or null. */
export const deviceTimeZone = (): string | null => {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === 'string' && z ? z : null;
  } catch {
    return null;
  }
};

// ---- the month grid (the website's public/js/calgrid.js, the same rules) ----

/** The month view's own words (the server makes every other word on it). */
export const CAL_WORDS = {
  month: 'Month',
  list: 'List',
  today: 'Today',
  prev: 'Previous month',
  next: 'Next month',
  nextUp: 'Next up',
  premiere: 'Premiere',
  episode: 'New episode',
  cinema: 'In cinemas',
  home: 'Out to stream or buy',
  have: 'On the server',
} as const;
/** The legend: what a poster's coloured edge means. */
export const KINDS = ['premiere', 'episode', 'cinema', 'home'] as const;
/** The kinds' colours (the website's --k-*). */
export const KIND_COLORS = {premiere: '#ffd479', episode: '#8b7bff', cinema: '#ff9a7c', home: '#72d4f4', have: '#8cffbe'} as const;

export type CalendarView = 'month' | 'list';
export type CalendarCell = {key: string; n: number; inMonth: boolean; past: boolean; today: boolean; items: CalendarEntry[]};

const DAY_MS = 86400000;
const keyMs = (key: string) => Date.parse(`${key}T00:00:00.000Z`);
export const addDays = (key: string, n: number) => new Date(keyMs(key) + n * DAY_MS).toISOString().slice(0, 10);
export const monthOf = (key: string) => key.slice(0, 7);
const weekday = (key: string) => new Date(keyMs(key)).getUTCDay(); // 0 Sunday

/** The weeks (rows of seven day keys) that show month `mk` — four to six, as many as it needs. */
export const monthWeeks = (mk: string, weekStart = 1): string[][] => {
  const first = `${mk}-01`;
  const lead = (weekday(first) - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const [y, m] = mk.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = Math.ceil((lead + days) / 7);
  return Array.from({length: rows}, (_, w) => Array.from({length: 7}, (_, d) => addDays(start, w * 7 + d)));
};

export const cellOf = (grid: CalendarGrid | null | undefined, key: string, mk: string, today: string): CalendarCell => {
  const d = (grid && grid.byDay && grid.byDay[key]) || null;
  return {key, n: Number(key.slice(8, 10)), inMonth: monthOf(key) === mk, past: key < today, today: key === today, items: (d && d.items) || []};
};

export const monthKeys = (grid: CalendarGrid | null | undefined) => ((grid && grid.months) || []).map(m => m.key);
export const monthInfo = (grid: CalendarGrid | null | undefined, mk: string) => ((grid && grid.months) || []).find(m => m.key === mk) || null;

/** True when the answer has a month grid to draw (an older server's has not). */
export const hasGrid = (cal: Calendar | null): cal is Calendar & {grid: CalendarGrid} =>
  !!(cal && cal.grid && cal.grid.byDay && Array.isArray(cal.grid.months) && cal.grid.months.length);

/** The day to open on: today when it has something, else the next day that does, else today. */
export const firstPick = (cal: Calendar | null): string | null => {
  const grid = cal && cal.grid;
  const today = cal && cal.today;
  if (!grid || !today) return null;
  const days = grid.byDay || {};
  if (days[today] && days[today].items.length) return today;
  const months = monthKeys(grid);
  const last = months.length ? grid.months[months.length - 1].last || grid.to : grid.to;
  for (let d = addDays(today, 1); d <= last; d = addDays(d, 1)) if (days[d] && days[d].items.length) return d;
  return today;
};

/** The day to pick when the month changes to `to`: today in today's month (unless `keepDay`), else the same day of the month. */
export const monthPick = (grid: CalendarGrid | null | undefined, pick: string, to: string, today: string, keepDay = false) => {
  if (to === monthOf(today) && !keepDay) return today;
  const info = monthInfo(grid, to);
  const lastN = Number(((info && info.last) || `${to}-28`).slice(8, 10));
  return `${to}-${String(Math.min(Number(pick.slice(8, 10)), lastN)).padStart(2, '0')}`;
};

/** A day's heading on the month view's panel. */
export const gridDayHeading = (cal: Calendar, key: string) => {
  const d = cal.grid && cal.grid.byDay[key];
  return d ? dayHeading({day: key, label: d.label, date: d.date, items: d.items}) : key;
};

/** What the picked day's panel says when the day has nothing. */
export const dayEmptyLine = (cal: Calendar) => (cal.counts.titles ? cal.empty.day || '' : cal.empty.noTitles);

/** What a day says to talk-back: "Tomorrow · 10 Nov: Night Harbour, New episode". */
export const cellLabel = (cal: Calendar, c: CalendarCell) => {
  const head = gridDayHeading(cal, c.key);
  return c.items.length ? `${head}: ${c.items.map(e => `${e.title}, ${e.what}`).join('; ')}` : head;
};

// The Month / List choice stays on this device (the website keeps it in its own storage).
const VIEW_KEY = 'aurora.calendarView';
export const loadCalendarView = async (): Promise<CalendarView> => {
  try {
    return (await AsyncStorage.getItem(VIEW_KEY)) === 'list' ? 'list' : 'month';
  } catch {
    return 'month';
  }
};
export const saveCalendarView = (v: CalendarView) => AsyncStorage.setItem(VIEW_KEY, v).catch(() => {});

// ---- the two requests ----
export const loadCalendar = (profileId: string, locale = deviceLocale(), tz = deviceTimeZone()) =>
  apiRequest<Calendar>(
    `/api/profiles/${encodeURIComponent(profileId)}/calendar?locale=${encodeURIComponent(locale)}${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`,
  );

export const saveFromCalendar = (profileId: string, e: CalendarEntry) =>
  apiPost<CalendarSaveResult>(`/api/profiles/${encodeURIComponent(profileId)}/calendar/save`, e.save);
