// Aurora Wrapped on the phone (src/phone/play/storyWords.ts): the story's words are the
// website's (public/js/screens/wrapped.js — each sentence is found there as written), the
// chapters and their clocks follow the website's, the kids rule holds (no roasts, whatever the
// server sends), the story's touch rules, and the share card's words and measuring.
import * as S from '../../src/phone/play/storyWords';
import type {PhoneWrapped} from '../../src/phone/play/storyWords';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
const WEB = fs.readFileSync(path.join(__dirname, '../../../public/js/screens/wrapped.js'), 'utf8') as string;

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
  nights: Array.from({length: 40}, (_, i) => [i * 6, 30 + i] as [number, number]),
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
  latestFinish: {title: 'Signal Lost', hour: 4},
  roasts: ['You finished "Signal Lost" at 4 in the morning. Nobody needs to know. I already do.', '', 'A second one.'],
};

describe('the words are the website’s', () => {
  const c = S.ctxOf(YEAR, 'Maya', false);
  test('each fixed sentence of the story is in wrapped.js as written', () => {
    const fixed = [
      S.opening(c).title,
      'Every night you pressed play since',
      'left a star. We counted them all.',
      'Tap to begin',
      S.hours(c).eyebrow,
      S.hours(S.ctxOf(YEAR, 'Maya', true)).eyebrow,
      S.typeWords(c).pre,
      'We need to talk, ',
      'Look at you go, ',
      'The highlights',
      'The intervention',
      S.FINALE.eyebrow,
      S.FINALE.title,
      S.FINALE.gold,
      S.FINALE.replay,
      S.FINALE.all,
      'All the numbers',
      'Play the story',
      'Share the picture',
      'Back to browsing',
      'Your sky is still dark, ',
      S.TEASER.line,
      ...S.TEASER.locked,
      S.TEASER.browse,
      "Couldn't load your stats.",
      'Your couch would like a word.',
      'Respectable. Popcorn-refill-level commitment.',
      'Short and sweet. Like a good trailer.',
      'What a story marathon!',
      'In bed before midnight. Mostly. Allegedly.',
      'started after midnight. We saw that.',
      "late-night adventures. Shh — we won't tell.",
      'hours, in one go',
      'Every star is a night you watched; these ones held hands.',
      'Brightest night',
      'my year in the night sky',
      'My Aurora Wrapped',
      'Your number one',
      'The podium',
      'Your genre DNA',
      'When you really watch',
      'Your longest streak',
      'Your longest sitting',
      'Your viewer type',
      'Time watched',
      'Your top five',
      'Longest streak',
      'Longest sitting',
      'Where you watch',
    ];
    for (const words of fixed) expect([words, WEB.includes(words)]).toEqual([words, true]);
  });
  test('the chapters and their words for a rich year', () => {
    expect(c.chapters).toEqual(['opening', 'hours', 'top', 'podium', 'genres', 'night', 'streak', 'longest', 'type', 'roasts', 'finale']);
    expect(S.opening(c).name).toBe('Maya,');
    expect(S.opening(c).chips).toEqual(['115 nights', '152 sittings', '12 titles']);
    expect(S.hours(c).value).toBe('136');
    expect(S.hours(c).unit).toBe('hours watched');
    const t = S.top(c)!;
    expect(t.hours).toBe('45 hours');
    expect(t.rest).toBe(' — 33% of everything you watched, one episode at a time.');
    expect(S.genres(c).first).toBe('Drama');
    expect(S.genres(c).second).toBe('Sci-Fi');
    expect(S.genres(c).bars[0].f).toBe(1);
    expect(S.genres(c).bars[0].mid).toBeCloseTo(0.42);
    expect(S.night(c).day).toBe('Saturdays, ');
    expect(S.night(c).hour).toBe('9 pm.');
    expect(S.night(c).line).toBe('6 sittings started after midnight. We saw that.');
    expect(S.streak(c).count).toBe('13');
    const l = S.longest(c)!;
    expect(l.clock).toBe('3:41');
    expect(l.ticks).toEqual(['0h', '1h', '2h', '3h', '4h']);
    expect(l.quip).toBe('Your couch would like a word.');
    expect(l.poster && l.poster.name).toBe('Ember & Frost');
    expect(S.roasts(c).header).toBe('We need to talk, Maya.');
  });
  test('the hand: the winner hides second from the left', () => {
    expect(S.handOrder([1, 2, 3, 4, 5])).toEqual([2, 1, 3, 4, 5]);
    expect(S.handOrder([1])).toEqual([1]);
    expect(S.podium(c).places.map(p => p.rank)).toEqual([2, 1, 3]);
    expect(S.podium(c).rest.map(p => p.rank)).toEqual([4, 5]);
  });
});

describe('the roasts', () => {
  test('the server’s own lines, as sent (empty ones dropped)', () => {
    const c = S.ctxOf(YEAR, 'Maya', false);
    expect(c.words).toEqual([YEAR.roasts![0 as never], 'A second one.']);
  });
  test('an older server sends none: the rules speak', () => {
    const c = S.ctxOf({...YEAR, roasts: undefined}, 'Maya', false);
    expect(c.words.length).toBeGreaterThan(0);
    expect(c.words.length).toBeLessThanOrEqual(4);
  });
  test('a kids profile never gets a roast, whatever the server sends', () => {
    const c = S.ctxOf(YEAR, 'Kiddo', true);
    expect(c.words.join(' ')).not.toContain('Signal Lost');
    expect(S.roasts(c).eyebrow).toBe('The highlights');
    expect(S.roasts(c).header).toBe('Look at you go, Kiddo!');
    expect(c.type.verdict).not.toBe(S.ctxOf(YEAR, 'Maya', false).type.verdict);
    expect(S.longest(c)!.quip).toBe('What a story marathon!');
  });
});

describe('the clock and the story’s moves', () => {
  const c = S.ctxOf(YEAR, 'Maya', false);
  test('the website’s pace, the finale holds', () => {
    expect(S.chapterInfo('opening', c).ms).toBe(6200);
    expect(S.chapterInfo('type', c).ms).toBe(10500);
    expect(S.chapterInfo('roasts', c).ms).toBe(1600 + 2 * 2700 + 1800);
    expect(S.chapterInfo('finale', c).hold).toBe(true);
  });
  test('a screen reader hears where it is', () => {
    expect(S.announce(c, 2)).toBe('3 of 11. Your number one: Northern Static, 45 hours.');
  });
  test('a tap: the left third goes back, the rest goes on', () => {
    expect(S.tapStep(10, 390)).toBe(-1);
    expect(S.tapStep(129, 390)).toBe(-1);
    expect(S.tapStep(131, 390)).toBe(1);
    expect(S.tapStep(380, 390)).toBe(1);
  });
  test('a swipe: left on, right back, down closes; a wobble is nothing', () => {
    expect(S.swipeOf(-120, 10)).toBe('next');
    expect(S.swipeOf(120, -8)).toBe('back');
    expect(S.swipeOf(5, 160)).toBe('close');
    expect(S.swipeOf(20, 30)).toBe(null);
    expect(S.swipeOf(-100, -140)).toBe(null);
  });
  test('a one-sitting year: opening, hours, number one, the type, the intervention, the finale', () => {
    const one: PhoneWrapped = {since: '2026-11-10', totalSec: 42 * 60, plays: 1, activeDays: 1, distinctTitles: 1, bestStreak: 1, topTitles: [{name: 'Solo', sec: 42 * 60}], topGenres: [{name: 'Drama', sec: 1}], byHour: Array(24).fill(0), byWeekday: Array(7).fill(0)};
    const c1 = S.ctxOf(one, 'Tom', false);
    expect(c1.chapters).toEqual(['opening', 'hours', 'top', 'type', 'roasts', 'finale']);
    expect(c1.type.name).toBe('The Newcomer');
    expect(S.hours(c1).value).toBe('42');
    expect(S.hours(c1).unit).toBe('minutes watched');
  });
});

describe('the page, the share', () => {
  const c = S.ctxOf(YEAR, 'Maya', false);
  test('All the numbers', () => {
    const p = S.page(c);
    expect(p.lede).toMatch(/ · since .+ · 152 sittings over 115 nights$/);
    expect(p.top.rows.length).toBe(5);
    expect(p.devices.rows.map(r => r.label)).toEqual(['TV', 'Phone']);
    expect(p.streak.tail).toBe(' nights in a row');
    expect(p.night.line).toBe('Saturdays, 9 pm');
  });
  test('the share sheet’s words and file', () => {
    const w = S.shareWords(c);
    expect(w.text).toBe("My Aurora Wrapped: 136 hours, and I'm " + c.type.name + '.');
    expect(w.file).toBe('aurora-wrapped-maya.png');
    expect(S.shareWords(S.ctxOf(YEAR, 'דנה כהן', false)).file).toBe('aurora-wrapped-דנה-כהן.png');
    expect(S.shareTiles(c)).toEqual([
      ['TOP GENRE', 'Drama'],
      ['BEST STREAK', '13 nights'],
      ['YOUR NIGHT', 'Saturday'],
    ]);
  });
  test('the card’s words fit: two lines at most, the last cut with …', () => {
    const lines = S.wrapEstimate('Same time, same couch, same you. The couch wants partial custody.', 560, 32, 2, false);
    expect(lines.length).toBeLessThanOrEqual(2);
    const long = S.wrapEstimate('The Unbelievably Long and Winding Chronicles of the Northern Lighthouse Keepers', 400, 60, 2);
    expect(long.length).toBe(2);
    expect(long[1].endsWith('…')).toBe(true);
    expect(S.fitSize('Maya', 888, 104, 56)).toBe(104);
    expect(S.fitSize('Maximiliana-Josephine Abernathy', 888, 104, 56)).toBeLessThan(104);
  });
  test('a title’s drawn colour is the same every time', () => {
    expect(S.hashHue('Northern Static')).toBe(S.hashHue('Northern Static'));
    expect(S.hashHue('a')).not.toBe(S.hashHue('b'));
  });
});
