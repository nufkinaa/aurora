// The title page's round buttons: a strip that holds more than fits shows half of the
// next one (elia 2026-11-10: "not clear enough that this ... can be scrolled horizontally").
import {stripItemWidth} from '../../src/phone/ui/stripFit';

const ROW = {lead: 8, gap: 2, base: 76, min: 70, max: 92};
// what shows of the first button past the screen's edge, as a share of it
const peek = (room: number, count: number) => {
  const w = stripItemWidth({...ROW, room, count});
  let x = ROW.lead;
  for (let i = 0; i < count; i++) {
    if (x + w > room) return {w, shown: (room - x) / w};
    x += w + ROW.gap;
  }
  return {w, shown: 1};
};

describe('stripItemWidth', () => {
  it('keeps the own width when every button fits', () => {
    expect(stripItemWidth({...ROW, room: 411, count: 4})).toBe(76);
    expect(stripItemWidth({...ROW, room: 411, count: 5})).toBe(76);
  });

  it('cuts the last button in sight about in half at a Pixel 9 (411 dp)', () => {
    for (const n of [6, 7, 9, 12]) {
      const {w, shown} = peek(411, n);
      expect(w).toBeGreaterThanOrEqual(ROW.min);
      expect(w).toBeLessThanOrEqual(ROW.max);
      expect(shown).toBeGreaterThan(0.4);
      expect(shown).toBeLessThan(0.6);
    }
  });

  it('does the same on narrow and wide phones', () => {
    for (const room of [320, 360, 375, 393, 430]) {
      const {shown} = peek(room, 10);
      expect(shown).toBeGreaterThan(0.4);
      expect(shown).toBeLessThan(0.6);
    }
  });

  it('stays near the own width', () => {
    expect(Math.abs(stripItemWidth({...ROW, room: 360, count: 8}) - 76)).toBeLessThan(2);
  });

  it('gives the own width back when no width in range works', () => {
    expect(stripItemWidth({...ROW, room: 411, count: 8, min: 80, max: 82})).toBe(76);
    expect(stripItemWidth({...ROW, room: 0, count: 8})).toBe(76);
  });
});
