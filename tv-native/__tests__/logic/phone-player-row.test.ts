// The phone player's bottom row always fits the screen's width (upright, a next episode:
// "Next" fell off the edge on a 411 dp phone — ui-phone 2026-11-10).
import {BTN, BTN_MIN, GAP, NEXT_WORD_W, playerRowFit} from '../../src/phone/player/rowFit';

const width = (room: number, buttons: number, next: boolean) => {
  const f = playerRowFit(room, buttons, next);
  const items = buttons + (next ? 1 : 0);
  const nextW = next ? (f.nextWord ? NEXT_WORD_W : f.size + 4) : 0;
  return {f, used: buttons * f.size + (next ? nextW : 0) + (items - 1) * GAP};
};

describe('playerRowFit', () => {
  it('changes nothing sideways (room to spare)', () => {
    expect(playerRowFit(860, 7, true)).toEqual({size: BTN, nextWord: true});
    expect(playerRowFit(860, 7, false)).toEqual({size: BTN, nextWord: false});
  });

  it('fits upright on a Pixel 9 (379 dp of row) with a next episode', () => {
    const {f, used} = width(379, 7, true);
    expect(used).toBeLessThanOrEqual(379);
    expect(f.size).toBeGreaterThanOrEqual(44);
  });

  it('fits without a next episode, as before', () => {
    expect(playerRowFit(379, 7, false).size).toBe(BTN);
  });

  it('fits on small phones too, never under the minimum', () => {
    for (const room of [288, 328, 343, 361]) {
      for (const n of [3, 6, 7]) {
        const {f, used} = width(room, n, true);
        expect(f.size).toBeGreaterThanOrEqual(BTN_MIN);
        if (f.size > BTN_MIN) expect(used).toBeLessThanOrEqual(room);
      }
    }
  });

  it('keeps the word when it fits (a copy on the phone: three buttons)', () => {
    expect(playerRowFit(379, 3, true)).toEqual({size: BTN, nextWord: true});
  });
});
