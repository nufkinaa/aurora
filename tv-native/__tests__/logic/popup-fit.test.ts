// The popups' ceilings (src/popupFit.ts) on the two panel sizes this app
// meets: 960x540 dp (Mi TV, Streamer) and 1280x720 dp.
import {bottomSheetMaxHeight, MENU_BOTTOM, menuMaxHeight, safeInset, sheetMaxHeight} from '../../src/popupFit';

const SIZES = [540, 720];

describe.each(SIZES)('a %i dp tall screen', h => {
  test('a player menu stands on the bar and its top stays inside the safe area', () => {
    const m = menuMaxHeight(h);
    // its top edge: the foot of the screen, up the bar's clearance, up its height
    const top = h - MENU_BOTTOM - m;
    expect(top).toBeGreaterThanOrEqual(safeInset(h));
    // and it is still a real list: several rows of ~37 dp
    expect(m).toBeGreaterThanOrEqual(7 * 37);
  });

  test('a centred sheet fits inside its padded backdrop and the safe area', () => {
    const m = sheetMaxHeight(h, 48);
    expect(m).toBeLessThanOrEqual(h - 2 * 48);
    expect(m).toBeLessThanOrEqual(h - 2 * safeInset(h));
  });

  test("a bottom sheet (X-Ray 446, a person 500) never reaches past the top's safe area", () => {
    for (const want of [446, 500, 900]) {
      const m = bottomSheetMaxHeight(h, want);
      expect(m).toBeLessThanOrEqual(want);
      expect(h - m).toBeGreaterThanOrEqual(safeInset(h));
    }
  });
});

test('the numbers the layouts get', () => {
  expect(menuMaxHeight(540)).toBe(335); // was '62%' of 540
  expect(menuMaxHeight(720)).toBe(446);
  expect(sheetMaxHeight(540, 48)).toBe(444);
  expect(sheetMaxHeight(720, 48)).toBe(624);
});

test('a very short window still leaves a usable menu', () => {
  expect(menuMaxHeight(300)).toBeGreaterThanOrEqual(140);
});
