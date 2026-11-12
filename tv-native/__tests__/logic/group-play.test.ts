// Pick together on the TV in the play look — the pure parts (src/play/groupShow.ts):
// the reveal's words are the website's own (public/js/screens/group.js SHOW),
// the deck's directions, the seats' sizes and the reveal's beats.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
import {freeSeats, revealPlan, seatSize, SHOW, STAR_AT, tieSides, verdictForGroupKey} from '../../src/play/groupShow';
import {tieJumps} from '../../src/play/tally';

test('the reveal says what the website says (group.js SHOW)', () => {
  const web: string = fs.readFileSync(path.join(__dirname, '../../../public/js/screens/group.js'), 'utf8');
  const block = /const SHOW = \{([\s\S]*?)\n\};/.exec(web);
  expect(block).toBeTruthy();
  const word = (k: string) => (new RegExp(`${k}: "([^"]*)"`).exec(block![1]) || [])[1];
  expect(SHOW.votesIn).toBe(word('votesIn'));
  expect(SHOW.tie).toBe(word('tie'));
  expect(SHOW.tieLine).toBe(word('tieLine'));
  expect(SHOW.skip).toBe(word('skip'));
  expect(/card: \(n, of\) => `Card \$\{n\} of \$\{of\}`/.test(block![1])).toBe(true);
  expect(SHOW.card(3, 20)).toBe('Card 3 of 20');
});

test('the deck: RIGHT is Yes, LEFT No, DOWN Maybe; UP and the rest are not answers', () => {
  expect(verdictForGroupKey('right')).toBe('yes');
  expect(verdictForGroupKey('left')).toBe('no');
  expect(verdictForGroupKey('down')).toBe('maybe');
  for (const k of ['up', 'select', 'playPause', 'back', '']) expect(verdictForGroupKey(k)).toBeNull();
});

test('seats shrink as the room fills; the dashed seats only while there is room', () => {
  expect([1, 6, 7, 10, 11, 30].map(seatSize)).toEqual([64, 64, 52, 52, 44, 44]);
  expect([1, 3, 4, 5, 9].map(freeSeats)).toEqual([2, 2, 1, 0, 0]);
});

test('the reveal: three stars, then the curtain; a tie adds the jumps and lands on the pick', () => {
  expect(STAR_AT).toEqual([200, 580, 960]);
  const plain = revealPlan(false);
  expect(plain).toEqual({tieAt: -1, jumps: [], wonAt: -1, end: 1500});
  for (const winner of [0, 1]) {
    const p = revealPlan(true, winner);
    expect(p.tieAt).toBe(1500);
    expect(p.jumps).toHaveLength(tieJumps(winner).length);
    expect(p.jumps[p.jumps.length - 1].i).toBe(winner); // the light stops on the server's pick
    expect(p.jumps.every((j, k) => k === 0 || j.at > p.jumps[k - 1].at)).toBe(true);
    expect(p.jumps[0].at).toBeGreaterThan(p.tieAt);
    expect(p.wonAt).toBeGreaterThan(p.jumps[p.jumps.length - 1].at);
    expect(p.end).toBeGreaterThan(p.wonAt);
    expect(p.end).toBeLessThan(6000); // a beat, not a wait
  }
});

test('the tie-break: the result\'s own time decides which side the pick stands on', () => {
  expect(tieSides(1000)).toEqual({swap: false, winner: 0});
  expect(tieSides(1001)).toEqual({swap: true, winner: 1});
  expect(tieSides(undefined)).toEqual({swap: false, winner: 0});
});
