// The phone's "Swipe your taste" (src/phone/tasteSwipe.ts) and "Your Aurora Wrapped"
// (src/phone/wrappedWords.ts): what a drag on the card answers, where it flies, the card's
// size, the Edit list's grid — and Wrapped's cards and roasts, in the website's words
// (public/js/screens/taste.js, wrapped.js). The queue itself is tasteSession.ts
// (taste-session.test.ts).
import {
  cardLabel,
  cardMeta,
  cardSize,
  DIST_X,
  DIST_Y,
  editPool,
  endWords,
  flyTo,
  keyOf,
  likedEntry,
  lovedLine,
  shuffled,
  stampLevels,
  swipeVerdict,
} from '../../src/phone/tasteSwipe';
import {fmtH, PREVIEW_CARDS, roastsFor, sinceLine, Wrapped, wrappedCards} from '../../src/phone/wrappedWords';

describe('a drag on the card', () => {
  test('far enough right is Love, left is Not for me, up is Haven’t seen', () => {
    expect(swipeVerdict({dx: DIST_X + 1, dy: 0})).toBe('love');
    expect(swipeVerdict({dx: -(DIST_X + 1), dy: 10})).toBe('nope');
    expect(swipeVerdict({dx: 5, dy: -(DIST_Y + 1)})).toBe('skip');
  });
  test('not far enough, and not flung: back to the middle', () => {
    expect(swipeVerdict({dx: DIST_X - 1, dy: 0})).toBeNull();
    expect(swipeVerdict({dx: 0, dy: -(DIST_Y - 1)})).toBeNull();
    expect(swipeVerdict({dx: 0, dy: 200})).toBeNull(); // down answers nothing (the site's too)
    expect(swipeVerdict({dx: 0, dy: 0})).toBeNull();
  });
  test('a fast flick counts from 30 px on; a slow one or a shorter one does not', () => {
    expect(swipeVerdict({dx: 40, dy: 0, vx: 0.8})).toBe('love');
    expect(swipeVerdict({dx: -40, dy: 0, vx: -0.8})).toBe('nope');
    expect(swipeVerdict({dx: 0, dy: -40, vy: -0.8})).toBe('skip');
    expect(swipeVerdict({dx: 40, dy: 0, vx: 0.3})).toBeNull();
    expect(swipeVerdict({dx: 20, dy: 0, vx: 2})).toBeNull();
  });
  test('a diagonal: sideways only when mostly sideways, up only when more up than sideways', () => {
    expect(swipeVerdict({dx: 120, dy: -230})).toBe('skip'); // 120 < 0.6 × 230: not a Love
    expect(swipeVerdict({dx: 150, dy: -200})).toBe('love'); // 150 ≥ 0.6 × 200
    expect(swipeVerdict({dx: 120, dy: 230})).toBeNull(); // mostly down: nothing
  });
  test('a touch the system took (the back gesture, a call) answers nothing', () => {
    expect(swipeVerdict({dx: 300, dy: 0}, true)).toBeNull();
  });
  test('the stamps grow with the drag; HAVEN’T SEEN only while the drag is nearly straight up', () => {
    expect(stampLevels(DIST_X / 2, 0)).toEqual({love: 0.5, nope: 0, skip: 0});
    expect(stampLevels(-DIST_X * 3, 0)).toEqual({love: 0, nope: 1, skip: 0});
    expect(stampLevels(10, -DIST_Y)).toEqual({love: 10 / DIST_X, nope: 0, skip: 1});
    expect(stampLevels(80, -DIST_Y).skip).toBe(0);
  });
  test('an answered card flies off the side it went (the screen at least 600 wide), skip flies up', () => {
    expect(flyTo('love', {dx: 130, dy: 20}, 411, 923)).toEqual({x: 600, y: 30, rotate: 24});
    expect(flyTo('nope', null, 800, 400)).toEqual({x: -800, y: 0, rotate: -24});
    const up = flyTo('skip', {dx: 10, dy: -120}, 411, 923);
    expect(up.y).toBe(-923);
    expect(up.x).toBe(15);
  });
});

describe('the card and its words', () => {
  test('2:3, as tall as the stage lets it, never past 640; a narrow stage limits by width', () => {
    expect(cardSize(379, 520)).toEqual({w: 346, h: 520});
    expect(cardSize(1000, 900)).toEqual({w: 426, h: 640});
    expect(cardSize(300, 600)).toEqual({w: 300, h: 450});
    expect(cardSize(0, 0)).toEqual({w: 0, h: 0});
  });
  test('the line under the title: year · Film / Series · two genres', () => {
    expect(cardMeta({year: 2019, type: 'movie', genres: ['Drama', 'Crime', 'Thriller']})).toBe('2019 · Film · Drama · Crime');
    expect(cardMeta({type: 'show'})).toBe('Series');
    expect(cardLabel({title: 'Dune', year: 2021})).toMatch(/^Dune \(2021\)\. Drag right: love/);
  });
  test('the round’s end, in the site’s words', () => {
    const t = {love: 10, nope: 8, skip: 6};
    expect(endWords(24, t, false)).toEqual({glyph: '✨', title: '24 answers — Home is already using them', tally: '♥ 10 loved · ✕ 8 not for you · 6 not seen', keepGoing: true});
    const dry = endWords(5, t, true);
    expect(dry.title).toBe("That's every title we had for you");
    expect(dry.keepGoing).toBe(false);
  });
});

describe('Edit list', () => {
  const cat = (n: number, cover = true) => ({imdbId: `tt${n}`, title: `C${n}`, cover: cover ? `/c${n}.jpg` : null});
  const lib = (n: number) => ({id: `lib${n}`, title: `L${n}`, cover: `/l${n}.jpg`});
  test('the loved titles first (picture or not), then the catalogue with a library title every fifth', () => {
    const pool = editPool([{imdbId: 'tt1', title: 'Loved', poster: '/p.jpg'}, {id: 'lib9', title: 'Mine'}], [1, 2, 3, 4, 5, 6].map(n => cat(n)), [lib(1), lib(9), lib(2)]);
    expect(pool.map(keyOf)).toEqual(['tt1', 'lib9', 'tt2', 'tt3', 'tt4', 'tt5', 'lib1', 'tt6', 'lib2']);
    expect(pool[0].cover).toBe('/p.jpg'); // the picker's picture stands in for a cover
  });
  test('no title twice, no catalogue tile without a picture, 120 at most', () => {
    const many = Array.from({length: 200}, (_, i) => cat(i + 10));
    expect(editPool([], [cat(1, false), cat(2), cat(2)], []).map(keyOf)).toEqual(['tt2']);
    expect(editPool([], many, []).length).toBe(120);
  });
  test('the count line, and what one tap saves', () => {
    expect(lovedLine(0)).toBe('tap everything you love');
    expect(lovedLine(3)).toBe('3 loved');
    expect(likedEntry({imdbId: 'tt1', title: 'X', cover: '/x.jpg', year: 2000})).toEqual({id: undefined, imdbId: 'tt1', title: 'X'});
  });
  test('shuffled keeps every title and leaves the original alone', () => {
    const a = [1, 2, 3, 4, 5];
    let i = 0;
    const b = shuffled(a, () => [0.1, 0.9, 0.5, 0.3][i++ % 4]);
    expect(a).toEqual([1, 2, 3, 4, 5]);
    expect([...b].sort()).toEqual(a);
  });
});

describe('Your Aurora Wrapped', () => {
  const base: Wrapped = {
    since: '2026-09-01T10:00:00.000Z',
    totalSec: 20 * 3600,
    plays: 12,
    distinctTitles: 6,
    topTitles: [{name: 'The Bear', sec: 5 * 3600}],
    topWeekday: 5,
    byDevice: [{name: 'TV', sec: 15 * 3600}],
    biggestDay: {day: '2026-09-12', sec: 3 * 3600},
    bestStreak: 3,
    lateNightSessions: 0,
    latestFinish: null,
    longestSession: {title: 'Dune', watchedSec: 9000},
    activeDays: 8,
    topGenres: [{name: 'Drama', sec: 1}, {name: 'Comedy', sec: 1}, {name: 'Crime', sec: 1}],
    started: 2,
    finished: 3,
  };
  test('hours as the site writes them', () => {
    expect(fmtH(20 * 3600)).toBe('20 hours');
    expect(fmtH(9000)).toBe('2.5 hours');
    expect(fmtH(40 * 60)).toBe('40 minutes');
  });
  test('the six cards, in the site’s order and words', () => {
    expect(wrappedCards(base)).toEqual([
      {value: '20 hours', label: 'watched', sub: '12 sessions · 8 days with at least one'},
      {value: '6', label: 'different titles', sub: '“The Bear” on top with 5.0 hours'},
      {value: 'Friday', label: 'is your night', sub: null},
      {value: '3', label: 'day streak', sub: 'biggest day: 3.0 hours'},
      {value: 'Drama', label: 'your genre', sub: 'Comedy · Crime'},
      {value: '2.5 hours', label: 'longest sitting', sub: '“Dune”'},
    ]);
    expect(wrappedCards({...base, topGenres: [], longestSession: null}).length).toBe(4);
  });
  test('nothing to roast: the site’s line with the name', () => {
    expect(roastsFor(base, 'Dana')).toEqual(['Honestly? Nothing to roast. Balanced viewing, reasonable hours. Who ARE you, Dana?']);
  });
  test('the roasts, worst first, four at most', () => {
    const w: Wrapped = {
      ...base,
      started: 9,
      finished: 2,
      latestFinish: {hour: 3, title: 'Dune'},
      lateNightSessions: 6,
      bestStreak: 8,
      topTitles: [{name: 'The Bear', sec: 12 * 3600}],
      byDevice: [{name: 'Mobile', sec: 1}, {name: 'TV', sec: 1}],
    };
    const r = roastsFor(w, 'Dana');
    expect(r).toEqual([
      "You've started 9 things and finished 2. Commitment issues, but make it streaming.",
      'You once finished “Dune” at 3am. The sunrise saw everything.',
      '6 sessions started after midnight. You and 3am are basically in a relationship.',
      '8 days in a row. The couch has permanently taken your shape.',
    ]);
    expect(roastsFor({...base, started: 8, finished: 0}, 'D')[0]).toBe('8 titles started. Zero finished. Bold strategy.');
    expect(roastsFor({...base, byDevice: [{name: 'Mobile', sec: 1}, {name: 'TV', sec: 1}]}, 'Dana')[0]).toBe(
      "Mostly watched on your phone. There's a beautiful big TV right there, Dana. It misses you.",
    );
    expect(roastsFor({...base, distinctTitles: 2, plays: 10}, 'D')[0]).toBe('10 sessions across 2 titles. Variety is overrated anyway.');
  });
  test('nothing watched yet: the preview cards and the line that says why', () => {
    expect(PREVIEW_CARDS.length).toBe(6);
    expect(sinceLine('Dana', null)).toBe("Dana · nothing to wrap yet — this is what it'll look like once you've watched a few things");
    expect(sinceLine('Dana', base.since)).toMatch(/^Dana · since .*2026/);
  });
});
