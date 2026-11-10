// Aurora Wrapped on the TV — the story's words and rules (src/play/
// wrappedRules.ts) say what the website's say (public/js/wrappedrules.js), on
// named years and on 400 drawn ones; and the rules that matter are checked by
// name too, so a failure says which one broke.
import * as mine from '../../src/play/wrappedRules';
import type {WrappedStats} from '../../src/play/wrappedRules';
import {loadWeb, seeded} from './web-twin';

const web = loadWeb('wrappedrules.js');

const BIG: WrappedStats = {
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
  byDevice: [{name: 'TV', sec: 100 * 3600}, {name: 'Mobile', sec: 30 * 3600}, {name: 'Web', sec: 6 * 3600}],
  topTitles: [
    {name: 'Northern Static', sec: 45 * 3600},
    {name: 'The Long Winter', sec: 22 * 3600},
    {name: 'כאן גרים בכיף', sec: 12 * 3600},
    {name: 'Paper Planets', sec: 9 * 3600},
    {name: 'A Very Long Title That Goes On And On And On Until It Wraps', sec: 6 * 3600},
  ],
  topGenres: [{name: 'Drama', sec: 60 * 3600}, {name: 'Sci-Fi', sec: 40 * 3600}, {name: 'Comedy', sec: 22 * 3600}, {name: 'Family', sec: 9 * 3600}],
  biggestDay: {day: '2026-03-08', sec: 7.5 * 3600},
  longestSession: {watchedSec: 3 * 3600 + 41 * 60},
  lateNightSessions: 9,
  latestFinish: {title: 'Northern Static', hour: 3},
};

const TINY: WrappedStats = {totalSec: 2400, plays: 1, activeDays: 1, distinctTitles: 1, started: 1, finished: 0, bestStreak: 1, topTitles: [{name: 'Pilot', sec: 2400}], topGenres: [{name: 'Comedy', sec: 2400}]};

const draw = (r: () => number): WrappedStats => {
  const int = (n: number) => Math.floor(r() * n);
  const maybe = <T,>(v: T, p = 0.85): T | undefined => (r() < p ? v : undefined);
  const plays = int(4) ? int(120) : int(4);
  const titles = Array.from({length: int(7)}, (_, i) => ({name: `Title ${i}`, sec: int(60 * 3600) + 60})).sort((a, b) => b.sec - a.sec);
  const totalSec = Math.max(60, titles.reduce((n, t) => n + t.sec, 0) + int(20 * 3600));
  const nightsN = int(60);
  const nights = Array.from({length: nightsN}, (_, i) => [i * (1 + int(2)) + int(2), 10 + int(300)] as [number, number])
    .filter((n, i, all) => !i || n[0] > all[i - 1][0]);
  const day = (d: number) => new Date(Date.UTC(2026, 0, 4 + d)).toISOString().slice(0, 10);
  const bestStreak = int(16);
  return {
    totalSec,
    plays,
    activeDays: int(90),
    distinctTitles: maybe(int(40)),
    started: maybe(int(30)),
    finished: maybe(int(12)),
    bestStreak,
    streak: nights.length >= 2 && bestStreak >= 2 && r() < 0.8 ? {from: day(nights[0][0]), to: day(nights[Math.min(nights.length - 1, bestStreak)][0])} : null,
    nightsFrom: maybe('2026-01-04'),
    nights: maybe(nights),
    byHour: maybe(Array.from({length: 24}, () => int(9) * 1200)),
    byWeekday: maybe(Array.from({length: 7}, () => int(9) * 4000)),
    byDevice: maybe([{name: r() < 0.5 ? 'Mobile' : 'TV', sec: int(9000) + 1}, {name: r() < 0.5 ? 'Mobile' : 'Web', sec: int(9000)}].slice(0, 1 + int(2))),
    topTitles: maybe(titles, 0.95),
    topGenres: maybe(Array.from({length: int(6)}, (_, i) => ({name: `Genre ${i}`, sec: int(40 * 3600) + 1})).sort((a, b) => b.sec - a.sec)),
    biggestDay: maybe({day: day(int(200)), sec: int(9 * 3600)}),
    longestSession: maybe({watchedSec: int(5 * 3600)}),
    lateNightSessions: maybe(int(12)),
    latestFinish: maybe({title: 'Late One', hour: int(24)}, 0.5),
    roasts: r() < 0.2 ? ['A line from the server.', '', '  ', 'Another one.', 3, 'Third.', 'Fourth.', 'Fifth.'] : undefined,
  };
};

const everything = (rules: Record<string, any>, w: WrappedStats, name: string) => ({
  felt: rules.hoursFelt(w.totalSec || 0),
  type: rules.viewerType(w),
  kidsType: rules.viewerType(w, {kids: true}),
  roasts: rules.roastsFor(w, name),
  kind: rules.kindWordsFor(w, name),
  said: rules.interventionFor(w, name),
  saidKids: rules.interventionFor(w, name, {kids: true}),
  chapters: rules.chaptersFor(w),
  sky: rules.skyLayout(w, true),
  skyTall: rules.skyLayout(w, false),
  weekend: rules.weekendShare(w),
  late: rules.lateShare(w),
  hour: rules.primeHour(w),
  genres: rules.genreShares(w),
});

test('the named years and 400 drawn ones: the website’s answers', () => {
  for (const w of [BIG, TINY, {}, {plays: 5}]) expect(everything(mine, w, 'Maya')).toEqual(everything(web, w, 'Maya'));
  const r = seeded(20261110);
  for (let i = 0; i < 400; i++) {
    const w = draw(r);
    expect(everything(mine, w, 'Noa')).toEqual(everything(web, w, 'Noa'));
  }
});

test('the small helpers are the website’s', () => {
  for (const sec of [0, 59, 60, 1800, 3600, 5400, 9 * 3600, 10 * 3600, 136 * 3600, 1234 * 3600]) {
    expect(mine.fmtH(sec)).toBe(web.fmtH(sec));
    expect(mine.clock(sec)).toBe(web.clock(sec));
    expect(mine.hoursFelt(sec)).toEqual(web.hoursFelt(sec));
  }
  for (let h = 0; h < 24; h++) expect(mine.hourLabel(h)).toBe(web.hourLabel(h));
  expect(mine.DAYS).toEqual(web.DAYS);
  expect(mine.TYPE_IDS).toEqual(web.TYPE_IDS);
  expect(mine.CON_MAX).toBe(web.CON_MAX);
});

test('the hours chapter says what the number feels like', () => {
  expect(mine.hoursFelt(136 * 3600)).toEqual({
    value: '136',
    unit: 'hours',
    lines: ["That's 5 days and 16 hours, back to back.", 'Or flying London to Sydney 6 times — without the jet lag.'],
  });
  expect(mine.hoursFelt(2400).unit).toBe('minutes');
  expect(mine.hoursFelt(2400).lines).toEqual(['One episode and a snack. A gentle start.']);
  expect(mine.hoursFelt(1234 * 3600).value).toBe('1,234');
});

test('the viewer type: fewer than three sittings is The Newcomer, nothing past a bar is The Casual, a tie goes to the earlier row', () => {
  expect(mine.viewerType(TINY).id).toBe('newcomer');
  expect(mine.viewerType({plays: 9, activeDays: 4}).id).toBe('casual');
  expect(mine.viewerType({plays: 9, activeDays: 4}).because).toBe('4 nights');
  // exactly at a bar is not past it
  expect(mine.viewerType({plays: 9, lateNightSessions: 5, bestStreak: 9}).id).toBe('casual');
  // night owl and creature of habit both twice their bar: the earlier row
  expect(mine.viewerType({plays: 9, lateNightSessions: 10, bestStreak: 18}).id).toBe('night-owl');
  expect(mine.viewerType({plays: 9, lateNightSessions: 10, bestStreak: 27}).id).toBe('creature');
  const t = mine.viewerType(BIG);
  expect(t.no).toBe(mine.TYPE_IDS.indexOf(t.id) + 1);
  expect(t.stars.length).toBeGreaterThan(1);
  for (const [a, b] of t.lines) {
    expect(t.stars[a]).toBeTruthy();
    expect(t.stars[b]).toBeTruthy();
  }
});

test('a kids profile is never roasted, whatever the server sends', () => {
  const w = {...BIG, roasts: ['You are a menace.']};
  expect(mine.interventionFor(w, 'Noa')).toEqual(['You are a menace.']);
  const kind = mine.interventionFor(w, 'Noa', {kids: true});
  expect(kind).not.toContain('You are a menace.');
  expect(kind[0]).toBe('Your favourite was “Northern Static”. Great pick, Noa!');
  expect(mine.viewerType(BIG, {kids: true}).verdict).not.toBe(mine.viewerType(BIG).verdict);
  expect(mine.interventionFor({}, 'Noa', {kids: true})).toEqual(['Your sky is just getting started, Noa. Every show you watch adds a star!']);
});

test('the chapters: a full year has all eleven, a one-sitting year the short story', () => {
  expect(mine.chaptersFor(BIG)).toEqual(['opening', 'hours', 'top', 'podium', 'genres', 'night', 'streak', 'longest', 'type', 'roasts', 'finale']);
  expect(mine.chaptersFor(TINY)).toEqual(['opening', 'hours', 'top', 'type', 'roasts', 'finale']);
  expect(mine.chaptersFor({})).toEqual(['opening', 'hours', 'type', 'roasts', 'finale']);
});

test('the sky: every night a star in the box, the streak a constellation of at most 24', () => {
  const sky = mine.skyLayout(BIG);
  expect(sky.stars).toHaveLength(BIG.nights!.length);
  for (const s of sky.stars) {
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(1);
    expect(s.y).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(1);
  }
  expect(sky.con.length).toBeGreaterThan(1);
  expect(sky.con.length).toBeLessThanOrEqual(mine.CON_MAX);
  expect(sky.brightest).not.toBeNull();
  const long = mine.skyLayout({nightsFrom: '2026-01-04', nights: Array.from({length: 60}, (_, i) => [i, 30] as [number, number]), streak: {from: '2026-01-04', to: '2026-03-04'}});
  expect(long.con).toHaveLength(mine.CON_MAX);
  expect(mine.skyLayout({}).stars).toEqual([]);
});

test('primeDay: the day with the most watching', () => {
  expect(mine.primeDay(BIG)).toBe(6);
  expect(mine.primeDay({})).toBeNull();
});
