// "Pick for me" on the TV (src/screens/Pick.tsx) in the play look, "The Draw",
// driven the way the remote drives it: the ask hands focus to ONE key that
// waits as "Thinking…" and becomes "Open" where it stands; the answer rolls
// in, stands a beat, and is the prize (one burst per answer); "Another one"
// rolls to the next pick without a second reward; coming back paints the prize
// still; calm gets it at once; an ask that came to nothing gives the question
// back with focus on Find.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

// Animations that are started and stay "running" until the test ends them.
type Run = {to: number; ms: number; done?: (r: {finished: boolean}) => void; stopped?: boolean};
const mockRuns: Run[] = [];
const mockLoops = {on: 0};
jest.mock('react-native', () => {
  const rn = jest.requireActual('./rn-stub.js');
  const R = jest.requireActual('react');
  const group = (list: Array<{start: () => void}>) => ({start: () => list.forEach(a => a.start()), stop: () => {}});
  return {
    ...rn,
    TextInput: 'TextInput',
    // the header, then the rows (or what stands in for them)
    FlatList: (p: {
      data: unknown[];
      numColumns: number;
      ListHeaderComponent: unknown;
      ListEmptyComponent: unknown;
      keyExtractor: (item: unknown, index: number) => string;
      renderItem: (row: {item: unknown; index: number}) => unknown;
    }) =>
      R.createElement(
        'FlatList',
        {numColumns: p.numColumns, rows: p.data.length},
        p.ListHeaderComponent,
        p.data.length
          ? p.data.map((item, index) => R.createElement(R.Fragment, {key: p.keyExtractor(item, index)}, p.renderItem({item, index})))
          : p.ListEmptyComponent,
      ),
    Animated: {
      ...rn.Animated,
      timing: (_v: unknown, cfg: {toValue: number; duration: number}) => {
        const run: Run = {to: cfg.toValue, ms: cfg.duration};
        return {
          start: (cb?: (r: {finished: boolean}) => void) => {
            run.done = cb;
            mockRuns.push(run);
          },
          stop: () => {
            run.stopped = true;
          },
        };
      },
      parallel: group,
      sequence: group,
      loop: () => ({
        start: () => {
          mockLoops.on += 1;
        },
        stop: () => {
          mockLoops.on -= 1;
        },
      }),
    },
  };
});
const mockLite = {on: false};
jest.mock('../../src/perfTier', () => ({isLite: () => mockLite.on}));
jest.mock('../../src/trail', () => ({trail: () => {}}));
const host = (name: string, extra: Record<string, unknown> = {}) => () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement(name, p, p.children as never), ...extra};
};
jest.mock('../../src/components/Focusable', () => host('Focusable')());
jest.mock('../../src/components/Btn', () => host('Btn')());
jest.mock('../../src/components/Chip', () => host('Chip')());
jest.mock('../../src/components/Icon', () => host('Icon')());
jest.mock('../../src/components/NavRail', () => host('NavRail')());
jest.mock('../../src/components/Card', () => host('Card', {COMPACT_W: 88})());
jest.mock('../../src/play/Burst', () => host('Burst')());
jest.mock('../../src/play/Room', () => host('Room')());
const mockApi = {aiStatus: jest.fn(), aiRecommend: jest.fn()};
jest.mock('../../src/api', () => ({
  get api() {
    return mockApi;
  },
  artPath: () => null,
  artPx: () => 480,
  imgSrc: (p: string | null) => (p ? {uri: p} : null),
}));
jest.mock('../../src/navLock', () => ({canNavigate: () => true}));
jest.mock('../../src/useRouteShown', () => ({useRouteShown: () => {}}));
jest.mock('../../src/prefetch', () => ({warmItem: () => {}}));
const mockRemote: {key: (e: {eventType: string}) => void; moved: boolean; rail: boolean} = {key: () => {}, moved: false, rail: false};
jest.mock('../../src/focus', () => ({
  useFocusFallback: () => {},
  noteFocus: () => {},
  railOpen: () => mockRemote.rail,
  requestRailOpen: () => {},
  pressMovedFocus: () => mockRemote.moved,
  useTVKeys: (fn: (e: {eventType: string}) => void) => {
    mockRemote.key = fn;
  },
}));
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (...a: unknown[]) => mockToast(...a)}));
// The screen keeps this profile's last answer at module scope and registers
// how to drop it — at import time, so the test keeps the handle on the global.
jest.mock('../../src/profileScope', () => ({
  registerProfileCache: (_name: string, fn: () => void) => {
    (globalThis as unknown as {pickDrop?: () => void}).pickDrop = fn;
  },
}));
jest.mock('../../src/navigation', () => ({}));
jest.mock('../../src/groupPick', () => ({WORDS: {entry: 'Pick together', entryLine: 'Everyone votes on their own phone.'}}));
jest.mock('../../src/theme', () => ({
  __esModule: true,
  useTvMetrics: () => ({width: 960, height: 540, safeBottom: 27}),
  default: {
    colors: {bg: '#000', text: '#fff', textDim: '#999', textFaint: '#666', accent: '#88f', white: '#fff', surface: '#111', surfaceHover: '#222', line: '#333'},
    fontSize: {title: 24, body: 15, small: 13, row: 18},
    radius: {s: 8, m: 12, l: 18, pill: 999},
    spacing: {xs: 4, sm: 8, md: 14, lg: 20, xl: 32, pageX: 48, pageY: 27, contentLeft: 84},
    CLEARANCE: {above: 28, below: 61},
  },
}));

import Pick from '../../src/screens/Pick';
import {HOLD_MS, LAND_MS, RESPIN_MS} from '../../src/play/reel';
import {PLAY} from '../../src/play/tokens';

type Node = TestRenderer.ReactTestInstance;
const pick = (n: number, o: Record<string, unknown> = {}) => ({
  id: `lib${n}`,
  imdbId: `tt${n}`,
  type: 'movie' as const,
  title: `Pick ${n}`,
  year: 2000 + n,
  poster: `/art/${n}.jpg`,
  why: `Because of reason ${n}.`,
  source: n === 1 ? 'downloaded' : 'discover',
  ...o,
});
const HAND = [1, 2, 3, 4, 5].map(n => pick(n));

// the navigation the screen is given: which screen is in front, and where it goes
const navEvents: Record<string, Array<() => void>> = {focus: [], blur: []};
const nav = {
  isFocused: () => true,
  push: jest.fn(),
  addListener: (e: string, fn: () => void) => {
    navEvents[e].push(fn);
    return () => navEvents[e].splice(navEvents[e].indexOf(fn), 1);
  },
};

// who was asked to take the focus, in order (a key is known by what it was when it mounted)
const focusLog: string[] = [];
let tree: TestRenderer.ReactTestRenderer;
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};
const mount = async () => {
  await act(async () => {
    tree = TestRenderer.create(<Pick navigation={nav as never} route={{key: 'Pick', name: 'Pick'} as never} />, {
      createNodeMock: el => {
        const p = (el.props || {}) as {uiId?: string; accessibilityLabel?: string};
        const name = p.uiId || p.accessibilityLabel || String(el.type);
        return {requestTVFocus: () => focusLog.push(name), focus: () => focusLog.push('field')};
      },
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
const byUi = (id: string): Node[] => tree.root.findAll(n => typeof n.type === 'string' && n.props.uiId === id);
// the stage's one key: the only bright key of the page
const mainKey = (): Node | undefined => all('Focusable').find(n => n.props.light === true);
const label = (n: Node | undefined) =>
  n
    ? n
        .findAll(x => (x.type as unknown) === 'Text')
        .map(x => x.children.join(''))
        .join('|')
    : '';
const burst = () => all('Burst')[0].props.fire as number;
const cards = () => all('Card');
const tick = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
const press = async (n: Node) => {
  act(() => {
    n.props.onPress();
  });
  await flush();
};
const say = (s: string) => act(() => all('TextInput')[0].props.onChangeText(s));
// the run of this length that is still going
const running = (ms: number) => mockRuns.filter(r => r.ms === ms && !r.stopped && r.done);
const end = (ms: number) =>
  act(() => {
    const r = running(ms).pop();
    if (!r) throw new Error(`no run of ${ms} ms is going`);
    mockRuns.splice(mockRuns.indexOf(r), 1);
    r.done?.({finished: true});
  });

// the server's answer, held by the test
let answer: (v: unknown) => void = () => {};
let refuse: (e: Error) => void = () => {};
const ask = async (q = 'slow and beautiful, nothing scary') => {
  say(q);
  await press(byUi('pick.go')[0]);
};
// from the ask to the prize, the whole show
const draw = async (hand: unknown[] = HAND) => {
  await ask();
  answer({items: hand});
  await flush();
  tick(1200); // the pictures had their time
  end(LAND_MS);
  tick(HOLD_MS);
};

beforeEach(() => {
  jest.useFakeTimers();
  (globalThis as unknown as {pickDrop?: () => void}).pickDrop?.();
  mockRuns.length = 0;
  mockLoops.on = 0;
  mockLite.on = false;
  mockRemote.moved = false;
  mockRemote.rail = false;
  focusLog.length = 0;
  navEvents.focus.length = 0;
  navEvents.blur.length = 0;
  nav.push.mockClear();
  mockToast.mockClear();
  mockApi.aiStatus.mockReset();
  mockApi.aiRecommend.mockReset();
  mockApi.aiStatus.mockResolvedValue({enabled: true});
  mockApi.aiRecommend.mockImplementation(
    () =>
      new Promise((res, rej) => {
        answer = res;
        refuse = rej;
      }),
  );
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

describe('before the ask', () => {
  it('is the question: Find in focus, the dials, three examples, and no stage', async () => {
    await mount();
    const find = byUi('pick.go');
    expect(find).toHaveLength(1);
    expect(find[0].props.hasTVPreferredFocus).toBe(true);
    expect(find[0].props.label).toBe('Find me something');
    expect(byUi('pick.option').length).toBeGreaterThanOrEqual(10);
    expect(byUi('pick.example')).toHaveLength(3);
    expect(mainKey()).toBeUndefined();
    expect(byUi('pick.unfold')).toHaveLength(0);
    expect(burst()).toBe(0);
    expect(mockLoops.on).toBe(0);
  });

  it('a question too short to ask puts focus in the field instead', async () => {
    await mount();
    await press(byUi('pick.go')[0]);
    expect(mockApi.aiRecommend).not.toHaveBeenCalled();
    expect(focusLog).toEqual(['field']);
    expect(mainKey()).toBeUndefined();
  });

  it('an example is asked as it stands', async () => {
    await mount();
    const ex = byUi('pick.example')[0];
    const words = ex.props.label as string;
    expect(words.length).toBeGreaterThan(10);
    await press(ex);
    expect(mockApi.aiRecommend).toHaveBeenCalledWith(words, 0, 'any', 'any', false);
    expect(mainKey()).toBeDefined();
  });

  it('a server without a recommender says so, and asks nothing', async () => {
    mockApi.aiStatus.mockResolvedValue({enabled: false});
    await mount();
    say('anything at all');
    await press(byUi('pick.go')[0]);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockApi.aiRecommend).not.toHaveBeenCalled();
    expect(mainKey()).toBeUndefined();
    expect(byUi('pick.example')).toHaveLength(0);
  });
});

describe('the wait', () => {
  it('the stage comes out, the question folds, and focus is handed to the one key', async () => {
    await mount();
    await ask();
    expect(mockApi.aiRecommend).toHaveBeenCalledWith('slow and beautiful, nothing scary', 0, 'any', 'any', false);
    // the question is one line now
    expect(byUi('pick.go')).toHaveLength(0);
    expect(byUi('pick.unfold')).toHaveLength(1);
    // the key waits: not Open yet, not counted as a press on Open
    const key = mainKey()!;
    expect(label(key)).toBe('Thinking…');
    expect(key.props.uiId).toBeUndefined();
    expect(key.props.edgeLeft).toBe(true);
    expect(byUi('pick.another')).toHaveLength(0);
    tick(150);
    expect(focusLog).toEqual(['Thinking…', 'Thinking…']);
    // if the focus passes over the folded line on its way there, the line stays folded
    act(() => byUi('pick.unfold')[0].props.onFocusChange(true));
    expect(byUi('pick.go')).toHaveLength(0);
    // the wait narrates itself, and the reel and the stars run (two loops, no more)
    expect(texts()).toEqual(expect.arrayContaining(['Reading the room…', 'The whole hand', 'Being dealt…']));
    expect(mockLoops.on).toBe(2);
    tick(2600);
    expect(texts()).toContain('Ransacking the archives…');
    // pressing the key now opens nothing
    await press(key);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('one draw at a time: a second ask while the question is out is ignored', async () => {
    await mount();
    await ask();
    await press(byUi('pick.retry')[0]);
    expect(mockApi.aiRecommend).toHaveBeenCalledTimes(1);
  });

  it('nothing runs while another screen is in front', async () => {
    await mount();
    await ask();
    expect(mockLoops.on).toBe(2);
    act(() => navEvents.blur.forEach(fn => fn()));
    expect(mockLoops.on).toBe(0);
    act(() => navEvents.focus.forEach(fn => fn()));
    expect(mockLoops.on).toBe(2);
  });
});

describe('the landing', () => {
  it('waits for its pictures unseen, rolls once, stands a beat, and is the prize — on the same key', async () => {
    await mount();
    await ask();
    const key = mainKey()!;
    answer({items: HAND});
    await flush();
    // the strip is there with its posters, unseen, behind the waiting reel
    const posters = all('Image').filter(i => i.props.source && i.props.source.uri);
    expect(posters).toHaveLength(8);
    expect(running(LAND_MS)).toHaveLength(0);
    expect(mockLoops.on).toBe(2);
    // the pictures are in: the reel comes down (one run), the loops are over
    act(() => posters.forEach(i => i.props.onLoad()));
    expect(running(LAND_MS)).toHaveLength(1);
    expect(mockLoops.on).toBe(0);
    expect(texts()).toContain('TONIGHT’S PICK');
    expect(texts()).not.toContain('Pick 1');
    expect(cards()).toHaveLength(0);
    expect(label(mainKey())).toBe('Thinking…');
    // (the 1200 ms the pictures were given does not start a second roll)
    tick(1200);
    expect(running(LAND_MS)).toHaveLength(1);
    // it comes to rest: the hand is dealt in the still beat, the prize after it
    end(LAND_MS);
    expect(cards()).toHaveLength(5);
    expect(burst()).toBe(0);
    expect(label(mainKey())).toBe('Thinking…');
    tick(HOLD_MS);
    expect(burst()).toBe(1);
    expect(mainKey()).toBe(key);
    expect(label(key)).toBe('Open');
    expect(key.props.uiId).toBe('pick.open');
    expect(key.props.accessibilityLabel).toBe('Open Pick 1');
    expect(texts()).toEqual(expect.arrayContaining(['TONIGHT’S PICK', '·  1 of 5', 'Pick 1', '2001  ·  Film', 'On this server', 'Because of reason 1.', 'Another one']));
    expect(texts()).toContain('5 films for “slow and beautiful, nothing scary”');
    expect(byUi('pick.another')).toHaveLength(1);
    // focus was handed once, at the ask, and to nothing since
    expect(focusLog.every(f => f === 'Thinking…')).toBe(true);
  });

  it('pictures that never arrive hold it up for 1200 ms and no longer', async () => {
    await mount();
    await ask();
    answer({items: HAND});
    await flush();
    tick(1199);
    expect(running(LAND_MS)).toHaveLength(0);
    tick(1);
    expect(running(LAND_MS)).toHaveLength(1);
  });

  it('picks without pictures roll at once, as titled tiles', async () => {
    await mount();
    await ask();
    answer({items: [pick(1, {poster: null}), pick(2, {poster: null})]});
    await flush();
    tick(0);
    expect(running(LAND_MS)).toHaveLength(1);
    expect(texts()).toEqual(expect.arrayContaining(['Pick 1', 'Pick 2'])); // (on the tiles)
  });

  it('Open is deaf for the first 400 ms, then opens the pick that was drawn', async () => {
    await mount();
    await draw();
    await press(mainKey()!);
    expect(nav.push).not.toHaveBeenCalled();
    tick(400);
    await press(mainKey()!);
    expect(nav.push).toHaveBeenCalledWith('Detail', {item: HAND[0]});
  });

  it('one pick is a prize without Another one', async () => {
    await mount();
    await draw([pick(1)]);
    expect(label(mainKey())).toBe('Open');
    expect(byUi('pick.another')).toHaveLength(0);
    expect(texts()).not.toContain('·  1 of 1');
    expect(texts()).toContain('1 film for “slow and beautiful, nothing scary”');
    expect(burst()).toBe(1);
  });

  it('left in the middle of the roll, it is simply there on the way back: no burst', async () => {
    await mount();
    await ask();
    answer({items: HAND});
    await flush();
    tick(1200);
    expect(running(LAND_MS)).toHaveLength(1);
    act(() => navEvents.blur.forEach(fn => fn()));
    expect(label(mainKey())).toBe('Open');
    expect(texts()).toContain('Pick 1');
    expect(cards()).toHaveLength(5);
    expect(burst()).toBe(0);
    tick(HOLD_MS + 50);
    expect(burst()).toBe(0);
  });
});

describe('Another one', () => {
  it('rolls to the next pick, round to the first again, with no second reward', async () => {
    await mount();
    await draw();
    tick(400);
    const key = mainKey()!;
    await press(byUi('pick.another')[0]);
    expect(running(RESPIN_MS)).toHaveLength(1);
    // while it rolls, neither key does anything
    await press(byUi('pick.another')[0]);
    await press(key);
    expect(running(RESPIN_MS)).toHaveLength(1);
    expect(nav.push).not.toHaveBeenCalled();
    end(RESPIN_MS);
    expect(texts()).toEqual(expect.arrayContaining(['·  2 of 5', 'Pick 2', 'Because of reason 2.']));
    expect(texts()).not.toContain('On this server');
    expect(mainKey()).toBe(key);
    expect(burst()).toBe(1);
    // the drawn pick is marked in the hand: a gold title
    const gold = tree.root.findAll(
      n => (n.type as unknown) === 'Text' && [n.props.style].flat(9).some((s: {color?: string} | false | null) => !!s && s.color === PLAY.gold) && n.children.join('') === 'Pick 2',
    );
    expect(gold).toHaveLength(1);
    await press(key);
    expect(nav.push).toHaveBeenCalledWith('Detail', {item: HAND[1]});
    // all the way round
    for (let i = 0; i < 4; i++) {
      await press(byUi('pick.another')[0]);
      end(RESPIN_MS);
    }
    expect(texts()).toContain('·  1 of 5');
    expect(burst()).toBe(1);
  });

  it('coming back to the tab paints the prize that was drawn, still: nothing is asked, nothing rolls', async () => {
    await mount();
    await draw();
    await press(byUi('pick.another')[0]);
    end(RESPIN_MS);
    act(() => tree.unmount());
    mockRuns.length = 0;
    mockApi.aiRecommend.mockClear();
    await mount();
    expect(mockApi.aiRecommend).not.toHaveBeenCalled();
    const key = mainKey()!;
    expect(label(key)).toBe('Open');
    expect(key.props.hasTVPreferredFocus).toBe(true);
    expect(texts()).toEqual(expect.arrayContaining(['·  2 of 5', 'Pick 2']));
    expect(cards()).toHaveLength(5);
    expect(burst()).toBe(0);
    expect(running(LAND_MS)).toHaveLength(0);
    expect(mockLoops.on).toBe(0);
    expect(byUi('pick.go')).toHaveLength(0); // the question is folded
  });
});

describe('calm', () => {
  it('gets the prize at once: no reel, no flash, no burst, nothing running', async () => {
    mockLite.on = true;
    await mount();
    await ask();
    expect(mockLoops.on).toBe(0);
    answer({items: HAND});
    await flush();
    expect(label(mainKey())).toBe('Open');
    expect(texts()).toEqual(expect.arrayContaining(['Pick 1', '·  1 of 5']));
    expect(cards()).toHaveLength(5);
    tick(2000);
    expect(burst()).toBe(0);
    expect(mockRuns).toHaveLength(0);
    await press(byUi('pick.another')[0]);
    expect(texts()).toContain('Pick 2');
    expect(mockRuns).toHaveLength(0);
  });
});

describe('an ask that came to nothing', () => {
  it('no picks: the stage folds away and the question is back, focus on Find', async () => {
    await mount();
    await ask();
    tick(400);
    focusLog.length = 0;
    answer({items: []});
    await flush();
    expect(byUi('pick.go')).toHaveLength(1);
    expect(texts()).toEqual(expect.arrayContaining(['No picks', 'Nothing matched — try fewer filters']));
    tick(150);
    expect(focusLog).toEqual(['pick.go', 'pick.go']);
    // the key that held the focus stays mounted, unseen, until Find has it
    expect(mainKey()).toBeDefined();
    tick(400);
    expect(mainKey()).toBeUndefined();
    expect(byUi('pick.unfold')).toHaveLength(0);
    expect(burst()).toBe(0);
    expect(mockLoops.on).toBe(0);
  });

  it('the server said why not: its own words', async () => {
    await mount();
    await ask();
    refuse(new Error('Too many questions today.'));
    await flush();
    expect(texts()).toContain('Too many questions today.');
    expect(byUi('pick.go')).toHaveLength(1);
    // and it can be asked again
    tick(500);
    await press(byUi('pick.retry')[0]);
    expect(mockApi.aiRecommend).toHaveBeenCalledTimes(2);
    expect(mockApi.aiRecommend).toHaveBeenLastCalledWith('slow and beautiful, nothing scary', 0, 'any', 'any', true);
    expect(label(mainKey())).toBe('Thinking…');
  });
});

describe('the hand', () => {
  it('UP from its top row lands on Try again, and not with the press that arrived there', async () => {
    await mount();
    await draw();
    focusLog.length = 0;
    act(() => cards()[0].props.onFocus(HAND[0], 0));
    mockRemote.moved = true;
    act(() => mockRemote.key({eventType: 'up'}));
    expect(focusLog).toEqual([]);
    mockRemote.moved = false;
    act(() => mockRemote.key({eventType: 'up'}));
    expect(focusLog).toEqual(['pick.retry']);
    // once, not on every UP after it
    act(() => mockRemote.key({eventType: 'up'}));
    expect(focusLog).toEqual(['pick.retry']);
  });

  it('UP from the folded question opens it again with focus on Find; a stage key folds it', async () => {
    await mount();
    await draw();
    tick(400);
    focusLog.length = 0;
    act(() => byUi('pick.unfold')[0].props.onFocusChange(true));
    expect(byUi('pick.go')).toHaveLength(1);
    tick(150);
    expect(focusLog).toEqual(['pick.go', 'pick.go']);
    tick(400);
    expect(byUi('pick.unfold')).toHaveLength(0);
    expect(label(mainKey())).toBe('Open'); // the prize stays where it was
    act(() => mainKey()!.props.onFocusChange(true));
    expect(byUi('pick.go')).toHaveLength(0);
    expect(byUi('pick.unfold')).toHaveLength(1);
  });

  it('Try again asks afresh; the same key waits again and the old hand is gone', async () => {
    await mount();
    await draw();
    const key = mainKey()!;
    await press(byUi('pick.retry')[0]);
    expect(mockApi.aiRecommend).toHaveBeenLastCalledWith('slow and beautiful, nothing scary', 0, 'any', 'any', true);
    expect(mainKey()).toBe(key);
    expect(label(key)).toBe('Thinking…');
    expect(cards()).toHaveLength(0);
    answer({items: HAND.slice(0, 3), cached: true});
    await flush();
    tick(1200);
    end(LAND_MS);
    tick(HOLD_MS);
    expect(burst()).toBe(2); // a new answer, its own reward
    expect(texts()).toContain('3 films for “slow and beautiful, nothing scary” · from earlier');
  });
});
