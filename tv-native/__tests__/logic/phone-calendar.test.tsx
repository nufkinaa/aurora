// The phone's Calendar (src/phone/screens/Calendar.tsx): the two tabs over the
// days, a row's words and buttons by the entry's flags, Save & watch (only on a
// tap: the answer's badge and line, a failure puts the button back), a failed
// load with Try again, the empty lines, the pending line, and a row opening
// its title through the shared openItem.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => {
  const R = jest.requireActual('react');
  // a SectionList that draws everything: the header, then each day's heading and rows, or the empty part
  const SectionList = (p: Record<string, any>) =>
    R.createElement(
      'SectionList',
      {refreshControl: p.refreshControl},
      p.ListHeaderComponent,
      p.sections.length
        ? p.sections.map((sec: any) =>
            R.createElement(R.Fragment, {key: sec.key}, p.renderSectionHeader({section: sec}), sec.data.map((item: any) => R.createElement(R.Fragment, {key: p.keyExtractor(item)}, p.renderItem({item, section: sec})))),
          )
        : p.ListEmptyComponent,
    );
  return {...jest.requireActual('./rn-stub.js'), SectionList, ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator'};
});
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p1'})}));
jest.mock('../../src/api', () => ({}));
const mockLoad = jest.fn();
const mockSave = jest.fn();
jest.mock('../../src/calendar', () => ({
  ...jest.requireActual('../../src/calendar'),
  loadCalendar: (...a: unknown[]) => mockLoad(...a),
  saveFromCalendar: (...a: unknown[]) => mockSave(...a),
}));
jest.mock('../../src/navLock', () => ({canNavigate: () => true}));
const mockOpen = jest.fn();
jest.mock('../../src/openItem', () => ({openItem: (...a: unknown[]) => mockOpen(...a)}));
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (t: string) => mockToast(t)}));
jest.mock('../../src/useRouteShown', () => ({useRouteShown: () => {}}));
const mockNav = {push: jest.fn(), isFocused: () => true};
jest.mock('../../src/phone/nav', () => ({usePNav: () => mockNav}));
// the phone's ui pieces: hosts that keep their props (uiId, label, onPress, disabled)
jest.mock('../../src/phone/ui/Buttons', () => {
  const R = jest.requireActual('react');
  return {ChipButton: (p: object) => R.createElement('ChipButton', p), GlassButton: (p: object) => R.createElement('GlassButton', p)};
});
jest.mock('../../src/phone/ui/Tap', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Tap', p, p.children as never)};
});
jest.mock('../../src/phone/ui/Icon', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: object) => R.createElement('Icon', p)};
});
jest.mock('../../src/phone/ui/Cards', () => ({artSrc: (p: string | null) => ({src: p ? {uri: `https://srv${p}?w=104`, headers: {'X-Session': 's'}} : null})}));
jest.mock('../../src/phone/ui/PageHead', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: {title: string}) => R.createElement('Text', {accessibilityRole: 'header'}, p.title),
    BackBar: (p: object) => R.createElement('BackBar', p),
    useColumn: () => null,
    useSolidBar: () => ({solid: false, onScroll: () => {}}),
  };
});
jest.mock('../../src/phone/ui/TabBar', () => ({useTabBarSpace: () => 80}));
jest.mock('../../src/phone/theme', () => ({
  colors: {text: '#fff', textDim: '#ccc', textFaint: '#888', accent: '#8b7bff', accentStrong: '#6c58ff', owned: '#6fe0b0', glass: 'g', glassEdge: 'ge', chip: 'c', chipEdge: 'ce'},
  GUTTER: 16,
  radius: {l: 16, pill: 999},
}));

import CalendarScreen from '../../src/phone/screens/Calendar';
import type {Calendar, CalendarEntry} from '../../src/calendar';

const entry = (o: Partial<CalendarEntry> & {key: string; title: string}): CalendarEntry => ({
  kind: 'episode',
  type: 'show',
  imdbId: 'tt0000001',
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
  canSave: false,
  save: null,
  play: null,
  item: {id: `disc:${o.key}`, imdbId: 'tt0000001', type: 'show', title: o.title, source: 'stream'} as never,
  ...o,
});
const OWNED = entry({key: 'tt1:2:5', title: 'Owned Show', state: 'have', badge: 'On the server', play: {id: 'ep25', showId: 'sh1', season: 2, episode: 5}});
const SAVEABLE = entry({key: 'tt2:1:1', title: 'New Show', kind: 'premiere', what: 'Series premiere', detail: 'S1 E1 · Pilot', canSave: true, save: {imdbId: 'tt2', type: 'show', season: 1, episode: 1}});
const FILM = entry({key: 'tt3:cinema', title: 'A Film', type: 'movie', kind: 'cinema', what: 'In cinemas', detail: null, out: false, day: '2026-11-12', poster: null});
const OLD = entry({key: 'tt4:home', title: 'Old Film', type: 'movie', kind: 'home', what: 'Out to stream or buy', detail: null, day: '2026-11-02', state: 'have', badge: 'On the server', play: {id: 'm4', showId: null, season: null, episode: null}});

const EMPTY = {noTitles: 'Add films and shows to My List.', upcoming: 'Nothing coming up in the next 60 days.', recent: 'Nothing came out in the last 14 days.', pending: null};
const CAL = (o: Partial<Calendar> = {}): Calendar => ({
  tz: 'Europe/Paris',
  locale: 'en-GB',
  today: '2026-11-09',
  upcoming: [
    {day: '2026-11-09', label: 'Today', date: '9 Nov', items: [SAVEABLE, OWNED]},
    {day: '2026-11-12', label: 'Thursday', date: '12 Nov', items: [FILM]},
  ],
  recent: [{day: '2026-11-02', label: 'Sun 2 Nov', date: null, items: [OLD]}],
  counts: {upcoming: 3, recent: 1, titles: 4},
  pending: 0,
  empty: EMPTY,
  ...o,
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const str = (c: unknown): string => (Array.isArray(c) ? c.map(str).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '');
const texts = (n: TestRenderer.ReactTestInstance | TestRenderer.ReactTestRenderer) => {
  const root = 'root' in n ? n.root : n;
  return root.findAll(x => (x.type as unknown) === 'Text').map(x => str(x.props.children));
};
const byUi = (n: TestRenderer.ReactTestInstance | TestRenderer.ReactTestRenderer, id: string) => {
  const root = 'root' in n ? n.root : n;
  return root.findAll(x => typeof x.type === 'string' && x.props.uiId === id);
};
const rowOf = (r: TestRenderer.ReactTestRenderer, title: string) => byUi(r, 'calendar.open').find(x => texts(x)[0] === title)!;

let r: TestRenderer.ReactTestRenderer;
const mount = async () => {
  await act(async () => {
    r = TestRenderer.create(<CalendarScreen />);
  });
  await flush();
};
beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue(CAL());
});
afterEach(() => act(() => r?.unmount()));

test('opens on Coming up: the tabs with their counts, each day under its heading, its rows in order', async () => {
  await mount();
  expect(mockLoad).toHaveBeenCalledWith('p1');
  const tabs = byUi(r, 'calendar.tab');
  expect(tabs.map(t => t.props.label)).toEqual(['Coming up · 3', 'Recently out · 1']);
  expect(tabs.map(t => t.props.active)).toEqual([true, false]);
  const t = texts(r);
  expect(t[0]).toBe('Calendar');
  expect(t).toContain('Today · 9 Nov');
  expect(t).toContain('Thursday · 12 Nov');
  expect(t.indexOf('Today · 9 Nov')).toBeLessThan(t.indexOf('New Show'));
  expect(t.indexOf('New Show')).toBeLessThan(t.indexOf('Owned Show'));
  expect(t.indexOf('Owned Show')).toBeLessThan(t.indexOf('Thursday · 12 Nov'));
  expect(t.indexOf('Thursday · 12 Nov')).toBeLessThan(t.indexOf('A Film'));
  expect(t).not.toContain('Old Film');
  // a row's words: title, what, detail, why; its label for talk-back
  const row = rowOf(r, 'Owned Show');
  expect(texts(row)).toEqual(['Owned Show', 'New episode', 'S2 E5 · The Long Night', 'In My List · Following', 'On the server']);
  expect(row.props.accessibilityLabel).toBe('Owned Show, New episode, S2 E5 · The Long Night, On the server');
  // the poster comes through the phone's art helper (with its headers); no poster: a glyph
  expect(row.findByType('Image' as never).props.source).toEqual({uri: 'https://srv/art/p.jpg?w=104', headers: {'X-Session': 's'}});
  expect(rowOf(r, 'A Film').findAllByType('Image' as never)).toHaveLength(0);
  expect(rowOf(r, 'A Film').findByType('Icon' as never).props.name).toBe('film');
});

test('`what` is in the accent, a premiere marked apart (the site\'s .kind-premiere gold); today\'s heading is lit', async () => {
  await mount();
  const what = (title: string) => rowOf(r, title).findAll(x => (x.type as unknown) === 'Text')[1];
  const flat = (st: unknown) => Object.assign({}, ...[].concat(st as never).flat(9).filter(Boolean));
  expect(str(what('New Show').props.children)).toBe('Series premiere');
  expect(flat(what('New Show').props.style).color).toBe('#ffd479');
  expect(flat(what('Owned Show').props.style).color).toBe('#8b7bff');
  const head = (t: string) => r.root.find(x => (x.type as unknown) === 'Text' && str(x.props.children) === t);
  expect(flat(head('Today · 9 Nov').props.style).color).toBe('#fff');
  expect(flat(head('Thursday · 12 Nov').props.style).color).toBe('#ccc');
});

test('Recently out: its day and row, and the tab is lit', async () => {
  await mount();
  await act(async () => byUi(r, 'calendar.tab')[1].props.onPress());
  const t = texts(r);
  expect(t).toContain('Sun 2 Nov');
  expect(t).toContain('Old Film');
  expect(t).not.toContain('New Show');
  expect(byUi(r, 'calendar.tab').map(x => x.props.active)).toEqual([false, true]);
});

test('opens on Recently out when only it has anything', async () => {
  mockLoad.mockResolvedValue(CAL({upcoming: [], counts: {upcoming: 0, recent: 1, titles: 4}}));
  await mount();
  expect(byUi(r, 'calendar.tab').map(x => [x.props.label, x.props.active])).toEqual([
    ['Coming up', false],
    ['Recently out · 1', true],
  ]);
  expect(texts(r)).toContain('Old Film');
});

test('the badge and the buttons follow the flags: Play when the server has it, Save & watch when it can', async () => {
  await mount();
  const owned = rowOf(r, 'Owned Show');
  expect(byUi(owned, 'calendar.play').map(b => b.props.label)).toEqual(['Play']);
  expect(byUi(owned, 'calendar.save')).toHaveLength(0);
  const fresh = rowOf(r, 'New Show');
  expect(byUi(fresh, 'calendar.play')).toHaveLength(0);
  expect(byUi(fresh, 'calendar.save').map(b => [b.props.label, b.props.disabled])).toEqual([['Save & watch', false]]);
  expect(texts(fresh)).not.toContain('On the server');
  const film = rowOf(r, 'A Film');
  expect(byUi(film, 'calendar.play')).toHaveLength(0);
  expect(byUi(film, 'calendar.save')).toHaveLength(0);
  // nothing was asked for or played on the way in
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockNav.push).not.toHaveBeenCalled();
});

test('Play starts the episode the server has (Show · S2 E5), a film by its name', async () => {
  await mount();
  await act(async () => byUi(rowOf(r, 'Owned Show'), 'calendar.play')[0].props.onPress());
  expect(mockNav.push).toHaveBeenLastCalledWith('Player', {id: 'ep25', title: 'Owned Show · S2 E5'});
  await act(async () => byUi(r, 'calendar.tab')[1].props.onPress());
  await act(async () => byUi(rowOf(r, 'Old Film'), 'calendar.play')[0].props.onPress());
  expect(mockNav.push).toHaveBeenLastCalledWith('Player', {id: 'm4', title: 'Old Film'});
  expect(mockOpen).not.toHaveBeenCalled();
});

test('Save & watch: Saving… while it asks, then the new badge, no second Save, and the line', async () => {
  let answer!: (v: unknown) => void;
  mockSave.mockReturnValue(new Promise(res => (answer = res)));
  await mount();
  await act(async () => {
    byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress();
  });
  expect(mockSave).toHaveBeenCalledWith('p1', SAVEABLE);
  expect(byUi(rowOf(r, 'New Show'), 'calendar.save').map(b => [b.props.label, b.props.disabled])).toEqual([['Saving…', true]]);
  // a second tap while it asks asks nothing
  await act(async () => {
    byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress();
  });
  expect(mockSave).toHaveBeenCalledTimes(1);
  await act(async () => answer({ok: true, state: 'saving', line: 'Saving New Show S1 E1 — it plays here when it lands.'}));
  await flush();
  const row = rowOf(r, 'New Show');
  expect(byUi(row, 'calendar.save')).toHaveLength(0);
  expect(texts(row)).toContain('Saving');
  expect(mockToast).toHaveBeenCalledWith('Saving New Show S1 E1 — it plays here when it lands.');
  // the other rows are as they were
  expect(texts(rowOf(r, 'Owned Show'))).toContain('On the server');
});

test('Save & watch waiting on an admin: the badge says so', async () => {
  mockSave.mockResolvedValue({ok: true, state: 'waiting', line: 'Asked — waiting for approval.'});
  await mount();
  await act(async () => byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress());
  await flush();
  expect(texts(rowOf(r, 'New Show'))).toContain('Waiting for approval');
  expect(mockToast).toHaveBeenCalledWith('Asked — waiting for approval.');
});

test('a refused save says its line and leaves the row as it was', async () => {
  mockSave.mockResolvedValue({ok: false, why: 'none', line: 'No copy to pick for you yet.'});
  await mount();
  await act(async () => byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress());
  await flush();
  expect(mockToast).toHaveBeenCalledWith('No copy to pick for you yet.');
  expect(byUi(rowOf(r, 'New Show'), 'calendar.save').map(b => [b.props.label, b.props.disabled])).toEqual([['Save & watch', false]]);
});

test('a save that fails puts the button back and says why (or the fallback)', async () => {
  mockSave.mockRejectedValueOnce(new Error('Downloads are switched off here.'));
  await mount();
  await act(async () => byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress());
  await flush();
  expect(mockToast).toHaveBeenLastCalledWith('Downloads are switched off here.');
  expect(byUi(rowOf(r, 'New Show'), 'calendar.save').map(b => [b.props.label, b.props.disabled])).toEqual([['Save & watch', false]]);
  mockSave.mockRejectedValueOnce(new Error(''));
  await act(async () => byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.onPress());
  await flush();
  expect(mockToast).toHaveBeenLastCalledWith("Couldn't ask for that download right now.");
  expect(byUi(rowOf(r, 'New Show'), 'calendar.save')[0].props.label).toBe('Save & watch');
});

test('a failed load says so with Try again, which loads again', async () => {
  mockLoad.mockRejectedValueOnce(new Error('offline'));
  await mount();
  expect(texts(r)).toContain("Couldn't load the calendar right now.");
  expect(byUi(r, 'calendar.tab')).toHaveLength(0);
  const retry = byUi(r, 'calendar.retry');
  expect(retry.map(b => b.props.label)).toEqual(['Try again']);
  await act(async () => retry[0].props.onPress());
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(texts(r)).not.toContain("Couldn't load the calendar right now.");
  expect(texts(r)).toContain('New Show');
});

test('pull to refresh loads again; a failing refresh keeps the calendar on screen', async () => {
  await mount();
  mockLoad.mockRejectedValueOnce(new Error('offline'));
  const rc = r.root.findByType('SectionList' as never).props.refreshControl;
  await act(async () => rc.props.onRefresh());
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(texts(r)).toContain('New Show');
  expect(mockToast).toHaveBeenCalledWith("Couldn't load the calendar right now.");
});

test('empty: no titles at all says how to fill it; an empty tab says its own line', async () => {
  mockLoad.mockResolvedValue(CAL({upcoming: [], recent: [], counts: {upcoming: 0, recent: 0, titles: 0}}));
  await mount();
  expect(texts(r)).toContain('Add films and shows to My List.');
  expect(r.root.findAll(x => (x.type as unknown) === 'Icon' && x.props.name === 'calendar')).toHaveLength(1);
  act(() => r.unmount());
  mockLoad.mockResolvedValue(CAL({recent: [], counts: {upcoming: 3, recent: 0, titles: 4}}));
  await mount();
  expect(texts(r)).not.toContain('Nothing came out in the last 14 days.');
  await act(async () => byUi(r, 'calendar.tab')[1].props.onPress());
  expect(texts(r)).toContain('Nothing came out in the last 14 days.');
  expect(byUi(r, 'calendar.tab')[1].props.label).toBe('Recently out');
});

test('the pending line shows when the server is still looking dates up', async () => {
  mockLoad.mockResolvedValue(CAL({pending: 2, empty: {...EMPTY, pending: 'Still looking up the dates of 2 titles — they show up here soon.'}}));
  await mount();
  expect(texts(r)).toContain('Still looking up the dates of 2 titles — they show up here soon.');
  act(() => r.unmount());
  mockLoad.mockResolvedValue(CAL());
  await mount();
  expect(texts(r).some(t => t.startsWith('Still looking up'))).toBe(false);
});

test('tapping a row opens its title through openItem with entry.item', async () => {
  await mount();
  await act(async () => rowOf(r, 'A Film').props.onPress());
  expect(mockOpen).toHaveBeenCalledWith(mockNav, FILM.item);
  expect(mockNav.push).not.toHaveBeenCalled();
});
