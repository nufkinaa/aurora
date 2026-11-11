// The phone's play screens, mounted (src/phone/play/*, screens/Wrapped.tsx): every chapter of
// the Wrapped story draws, moving and still, with its words; the story's frame (Skip, close,
// pause) moves and closes; All the numbers and the teaser draw; the share card is one picture;
// a kids year gets the highlights, never a roast.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

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
  const anim = () => ({start: () => {}, stop: () => {}});
  return {
    ...rn,
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    Share: {share: () => Promise.resolve()},
    BackHandler: {addEventListener: () => ({remove: () => {}})},
    PanResponder: {create: () => ({panHandlers: {}})},
    AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(false), isScreenReaderEnabled: () => Promise.resolve(false)},
    useWindowDimensions: () => ({width: 412, height: 915}),
    Animated: {
      ...rn.Animated,
      Value,
      ValueXY,
      add: () => 0,
      multiply: () => 0,
      timing: anim,
      spring: anim,
      parallel: anim,
      sequence: anim,
      loop: anim,
    },
  };
});
jest.mock('react-native-svg', () => {
  const R = jest.requireActual('react');
  const host = (name: string) => (p: Record<string, unknown>) => R.createElement(name, p, p.children as never);
  const Svg = R.forwardRef((p: Record<string, unknown>, ref: unknown) => {
    R.useImperativeHandle(ref, () => ({toDataURL: (cb: (s: string) => void) => cb('iVBORw0KGgo=')}));
    return R.createElement('Svg', p, p.children as never);
  });
  return {
    __esModule: true,
    default: Svg,
    Circle: host('Circle'),
    Line: host('Line'),
    ClipPath: host('ClipPath'),
    Defs: host('Defs'),
    Ellipse: host('Ellipse'),
    G: host('G'),
    Image: host('SvgImage'),
    LinearGradient: host('LinearGradient'),
    Polygon: host('Polygon'),
    RadialGradient: host('RadialGradient'),
    Rect: host('Rect'),
    Stop: host('Stop'),
    Text: host('SvgText'),
  };
});
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 24, bottom: 16, left: 0, right: 0})}));
jest.mock('../../src/perfTier', () => ({isLite: () => false}));
jest.mock('../../src/trail', () => ({trail: () => {}}));
jest.mock('../../src/telemetry', () => ({uiHit: () => {}}));
jest.mock('../../src/toast', () => ({showToast: jest.fn()}));
const mockShare = jest.fn(() => Promise.resolve(true));
jest.mock('../../src/phone/native', () => ({phoneNative: {haptic: () => {}, sharePicture: (...a: unknown[]) => mockShare(...(a as []))}}));
jest.mock('../../src/phone/ui/Cards', () => ({artSrc: () => ({src: null})}));
jest.mock('../../src/phone/ui/tabBarShown', () => ({setTabBarShown: jest.fn()}));
jest.mock('../../src/phone/ui/Tap', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Tap', p, p.children as never)};
});

import WrappedStory from '../../src/phone/play/WrappedStory';
import ChapterView, {ChapterApi} from '../../src/phone/play/WrappedChapters';
import {WrappedNumbers, WrappedTeaser} from '../../src/phone/play/WrappedPage';
import {ShareCard} from '../../src/phone/play/ShareCard';
import {ctxOf, PhoneWrapped} from '../../src/phone/play/storyWords';
import {setTabBarShown} from '../../src/phone/ui/tabBarShown';

const YEAR: PhoneWrapped = {
  since: '2026-01-17T20:00:00Z',
  totalSec: 136 * 3600,
  plays: 152,
  activeDays: 115,
  distinctTitles: 12,
  started: 6,
  finished: 4,
  bestStreak: 13,
  streak: {from: '2026-08-31', to: '2026-09-12'},
  nightsFrom: '2026-01-17',
  nights: Array.from({length: 60}, (_, i) => [i < 46 ? i * 5 : 226 + (i - 46), 30 + i] as [number, number]),
  byHour: Array.from({length: 24}, (_, h) => (h === 21 ? 50 : h > 17 ? 20 : 2) * 600),
  byWeekday: [10, 4, 3, 6, 7, 8, 14].map(v => v * 3600),
  topWeekday: 6,
  byDevice: [{name: 'TV', sec: 100 * 3600}, {name: 'Mobile', sec: 36 * 3600}],
  topTitles: [
    {name: 'Northern Static', sec: 45 * 3600, show: true, poster: '/img/meta/tt1.png'},
    {name: 'Kingdom of Ash', sec: 19 * 3600},
    {name: 'Low Orbit', sec: 18 * 3600},
    {name: 'הבית ברחוב הירקון', sec: 13 * 3600},
    {name: 'Ember & Frost', sec: 13 * 3600},
  ],
  topGenres: [
    {name: 'Drama', sec: 60 * 3600},
    {name: 'Sci-Fi', sec: 50 * 3600},
    {name: 'Mystery', sec: 40 * 3600},
  ],
  biggestDay: {day: '2026-09-12', sec: 6 * 3600},
  longestSession: {title: 'Ember & Frost', watchedSec: 3 * 3600 + 41 * 60},
  lateNightSessions: 6,
  roasts: ['You finished "Signal Lost" at 4 in the morning. Nobody needs to know. I already do.', 'Second line.'],
};

type R = TestRenderer.ReactTestRenderer;
const mount = (el: React.ReactElement): R => {
  let r!: R;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
};
const texts = (r: R) =>
  r.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n => [].concat(n.props.children).flat(9).filter(c => typeof c === 'string' || typeof c === 'number').join(''));
const has = (r: R, t: string) => texts(r).some(x => x.includes(t));

const api = (still: boolean, at = jest.fn()): ChapterApi => ({
  still,
  at,
  width: 364,
  height: 700,
  burst: jest.fn(),
  haptic: jest.fn(),
  replay: jest.fn(),
  closeStory: jest.fn(),
  share: jest.fn(),
  shareCard: null,
});

describe('every chapter draws, moving and still', () => {
  const c = ctxOf(YEAR, 'Maya', false);
  const WORDS: Record<string, string[]> = {
    opening: ['Maya,', 'your sky is ready.', '115 nights', 'TAP TO BEGIN'],
    hours: ['Time well spent (allegedly)', 'hours watched'],
    top: ['Your number one', 'Northern Static', '45 hours'],
    podium: ['The podium', 'Kingdom of Ash', 'Low Orbit', 'הבית ברחוב הירקון'],
    genres: ['Your genre DNA', 'Drama', ', with a Sci-Fi streak.', '40%'],
    night: ['When you really watch', 'Saturdays, ', '9 pm.', 'PRIME TIME', '6 sittings started after midnight. We saw that.'],
    streak: ['Your longest streak', ' nights in a row', 'Brightest night'],
    longest: ['Your longest sitting', 'hours, in one go', 'Your couch would like a word.'],
    type: ['Your viewer type', 'Based on everything you watched, you are…'],
    roasts: ['The intervention', 'We need to talk, Maya.'],
    finale: ["That's a wrap", 'in one picture.', 'All the numbers'],
  };
  for (const still of [false, true]) {
    for (const id of c.chapters) {
      test(`${id}${still ? ' (still)' : ''}`, () => {
        const r = mount(<ChapterView id={id} c={c} api={api(still)} />);
        for (const w of WORDS[id] || []) expect([id, w, has(r, w)]).toEqual([id, w, true]);
        act(() => r.unmount());
      });
    }
  }
  test('the reveal and the intervention wait on the story’s clock (and a still story deals the lines at once)', () => {
    const at = jest.fn();
    const r = mount(<ChapterView id="type" c={c} api={api(false, at)} />);
    expect(at).toHaveBeenCalledWith(2350, expect.any(Function));
    act(() => at.mock.calls[0][1]());
    expect(has(r, c.type.verdict)).toBe(true);
    act(() => r.unmount());
    const at2 = jest.fn();
    const r2 = mount(<ChapterView id="roasts" c={c} api={api(false, at2)} />);
    expect(at2).toHaveBeenCalledTimes(2);
    expect(has(r2, 'Second line.')).toBe(false);
    act(() => at2.mock.calls.forEach(([, fn]) => fn()));
    expect(has(r2, 'Second line.')).toBe(true);
    act(() => r2.unmount());
    const r3 = mount(<ChapterView id="roasts" c={c} api={api(true)} />);
    expect(has(r3, 'Second line.')).toBe(true);
    expect(has(r3, '2/2')).toBe(true);
    act(() => r3.unmount());
  });
});

describe('the story', () => {
  const c = ctxOf(YEAR, 'Maya', false);
  test('the frame: the name, Skip goes to the summary, the tab bar steps aside and comes back', () => {
    const onClose = jest.fn();
    const r = mount(<WrappedStory c={c} still={false} poster={null} onClose={onClose} />);
    expect(setTabBarShown).toHaveBeenLastCalledWith(false);
    expect(has(r, 'Maya')).toBe(true);
    expect(has(r, 'your sky is ready.')).toBe(true);
    expect(has(r, '1 of 11. Maya, your Aurora Wrapped.')).toBe(true);
    const skip = r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.skip');
    act(() => skip.props.onPress());
    expect(has(r, "That's a wrap")).toBe(true);
    expect(has(r, '11 of 11.')).toBe(true);
    // the finale holds: no Skip there
    expect(r.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.skip')).toHaveLength(0);
    const all = r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'wrapped.all');
    act(() => all.props.onPress());
    expect(onClose).toHaveBeenCalled();
    act(() => r.unmount());
    expect(setTabBarShown).toHaveBeenLastCalledWith(true);
  });
  test('a chapter’s timed moments land on its own visit’s clock (the intervention deals its lines)', () => {
    jest.useFakeTimers();
    const r = mount(<WrappedStory c={c} still={false} poster={null} onClose={() => {}} />);
    act(() => r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.skip').props.onPress());
    // back one: the intervention, its lines not dealt yet
    const back = r.root.find(n => (n.type as unknown) === 'Text' && n.props.accessibilityLabel === 'Previous chapter');
    act(() => back.props.onPress());
    expect(has(r, 'We need to talk, Maya.')).toBe(true);
    const dealt = () => texts(r).filter(x => x === 'Second line.').length; // (the card itself, not the screen reader's line)
    expect(dealt()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(1300 + 2700 + 50);
    });
    expect(dealt()).toBe(1);
    act(() => r.unmount());
    jest.useRealTimers();
  });
  test('pause shows Play; a still story has no pause key', () => {
    const r = mount(<WrappedStory c={c} still={false} poster={null} onClose={() => {}} />);
    const pause = r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.pause');
    expect(pause.props.accessibilityLabel).toBe('Pause');
    act(() => pause.props.onPress());
    expect(r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.pause').props.accessibilityLabel).toBe('Play');
    act(() => r.unmount());
    const r2 = mount(<WrappedStory c={c} still poster={null} onClose={() => {}} />);
    expect(r2.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.pause')).toHaveLength(0);
    act(() => r2.unmount());
  });
  test('the finale shares the picture with its words', async () => {
    const r = mount(<WrappedStory c={c} still poster={null} onClose={() => {}} />);
    act(() => r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'story.skip').props.onPress());
    const share = r.root.find(n => (n.type as unknown) === 'Tap' && n.props.uiId === 'wrapped.share');
    await act(async () => {
      await share.props.onPress();
    });
    expect(mockShare).toHaveBeenCalledWith('iVBORw0KGgo=', 'aurora-wrapped-maya.png', 'My Aurora Wrapped', `My Aurora Wrapped: 136 hours, and I'm ${c.type.name}.`);
    act(() => r.unmount());
  });
});

describe('the page, the teaser, the share card, kids', () => {
  test('All the numbers: every stat as text', () => {
    const c = ctxOf(YEAR, 'Maya', false);
    const r = mount(<WrappedNumbers c={c} onPlay={() => {}} onShare={() => {}} onBrowse={() => {}} />);
    for (const w of ['All the numbers', 'Play the story', 'Share the picture', '136', 'Your top five', 'Northern Static', 'Your genre DNA', 'Where you watch', 'Phone', '13', 'The intervention', 'Back to browsing', c.type.name])
      expect([w, has(r, w)]).toEqual([w, true]);
    act(() => r.unmount());
  });
  test('the teaser for a sky that is still dark', () => {
    const r = mount(<WrappedTeaser name="Noa" onBrowse={() => {}} />);
    expect(has(r, 'Your sky is still dark, ')).toBe(true);
    expect(has(r, 'Noa.')).toBe(true);
    expect(has(r, 'Find something to watch')).toBe(true);
    expect(has(r, 'Your viewer type')).toBe(true);
    act(() => r.unmount());
  });
  test('the share card: the profile’s own name and stats, no roasts', () => {
    const c = ctxOf(YEAR, 'Maya', false);
    const r = mount(<ShareCard c={c} width={240} poster={null} />);
    const words = r.root.findAll(n => (n.type as unknown) === 'SvgText').map(n => [].concat(n.props.children).join(''));
    for (const w of ['AURORA WRAPPED', 'Maya', '136', 'hours watched', 'VIEWER TYPE', 'NUMBER ONE', 'Northern Static', 'TOP GENRE', 'Drama', '13 nights', 'Saturday', 'Aurora', 'my year in the night sky']) expect([w, words.some(x => x.includes(w))]).toEqual([w, true]);
    expect(words.some(x => x.includes('Signal Lost'))).toBe(false);
    act(() => r.unmount());
  });
  test('a kids year: the highlights, never the server’s roasts', () => {
    const c = ctxOf(YEAR, 'Kiddo', true);
    const r = mount(<ChapterView id="roasts" c={c} api={api(true)} />);
    expect(has(r, 'The highlights')).toBe(true);
    expect(has(r, 'Look at you go, Kiddo!')).toBe(true);
    expect(has(r, 'Signal Lost')).toBe(false);
    act(() => r.unmount());
  });
});
