// Pick for me, Taste and Pick together on the phone in the Aurora Play look: the words the
// play layer adds are the website's (pickforme.js DRAW, taste.js's end of a round, group.js
// SHOW — each found there as written), and the small rules (the reel's ticks, the pips, what
// Aurora learned, the tally) answer as the website's do.
import {DRAW, metaLine, showPips, tickTimes} from '../../src/phone/play/pickWords';
import {learnedTags, SHOW, tallyChips} from '../../src/phone/play/gameWords';
import {LAND_MS, landingStrip, RESPIN_MS} from '../../src/play/reel';
import {readTaste} from '../../src/play/tasteRead';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
const web = (f: string) => fs.readFileSync(path.join(__dirname, '../../../public/js/screens', f), 'utf8') as string;

test('the draw’s words are pickforme.js’s', () => {
  const src = web('pickforme.js');
  for (const w of [DRAW.kicker, DRAW.open, DRAW.another, DRAW.hand]) expect([w, src.includes(`"${w}"`)]).toEqual([w, true]);
  expect(DRAW.of(1, 6)).toBe('1 of 6');
  expect(DRAW.said('Heat')).toBe("Tonight's pick: Heat");
});

test('the end of a round and the show say what taste.js and group.js say', () => {
  const taste = web('taste.js');
  for (const w of [' answers — Home is already using them', 'Aurora learned', 'Keep going', ' loved', ' not for you', ' not seen', "That's every title we had for you"]) expect([w, taste.includes(w)]).toEqual([w, true]);
  const group = web('group.js');
  for (const w of [SHOW.votesIn, SHOW.tie, SHOW.tieLine, SHOW.skip]) expect([w, group.includes(`"${w}"`)]).toEqual([w, true]);
  expect(SHOW.card(3, 10)).toBe('Card 3 of 10');
});

test('the prize’s line', () => {
  expect(metaLine({year: 2019, type: 'movie'})).toBe('2019 · Film');
  expect(metaLine({year: 2021, type: 'show'})).toBe('2021 · Series');
  expect(metaLine({type: 'movie'})).toBe('Film');
});

test('a tick for each poster that passes the payline, slowing down', () => {
  const cells = ['back', ...landingStrip(6, 0)];
  const ticks = tickTimes(cells.length - 1, LAND_MS);
  expect(ticks.length).toBeGreaterThanOrEqual(cells.length - 2);
  expect(ticks.length).toBeLessThanOrEqual(cells.length + 1);
  for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
  // the reel slows: the last gap is longer than the first
  expect(ticks[ticks.length - 1] - ticks[ticks.length - 2]).toBeGreaterThan(ticks[1] - ticks[0]);
  expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(LAND_MS);
  expect(tickTimes(2, RESPIN_MS).length).toBeGreaterThanOrEqual(2);
  expect(tickTimes(0, LAND_MS)).toEqual([]);
});

test('the pips: for two to twelve picks', () => {
  expect(showPips(1)).toBe(false);
  expect(showPips(2)).toBe(true);
  expect(showPips(12)).toBe(true);
  expect(showPips(13)).toBe(false);
});

test('what Aurora learned: the loved genres lit (four at most), the refused ones dim (two)', () => {
  const read = readTaste([
    {verdict: 'love', genres: ['Comedy', 'Drama']},
    {verdict: 'love', genres: ['Comedy']},
    {verdict: 'love', genres: ['Thriller']},
    {verdict: 'nope', genres: ['Horror']},
    {verdict: 'nope', genres: ['Horror']},
    {verdict: 'skip', genres: ['Western']},
  ]);
  expect(learnedTags(read)).toEqual([
    {label: 'Comedy ×2', lit: true},
    {label: 'Drama', lit: true},
    {label: 'Thriller', lit: true},
    {label: 'less Horror', lit: false},
  ]);
  expect(learnedTags(readTaste([]))).toEqual([]);
});

test('the tally as three chips', () => {
  expect(tallyChips({love: 8, nope: 8, skip: 8}).map(c => c.label)).toEqual(['♥ 8 loved', '✕ 8 not for you', '8 not seen']);
});
