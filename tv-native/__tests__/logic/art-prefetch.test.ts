// Pictures fetched ahead of the cards (src/artPrefetch.ts, src/cardArt.ts):
// the address and headers are the card's own, the plan is bounded, nothing
// starts during a run of presses, and a move drops what had not started.
import {setActiveProfile, setBaseUrl, setSession, HeroItem} from '../../src/api';
import {cardArt, prefetchable} from '../../src/cardArt';
import {wasDrawn} from '../../src/blur';
import {artIdle, planPrefetch, IDLE_MS, LIMITS, LIMITS_LITE, LIMITS_LOW, _artInternals} from '../../src/artPrefetch';

const BASE = 'http://tv.test:4000';
const poster = (i: number): HeroItem => ({id: `m${i}`, title: `t${i}`, type: 'movie', poster: `https://images.metahub.space/poster/small/tt${1000 + i}/img`}) as HeroItem;

beforeEach(() => {
  setBaseUrl(BASE);
  setSession('sess-1');
  setActiveProfile('prof-1');
  _artInternals.reset();
});

describe('the address is the card\'s', () => {
  test('a poster the server sizes: the proxied address at the card\'s width step, with the session headers', () => {
    const it = poster(1);
    const src = prefetchable(it)!;
    // PixelRatio 2 in the stub: 124dp → 248px → the 256 step
    expect(src.uri).toBe(`${BASE}/img/ext?u=${encodeURIComponent(it.poster!)}&w=256`);
    expect(src.headers).toEqual({'X-Session': 'sess-1', 'X-Profile': 'prof-1'});
    // and it IS what the card's <Image> is given
    expect(src).toEqual(cardArt(it).src);
  });

  test('a library cover', () => {
    const it = {id: 'abc123', title: 'x', type: 'movie', cover: '/img/abc123'} as HeroItem;
    expect(prefetchable(it)!.uri).toBe(`${BASE}/img/abc123?w=256`);
  });

  test('Continue Watching: the landscape art at the frame card\'s step; a resume frame as it is', () => {
    const it = {...poster(2), backdrop: 'https://images.metahub.space/background/medium/tt1002/img'} as HeroItem;
    // 140dp tall × 16/9 = 249dp → 498px → the 640 step
    expect(prefetchable(it, {wide: true, frame: true})!.uri).toBe(`${BASE}/img/ext?u=${encodeURIComponent(it.backdrop!)}&w=640`);
    const lib = {id: 'lib1', title: 'x', type: 'movie', cover: '/img/lib1', progress: {position: 300, duration: 6000}} as HeroItem;
    const f = prefetchable(lib, {wide: true, frame: true})!;
    expect(f.uri).toBe(`${BASE}/img/frame/lib1?t=300`);
    expect(f).toEqual(cardArt(lib, {wide: true, frame: true}).src);
  });

  test('a picture the server cannot size is left to the card (it is decoded at the view\'s size, another cache key)', () => {
    const it = {id: 'x', title: 'x', type: 'movie', poster: 'https://example.org/p.jpg'} as HeroItem;
    expect(cardArt(it).src!.uri).toBe('https://example.org/p.jpg');
    expect(prefetchable(it)).toBeNull();
    expect(prefetchable({id: 'y', title: 'y'} as HeroItem)).toBeNull();
  });

  test('no session, no profile: no headers (an open server)', () => {
    setSession(null);
    setActiveProfile(null);
    expect(prefetchable(poster(3))!.headers).toBeUndefined();
  });
});

describe('planPrefetch', () => {
  const s = (u: string) => ({uri: u});
  test('in order, each address once, nothing already known, at most max', () => {
    const plan = planPrefetch([s('a'), null, s('b'), s('a'), s('c'), undefined, s('d'), s('e')], u => u === 'c', 3);
    expect(plan.map(p => p.uri)).toEqual(['a', 'b', 'd']);
    expect(planPrefetch([s('a')], () => false, 0)).toEqual([]);
  });
  test('the tiers only ever shrink the plan', () => {
    for (const k of ['row', 'shelves', 'gridRows', 'total', 'flying'] as const) {
      expect(LIMITS_LITE[k]).toBeLessThanOrEqual(LIMITS[k]);
      expect(LIMITS_LOW[k]).toBeLessThanOrEqual(LIMITS_LITE[k]);
    }
    expect(LIMITS.total).toBeLessThanOrEqual(20);
    expect(LIMITS.flying).toBeLessThanOrEqual(4);
  });
});

describe('at rest only, a few at a time', () => {
  type Call = {uri: string; headers: Record<string, string> | null; done: (r: 'hit' | 'ok' | 'fail') => void};
  let calls: Call[];
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    calls = [];
    _artInternals.setNative({
      prefetch: (uri, headers) => new Promise(res => calls.push({uri, headers, done: res})),
    });
  });
  afterEach(() => {
    _artInternals.setNative(undefined);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const wish = (from: number, n: number) => () => Array.from({length: n}, (_, i) => prefetchable(poster(from + i)));

  test('nothing is asked for while presses keep coming; one rest asks, four at a time, with the headers', async () => {
    for (let i = 0; i < 10; i++) {
      artIdle('row', wish(100 + i, 6));
      jest.advanceTimersByTime(IDLE_MS - 50); // a held key: 50–110 ms a press
      expect(calls.length).toBe(0);
    }
    jest.advanceTimersByTime(60);
    expect(calls.length).toBe(4);
    expect(_artInternals.queued()).toBe(2);
    expect(calls[0].uri).toBe(prefetchable(poster(109))!.uri);
    expect(calls[0].headers).toEqual({'X-Session': 'sess-1', 'X-Profile': 'prof-1'});
    calls[0].done('ok');
    await flush();
    expect(calls.length).toBe(5);
    // fetched: a card that mounts now skips its placeholder
    expect(wasDrawn(calls[0].uri)).toBe(true);
    expect(wasDrawn(calls[1].uri)).toBe(false);
  });

  test('a focus move drops what had not started; the next rest does not ask twice for what is in flight', async () => {
    artIdle('row', wish(200, 6));
    jest.advanceTimersByTime(IDLE_MS);
    expect(calls.length).toBe(4);
    artIdle('row', wish(200, 6)); // focus moved
    expect(_artInternals.queued()).toBe(0);
    jest.advanceTimersByTime(IDLE_MS);
    // the two that were dropped are asked for now — as the in-flight ones allow
    expect(calls.length).toBe(4);
    expect(_artInternals.queued()).toBe(2);
    calls[0].done('hit');
    calls[1].done('fail');
    await flush();
    expect(calls.length).toBe(6);
    expect(new Set(calls.map(c => c.uri)).size).toBe(6);
    // a failure may be asked for again at a later rest
    expect(wasDrawn(calls[1].uri)).toBe(false);
  });

  test('every place\'s wish is one plan, capped at the total', () => {
    artIdle('row', wish(300, 6));
    artIdle('shelves', wish(400, 14));
    artIdle('grid', wish(500, 18));
    jest.advanceTimersByTime(IDLE_MS);
    expect(calls.length + _artInternals.queued()).toBe(LIMITS.total);
  });

  test('without the native module nothing happens', () => {
    _artInternals.setNative(undefined);
    artIdle('row', wish(600, 6));
    jest.advanceTimersByTime(IDLE_MS * 2);
    expect(calls.length).toBe(0);
  });
});
