// The TV's Calendar screen (src/screens/Calendar.tsx), driven the way the
// remote drives it: it opens on Coming up with the days and their entries, a
// tab press shows Recently out, the buttons are there by the entry's flags,
// Save & watch asks once and turns into the new badge, a failed read offers
// Try again, the empty states say the server's words, and OK on a row opens
// the title.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => {
  const R = jest.requireActual('react');
  return {
    ...jest.requireActual('./rn-stub.js'),
    // every row, in order (the real one windows them)
    FlatList: (p: {data: {key: string}[]; renderItem: (a: {item: unknown; index: number}) => React.ReactNode}) =>
      R.createElement('FlatList', null, p.data.map((item, index) => R.createElement(R.Fragment, {key: item.key}, p.renderItem({item, index})))),
  };
});
// a host component by name, keeping its props (a function declaration: jest.mock is hoisted above it)
function mockHost(name: string) {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement(name, p, p.children as never)};
}
jest.mock('../../src/components/Focusable', () => mockHost('Focusable'));
jest.mock('../../src/components/Btn', () => mockHost('Btn'));
jest.mock('../../src/components/Chip', () => mockHost('Chip'));
jest.mock('../../src/components/NavRail', () => mockHost('NavRail'));
jest.mock('../../src/components/Skeleton', () => mockHost('Skeleton'));
jest.mock('../../src/components/States', () => {
  const R = jest.requireActual('react');
  return {Empty: (p: Record<string, unknown>) => R.createElement('Empty', p)};
});
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../../src/api', () => ({artSrc: (p: string | null) => ({src: p ? {uri: `http://srv${p}`} : null, sized: false})}));
const mockLoad = jest.fn();
const mockSave = jest.fn();
jest.mock('../../src/calendar', () => ({
  ...jest.requireActual('../../src/calendar'),
  loadCalendar: (...a: unknown[]) => mockLoad(...a),
  saveFromCalendar: (...a: unknown[]) => mockSave(...a),
}));
const mockOpen = jest.fn();
jest.mock('../../src/openItem', () => ({openItem: (...a: unknown[]) => mockOpen(...a)}));
jest.mock('../../src/prefetch', () => ({warmItem: () => {}}));
const mockGoSection = jest.fn();
jest.mock('../../src/navSection', () => ({goSection: (...a: unknown[]) => mockGoSection(...a)}));
jest.mock('../../src/navLock', () => ({canNavigate: () => true}));
jest.mock('../../src/focus', () => {
  const R = jest.requireActual('react');
  return {
    noteOwnFocusMove: () => {},
    pressMovedFocus: () => false,
    railOpen: () => false,
    useFocusFallback: () => {},
    useTVKeys: () => true,
    // focus.ts's own rule: the first cell, once, on the first fill
    useListClaim: (key: string, ready: boolean) => {
      const spent = R.useRef(null);
      const claim = ready && spent.current !== key;
      R.useEffect(() => {
        if (ready) spent.current = key;
      }, [key, ready]);
      return R.useCallback((i: number) => claim && i === 0, [claim]);
    },
  };
});
jest.mock('../../src/motion', () => ({useScreenIn: () => ({})}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p1'})}));
const mockShown = jest.fn();
jest.mock('../../src/useRouteShown', () => ({useRouteShown: (ready: boolean) => mockShown(ready)}));
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (...a: unknown[]) => mockToast(...a)}));
jest.mock('../../src/usage', () => ({track: () => {}}));
jest.mock('../../src/theme', () => ({
  __esModule: true,
  default: {
    colors: {bg: '#000', bgRaised: '#111', surface: '#222', surfaceHover: '#333', line: '#444', text: '#fff', textDim: '#999', textFaint: '#666', accent: '#88f', star: '#fc4', white: '#fff'},
    fontSize: {title: 24, row: 18, body: 15, small: 13},
    radius: {s: 8, m: 12, pill: 999},
    spacing: {xs: 4, sm: 8, md: 14, lg: 20, xl: 32, pageX: 48, contentLeft: 84},
    CLEARANCE: {above: 28, below: 61},
  },
  useTvMetrics: () => ({width: 960, height: 540, safeBottom: 0}),
}));

import CalendarScreen from '../../src/screens/Calendar';
import type {Calendar, CalendarEntry} from '../../src/calendar';

const item = (id: string, title: string) => ({id, imdbId: id, type: 'show', title});
const entry = (over: Partial<CalendarEntry>): CalendarEntry => ({
  key: 'k',
  kind: 'episode',
  type: 'show',
  imdbId: 'tt1',
  title: 'Show',
  year: 2024,
  poster: '/p.jpg',
  day: '2026-11-09',
  at: 0,
  what: 'New episode',
  detail: null,
  why: 'In My List',
  out: true,
  state: 'none',
  badge: null,
  canSave: false,
  save: null,
  play: null,
  item: item('disc:tt1', 'Show') as never,
  ...over,
});
const ON_SERVER = entry({
  key: 'tt1:2:5',
  title: 'The Long Show',
  what: 'New episode',
  detail: 'S2 E5 · The Long Night',
  state: 'have',
  badge: 'On the server',
  play: {id: 'ep25', showId: 'show1', season: 2, episode: 5},
  item: item('show1', 'The Long Show') as never,
});
const RELEASED = entry({
  key: 'tt2:1:1',
  imdbId: 'tt2',
  kind: 'premiere',
  title: 'New Thing',
  what: 'Series premiere',
  detail: 'S1 E1',
  why: 'Following',
  canSave: true,
  save: {imdbId: 'tt2', type: 'show', season: 1, episode: 1},
  item: item('disc:tt2', 'New Thing') as never,
});
const FILM = entry({key: 'tt3:cinema', imdbId: 'tt3', type: 'movie', kind: 'cinema', title: 'A Film', what: 'In cinemas', day: '2026-11-12', item: item('disc:tt3', 'A Film') as never});
const OLD = entry({key: 'tt4:home', imdbId: 'tt4', type: 'movie', kind: 'home', title: 'Old Film', what: 'Out to stream or buy', day: '2026-11-05', item: item('disc:tt4', 'Old Film') as never});

const CAL = (over: Partial<Calendar> = {}): Calendar => ({
  tz: 'Europe/London',
  locale: 'en-GB',
  today: '2026-11-09',
  upcoming: [
    {day: '2026-11-09', label: 'Today', date: '9 Nov', items: [ON_SERVER, RELEASED]},
    {day: '2026-11-12', label: 'Wednesday', date: '12 Nov', items: [FILM]},
  ],
  recent: [{day: '2026-11-05', label: 'Wed 5 Nov', date: null, items: [OLD]}],
  counts: {upcoming: 3, recent: 1, titles: 4},
  pending: 0,
  empty: {noTitles: 'Add titles to My List to see them here.', upcoming: 'Nothing coming up.', recent: 'Nothing out lately.', pending: null},
  ...over,
});

const nav = {push: jest.fn(), goBack: jest.fn(), isFocused: () => true};
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
type R = TestRenderer.ReactTestRenderer;
const textOf = (n: TestRenderer.ReactTestInstance): string =>
  ([] as unknown[]).concat(n.props.children).filter(c => typeof c === 'string').join('');
const texts = (r: R) => r.root.findAll(n => (n.type as unknown) === 'Text').map(textOf);
const byUi = (r: R, id: string) => r.root.findAll(n => typeof n.type === 'string' && n.props.uiId === id);
const btn = (r: R, id: string, label?: string) => byUi(r, id).filter(n => label == null || n.props.label === label);

let r: R;
const mount = async () => {
  await act(async () => {
    r = TestRenderer.create(<CalendarScreen navigation={nav as never} route={{key: 'cal-1', name: 'Calendar'} as never} />);
  });
  await flush();
};
beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue(CAL());
});
afterEach(() => act(() => r?.unmount()));

test('Coming up: the tabs with their counts, the days and their headings, the entries; the rail lights Calendar', async () => {
  await mount();
  expect(mockLoad).toHaveBeenCalledWith('p1');
  expect(btn(r, 'calendar.tab').map(t => [t.props.label, t.props.on])).toEqual([
    ['Coming up · 3', true],
    ['Recently out · 1', false],
  ]);
  const t = texts(r);
  expect(t).toEqual(expect.arrayContaining(['Calendar', 'Today · 9 Nov', 'Wednesday · 12 Nov', 'The Long Show', 'S2 E5 · The Long Night', 'Series premiere', 'A Film', 'In cinemas']));
  expect(t.indexOf('Today · 9 Nov')).toBeLessThan(t.indexOf('The Long Show'));
  expect(t.indexOf('The Long Show')).toBeLessThan(t.indexOf('Wednesday · 12 Nov'));
  expect(t.indexOf('Wednesday · 12 Nov')).toBeLessThan(t.indexOf('A Film'));
  expect(t).not.toContain('Old Film');
  expect(byUi(r, 'calendar.open')).toHaveLength(3);
  // the first row takes the focus on arrival, and only it
  expect(byUi(r, 'calendar.open').map(n => n.props.hasTVPreferredFocus)).toEqual([true, false, false]);
  expect(r.root.findByType('NavRail' as never).props.active).toBe('calendar');
  expect(mockShown).toHaveBeenLastCalledWith(true);
});

test('the route is not shown until the first answer is on', async () => {
  mockLoad.mockReturnValue(new Promise(() => {}));
  await mount();
  expect(mockShown).not.toHaveBeenCalledWith(true);
  expect(r.root.findAllByType('Skeleton' as never).length).toBeGreaterThan(0);
});

test('a tab press shows Recently out (and the focus stays on the tab)', async () => {
  await mount();
  await act(async () => btn(r, 'calendar.tab', 'Recently out · 1')[0].props.onPress());
  expect(btn(r, 'calendar.tab').map(t => t.props.on)).toEqual([false, true]);
  const t = texts(r);
  expect(t).toEqual(expect.arrayContaining(['Wed 5 Nov', 'Old Film', 'Out to stream or buy']));
  expect(t).not.toContain('The Long Show');
  expect(byUi(r, 'calendar.open').map(n => n.props.hasTVPreferredFocus)).toEqual([false]);
});

test('badge, Play and Save & watch by the entry’s flags; Play starts the episode', async () => {
  await mount();
  expect(texts(r)).toContain('On the server');
  expect(btn(r, 'calendar.play')).toHaveLength(1); // the one on the server
  expect(btn(r, 'calendar.save')).toHaveLength(1); // the released one it can ask for
  expect(btn(r, 'calendar.save')[0].props.label).toBe('Save & watch');
  await act(async () => btn(r, 'calendar.play')[0].props.onPress());
  expect(nav.push).toHaveBeenCalledWith('Player', {id: 'ep25', title: 'The Long Show · S2 E5'});
});

test('Play on a film plays it by its name', async () => {
  const film = {...FILM, state: 'have' as const, badge: 'On the server', play: {id: 'lib9', showId: null, season: null, episode: null}};
  mockLoad.mockResolvedValue(CAL({upcoming: [{day: '2026-11-12', label: 'Wednesday', date: '12 Nov', items: [film]}]}));
  await mount();
  await act(async () => btn(r, 'calendar.play')[0].props.onPress());
  expect(nav.push).toHaveBeenCalledWith('Player', {id: 'lib9', title: 'A Film'});
});

test('Save & watch: Saving… while it asks, once; then the toast and the new badge, and no Save', async () => {
  let answer!: (v: unknown) => void;
  mockSave.mockReturnValue(new Promise(res => (answer = res)));
  await mount();
  await act(async () => {
    btn(r, 'calendar.save')[0].props.onPress();
  });
  expect(mockSave).toHaveBeenCalledWith('p1', RELEASED);
  expect(btn(r, 'calendar.save')[0].props.label).toBe('Saving…');
  expect(btn(r, 'calendar.save')[0].props.dim).toBe(true);
  await act(async () => {
    btn(r, 'calendar.save')[0].props.onPress();
  }); // a second press does nothing
  expect(mockSave).toHaveBeenCalledTimes(1);
  await act(async () => answer({ok: true, state: 'saving', line: 'Saving New Thing — it plays here when it is in.'}));
  await flush();
  expect(mockToast).toHaveBeenCalledWith('Saving New Thing — it plays here when it is in.', '⬇️');
  expect(btn(r, 'calendar.save')).toHaveLength(0);
  expect(texts(r)).toContain('Saving');
});

test('Save & watch refused: the line, and the button back', async () => {
  mockSave.mockResolvedValue({ok: false, why: 'none', line: 'No good copy yet.'});
  await mount();
  await act(async () => {
    btn(r, 'calendar.save')[0].props.onPress();
  });
  await flush();
  expect(mockToast).toHaveBeenCalledWith('No good copy yet.', '🔍');
  expect(btn(r, 'calendar.save')[0].props.label).toBe('Save & watch');
});

test('Save & watch failing: the error’s words, and the button back', async () => {
  mockSave.mockRejectedValue(new Error('Server busy'));
  await mount();
  await act(async () => {
    btn(r, 'calendar.save')[0].props.onPress();
  });
  await flush();
  expect(mockToast).toHaveBeenCalledWith('Server busy', '⚠️');
  expect(btn(r, 'calendar.save')[0].props.label).toBe('Save & watch');
  mockSave.mockRejectedValue(new Error(''));
  await act(async () => {
    btn(r, 'calendar.save')[0].props.onPress();
  });
  await flush();
  expect(mockToast).toHaveBeenLastCalledWith("Couldn't ask for that download right now.", '⚠️');
});

test('a failed read: the line and Try again, which reads again', async () => {
  mockLoad.mockRejectedValueOnce(new Error('offline'));
  await mount();
  expect(texts(r)).toContain("Couldn't load the calendar right now.");
  const retry = btn(r, 'calendar.retry');
  expect(retry).toHaveLength(1);
  expect(retry[0].props.label).toBe('Try again');
  expect(mockShown).toHaveBeenLastCalledWith(true);
  await act(async () => retry[0].props.onPress());
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(btn(r, 'calendar.retry')).toHaveLength(0);
  expect(texts(r)).toContain('The Long Show');
});

test('no titles at all: the server’s line, and a way to find some', async () => {
  mockLoad.mockResolvedValue(CAL({upcoming: [], recent: [], counts: {upcoming: 0, recent: 0, titles: 0}}));
  await mount();
  const empty = r.root.findByType('Empty' as never);
  expect(empty.props.message).toBe('Add titles to My List to see them here.');
  expect(empty.props.glyph).toBe('🗓️');
  await act(async () => empty.props.onAction());
  expect(mockGoSection).toHaveBeenCalledWith(nav, 'calendar', 'movies');
});

test('an empty tab: its own line; the other tab is one press away', async () => {
  mockLoad.mockResolvedValue(CAL({upcoming: [], counts: {upcoming: 0, recent: 1, titles: 4}}));
  // firstTab opens on Recently out when only it has something
  await mount();
  expect(btn(r, 'calendar.tab').map(t => t.props.on)).toEqual([false, true]);
  await act(async () => btn(r, 'calendar.tab', 'Coming up')[0].props.onPress());
  const empty = r.root.findByType('Empty' as never);
  expect(empty.props.message).toBe('Nothing coming up.');
  expect(empty.props.actionLabel).toBe('Recently out · 1');
  expect(empty.props.claimFocus).toBe(false);
  await act(async () => empty.props.onAction());
  expect(texts(r)).toContain('Old Film');
});

test('the pending line, when the server sends one', async () => {
  mockLoad.mockResolvedValue(CAL({pending: 2, empty: {...CAL().empty, pending: 'Still looking up 2 titles…'}}));
  await mount();
  expect(texts(r)).toContain('Still looking up 2 titles…');
});

test('OK on a row opens the title (the shared openItem, with the entry’s card)', async () => {
  await mount();
  await act(async () => byUi(r, 'calendar.open')[1].props.onPress());
  expect(mockOpen).toHaveBeenCalledWith(nav, RELEASED.item);
});
