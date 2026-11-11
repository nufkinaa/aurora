// The play kit's pieces (src/play/*.tsx), mounted: what each one draws, that
// calm draws the finished state with nothing to run, and that a burst is
// given once per `fire` and never under calm.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

// Animations that are started and stay "running" (the shared stub ends them at
// once, which would take a burst off the screen before it can be looked at).
const mockRuns: Array<{to: number; ms: number; done?: (r: {finished: boolean}) => void}> = [];
jest.mock('react-native', () => {
  const rn = jest.requireActual('./rn-stub.js');
  return {
    ...rn,
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
      parallel: (list: Array<{start: () => void}>) => ({start: () => list.forEach(a => a.start()), stop: () => {}}),
      sequence: (list: Array<{start: () => void}>) => ({start: () => list.forEach(a => a.start()), stop: () => {}}),
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

import Burst from '../../src/play/Burst';
import {Plates, Stamp, Tile} from '../../src/play/Cards';
import Meter from '../../src/play/Meter';
import {Flip, Pill, Pop} from '../../src/play/Motion';
import Odometer from '../../src/play/Odometer';
import PlayKey from '../../src/play/PlayKey';
import Room from '../../src/play/Room';
import SkyLines from '../../src/play/SkyLines';
import {constellation} from '../../src/play/constellation';
import {T} from '../../src/play/tokens';

type Node = TestRenderer.ReactTestInstance;
const mount = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
};
const all = (r: TestRenderer.ReactTestRenderer, type: string): Node[] => r.root.findAll(n => (n.type as unknown) === type);
const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n => n.children.filter(c => typeof c === 'string').join(''))
    .filter(Boolean);

beforeEach(() => {
  mockRuns.length = 0;
  mockLite.on = false;
});

describe('Meter', () => {
  it('a plain ribbon has no pips; with `lit` it has the four, three pictures each', () => {
    expect(all(mount(<Meter value={0.3} width={300} />), 'Image')).toHaveLength(0);
    const r = mount(<Meter value={0.3} width={300} lit={1} />);
    expect(all(r, 'Image')).toHaveLength(8); // rim + unlit, four times
    expect(all(r, 'Animated.Image')).toHaveLength(5); // the ribbon + four lit stars
  });

  it('moves when the value changes, and not under calm', () => {
    const r = mount(<Meter value={0.2} width={300} />);
    expect(mockRuns).toHaveLength(0); // nothing runs for the first value
    act(() => r.update(<Meter value={0.5} width={300} />));
    expect(mockRuns.map(x => [x.to, x.ms])).toEqual([[0.5, T.ribbon]]);
    act(() => r.update(<Meter value={0.7} width={300} calm />));
    expect(mockRuns).toHaveLength(1);
  });
});

describe('Burst', () => {
  it('draws nothing until it is fired, then 16 meteors and the flash, and is gone when it ends', () => {
    const r = mount(<Burst fire={0} x={480} y={270} />);
    expect(r.toJSON()).toBeNull();
    act(() => r.update(<Burst fire={1} x={480} y={270} />));
    expect(all(r, 'Animated.Image')).toHaveLength(17);
    expect(mockRuns.map(x => x.ms)).toEqual([T.burst]); // ONE value moves them all
    act(() => mockRuns[0].done?.({finished: true}));
    expect(r.toJSON()).toBeNull();
  });

  it('the same `fire` is one burst; a new one is another; calm gives none', () => {
    const r = mount(<Burst fire={1} x={0} y={0} count={8} />);
    expect(all(r, 'Animated.Image')).toHaveLength(9);
    act(() => r.update(<Burst fire={1} x={0} y={0} count={8} />));
    expect(mockRuns).toHaveLength(1);
    act(() => r.update(<Burst fire={2} x={0} y={0} count={8} />));
    expect(mockRuns).toHaveLength(2);
    const calm = mount(<Burst fire={1} x={0} y={0} calm />);
    expect(calm.toJSON()).toBeNull();
  });
});

describe('Odometer', () => {
  it('one wheel per digit, the rest stands still; calm is the plain number', () => {
    const r = mount(<Odometer text="1,284" />);
    expect(all(r, 'Animated.View')).toHaveLength(4);
    expect(texts(r)).toContain(',');
    expect(mockRuns).toHaveLength(4);
    const still = mount(<Odometer text="1,284" calm />);
    expect(texts(still)).toEqual(['1,284']);
    expect(all(still, 'Animated.View')).toHaveLength(0);
    expect(mockRuns).toHaveLength(4);
  });

  it('every wheel ends on its own digit', () => {
    const r = mount(<Odometer text="907" />);
    const last = all(r, 'Animated.View').map(w => {
      const col = w.findAll(n => (n.type as unknown) === 'Text');
      return col[col.length - 1].children.join('');
    });
    expect(last).toEqual(['9', '0', '7']);
  });
});

describe('the deck', () => {
  it('two plates, then one, then none as the cards run out', () => {
    const plates = (left: number) => all(mount(<Plates left={left} width={200} height={300} />), 'View').length;
    expect([6, 4, 3, 2, 1, 0].map(plates)).toEqual([2, 2, 1, 0, 0, 0]);
  });

  it('a stamp says its word; a tile carries the title', () => {
    expect(texts(mount(<Stamp label="LOVE" color="#5cf5b8" tilt={-8} />))).toEqual(['LOVE']);
    expect(texts(mount(<Tile title="A film without a poster" />))).toEqual(['A film without a poster']);
  });
});

describe('PlayKey', () => {
  const key = (r: TestRenderer.ReactTestRenderer) => r.root.findAll(n => (n.type as unknown) === 'Focusable')[0];

  it('aurora and gold wear a baked face and the stood-off ring; glass does not', () => {
    for (const kind of ['aurora', 'gold'] as const) {
      const r = mount(<PlayKey label="Open" kind={kind} onPress={() => {}} uiId="pick.open" />);
      expect(all(r, 'Image')).toHaveLength(1);
      expect(key(r).props.light).toBe(true);
      expect(key(r).props.ring).toBe('white');
      expect(texts(r)).toEqual(['Open']);
    }
    const glass = mount(<PlayKey label="Another one" onPress={() => {}} uiId="pick.another" />);
    expect(all(glass, 'Image')).toHaveLength(0);
    expect(key(glass).props.light).toBe(false);
  });

  it('a key that changes its meaning is the same mounted key', () => {
    const press = jest.fn();
    const r = mount(<PlayKey label="Thinking…" kind="aurora" dim onPress={press} uiId="pick.open" />);
    const before = key(r);
    act(() => r.update(<PlayKey label="Open" kind="gold" onPress={press} uiId="pick.open" />));
    expect(key(r)).toBe(before);
    expect(texts(r)).toEqual(['Open']);
    act(() => key(r).props.onPress());
    expect(press).toHaveBeenCalledTimes(1);
  });
});

describe('the small moves', () => {
  it('a pill shows its remark, and nothing when there is none', () => {
    const r = mount(<Pill say={null} />);
    expect(r.toJSON()).toBeNull();
    act(() => r.update(<Pill say={{text: 'First stars are lit', n: 1}} />));
    expect(texts(r)).toEqual(['First stars are lit']);
    act(() => r.update(<Pill say={null} />));
    expect(r.toJSON()).toBeNull();
    act(() => r.unmount()); // (its timer dies with it)
  });

  it('a flip keeps both faces mounted; a pop wraps its child', () => {
    const r = mount(<Flip flipped={false} width={100} height={150} front={<TestFace t="back of the card" />} back={<TestFace t="the title" />} />);
    expect(texts(r)).toEqual(['back of the card', 'the title']);
    expect(mockRuns).toHaveLength(1); // (the first run only settles it where it is)
    expect(mockRuns[0].to).toBe(0);
    act(() => r.update(<Flip flipped width={100} height={150} front={<TestFace t="back of the card" />} back={<TestFace t="the title" />} />));
    expect(mockRuns[1].to).toBe(1);
    expect(texts(mount(<Pop calm><TestFace t="a seat" /></Pop>))).toEqual(['a seat']);
  });
});

function TestFace({t}: {t: string}) {
  return React.createElement('Text', null, t);
}

describe('SkyLines', () => {
  it('one star per point, one bar per line, lit by one value', () => {
    const sky = constellation(9, 5);
    const r = mount(<SkyLines points={sky.points} lines={sky.lines} width={320} height={110} />);
    expect(all(r, 'Animated.Image')).toHaveLength(9);
    expect(all(r, 'Animated.View')).toHaveLength(sky.lines.length);
    expect(mockRuns).toHaveLength(1);
    const calm = mount(<SkyLines points={sky.points} lines={sky.lines} width={320} height={110} calm />);
    expect(all(calm, 'Animated.Image')).toHaveLength(9);
    expect(mockRuns).toHaveLength(1);
    expect(mount(<SkyLines points={[]} lines={[]} width={320} height={110} />).toJSON()).toBeNull();
  });
});

describe('Room', () => {
  it('is one picture and five still stars; nothing twinkles under calm or when it is not in front', () => {
    jest.useFakeTimers();
    try {
      const r = mount(<Room />);
      expect(all(r, 'Image')).toHaveLength(1);
      expect(all(r, 'Animated.Image')).toHaveLength(5);
      act(() => {
        jest.advanceTimersByTime(1300);
      });
      expect(mockRuns.length).toBeGreaterThan(0); // the first twinkle
      act(() => r.unmount());
      mockRuns.length = 0;
      const calm = mount(<Room calm />);
      const away = mount(<Room on={false} />);
      act(() => {
        jest.advanceTimersByTime(20000);
      });
      expect(mockRuns).toHaveLength(0);
      act(() => calm.unmount());
      act(() => away.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
