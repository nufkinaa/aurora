// The TV's start-up timeline (src/startline.ts) — the website's rules
// (public/js/startline.js, test/startline.test.js), and where a start that
// failed before its first frame falls back to.
import {fallbackFrom, startupOf, stepsText} from '../../src/startline';

describe('the start-up, step by step', () => {
  it('names each step in ms from the press, in order, and the slowest gap', () => {
    const s = startupOf(1000, {open: 1000, item: 1300, decide: 1310, claim: 9310, ask: 9320, byte: 9900, frame: 11000}, 'h264');
    expect(s && s.steps).toEqual([['open', 0], ['item', 300], ['decide', 310], ['claim', 8310], ['ask', 8320], ['byte', 8900], ['frame', 10000]]);
    expect(s && s.slow).toBe('claim');
    expect(s && s.total).toBe(10000);
    expect(stepsText(s)).toBe('open:0,item:300,decide:310,claim:8310,ask:8320,byte:8900,frame:10000');
  });
  it('nothing noted: nothing', () => {
    expect(startupOf(5, {})).toBeNull();
  });
});

describe('a start that failed before its first frame', () => {
  it('a direct play on its way to the resume point falls back there, not to 0:00', () => {
    expect(fallbackFrom({resumeAt: 2950, cur: 0, offset: 0})).toBe(2950);
  });
  it('otherwise where it got to, or where its stream began', () => {
    expect(fallbackFrom({resumeAt: 0, cur: 600, offset: 580})).toBe(600);
    expect(fallbackFrom({resumeAt: 0, cur: 0, offset: 580})).toBe(580);
    expect(fallbackFrom({resumeAt: 0, cur: 2, offset: 0})).toBe(0);
  });
});
