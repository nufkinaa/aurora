// Taste on the TV (src/screens/Taste.tsx), driven the way the remote drives
// it: the card in focus, LEFT / RIGHT / DOWN as the three answers, the remark
// at a lit star said once (also after Undo), and the end of a round — the
// number, what Aurora learned, the one burst per round, none under calm.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

// Animations that are started and stay "running" until the test ends them.
const mockRuns: Array<{to: number; ms: number; done?: (r: {finished: boolean}) => void}> = [];
jest.mock('react-native', () => {
  const rn = jest.requireActual('./rn-stub.js');
  const group = (list: Array<{start: () => void}>) => ({start: () => list.forEach(a => a.start()), stop: () => {}});
  return {
    ...rn,
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      ...rn.Animated,
      timing: (_v: unknown, cfg: {toValue: number; duration: number}) => {
        const run: {to: number; ms: number; done?: (r: {finished: boolean}) => void} = {to: cfg.toValue, ms: cfg.duration};
        return {
          start: (cb?: (r: {finished: boolean}) => void) => {
            run.done = cb;
            mockRuns.push(run);
          },
          stop: () => {},
        };
      },
      parallel: group,
      sequence: group,
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
const mockApi = {tasteDeck: jest.fn(), tasteAnswer: jest.fn()};
jest.mock('../../src/api', () => ({
  get api() {
    return mockApi;
  },
  artPath: () => null,
  artPx: () => 480,
  imgSrc: (p: string | null) => (p ? {uri: p} : null),
}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p1'})}));
jest.mock('../../src/useRouteShown', () => ({useRouteShown: () => {}}));
const mockRemote: {key: (e: {eventType: string}) => void; moved: boolean} = {key: () => {}, moved: false};
jest.mock('../../src/focus', () => ({
  useFocusFallback: () => {},
  noteOwnFocusMove: () => {},
  pressMovedFocus: () => mockRemote.moved,
  useTVKeys: (fn: (e: {eventType: string}) => void) => {
    mockRemote.key = fn;
  },
}));
jest.mock('../../src/artPrefetch', () => ({artForget: () => {}, artIdle: () => {}}));
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (...a: unknown[]) => mockToast(...a)}));
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

import Taste from '../../src/screens/Taste';
import {T} from '../../src/play/tokens';

type Node = TestRenderer.ReactTestInstance;
const card = (n: number, genres = ['Comedy']) => ({imdbId: `tt${n}`, id: `lib${n}`, type: 'movie' as const, title: `Title ${n}`, year: 2020 + n, poster: null, genres, line: `What title ${n} is about.`});
const nav = {isFocused: () => true, goBack: jest.fn()};

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
    tree = TestRenderer.create(<Taste navigation={nav as never} route={{key: 'Taste', name: 'Taste'} as never} />);
  });
  await flush();
};
const texts = () =>
  tree.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n => n.children.filter(c => typeof c === 'string').join(''))
    .filter(Boolean);
const byUi = (id: string): Node[] => tree.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.uiId === id);
const all = (type: string): Node[] => tree.root.findAll(n => (n.type as unknown) === type);
const focusCard = () => act(() => byUi('taste.love')[0].props.onFocusChange(true));
const key = async (eventType: string) => {
  act(() => mockRemote.key({eventType}));
  await flush();
};
// every animation that is still running ends
const settle = () =>
  act(() => {
    for (const r of mockRuns.splice(0)) r.done?.({finished: true});
  });

beforeEach(() => {
  jest.useFakeTimers();
  mockRuns.length = 0;
  mockLite.on = false;
  mockRemote.moved = false;
  mockHit.mockClear();
  mockToast.mockClear();
  nav.goBack.mockClear();
  mockApi.tasteDeck.mockReset();
  mockApi.tasteAnswer.mockReset();
  // a round of four; the server always has two more cards
  let n = 6;
  mockApi.tasteDeck.mockResolvedValue({goal: 4, more: 4, cards: [1, 2, 3, 4, 5, 6].map(k => card(k))});
  mockApi.tasteAnswer.mockImplementation(async () => ({was: null, cards: [card(++n), card(++n)]}));
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

describe('the deck', () => {
  it('shows the card in focus, what it is on its foot, and the three answers where their keys are', async () => {
    await mount();
    const c = byUi('taste.love');
    expect(c).toHaveLength(1);
    expect(c[0].props.hasTVPreferredFocus).toBe(true);
    const t = texts();
    expect(t).toEqual(expect.arrayContaining(['Title 1', '2021 · Film · Comedy', 'What title 1 is about.', 'Not for me', 'Love it', "Haven't seen it", '0 / 4']));
    // the keys of the page: Undo (dim: nothing to take back) and Done
    expect(byUi('taste.undo')).toHaveLength(1);
    expect(byUi('taste.done')).toHaveLength(1);
    // LEFT, RIGHT and DOWN are answers, so they must move no focus
    const trap = all('TVFocusGuideView')[0].props;
    expect([trap.trapFocusLeft, trap.trapFocusRight, trap.trapFocusDown]).toEqual([true, true, true]);
    expect(trap.trapFocusUp).toBeUndefined();
  });

  it('answers with the arrows only while the card is in focus, and not with the press that arrived on it', async () => {
    await mount();
    await key('right');
    expect(mockApi.tasteAnswer).not.toHaveBeenCalled(); // focus is not on the card yet
    focusCard();
    mockRemote.moved = true;
    await key('down');
    expect(mockApi.tasteAnswer).not.toHaveBeenCalled(); // that press only carried focus here
    mockRemote.moved = false;
    await key('right');
    expect(mockHit).toHaveBeenCalledWith('taste.love');
    expect(mockApi.tasteAnswer).toHaveBeenCalledWith('p1', expect.objectContaining({imdbId: 'tt1', verdict: 'love'}));
    // the stamped card is on its way out over the next one
    expect(texts()).toEqual(expect.arrayContaining(['LOVE', 'Title 1', 'Title 2', '1 / 4']));
    // one run for the answer: slam + throw
    expect(mockRuns.some(r => r.ms === T.slam + T.throw)).toBe(true);
    settle();
    expect(texts()).not.toContain('LOVE');
    expect(texts()).not.toContain('Title 1');
    await key('left');
    expect(mockHit).toHaveBeenCalledWith('taste.nope');
    expect(texts()).toContain('NOPE');
    settle();
    await key('down');
    expect(mockHit).toHaveBeenCalledWith('taste.skip');
    expect(texts()).toContain("HAVEN'T SEEN");
    // OK on the card is Love
    settle();
    expect(mockApi.tasteAnswer).toHaveBeenCalledTimes(3);
  });

  it('says something at a lit star — once, also after Undo', async () => {
    await mount();
    focusCard();
    await key('right');
    expect(texts()).toContain('First stars are lit');
    act(() => {
      jest.advanceTimersByTime(T.pillIn + T.pillHold + T.pillOut + 50);
    });
    expect(texts()).not.toContain('First stars are lit');
    act(() => byUi('taste.undo')[0].props.onPress());
    await flush();
    expect(texts()).toEqual(expect.arrayContaining(['Title 1', '0 / 4']));
    focusCard();
    await key('right');
    expect(texts()).toContain('1 / 4');
    expect(texts()).not.toContain('First stars are lit');
    await key('right');
    expect(texts()).toContain('A pattern is showing: Comedy');
  });
});

describe('the end of a round', () => {
  const playRound = async (n: number, keys = ['right', 'right', 'right', 'left']) => {
    focusCard();
    for (let i = 0; i < n; i++) await key(keys[i % keys.length]);
    // the round's last card is thrown like the others; the round's end comes when it has flown
    act(() => {
      for (const r of mockRuns.filter(x => x.ms !== T.burst)) {
        mockRuns.splice(mockRuns.indexOf(r), 1);
        r.done?.({finished: true});
      }
    });
    await flush();
  };

  it('waits for the last card to be thrown: the stamp and the throw are seen, then the end', async () => {
    await mount();
    focusCard();
    for (const k of ['right', 'right', 'right', 'left']) await key(k);
    expect(byUi('taste.more')).toHaveLength(0); // the last card is still in the air
    expect(texts()).toContain('NOPE'); // its stamp
    expect(byUi('taste.love')).toHaveLength(0); // nothing new on top of it
    act(() => {
      for (const r of mockRuns.splice(0)) r.done?.({finished: true});
    });
    await flush();
    expect(byUi('taste.more')).toHaveLength(1);
  });

  it('is the reward: the number, the tally, what Aurora learned, Keep going in focus — and one burst', async () => {
    await mount();
    await playRound(4);
    const t = texts();
    expect(t).toEqual(
      expect.arrayContaining(['answers — Home is already using them', '3 loved', '1 not for you', '0 not seen', 'AURORA LEARNED', 'Comedy ×3']),
    );
    expect(tree.root.findAll(n => n.props.accessibilityLabel === '4 answers').length).toBeGreaterThan(0);
    expect(byUi('taste.love')).toHaveLength(0);
    const more = byUi('taste.more');
    expect(more).toHaveLength(1);
    expect(more[0].props.hasTVPreferredFocus).toBe(true);
    // the page's Done at the top, and the round's own
    expect(byUi('taste.done')).toHaveLength(2);
    expect(byUi('taste.done').some(d => d.props.hasTVPreferredFocus)).toBe(false);
    // three loved titles = three stars in the sky; the burst comes a moment later
    const before = all('Animated.Image').length;
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(all('Animated.Image').length - before).toBe(17); // 16 meteors and the flash
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(1);
  });

  it('gives a round its burst once: not again after Undo, and a smaller one for the next round', async () => {
    await mount();
    await playRound(4);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(1);
    // the last answer is taken back and given again: the same round ends twice
    act(() => byUi('taste.undo')[0].props.onPress());
    await flush();
    expect(byUi('taste.love')).toHaveLength(1);
    await playRound(1);
    expect(byUi('taste.more')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(1);
    // Keep going: the deck is back, the round is four longer
    act(() => byUi('taste.more')[0].props.onPress());
    await flush();
    expect(byUi('taste.love')).toHaveLength(1);
    expect(texts()).toContain('4 / 8');
    await playRound(4);
    const before = all('Animated.Image').length;
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(all('Animated.Image').length - before).toBe(10); // 9 meteors and the flash
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(2);
  });

  it('is still and complete under calm: the plain number, no burst, nothing running', async () => {
    mockLite.on = true;
    await mount();
    await playRound(4);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(texts()).toEqual(expect.arrayContaining(['4', 'answers — Home is already using them', 'Comedy ×3']));
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(0);
    // no flight either: a short fade
    expect(mockRuns.some(r => r.ms === T.slam + T.throw)).toBe(false);
  });

  it('says so when every title was answered: Done in focus, no Keep going, no burst', async () => {
    mockApi.tasteDeck.mockResolvedValue({goal: 24, more: 12, cards: [card(1), card(2, ['Drama'])]});
    mockApi.tasteAnswer.mockResolvedValue({was: null, cards: []});
    await mount();
    await playRound(2, ['right', 'down']);
    expect(texts()).toEqual(expect.arrayContaining(["That's every title we had for you", '1 loved', '0 not for you', '1 not seen']));
    expect(byUi('taste.more')).toHaveLength(0);
    expect(byUi('taste.done').filter(d => d.props.hasTVPreferredFocus)).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockRuns.filter(r => r.ms === T.burst)).toHaveLength(0);
  });

  it('Done leaves', async () => {
    await mount();
    act(() => byUi('taste.done')[0].props.onPress());
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('when it goes wrong', () => {
  it('says the titles did not load', async () => {
    mockApi.tasteDeck.mockRejectedValue(new Error('offline'));
    await mount();
    expect(texts()).toContain("Couldn't load titles — try again in a moment.");
    expect(byUi('taste.love')).toHaveLength(0);
  });

  it('an answer the server did not store is taken back, with a word', async () => {
    mockApi.tasteAnswer.mockRejectedValue(new Error('offline'));
    await mount();
    focusCard();
    await key('right');
    expect(mockToast).toHaveBeenCalledWith("Couldn't save that answer — try again", expect.anything());
    expect(texts()).toEqual(expect.arrayContaining(['Title 1', '0 / 4']));
  });
});
