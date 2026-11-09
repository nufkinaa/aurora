// The Calendar — the TV's and the phone's shared half (screens/Calendar.tsx,
// phone/screens/Calendar.tsx). The server makes the calendar and its words
// (src/media/calendar.js: GET /api/profiles/:id/calendar), so all three apps
// print the same ones; this file only asks for it, says the few words of the
// screen itself, and turns a Save & watch answer into the card's new state.
// PURE apart from the two requests (tested in __tests__/logic/calendar.test.ts).
// The website's copy of these words: public/js/screens/calendar.js.
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
export type Calendar = {
  tz: string;
  locale: string;
  today: string;
  upcoming: CalendarDay[];
  recent: CalendarDay[];
  counts: {upcoming: number; recent: number; titles: number};
  pending: number;
  empty: {noTitles: string; upcoming: string; recent: string; pending: string | null};
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
/** The same, applied to the whole calendar (both tabs: a key is on one day only). */
export const withEntry = (cal: Calendar, key: string, next: (e: CalendarEntry) => CalendarEntry): Calendar => {
  const map = (days: CalendarDay[]) => days.map(d => (d.items.some(i => i.key === key) ? {...d, items: d.items.map(i => (i.key === key ? next(i) : i))} : d));
  return {...cal, upcoming: map(cal.upcoming), recent: map(cal.recent)};
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

// ---- the two requests ----
export const loadCalendar = (profileId: string, locale = deviceLocale()) =>
  apiRequest<Calendar>(`/api/profiles/${encodeURIComponent(profileId)}/calendar?locale=${encodeURIComponent(locale)}`);

export const saveFromCalendar = (profileId: string, e: CalendarEntry) =>
  apiPost<CalendarSaveResult>(`/api/profiles/${encodeURIComponent(profileId)}/calendar/save`, e.save);
