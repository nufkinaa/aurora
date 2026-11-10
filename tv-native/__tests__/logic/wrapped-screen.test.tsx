// Aurora Wrapped on the TV (src/screens/Wrapped.tsx), driven the way the
// remote drives it: the chapters of the year in their order, RIGHT / OK and
// LEFT, the clock that moves the story on and stops at the finale, PLAY/PAUSE
// that holds it, calm (no clock, no burst), the one burst per run, the
// finale's two keys, the empty year, the request that fails, a kids profile
// that is never roasted — and nothing left running when the screen goes.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

// Every animation that is started, with the value it moves (they end at once,
// like the stub's: the screen must never wait for one).
type Run = {v: unknown; to: number; ms: number};
const mockRuns: Run[] = [];
jest.mock('react-native', () => {
  const rn = jest.requireActual('./rn-stub.js');
  return {
    ...rn,
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      ...rn.Animated,
      timing: (v: unknown, cfg: {toValue: number; duration: number}) => ({
        start: (cb?: (r: {finished: boolean}) => void) => {
          mockRuns.push({v, to: cfg.toValue, ms: cfg.duration});
          if (cb) cb({finished: true});
        },
        stop: () => {},
      }),
    },
  };
});
const mockLite = {on: false};
jest.mock('../../src/perfTier', () => ({isLite: () => mockLite.on}));
jest.mock('../../src/trail', () => ({trail: () => {}}));
jest.mock('../../src/components/Focusable', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Focusable', p, p.children as never)};
});
jest.mock('../../src/components/States', () => ({ErrorState: 'ErrorState'}));
jest.mock('../../src/play/Burst', () => ({__esModule: true, default: 'Burst'}));
jest.mock('../../src/play/Room', () => ({__esModule: true, default: 'Room'}));
const mockApi = {request: jest.fn(), me: jest.fn()};
jest.mock('../../src/api', () => ({
  apiRequest: (...a: unknown[]) => mockApi.request(...a),
  artPath: () => null,
  artPx: () => 480,
  imgSrc: (p: string | null) => (p ? {uri: p} : null),
}));
jest.mock('../../src/navSection', () => ({loadMe: (...a: unknown[]) => mockApi.me(...a)}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p 1'})}));
jest.mock('../../src/useRouteShown', () => ({useRouteShown: () => {}}));
const mockRemote: {key: (e: {eventType: string}) => void; moved: boolean; own: number} = {key: () => {}, moved: false, own: 0};
jest.mock('../../src/focus', () => ({
  useFocusFallback: () => {},
  noteOwnFocusMove: () => {
    mockRemote.own++;
  },
  pressMovedFocus: () => mockRemote.moved,
  // (the real one hears nothing while `deaf`)
  useTVKeys: (fn: (e: {eventType: string}) => void, opts?: {deaf?: boolean}) => {
    mockRemote.key = e => {
      if (!opts?.deaf) fn(e);
    };
  },
}));
const mockHit = jest.fn();
jest.mock('../../src/telemetry', () => ({uiHit: (id: string) => mockHit(id)}));
jest.mock('../../src/navigation', () => ({}));
jest.mock('../../src/theme', () => ({
  __esModule: true,
  useTvMetrics: () => ({width: 960, height: 540, safeBottom: 27}),
  default: {
    colors: {bg: '#000', text: '#fff', textDim: '#999', textFaint: '#666'},
    fontSize: {title: 24, body: 15, small: 13, row: 18},
    radius: {s: 8, m: 12, l: 18, pill: 999},
    spacing: {xs: 4, sm: 8, md: 14, lg: 20, xl: 32, pageX: 48, pageY: 27},
  },
}));

import Wrapped from '../../src/screens/Wrapped';
import {chaptersFor} from '../../src/play/wrappedRules';
import type {Chapter, WrappedStats} from '../../src/play/wrappedRules';
import {BURST_BEAT, planOf, storyOf} from '../../src/play/wrapped/story';

type Node = TestRenderer.ReactTestInstance;

// a full year: every chapter is there
const YEAR: WrappedStats = {
  since: '2026-01-04',
  totalSec: 136 * 3600,
  plays: 240,
  activeDays: 88,
  distinctTitles: 41,
  started: 30,
  finished: 12,
  bestStreak: 13,
  streak: {from: '2026-03-02', to: '2026-03-14'},
  nightsFrom: '2026-01-04',
  nights: Array.from({length: 88}, (_, i) => [i * 3 < 57 || i * 3 > 69 ? i * 3 : 57 + (i % 13), 30 + ((i * 37) % 200)] as [number, number]).sort((a, b) => a[0] - b[0]),
  byHour: [3, 2, 1, 0, 0, 0, 0, 1, 2, 2, 3, 4, 5, 6, 6, 8, 10, 14, 22, 30, 41, 38, 20, 9].map(v => v * 1800),
  byWeekday: [40, 12, 10, 11, 14, 30, 44].map(v => v * 3000),
  topTitles: [
    {name: 'Northern Static', sec: 45 * 3600, poster: '/art/northern.jpg'},
    {name: 'The Long Winter', sec: 22 * 3600},
    {name: 'כאן גרים בכיף', sec: 12 * 3600},
    {name: 'Paper Planets', sec: 9 * 3600},
    {name: 'A Very Long Title That Goes On And On And On Until It Wraps', sec: 6 * 3600},
  ],
  topGenres: [{name: 'Drama', sec: 60 * 3600}, {name: 'Sci-Fi', sec: 40 * 3600}, {name: 'Comedy', sec: 22 * 3600}, {name: 'Family', sec: 9 * 3600}],
  biggestDay: {day: '2026-03-08', sec: 7.5 * 3600},
  longestSession: {watchedSec: 3 * 3600 + 41 * 60, title: 'Northern Static'},
  lateNightSessions: 9,
  latestFinish: {title: 'Northern Static', hour: 3},
};
// a first week: only the chapters that have something to say
const TINY: WrappedStats = {totalSec: 2400, plays: 1, activeDays: 1, distinctTitles: 1, started: 1, finished: 0, bestStreak: 1, topTitles: [{name: 'Pilot', sec: 2400}], topGenres: [{name: 'Comedy', sec: 2400}]};
const ROAST = 'A roast the server wrote, about your couch.';

// the navigation: in front unless a test says otherwise
const listeners: Record<string, Array<() => void>> = {focus: [], blur: []};
const nav = {
  front: true,
  isFocused: () => nav.front,
  addListener: (e: 'focus' | 'blur', fn: () => void) => {
    listeners[e].push(fn);
    return () => {
      listeners[e] = listeners[e].filter(x => x !== fn);
    };
  },
  goBack: jest.fn(),
};

// what the app asked to take focus (a Focusable's node, by its control id)
const asked: string[] = [];
let tree: TestRenderer.ReactTestRenderer;
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};
const mount = async () => {
  await act(async () => {
    tree = TestRenderer.create(<Wrapped navigation={nav as never} route={{key: 'Wrapped', name: 'Wrapped'} as never} />, {
      createNodeMock: el =>
        (el.type as unknown) === 'Focusable'
          ? {requestTVFocus: () => asked.push(String((el.props as {uiId?: string}).uiId))}
          : null,
    });
  });
  await flush();
};
const texts = () =>
  tree.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n => n.children.filter(c => typeof c === 'string').join(''))
    .filter(Boolean);
const all = (type: string): Node[] => tree.root.findAll(n => (n.type as unknown) === type);
const byUi = (id: string): Node[] => tree.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.uiId === id);
const byId = (testID: string): Node[] => tree.root.findAll(n => typeof n.type === 'string' && n.props.testID === testID);
// the chapters on the screen now (there must only ever be one)
const shown = (): string[] =>
  tree.root
    .findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string' && n.props.testID.startsWith('wrapped.chapter.'))
    .map(n => String(n.props.testID).slice('wrapped.chapter.'.length));
// the progress row's values, one per chapter
const segments = (): Array<{v: number}> => tree.root.find(n => typeof n.type !== 'string' && Array.isArray(n.props.values) && typeof n.props.count === 'number').props.values;
const fire = (): number => all('Burst')[0].props.fire;
const key = async (eventType: string) => {
  act(() => mockRemote.key({eventType}));
  await flush();
};
const ok = async () => {
  act(() => byUi('story.next')[0].props.onPress());
  await flush();
};
// time passes (and what the passing started is given its turn)
const tick = (ms: number) => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  act(() => {
    jest.advanceTimersByTime(0);
  });
};
const goTo = async (chapter: Chapter) => {
  for (let i = 0; i < 12 && shown()[0] !== chapter; i++) await key('right');
  expect(shown()).toEqual([chapter]);
};

const answer = (stats: unknown, me: unknown = {id: 'p 1', name: 'Elia'}) => {
  mockApi.request.mockResolvedValue(stats);
  mockApi.me.mockResolvedValue(me);
};

beforeEach(() => {
  // (microtasks stay real: React's own `act` queues some, and they are not the screen's timers)
  jest.useFakeTimers({doNotFake: ['queueMicrotask', 'nextTick']});
  mockRuns.length = 0;
  asked.length = 0;
  mockLite.on = false;
  mockRemote.moved = false;
  mockRemote.own = 0;
  mockHit.mockClear();
  nav.front = true;
  nav.goBack.mockClear();
  listeners.focus = [];
  listeners.blur = [];
  mockApi.request.mockReset();
  mockApi.me.mockReset();
  answer(YEAR);
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

describe('the story', () => {
  it('asks for this profile and tells the chapters the rules list, in their order', async () => {
    await mount();
    expect(mockApi.request).toHaveBeenCalledTimes(1);
    expect(mockApi.request.mock.calls[0][0]).toBe('/api/profiles/p%201/wrapped');
    const want = chaptersFor(YEAR);
    expect(want).toEqual(['opening', 'hours', 'top', 'podium', 'genres', 'night', 'streak', 'longest', 'type', 'roasts', 'finale']);
    expect(byId('wrapped.segment')).toHaveLength(want.length);
    const seen: string[] = [];
    for (let i = 0; i < want.length; i++) {
      expect(shown()).toHaveLength(1); // only the current chapter is mounted
      seen.push(shown()[0]);
      if (i < want.length - 1) await key('right');
    }
    expect(seen).toEqual(want);
    expect(texts()).toContain("THAT'S A WRAP");
  });

  it('leaves out the chapters a small year has nothing to say in', async () => {
    answer(TINY);
    await mount();
    const want = chaptersFor(TINY);
    expect(want).toEqual(['opening', 'hours', 'top', 'type', 'roasts', 'finale']);
    expect(byId('wrapped.segment')).toHaveLength(want.length);
    const seen: string[] = [];
    for (let i = 0; i < want.length; i++) {
      seen.push(shown()[0]);
      if (i < want.length - 1) await key('right');
    }
    expect(seen).toEqual(want);
  });

  it('opens on the name and the year, and a missing poster is a tile with the title', async () => {
    await mount();
    expect(texts()).toEqual(expect.arrayContaining(['AURORA WRAPPED', 'Elia, your year in Aurora', '88 nights', '240 sittings', '41 titles']));
    await goTo('podium');
    // the second and third have no picture: their titles are on tiles, and under them
    expect(texts().filter(t => t === 'The Long Winter').length).toBeGreaterThanOrEqual(2);
    expect(texts().filter(t => t === 'כאן גרים בכיף').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the remote', () => {
  it('RIGHT and OK go on, LEFT goes back, and LEFT on the first chapter does nothing', async () => {
    await mount();
    expect(shown()).toEqual(['opening']);
    await key('left');
    expect(shown()).toEqual(['opening']);
    expect(mockHit).not.toHaveBeenCalled();
    await key('right');
    expect(shown()).toEqual(['hours']);
    await ok();
    expect(shown()).toEqual(['top']);
    await key('left');
    expect(shown()).toEqual(['hours']);
    expect(mockHit.mock.calls.map(c => c[0])).toEqual(['story.next', 'story.prev']); // (OK's own hit is the Focusable's)
  });

  it('UP, DOWN and the OK key event do nothing here; one focusable holds the screen, in a guide that traps every side', async () => {
    await mount();
    for (const k of ['up', 'down', 'select', 'longSelect', 'menu']) await key(k);
    expect(shown()).toEqual(['opening']);
    const page = byUi('story.next');
    expect(page).toHaveLength(1);
    expect(all('Focusable')).toHaveLength(1);
    expect(page[0].props.ring).toBe('none');
    expect(page[0].props.noScale).toBe(true);
    expect(page[0].props.hasTVPreferredFocus).toBe(true);
    const guide = all('TVFocusGuideView');
    expect(guide).toHaveLength(1);
    expect(guide[0].props).toMatchObject({trapFocusUp: true, trapFocusDown: true, trapFocusLeft: true, trapFocusRight: true});
  });

  it('the release of the press that carried focus here is not a move', async () => {
    await mount();
    mockRemote.moved = true;
    await key('right');
    expect(shown()).toEqual(['opening']);
    mockRemote.moved = false;
    await key('right');
    expect(shown()).toEqual(['hours']);
  });
});

describe('the clock', () => {
  it('fills the current segment over the chapter\'s time and moves on by itself', async () => {
    await mount();
    const story = storyOf(YEAR, 'Elia', false);
    const first = planOf('opening', story);
    const segs = segments();
    const fills = mockRuns.filter(r => r.v === segs[0]);
    expect(fills).toEqual([{v: segs[0], to: 1, ms: first.ms}]);
    tick(first.ms - 1);
    expect(shown()).toEqual(['opening']);
    tick(1);
    expect(shown()).toEqual(['hours']);
    // the one before is full, the ones after are empty, this one is being filled
    expect(segs[0].v).toBe(1);
    expect(segs[2].v).toBe(0);
    expect(mockRuns.filter(r => r.v === segs[1])).toEqual([{v: segs[1], to: 1, ms: planOf('hours', story).ms}]);
  });

  it('goes through every chapter, each after its own time, and stops on the finale', async () => {
    await mount();
    const story = storyOf(YEAR, 'Elia', false);
    const list = chaptersFor(YEAR);
    for (let i = 0; i < list.length - 1; i++) {
      expect(shown()).toEqual([list[i]]);
      const {ms} = planOf(list[i], story);
      expect(ms).toBeGreaterThanOrEqual(7000);
      tick(ms - 1);
      expect(shown()).toEqual([list[i]]);
      tick(1);
    }
    expect(shown()).toEqual(['finale']);
    expect(jest.getTimerCount()).toBe(0);
    tick(10 * 60 * 1000);
    expect(shown()).toEqual(['finale']);
    expect(segments().every(s => s.v === 1 || mockRuns.some(r => r.v === s))).toBe(true);
    expect(segments()[list.length - 1].v).toBe(1);
  });

  it('PLAY/PAUSE holds the story where it is, with a still mark, and goes on for the rest of the chapter', async () => {
    await mount();
    const story = storyOf(YEAR, 'Elia', false);
    const {ms} = planOf('opening', story);
    const segs = segments();
    tick(3000);
    await key('playPause');
    expect(byId('wrapped.paused')).toHaveLength(1);
    expect(texts()).toContain('Paused');
    expect(segs[0].v).toBeCloseTo(3000 / ms, 5); // the fill stands where it was
    expect(jest.getTimerCount()).toBe(0);
    tick(5 * 60 * 1000);
    expect(shown()).toEqual(['opening']);
    mockRuns.length = 0;
    await key('playPause');
    expect(byId('wrapped.paused')).toHaveLength(0);
    expect(mockRuns.filter(r => r.v === segs[0])).toEqual([{v: segs[0], to: 1, ms: ms - 3000}]);
    tick(ms - 3000 - 1);
    expect(shown()).toEqual(['opening']);
    tick(1);
    expect(shown()).toEqual(['hours']);
    expect(mockHit.mock.calls.map(c => c[0])).toEqual(['story.pause', 'story.pause']);
  });

  it('a held story still answers RIGHT and LEFT, and moving lets it go on', async () => {
    await mount();
    await key('pause');
    expect(byId('wrapped.paused')).toHaveLength(1);
    await key('right');
    expect(shown()).toEqual(['hours']);
    expect(byId('wrapped.paused')).toHaveLength(0);
    tick(planOf('hours', storyOf(YEAR, 'Elia', false)).ms);
    expect(shown()).toEqual(['top']);
  });

  it('does not run while another screen is in front', async () => {
    nav.front = false;
    await mount();
    tick(60 * 1000);
    expect(shown()).toEqual(['opening']);
    expect(jest.getTimerCount()).toBe(0);
    act(() => listeners.focus.forEach(f => f()));
    tick(planOf('opening', storyOf(YEAR, 'Elia', false)).ms);
    expect(shown()).toEqual(['hours']);
    act(() => listeners.blur.forEach(f => f()));
    tick(60 * 1000);
    expect(shown()).toEqual(['hours']);
  });

  it('leaves nothing running when the screen goes', async () => {
    await mount();
    tick(2000);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    act(() => tree.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an answer that arrives after the screen has gone is dropped', async () => {
    let give: (w: WrappedStats) => void = () => {};
    mockApi.request.mockReturnValue(new Promise<WrappedStats>(r => (give = r)));
    await mount();
    expect(all('ActivityIndicator')).toHaveLength(1);
    expect(shown()).toEqual([]);
    act(() => tree.unmount());
    give(YEAR);
    await flush();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('calm', () => {
  beforeEach(() => {
    mockLite.on = true;
  });

  it('keeps no clock: the story moves only by a key, and the row shows whole segments', async () => {
    await mount();
    expect(jest.getTimerCount()).toBe(0);
    tick(10 * 60 * 1000);
    expect(shown()).toEqual(['opening']);
    const segs = segments();
    expect(segs[0].v).toBe(1);
    expect(segs[1].v).toBe(0);
    expect(mockRuns.filter(r => segs.includes(r.v as {v: number}))).toEqual([]);
    // nothing to hold: PLAY/PAUSE is not a thing here, and the hint does not offer it
    await key('playPause');
    expect(byId('wrapped.paused')).toHaveLength(0);
    expect(texts().some(t => /Play\/Pause/.test(t))).toBe(false);
    await key('right');
    expect(shown()).toEqual(['hours']);
    expect(segs[0].v).toBe(1);
    expect(segs[1].v).toBe(1);
    await key('left');
    expect(segs[1].v).toBe(0);
  });

  it('gives no burst, and every chapter is whole at once', async () => {
    await mount();
    await goTo('type');
    tick(60 * 1000);
    expect(fire()).toBe(0);
    expect(all('Burst')[0].props.calm).toBe(true);
    // nothing moved to get here
    expect(mockRuns).toEqual([]);
    await goTo('finale');
    expect(fire()).toBe(0);
  });
});

describe('the reward', () => {
  it('is one burst, on the viewer-type chapter, when the card has turned', async () => {
    await mount();
    const turn = planOf('type', storyOf(YEAR, 'Elia', false)).beats[BURST_BEAT - 1];
    await goTo('type');
    expect(fire()).toBe(0);
    tick(turn - 1);
    expect(fire()).toBe(0);
    tick(1);
    expect(fire()).toBe(1);
    // over the chapter again, both ways: not a second time
    await key('right');
    await key('left');
    expect(shown()).toEqual(['type']);
    tick(turn + 1000);
    expect(fire()).toBe(1);
    await key('left');
    await key('right');
    tick(turn + 1000);
    expect(fire()).toBe(1);
  });

  it('is given again in a new run, after Watch again', async () => {
    await mount();
    const turn = planOf('type', storyOf(YEAR, 'Elia', false)).beats[BURST_BEAT - 1];
    await goTo('type');
    tick(turn);
    expect(fire()).toBe(1);
    await goTo('finale');
    act(() => byUi('wrapped.replay')[0].props.onPress());
    await flush();
    expect(shown()).toEqual(['opening']);
    await goTo('type');
    tick(turn);
    expect(fire()).toBe(2);
  });

  it('is skipped when the chapter is left before the card turns, and still there on the way back', async () => {
    await mount();
    const turn = planOf('type', storyOf(YEAR, 'Elia', false)).beats[BURST_BEAT - 1];
    await goTo('type');
    tick(turn - 500);
    await key('right');
    tick(5000);
    expect(fire()).toBe(0);
    await key('left');
    tick(turn);
    expect(fire()).toBe(1);
  });
});

describe('the finale', () => {
  it('has two keys, Watch again and Done, with Done in focus; LEFT and RIGHT are the platform\'s again', async () => {
    await mount();
    await goTo('finale');
    tick(0);
    expect(byUi('story.next')).toHaveLength(0);
    expect(all('TVFocusGuideView')).toHaveLength(0);
    const replay = byUi('wrapped.replay');
    const done = byUi('wrapped.done');
    expect(replay).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(all('Focusable')).toHaveLength(2);
    expect(replay[0].props.accessibilityLabel).toBe('Watch again');
    expect(done[0].props.accessibilityLabel).toBe('Done');
    expect(done[0].props.hasTVPreferredFocus).toBe(true);
    expect(!!replay[0].props.hasTVPreferredFocus).toBe(false);
    expect(asked[asked.length - 1]).toBe('wrapped.done'); // and it is asked to take the focus, announced
    expect(mockRemote.own).toBeGreaterThan(0);
    // the story's keys are deaf here: the two keys are moved between by the platform
    mockHit.mockClear();
    await key('left');
    await key('right');
    await key('playPause');
    expect(shown()).toEqual(['finale']);
    expect(mockHit).not.toHaveBeenCalled();
    expect(byId('wrapped.paused')).toHaveLength(0);
    // the year in three numbers, and the type
    expect(texts()).toEqual(expect.arrayContaining(["THAT'S A WRAP", '41', 'titles', '88', 'nights', 'Your viewer type']));
  });

  it('Watch again starts the story over, with the page in focus again', async () => {
    await mount();
    await goTo('finale');
    tick(0);
    act(() => byUi('wrapped.replay')[0].props.onPress());
    await flush();
    tick(0);
    expect(shown()).toEqual(['opening']);
    expect(byUi('story.next')).toHaveLength(1);
    expect(asked[asked.length - 1]).toBe('story.next');
    const segs = segments();
    expect(segs[1].v).toBe(0);
    expect(segs[segs.length - 1].v).toBe(0);
    // and it runs by itself again
    tick(planOf('opening', storyOf(YEAR, 'Elia', false)).ms);
    expect(shown()).toEqual(['hours']);
  });

  it('Done leaves', async () => {
    await mount();
    await goTo('finale');
    act(() => byUi('wrapped.done')[0].props.onPress());
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('a profile with nothing yet', () => {
  it.each([[{empty: true}], [null]])('shows one page and one key, Done, in focus (%j)', async stats => {
    answer(stats);
    await mount();
    tick(0);
    expect(byId('wrapped.empty')).toHaveLength(1);
    expect(texts()).toContain('Your sky is just getting started');
    expect(shown()).toEqual([]);
    expect(byId('wrapped.segment')).toHaveLength(0);
    expect(all('Burst')).toHaveLength(0);
    const keys = all('Focusable');
    expect(keys).toHaveLength(1);
    expect(keys[0].props.uiId).toBe('wrapped.done');
    expect(keys[0].props.hasTVPreferredFocus).toBe(true);
    expect(asked[asked.length - 1]).toBe('wrapped.done');
    expect(jest.getTimerCount()).toBe(0);
    await key('right');
    expect(shown()).toEqual([]);
    act(() => keys[0].props.onPress());
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('a request that fails', () => {
  it('shows the error state, and Try again asks again', async () => {
    mockApi.request.mockRejectedValueOnce(new Error('503 /api/profiles/p1/wrapped'));
    await mount();
    const err = all('ErrorState');
    expect(err).toHaveLength(1);
    expect(err[0].props.message).toBe("Couldn't load your Wrapped.");
    expect(err[0].props.actionLabel).toBe('Try again');
    expect(shown()).toEqual([]);
    expect(all('Focusable')).toHaveLength(0); // the error state's own key holds the focus
    expect(jest.getTimerCount()).toBe(0);
    await act(async () => {
      err[0].props.onAction();
    });
    await flush();
    expect(mockHit).toHaveBeenCalledWith('wrapped.retry');
    expect(mockApi.request).toHaveBeenCalledTimes(2);
    expect(all('ErrorState')).toHaveLength(0);
    expect(shown()).toEqual(['opening']);
  });
});

describe('who is watching', () => {
  it('a grown-up gets the roast the server wrote', async () => {
    answer({...YEAR, roasts: [ROAST]});
    await mount();
    await goTo('roasts');
    expect(texts()).toEqual(expect.arrayContaining(['THE INTERVENTION', 'We need to talk, Elia.', ROAST]));
  });

  it('a kids profile gets kind words, never a roast', async () => {
    answer({...YEAR, roasts: [ROAST]}, {id: 'p 1', name: 'Noa', kids: {maxAge: 9}});
    await mount();
    await goTo('hours');
    expect(texts()).toContain('STORY TIME');
    await goTo('roasts');
    const t = texts();
    expect(t).toEqual(expect.arrayContaining(['THE HIGHLIGHTS', 'Look at you go, Noa!']));
    expect(t).not.toContain(ROAST);
    expect(t).not.toContain('THE INTERVENTION');
    expect(t.some(x => /couch|need to talk/i.test(x))).toBe(false);
  });

  it('a profile that cannot be read is told the kind words too', async () => {
    answer({...YEAR, roasts: [ROAST]}, null);
    await mount();
    await goTo('roasts');
    const t = texts();
    expect(t).toContain('THE HIGHLIGHTS');
    expect(t).not.toContain(ROAST);
  });

  it('the story does not start before it is known who is watching', async () => {
    let give: (me: unknown) => void = () => {};
    mockApi.me.mockReturnValue(new Promise(r => (give = r)));
    await mount();
    expect(all('ActivityIndicator')).toHaveLength(1);
    expect(shown()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    // the page already holds the focus while it waits, and OK on it does nothing
    expect(all('Focusable')).toHaveLength(1);
    act(() => all('Focusable')[0].props.onPress());
    await act(async () => {
      give({id: 'p 1', name: 'Noa', kids: {maxAge: 9}});
    });
    await flush();
    expect(all('ActivityIndicator')).toHaveLength(0);
    expect(shown()).toEqual(['opening']);
    expect(texts()).toContain('Noa, your year in Aurora');
  });
});
