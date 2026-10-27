// The TV's watch party sync math against the same cases as the site's
// (test/party-sync.test.js).
import {aheadOf, bestClock, clockFrom, decide, landTolerance, readyToGo, startsIn, targetOf, waitingWords} from '../../src/partySync';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cases = require('../../../test/fixtures/party-sync-cases.json');

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

test('where the film is, when it starts, what to do about a gap', () => {
  for (const c of cases.targetOf) near(targetOf(c.st, c.now), c.want);
  for (const c of cases.startsIn) near(startsIn(c.st, c.now), c.want);
  for (const c of cases.decide) {
    const d = decide(c.drift, c.o);
    expect(d.act).toBe(c.act);
    expect((d as {rate?: number}).rate).toBeUndefined();
  }
  for (const c of cases.landTolerance) expect(landTolerance(c.heavy)).toBe(c.want);
});

test('the clock, buffered-ahead, ready, the waiting words', () => {
  for (const c of cases.clock) expect(clockFrom(c.t0, c.t1, c.now)).toEqual({rtt: c.rtt, offset: c.offset});
  expect(bestClock([{rtt: 90, offset: 1}, {rtt: 30, offset: 2}, null, {rtt: -1, offset: 9}])).toEqual({rtt: 30, offset: 2});
  for (const c of cases.aheadOf) near(aheadOf(c.ranges, c.t), c.want);
  for (const c of cases.readyToGo) expect(readyToGo(c.o)).toBe(c.want);
  for (const c of cases.waitingWords) expect(waitingWords(c.names)).toBe(c.want);
});
