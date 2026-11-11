// Aurora Play on the TV — the kit's pure rules (src/play/*.ts) give the
// website's own answers (public/js/play/*.js), and the TV-only helpers built
// on them (the reel's stops, a meteor's flight, the answer's run) are sound
// for an Animated interpolation: stops that only go up, ends where they must.
import * as reel from '../../src/play/reel';
import * as tally from '../../src/play/tally';
import * as taste from '../../src/play/tasteRead';
import * as con from '../../src/play/constellation';
import * as count from '../../src/play/count';
import * as met from '../../src/play/meteors';
import * as deck from '../../src/play/deck';
import {PLAY, BURST_COLORS, STAR_PATH} from '../../src/play/tokens';
import {loadWeb, seeded} from './web-twin';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const motionStub = {reduced: () => false, tween: () => {}, EASE: {}, clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))};
const web = {
  reel: loadWeb('play/reel.js'),
  tally: loadWeb('play/tally.js'),
  taste: loadWeb('play/tasteread.js'),
  con: loadWeb('play/constellation.js', motionStub),
  count: loadWeb('play/count.js', motionStub),
  burst: loadWeb('play/burst.js', motionStub),
  deck: loadWeb('play/deck.js', motionStub),
};

const rising = (xs: number[]) => xs.every((x, i) => !i || x > xs[i - 1]);

describe('the reel', () => {
  test('times are the website’s', () => {
    expect([reel.LAND_MS, reel.RESPIN_MS, reel.HOLD_MS]).toEqual([web.reel.LAND_MS, web.reel.RESPIN_MS, web.reel.HOLD_MS]);
  });

  test('landingStrip, respinStrip, nextDraw: the website’s answers for every small hand', () => {
    for (let n = 0; n <= 14; n++) {
      for (let w = 0; w <= Math.max(0, n); w++) {
        for (const len of [undefined, 2, 5, 9, 12]) {
          expect(reel.landingStrip(n, w, len as number)).toEqual(web.reel.landingStrip(n, w, len));
        }
        expect(reel.nextDraw(w, n)).toBe(web.reel.nextDraw(w, n));
        for (let to = 0; to < Math.max(1, n); to++) expect(reel.respinStrip(n, w, to)).toEqual(web.reel.respinStrip(n, w, to));
      }
    }
  });

  test('the strip ends on the winner and a one-pick hand has one cell', () => {
    expect(reel.landingStrip(6, 2).slice(-1)).toEqual([2]);
    expect(reel.landingStrip(6, 2)).toHaveLength(9);
    expect(reel.landingStrip(1, 0)).toEqual([0]);
    expect(reel.landingStrip(0)).toEqual([]);
    // "Another one" never shows the same poster twice in a row
    for (let n = 2; n <= 8; n++) {
      for (let a = 0; a < n; a++) {
        const s = reel.respinStrip(n, a, reel.nextDraw(a, n));
        expect(s[0]).toBe(a);
        expect(s[s.length - 1]).toBe(reel.nextDraw(a, n));
        s.forEach((v, i) => i && expect(v).not.toBe(s[i - 1]));
      }
    }
  });

  test('reelPos and cellAt: the website’s curve', () => {
    for (const last of [0, 1, 2, 8, 9.5]) {
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        expect(reel.reelPos(t, last)).toBeCloseTo(web.reel.reelPos(t, last), 12);
        expect(reel.cellAt(reel.reelPos(t, last))).toBe(web.reel.cellAt(web.reel.reelPos(t, last)));
      }
    }
  });

  test('reelStops: one interpolation that starts at rest, ends exactly on the cell and runs past it once', () => {
    const {inputRange, outputRange} = reel.reelStops(8, 225);
    expect(inputRange[0]).toBe(0);
    expect(inputRange[inputRange.length - 1]).toBe(1);
    expect(rising(inputRange)).toBe(true);
    expect(inputRange).toHaveLength(outputRange.length);
    expect(outputRange[0]).toBeCloseTo(0, 6);
    expect(outputRange[outputRange.length - 1]).toBe(-8 * 225);
    // the overshoot: somewhere near the end the strip is past the cell, by less than a tenth of a cell
    const past = Math.min(...outputRange);
    expect(past).toBeLessThan(-8 * 225);
    expect(past).toBeGreaterThan(-8.1 * 225);
    // nothing to roll: flat
    expect(reel.reelStops(0, 225).outputRange.every(v => Math.abs(v) === 0)).toBe(true);
  });

  test('reelStops from where the waiting reel stands: starts there, ends on the same cell', () => {
    const {outputRange} = reel.reelStops(10, 240, 48, 0.4);
    expect(outputRange[0]).toBeCloseTo(-0.4 * 240, 6);
    expect(outputRange[outputRange.length - 1]).toBe(-10 * 240);
    expect(Math.min(...outputRange)).toBeGreaterThan(-10.1 * 240);
    // never backwards before the overshoot
    const upTo = outputRange.indexOf(Math.min(...outputRange));
    expect(outputRange.slice(0, upTo + 1).every((v, i, a) => i === 0 || v <= a[i - 1])).toBe(true);
  });
});

describe('telling a vote', () => {
  test('tallyOf and isTie: the website’s answers', () => {
    const r = seeded(11);
    const pick = () => {
      const yes = Math.floor(r() * 5);
      const maybe = Math.floor(r() * 4);
      const no = Math.floor(r() * 4);
      const missing = Math.floor(r() * 2);
      return {yes, maybe, no, missing, of: r() < 0.2 ? 0 : yes + maybe + no + missing, everyone: r() < 0.15};
    };
    for (let i = 0; i < 300; i++) {
      const a = pick();
      const b = r() < 0.4 ? {...a, everyone: false} : pick();
      expect(tally.tallyOf(a)).toEqual(web.tally.tallyOf(a));
      expect(tally.isTie({picks: [a, b]})).toBe(web.tally.isTie({picks: [a, b]}));
    }
    expect(tally.tallyOf(null)).toEqual([]);
    expect(tally.tallyOf({yes: 2, maybe: 1, of: 4})).toEqual(['yes', 'yes', 'maybe', 'no']);
    expect(tally.tallyOf({yes: 13, of: 13})).toEqual([]);
    expect(tally.isTie(null)).toBe(false);
    expect(tally.isTie({picks: [{yes: 1}]})).toBe(false);
    expect(tally.MAX_MARKS).toBe(web.tally.MAX_MARKS);
  });

  test('tieJumps: the website’s, the last jump on the winner, slower each time', () => {
    for (const w of [0, 1]) {
      for (const opt of [undefined, {n: 5}, {n: 1}, {n: 12, first: 60, grow: 1.3}]) {
        expect(tally.tieJumps(w, opt)).toEqual(web.tally.tieJumps(w, opt));
      }
      const j = tally.tieJumps(w);
      expect(j[j.length - 1].i).toBe(w);
      j.forEach((s, i) => i && expect(s.i).not.toBe(j[i - 1].i));
      const gaps = j.slice(1).map((s, i) => s.at - j[i].at);
      gaps.forEach((g, i) => i && expect(g).toBeGreaterThan(gaps[i - 1]));
    }
  });
});

describe('the taste read', () => {
  const GENRES = ['Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Family', ''];
  test('readTaste, marksOf, litAt, milestone: the website’s answers on drawn sittings', () => {
    const r = seeded(7);
    for (let i = 0; i < 200; i++) {
      const answers = Array.from({length: Math.floor(r() * 30)}, () => ({
        verdict: ['love', 'nope', 'skip', 'other'][Math.floor(r() * 4)],
        genres: r() < 0.1 ? null : Array.from({length: Math.floor(r() * 3)}, () => GENRES[Math.floor(r() * GENRES.length)]),
      }));
      const mine = taste.readTaste(answers);
      const theirs = web.taste.readTaste(answers);
      expect(mine).toEqual(theirs);
      for (const k of [0, 1, 2, 3, 4]) expect(taste.milestone(k, mine)).toBe(web.taste.milestone(k, theirs));
    }
    for (const goal of [0, 1, 3, 12, 24, 25]) {
      expect(taste.marksOf(goal)).toEqual(web.taste.marksOf(goal));
      for (let a = 0; a <= goal + 1; a++) expect(taste.litAt(a, goal)).toBe(web.taste.litAt(a, goal));
    }
  });

  test('the words', () => {
    expect(taste.milestone(1, {love: 1})).toBe('First stars are lit');
    expect(taste.milestone(1, {love: 0})).toBe('Tough crowd — keep going');
    expect(taste.milestone(2, {top: {genre: 'Comedy', n: 2}})).toBe('A pattern is showing: Comedy');
    expect(taste.milestone(2, {})).toBe('Halfway there');
    expect(taste.milestone(3, {nope: 5, love: 2})).toBe('Picky. Aurora likes that.');
    expect(taste.milestone(3, {top: {genre: 'Drama', n: 3}, nope: 0, love: 3})).toBe('You keep loving Drama');
    expect(taste.milestone(3, null)).toBe('Almost there');
    expect(taste.milestone(4, {})).toBe('');
    expect(taste.marksOf(24)).toEqual([6, 12, 18, 24]);
  });
});

describe('the constellation', () => {
  test('the same seed draws the website’s sky', () => {
    for (let n = 0; n <= 14; n++) {
      for (const seed of [1, 2, 99, con.seedOf('lib-abc'), con.seedOf('שלום')]) {
        expect(con.constellation(n, seed)).toEqual(web.con.constellation(n, seed));
        expect(con.constellation(n, seed, {w: 420, h: 96})).toEqual(web.con.constellation(n, seed, {w: 420, h: 96}));
      }
    }
    for (const s of ['', 'a', 'lib-abc', 'שלום', '🎬x']) expect(con.seedOf(s)).toBe(web.con.seedOf(s));
    expect(con.MAX_STARS).toBe(web.con.MAX_STARS);
  });

  test('every star is inside the box and every line joins two stars', () => {
    for (let n = 1; n <= 12; n++) {
      const sky = con.constellation(n, 5 + n, {w: 420, h: 96});
      expect(sky.points).toHaveLength(n);
      for (const p of sky.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(420);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(96 + 6);
      }
      for (const [a, b] of sky.lines) {
        expect(sky.points[a]).toBeTruthy();
        expect(sky.points[b]).toBeTruthy();
      }
    }
  });

  test('lineBox: the bar between two stars', () => {
    const b = con.lineBox({x: 0, y: 0}, {x: 30, y: 40});
    expect(b.len).toBeCloseTo(50, 6);
    expect(b.cx).toBe(15);
    expect(b.cy).toBe(20);
    expect(b.deg).toBeCloseTo(53.13, 2);
    expect(con.lineBox({x: 10, y: 5}, {x: 0, y: 5}).deg).toBeCloseTo(180, 6);
  });
});

describe('numbers that arrive', () => {
  test('wheelPlan: the website’s', () => {
    for (const text of ['0', '7', '24', '136', '1,204', '2.5', '3:41', 'abc', '']) {
      for (const laps of [undefined, 0, 1, 3]) {
        expect(count.wheelPlan(text, laps as number)).toEqual(web.count.wheelPlan(text, laps));
      }
    }
    expect(count.wheelPlan(24)).toEqual([
      {digit: 2, steps: 12},
      {digit: 4, steps: 24},
    ]);
  });

  test('wheelMs: the leftmost wheel lands first, the last one takes the whole time', () => {
    expect(count.wheelMs(1600, 0, 3)).toBe(992);
    expect(count.wheelMs(1600, 2, 3)).toBe(1600);
    expect(count.wheelMs(1600, 0, 1)).toBe(1600);
  });
});

describe('the burst', () => {
  test('the shower is the website’s for the same seed', () => {
    for (const [n, seed] of [[42, 1], [14, 9], [44, 11], [8, 12345]]) {
      expect(met.meteors(n, seed)).toEqual(web.burst.meteors(n, seed));
    }
  });

  test('flight: stops that only go up, start and end dark, travel outward', () => {
    for (const seed of [1, 5, 77]) {
      for (const m of met.meteors(14, seed)) {
        const f = met.flight(m, 600);
        expect(rising(f.input)).toBe(true);
        expect(f.input[0]).toBeGreaterThanOrEqual(0);
        expect(f.input[f.input.length - 1]).toBeLessThanOrEqual(1);
        for (const list of [f.dx, f.dy, f.alpha, f.tail]) expect(list).toHaveLength(f.input.length);
        expect(f.alpha[0]).toBe(0);
        expect(f.alpha[f.alpha.length - 1]).toBe(0);
        expect(Math.max(...f.alpha)).toBeGreaterThan(0.9);
        const dist = f.dx.map((x, i) => Math.hypot(x, f.dy[i]));
        dist.forEach((d, i) => i && expect(d).toBeGreaterThanOrEqual(dist[i - 1] - 0.2));
        // it stays near the box: no meteor flies a whole diagonal
        expect(dist[dist.length - 1]).toBeLessThan(600);
      }
    }
  });

  test('glowAt and travelled are the website’s formulas', () => {
    expect(met.glowAt(0)).toBe(0);
    expect(met.glowAt(0.075)).toBeCloseTo(0.5, 6);
    expect(met.glowAt(0.15)).toBeCloseTo(1, 6);
    expect(met.glowAt(1)).toBe(0);
    const m = met.meteors(1, 3)[0];
    expect(met.travelled(m, 1)).toBeCloseTo(m.speed * m.life * 0.5, 9);
    expect(met.travelled(m, 0)).toBe(0);
  });
});

describe('the deck', () => {
  test('depth and plates', () => {
    for (const left of [-1, 0, 1, 2, 3, 4, 5, 24, NaN]) expect(String(deck.depthOf(left))).toBe(web.deck.depthOf(left));
    expect([0, 1, 2, 3, 4, 9].map(deck.platesOf)).toEqual([0, 0, 0, 1, 2, 2]);
    expect(deck.SLAM_MS).toBe(web.deck.SLAM_MS);
  });

  test('answerRun: one run — the stamp lands before the card leaves', () => {
    const run = deck.answerRun();
    expect(run.total).toBe(470);
    for (const part of [run.stampIn, run.stampScale, run.travel, run.fade]) {
      expect(rising(part.inputRange)).toBe(true);
      expect(part.inputRange[0]).toBe(0);
      expect(part.inputRange[part.inputRange.length - 1]).toBe(1);
      expect(part.inputRange).toHaveLength(part.outputRange.length);
    }
    expect(run.stampScale.outputRange[0]).toBe(2.2);
    expect(run.stampScale.outputRange.slice(-1)[0]).toBe(1);
    expect(run.travel.outputRange.slice(-1)[0]).toBe(1);
    // while the stamp is coming down the card has hardly moved
    expect(Math.max(...run.travel.outputRange.slice(0, 3))).toBeLessThan(0.05);
    expect(run.fade.outputRange.slice(-1)[0]).toBe(0);
  });
});

describe('the tokens', () => {
  test('the colours are the website’s --play-* values', () => {
    const css: string = fs.readFileSync(path.join(__dirname, '../../../public/css/play.css'), 'utf8');
    const token = (name: string) => {
      const m = css.match(new RegExp(`--play-${name}:\\s*([^;]+);`));
      return m ? m[1].trim().toLowerCase() : null;
    };
    const same: [string, string][] = [
      ['night-0', PLAY.night0],
      ['night-1', PLAY.night1],
      ['night-2', PLAY.night2],
      ['night-3', PLAY.night3],
      ['green', PLAY.green],
      ['teal', PLAY.teal],
      ['violet', PLAY.violet],
      ['rose', PLAY.rose],
      ['gold', PLAY.gold],
      ['gold-hi', PLAY.goldHi],
      ['gold-deep', PLAY.goldDeep],
      ['gold-ink', PLAY.goldInk],
      ['ink', PLAY.ink],
    ];
    for (const [name, mine] of same) expect([name, token(name)]).toEqual([name, mine]);
  });

  test('the burst colours and the star are the website’s', () => {
    const burst: string = fs.readFileSync(path.join(__dirname, '../../../public/js/play/burst.js'), 'utf8');
    for (const c of BURST_COLORS) expect(burst).toContain(c);
    const stage: string = fs.readFileSync(path.join(__dirname, '../../../public/js/play/stage.js'), 'utf8');
    expect(stage).toContain(STAR_PATH);
  });
});
