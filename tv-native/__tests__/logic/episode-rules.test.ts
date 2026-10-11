// The episode rules the website and the TV share (episodeRules.ts).
declare const __dirname: string;
import {pickUp, resumePoint, SKIP_STEPS, startSeason} from '../../src/episodeRules';

const ep = (n: number, o: Record<string, unknown> = {}) => ({n, owned: true, watched: false, position: 0, touchedAt: null as number | null, ...o});

describe('which episode a show’s Play stands for', () => {
  test('two half-watched episodes: the one touched LAST, not the earliest', () => {
    const eps = [ep(1, {watched: true, touchedAt: 100}), ep(2, {position: 900, touchedAt: 200}), ep(3), ep(7, {position: 1200, touchedAt: 900})];
    const hit = pickUp(eps)!;
    expect(hit.ep.n).toBe(7);
    expect(hit).toMatchObject({resumed: true, mid: true});
  });

  test('the last touched one is finished: the next one ON DISK after it', () => {
    const eps = [ep(1, {watched: true, touchedAt: 100}), ep(2, {watched: true, touchedAt: 500}), ep(3), ep(4)];
    const hit = pickUp(eps)!;
    expect(hit.ep.n).toBe(3);
    expect(hit).toMatchObject({resumed: true, mid: false}); // "Continue S1 E3", no clock
  });

  test('episodes not on disk are never the answer', () => {
    const eps = [ep(1, {watched: true, touchedAt: 500}), ep(2, {owned: false}), ep(3)];
    expect(pickUp(eps)!.ep.n).toBe(3);
    expect(pickUp([ep(1, {owned: false})])).toBeNull();
  });

  test('nothing watched: the first on disk, as Play', () => {
    const hit = pickUp([ep(1, {owned: false}), ep(2), ep(3)])!;
    expect(hit.ep.n).toBe(2);
    expect(hit.resumed).toBe(false);
  });

  test('under ten seconds in is not "part-way" (no clock), exactly at ten neither', () => {
    expect(pickUp([ep(1, {position: 8, touchedAt: 5})])!).toMatchObject({resumed: true, mid: false});
    expect(pickUp([ep(1, {position: 10, touchedAt: 5})])!.mid).toBe(false);
    expect(pickUp([ep(1, {position: 11, touchedAt: 5})])!.mid).toBe(true);
  });

  test('a hand-marked row (stamp 0) still counts as touched, but anything watched for real is newer', () => {
    const eps = [ep(1, {watched: true, touchedAt: 0}), ep(2, {position: 300, touchedAt: 50}), ep(3)];
    expect(pickUp(eps)!.ep.n).toBe(2);
  });

  test('the last episode on disk is finished: back to the first, and the button says Play', () => {
    const hit = pickUp([ep(1, {watched: true, touchedAt: 1}), ep(2, {watched: true, touchedAt: 9})])!;
    expect(hit.ep.n).toBe(1);
    expect(hit.resumed).toBe(false);
  });
});

describe('which season opens', () => {
  test('picked by hand, else where Play is, else what loaded first, else the first', () => {
    expect(startSeason([1, 2, 3], 2, 3, 1)).toBe(2);
    expect(startSeason([1, 2, 3], null, 3, 1)).toBe(3);
    expect(startSeason([1, 2, 3], null, null, 1)).toBe(1);
    expect(startSeason([2, 3], 9, 7, 1)).toBe(2); // none of them is in the list
    expect(startSeason([], null, null, null)).toBeNull();
  });
});

describe('where a title resumes', () => {
  test('four seconds before where it was left', () => {
    expect(resumePoint({position: 754.6}, 3000)).toBe(750);
  });
  test('not within the first ten seconds, not within twenty of the end, not when finished', () => {
    expect(resumePoint({position: 10}, 3000)).toBeNull();
    expect(resumePoint({position: 12}, 3000)).toBe(8);
    expect(resumePoint({position: 2985}, 3000)).toBeNull();
    expect(resumePoint({position: 900, finished: true}, 3000)).toBeNull();
    expect(resumePoint(null, 3000)).toBeNull();
  });
  test('a title with no known length still resumes', () => {
    expect(resumePoint({position: 500}, 0)).toBe(496);
  });
});

test('the skip steps are the website’s (public/js/screens/player.js)', () => {
  const fs = require('fs');
  const path = require('path');
  const web: string = fs.readFileSync(path.join(__dirname, '../../../public/js/screens/player.js'), 'utf8');
  const m = /const SKIP_STEPS = \[([^\]]+)\]/.exec(web);
  expect(m).not.toBeNull();
  expect(SKIP_STEPS).toEqual(m![1].split(',').map(x => Number(x.trim())));
});
