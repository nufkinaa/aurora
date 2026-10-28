// A torrent source nobody shares: the TV moves on to the next one by itself,
// with the site's rule and numbers (playerRules.ts deadSource, playBest.ts
// fallbackSources — public/js/playstart.js, test/playstart.test.js).
import {deadSource} from '../../src/playerRules';
import {fallbackSources} from '../../src/playBest';
import type {Stream} from '../../src/api';

describe('a source nobody shares', () => {
  it('is left after 25 s with nobody, or 45 s with nothing at all', () => {
    expect(deadSource({elapsedMs: 10000, peers: 0})).toBe(false);
    expect(deadSource({elapsedMs: 26000, peers: 0})).toBe(true);
    expect(deadSource({elapsedMs: 26000, peers: 3})).toBe(false);
    expect(deadSource({elapsedMs: 46000, peers: 3, progress: 0})).toBe(true);
    expect(deadSource({elapsedMs: 60000, peers: 0, progress: 0.01})).toBe(false);
    expect(deadSource({elapsedMs: 60000, peers: 0, everPlayed: true})).toBe(false);
  });
  it('the next sources: live, pickable, not reported bad, most seeders first', () => {
    const s = (infoHash: string, seeders: number, extra: Partial<Stream> = {}) => ({infoHash, fileIdx: 0, seeders, cam: false, dubbed: false, ...extra}) as unknown as Stream;
    const chosen = s('a', 1);
    const list = [chosen, s('b', 5), s('c', 40), s('d', 90, {cam: true}), s('e', 0), s('f', 9, {badHere: {reason: 'x', label: 'y'}})];
    expect(fallbackSources(list, chosen).map(x => x.infoHash)).toEqual(['c', 'b']);
  });
});
