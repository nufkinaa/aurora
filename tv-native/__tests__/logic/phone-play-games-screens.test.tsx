// Pick for me and Taste on the phone in the Aurora Play look, mounted with the server stood
// in for: the draw (ask -> the reel's wait -> the answer rolls in -> the prize with Open and
// Another one, the whole hand; calm: the prize at once), and the deck (the keys answer at
// once, the meter's stars, a lit star's line, the round's end with what Aurora learned).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

const mockCalm = {on: false};
jest.mock('react-native', () => {
  const rn = jest.requireActual('./rn-stub.js');
  class Value {
    v: number;
    constructor(v: number) {
      this.v = v;
    }
    setValue(v: number) {
      this.v = v;
    }
    stopAnimation(cb?: (v: number) => void) {
      if (cb) cb(this.v);
    }
    interpolate(cfg: unknown) {
      return {interpolated: cfg, interpolate: (c: unknown) => ({interpolated: c})};
    }
  }
  class ValueXY {
    x: Value;
    y: Value;
    constructor(v: {x: number; y: number} = {x: 0, y: 0}) {
      this.x = new Value(v.x);
      this.y = new Value(v.y);
    }
    setValue(v: {x: number; y: number}) {
      this.x.setValue(v.x);
      this.y.setValue(v.y);
    }
    stopAnimation() {}
  }
  // every animation ends at once (the reel lands, the cards fly)
  const anim = () => ({start: (cb?: (r: {finished: boolean}) => void) => cb && cb({finished: true}), stop: () => {}});
  return {
    ...rn,
    ScrollView: 'ScrollView',
    FlatList: 'FlatList',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    Keyboard: {dismiss: () => {}},
    PanResponder: {create: () => ({panHandlers: {}})},
    AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(mockCalm.on), isScreenReaderEnabled: () => Promise.resolve(false)},
    useWindowDimensions: () => ({width: 412, height: 915}),
    Animated: {...rn.Animated, Value, ValueXY, add: () => 0, multiply: () => 0, timing: anim, spring: anim, parallel: anim, sequence: anim, loop: () => ({start: () => {}, stop: () => {}})},
  };
});
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 24, bottom: 16, left: 0, right: 0})}));
jest.mock('@react-navigation/native', () => ({StackActions: {replace: () => ({}), pop: () => ({})}, useNavigation: () => ({})}));
jest.mock('../../src/perfTier', () => ({isLite: () => false}));
jest.mock('../../src/trail', () => ({trail: () => {}}));
jest.mock('../../src/telemetry', () => ({uiHit: () => {}}));
jest.mock('../../src/toast', () => ({showToast: jest.fn()}));
jest.mock('../../src/profileScope', () => ({registerProfileCache: () => {}}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p1'})}));
jest.mock('../../src/navSection', () => ({useMe: () => ({id: 'p1', name: 'Maya'})}));
const mockOpen = jest.fn();
jest.mock('../../src/openItem', () => ({openItem: (...a: unknown[]) => mockOpen(...a)}));
jest.mock('../../src/phone/native', () => ({phoneNative: {haptic: () => {}}}));
jest.mock('../../src/phone/aiStatus', () => ({aiKnown: () => true, aiEnabled: () => Promise.resolve(true)}));
jest.mock('../../src/phone/nav', () => ({usePNav: () => ({push: jest.fn(), addListener: () => () => {}, isFocused: () => true})}));
jest.mock('../../src/phone/ui/Cards', () => ({artSrc: () => ({src: null})}));
jest.mock('../../src/phone/ui/Grid', () => ({gridColumns: () => 3}));
jest.mock('../../src/phone/ui/PageHead', () => ({BackBar: () => null, useColumn: () => null, usePageTop: () => 100, useSolidBar: () => ({solid: false, onScroll: () => {}})}));
jest.mock('../../src/phone/ui/TabBar', () => ({useTabBarSpace: () => 80}));
jest.mock('../../src/phone/ui/TopBar', () => ({useBarTop: () => 20}));
jest.mock('../../src/phone/ui/Tap', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Tap', p, p.children as never)};
});
jest.mock('../../src/phone/ui/Buttons', () => {
  const R = jest.requireActual('react');
  const b = (name: string) => (p: Record<string, unknown>) => R.createElement(name, p);
  return {PrimaryButton: b('PrimaryButton'), GlassButton: b('GlassButton'), ChipButton: b('ChipButton')};
});
const mockApi = {aiRecommend: jest.fn(), tasteDeck: jest.fn(), tasteAnswer: jest.fn()};
jest.mock('../../src/api', () => ({
  get api() {
    return mockApi;
  },
  apiPost: jest.fn(() => Promise.resolve({})),
  apiRequest: jest.fn(() => Promise.resolve({})),
}));

import Pick from '../../src/phone/screens/Pick';
import Taste from '../../src/phone/screens/Taste';

type R = TestRenderer.ReactTestRenderer;
let r: R;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const texts = () =>
  r.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n => [].concat(n.props.children).flat(9).filter(c => typeof c === 'string' || typeof c === 'number').join(''));
const has = (t: string) => texts().some(x => x.includes(t));
const byUi = (id: string) => r.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.uiId === id);
const press = async (id: string, i = 0) => {
  await act(async () => {
    byUi(id)[i].props.onPress(); // (not awaited: an ask stays open until the answer is given)
  });
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCalm.on = false;
});
afterEach(() => {
  act(() => r?.unmount());
  jest.useRealTimers();
});

const PICKS = [
  {id: 'a', title: 'Knives Out', year: 2019, type: 'movie', why: 'A whodunit with a wink.'},
  {id: 'b', title: 'Inception', year: 2010, type: 'movie', why: 'A heist inside a dream.'},
  {id: 'c', title: 'Silo', year: 2023, type: 'show', why: 'A mystery that keeps paying off.'},
];

test('Pick for me: the reel waits, the answer is drawn, Another one walks the hand', async () => {
  let answer!: (v: unknown) => void;
  mockApi.aiRecommend.mockReturnValue(new Promise(ok => (answer = ok)));
  await act(async () => {
    r = TestRenderer.create(<Pick />);
  });
  await flush();
  expect(has('AI')).toBe(true);
  expect(has('Pick together')).toBe(true);
  const input = r.root.find(n => (n.type as unknown) === 'TextInput');
  await act(async () => input.props.onChangeText('a clever heist with a twist'));
  await press('pick.go');
  // the wait: card backs in the reel and the narration
  expect(has('Reading the room…')).toBe(true);
  await act(async () => answer({items: PICKS, cached: false}));
  await flush();
  // the reel has landed (the stub ends every animation at once); a beat, then the prize
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  await flush();
  expect(has("Tonight's pick")).toBe(true);
  expect(has('Knives Out')).toBe(true);
  expect(has('2019 · Film')).toBe(true);
  expect(has('A whodunit with a wink.')).toBe(true);
  expect(has(' · 1 of 3')).toBe(true);
  expect(has('The whole hand')).toBe(true);
  expect(has('3 films for “a clever heist with a twist”')).toBe(true);
  await press('pick.another');
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  await flush();
  expect(has(' · 2 of 3')).toBe(true);
  expect(has('2010 · Film')).toBe(true);
  await press('pick.open');
  expect(mockOpen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({title: 'Inception'}));
});

test('Pick for me, Remove animations: the prize at once', async () => {
  mockCalm.on = true;
  mockApi.aiRecommend.mockResolvedValue({items: PICKS, cached: false});
  await act(async () => {
    r = TestRenderer.create(<Pick />);
  });
  await flush();
  await press('pick.example', 0);
  await flush();
  expect(has("Tonight's pick")).toBe(true);
  expect(has('Knives Out')).toBe(true);
});

const CARDS = Array.from({length: 12}, (_, i) => ({imdbId: `tt${100 + i}`, type: 'movie', title: `Film ${i + 1}`, year: 2000 + i, genres: [i % 2 ? 'Comedy' : 'Drama']}));

test('Taste: the keys answer at once, the stars light and say something, the round ends with what Aurora learned', async () => {
  let served = 0;
  mockApi.tasteDeck.mockImplementation(() => Promise.resolve({cards: CARDS.slice(0, 6), goal: 4, more: 4}));
  mockApi.tasteAnswer.mockImplementation(() => {
    served += 1;
    return Promise.resolve({cards: CARDS.slice(6 + served, 8 + served), was: null});
  });
  await act(async () => {
    r = TestRenderer.create(<Taste navigation={{push: jest.fn(), goBack: jest.fn(), addListener: () => () => {}, isFocused: () => true} as never} route={{} as never} />);
  });
  await flush();
  expect(has("What's your taste?")).toBe(true);
  expect(has('0 / 4')).toBe(true);
  const stage = r.root.find(n => (n.type as unknown) === 'View' && typeof n.props.onLayout === 'function' && n.props.style && n.props.style.minHeight === 240);
  await act(async () => stage.props.onLayout({nativeEvent: {layout: {width: 412, height: 520}}}));
  expect(has('Film 1')).toBe(true);
  await press('taste.love');
  expect(has('1 / 4')).toBe(true);
  // a quarter of the round: the first star lights and says so
  expect(has('First stars are lit')).toBe(true);
  await press('taste.love');
  await press('taste.nope');
  await press('taste.love');
  await flush();
  expect(has('4 / 4')).toBe(true);
  expect(has('answers — Home is already using them')).toBe(true);
  expect(has('♥FE0E 3 loved')).toBe(true); // (the heart drawn as text, not an emoji)
  expect(has('✕ 1 not for you')).toBe(true);
  expect(has('Aurora learned')).toBe(true);
  expect(byUi('taste.more')).toHaveLength(1);
  expect(byUi('taste.done').length).toBeGreaterThan(0);
  expect(mockApi.tasteAnswer).toHaveBeenCalledTimes(4);
});
