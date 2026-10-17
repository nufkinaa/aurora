// The TV taste picker's bookkeeping (src/tasteSession.ts): the queue, the
// answers, Undo, the round — the same rules as the website's taste.js.
import {KEEP, leavingAfter, TasteCard, TasteSession, verdictForKey} from '../../src/tasteSession';

const card = (n: number): TasteCard => ({imdbId: `tt${String(n).padStart(7, '0')}`, type: n % 3 ? 'movie' : 'show', title: `Title ${n}`});
const cards = (from: number, count: number) => Array.from({length: count}, (_, i) => card(from + i));

describe('the remote', () => {
  test('LEFT is Not for me, RIGHT is Love, DOWN is Haven’t seen; UP and the rest answer nothing', () => {
    expect(verdictForKey('left')).toBe('nope');
    expect(verdictForKey('right')).toBe('love');
    expect(verdictForKey('down')).toBe('skip');
    expect(verdictForKey('up')).toBeNull();
    expect(verdictForKey('select')).toBeNull(); // OK is the card's own press (Love)
    expect(verdictForKey('playPause')).toBeNull();
  });
});

describe('TasteSession', () => {
  test('answers walk the queue; the reply replaces what is past the two on show', () => {
    const s = new TasteSession(24, 12);
    s.take(cards(1, KEEP + 2));
    expect(s.current?.imdbId).toBe(card(1).imdbId);
    expect(s.behind?.imdbId).toBe(card(2).imdbId);
    const e = s.answer('love')!;
    expect(e.card.imdbId).toBe(card(1).imdbId);
    expect(s.answered).toBe(1);
    expect(s.tally.love).toBe(1);
    expect(s.queuedIds()).toEqual([card(2).imdbId, card(3).imdbId]);
    // the reply: two fresh cards, chosen knowing the answer
    s.take([card(50), card(51)], true);
    expect(s.queue.map(c => c.imdbId)).toEqual([card(2), card(3), card(50), card(51)].map(c => c.imdbId));
  });

  test('nothing answered comes back, nothing is queued twice', () => {
    const s = new TasteSession();
    s.take(cards(1, 3));
    s.answer('nope');
    s.take([card(1), card(2), card(9), card(9)]);
    expect(s.queue.map(c => c.imdbId)).toEqual([card(2), card(3), card(9)].map(c => c.imdbId));
  });

  test('Undo brings the last card back on show, one answer at a time, with the answer it had before', () => {
    const s = new TasteSession();
    s.take(cards(1, 4));
    const a = s.answer('love')!;
    const b = s.answer('skip')!;
    s.settle(a, null);
    s.settle(b, 'nope'); // it had been a "Not for me" in an earlier sitting
    const u1 = s.undo()!;
    expect(u1).toBe(b);
    expect(u1.was).toBe('nope'); // what Undo sends back to the server
    expect(s.current?.imdbId).toBe(card(2).imdbId);
    expect(s.tally).toEqual({love: 1, nope: 0, skip: 0});
    expect(s.undo()).toBe(a);
    expect(s.current?.imdbId).toBe(card(1).imdbId);
    expect(s.answered).toBe(0);
    expect(s.undo()).toBeNull();
    // an undone card may be answered again
    expect(s.answer('nope')?.card.imdbId).toBe(card(1).imdbId);
  });

  test('an answer the server did not store is taken back — unless Undo already did', () => {
    const s = new TasteSession();
    s.take(cards(1, 3));
    const a = s.answer('love')!;
    expect(s.fail(a)).toBe(true);
    expect(s.current?.imdbId).toBe(card(1).imdbId);
    expect(s.answered).toBe(0);
    const b = s.answer('nope')!;
    s.undo();
    expect(s.fail(b)).toBe(false);
    expect(s.queue.filter(c => c.imdbId === card(1).imdbId).length).toBe(1);
  });

  test('a round is `goal` answers; Keep going adds `more`; progress is shown out of the goal', () => {
    const s = new TasteSession(3, 2);
    s.take(cards(1, 10));
    s.answer('love');
    expect(s.progress).toBeCloseTo(1 / 3);
    s.answer('nope');
    s.answer('skip');
    expect(s.roundOver).toBe(true);
    expect(s.answer('love')).toBeNull(); // the round is over until Keep going
    s.keepGoing();
    expect(s.goal).toBe(5);
    expect(s.roundOver).toBe(false);
    expect(s.answer('love')).not.toBeNull();
  });

  test('a deck that runs dry ends the round once the last card is answered', () => {
    const s = new TasteSession(24);
    s.take(cards(1, 2));
    s.answer('love');
    s.take([], true); // the server has nothing more
    expect(s.exhausted).toBe(true);
    expect(s.roundOver).toBe(false); // one still on show
    s.answer('skip');
    expect(s.roundOver).toBe(true);
  });
});

describe('the flying card', () => {
  // Mi TV 2026-10-18: the answer that ends a round unmounted the band mid-flight,
  // the animation ended with finished=false, and the card stayed set — Keep going
  // drew it frozen half way over the next card.
  test('a flight that ends, finished or cut short, takes its own card away', () => {
    expect(leavingAfter({n: 24}, 24)).toBeNull();
  });
  test('the end of an older flight leaves a newer card flying', () => {
    const newer = {n: 25};
    expect(leavingAfter(newer, 24)).toBe(newer);
  });
  test('nothing flying stays nothing', () => {
    expect(leavingAfter(null, 3)).toBeNull();
  });
});
