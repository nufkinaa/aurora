// Home's greeting on the billboard reads over any picture through a fade from the top edge
// alone (elia 2026-11-10), and the fade has no band where it ends.
import {contrast, greetFade, through, TOP_ALPHA, WORDS_ALPHA} from '../../src/phone/ui/greetFade';

const WHITE = [255, 255, 255];
const GREETING = [243, 244, 248]; // colors.text
const REMARK = [243, 244, 248].map(v => Math.round(v * 0.92)); // rgba(243,244,248,0.92) on dark: a step dimmer

describe('greetFade', () => {
  it('keeps the greeting at 4.5:1 or more over white art, the remark at 4:1 or more', () => {
    expect(contrast(GREETING, through(WHITE, WORDS_ALPHA))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(REMARK, through(WHITE, WORDS_ALPHA))).toBeGreaterThanOrEqual(4);
    expect(contrast(GREETING, through(WHITE, TOP_ALPHA))).toBeGreaterThan(4.5);
  });

  it('is only as tall as the words and its ease', () => {
    const f = greetFade(18 + 27 + 4 + 42);
    expect(f.height).toBe(147);
  });

  it('eases out with no step: every stop is lighter than the one above, ending at 0', () => {
    const {gradient} = greetFade(91);
    const stops = [...gradient.matchAll(/rgba\(7,8,17,([\d.]+)\) ([\d.]+)%/g)].map(m => [Number(m[1]), Number(m[2])]);
    expect(stops.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i][0]).toBeLessThanOrEqual(stops[i - 1][0]);
      expect(stops[i][1]).toBeGreaterThan(stops[i - 1][1]);
      // no drop steeper than a third of the way at once
      expect(stops[i - 1][0] - stops[i][0]).toBeLessThanOrEqual(0.36);
    }
    expect(stops[stops.length - 1][0]).toBe(0);
    expect(stops[stops.length - 1][1]).toBe(100);
  });
});

import {footFade, FOOT_WORDS_ALPHA} from '../../src/phone/ui/greetFade';

describe('footFade', () => {
  it('holds enough under the title for white art to read', () => {
    expect(contrast(GREETING, through(WHITE, FOOT_WORDS_ALPHA))).toBeGreaterThanOrEqual(4.5);
  });
  it('is as deep as the words and eases out to nothing', () => {
    const f = footFade(204);
    expect(f.height).toBe(276);
    expect(f.gradient.startsWith('linear-gradient(0deg, rgba(7,8,17,0.92) 0%, rgba(7,8,17,0.62) 73.9%')).toBe(true);
    expect(f.gradient.endsWith('rgba(7,8,17,0) 100%)')).toBe(true);
  });
});
