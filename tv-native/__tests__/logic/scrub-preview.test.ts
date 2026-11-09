// The pictures above the scrub point (src/playback/scrubPreview.ts): the
// server's answer, which tile shows which second, the drawing, the warm-up.
import {readScrubIndex, sheetsToWarm, thumbLeft, tileAt, tileLayout} from '../../src/playback/scrubPreview';

const answer = {
  ready: true,
  v: 1,
  interval: 10,
  w: 240,
  h: 134,
  cols: 10,
  rows: 10,
  count: 250,
  sheets: ['/img/scrub/abc/0.jpg?k=1', '/img/scrub/abc/1.jpg?k=1', '/img/scrub/abc/2.jpg?k=1'],
};

describe('the server’s answer', () => {
  test('ready: read as it is', () => {
    expect(readScrubIndex(answer)).toEqual({interval: 10, w: 240, h: 134, cols: 10, rows: 10, count: 250, sheets: answer.sheets});
  });

  test('not ready, an older server, junk, a format this app does not know: no pictures', () => {
    expect(readScrubIndex({ready: false})).toBeNull();
    expect(readScrubIndex({error: 'Not found'})).toBeNull();
    expect(readScrubIndex(null)).toBeNull();
    expect(readScrubIndex('<html>')).toBeNull();
    expect(readScrubIndex({...answer, v: 2})).toBeNull();
    expect(readScrubIndex({...answer, interval: 0})).toBeNull();
    expect(readScrubIndex({...answer, w: -1})).toBeNull();
    expect(readScrubIndex({...answer, cols: 2.5})).toBeNull();
    expect(readScrubIndex({...answer, sheets: []})).toBeNull();
    expect(readScrubIndex({...answer, sheets: ['/a.jpg', 7]})).toBeNull();
    // 250 pictures need 3 sheets of 100
    expect(readScrubIndex({...answer, sheets: answer.sheets.slice(0, 2)})).toBeNull();
  });
});

describe('the tile for a second', () => {
  const idx = readScrubIndex(answer)!;

  test('i = round(t / interval), then sheet, column and row', () => {
    expect(tileAt(idx, 0)).toEqual({i: 0, sheet: 0, x: 0, y: 0});
    expect(tileAt(idx, 14)).toEqual({i: 1, sheet: 0, x: 240, y: 0});
    expect(tileAt(idx, 15)).toEqual({i: 2, sheet: 0, x: 480, y: 0});
    expect(tileAt(idx, 125)).toEqual({i: 13, sheet: 0, x: 3 * 240, y: 134});
    expect(tileAt(idx, 999)).toEqual({i: 100, sheet: 1, x: 0, y: 0});
    expect(tileAt(idx, 1994)).toEqual({i: 199, sheet: 1, x: 9 * 240, y: 9 * 134});
  });

  test('clamped to the pictures there are', () => {
    expect(tileAt(idx, -30).i).toBe(0);
    expect(tileAt(idx, 99999)).toEqual({i: 249, sheet: 2, x: 9 * 240, y: 4 * 134});
    expect(tileAt(idx, NaN).i).toBe(0);
  });

  test('drawn at 192 wide: the box keeps the aspect, the whole sheet sits behind it', () => {
    const l = tileLayout(idx, 125, 192); // scale 0.8
    expect(l.boxW).toBe(192);
    expect(l.boxH).toBe(107);
    expect(l.left).toBeCloseTo(-576);
    expect(l.top).toBeCloseTo(-107.2);
    expect(l.sheetW).toBeCloseTo(1920);
    expect(l.sheetH).toBeCloseTo(1072);
  });
});

describe('where it goes and what is fetched first', () => {
  test('centred on the scrub point, kept inside the track', () => {
    expect(thumbLeft(0.5, 1000, 200)).toBe(400);
    expect(thumbLeft(0, 1000, 200)).toBe(0);
    expect(thumbLeft(0.02, 1000, 200)).toBe(0);
    expect(thumbLeft(1, 1000, 200)).toBe(800);
    expect(thumbLeft(0.95, 1000, 200)).toBe(800);
    expect(thumbLeft(0.5, 100, 200)).toBe(0); // a track narrower than the picture
  });

  test('the sheet under the playhead, then the way the scrub goes, then the other side', () => {
    const idx = readScrubIndex(answer)!;
    expect(sheetsToWarm(idx, 1200, 1, 3)).toEqual([1, 2, 0]);
    expect(sheetsToWarm(idx, 1200, -1, 3)).toEqual([1, 0, 2]);
    expect(sheetsToWarm(idx, 0, 0, 3)).toEqual([0, 1, 2]);
    expect(sheetsToWarm(idx, 2400, 1, 2)).toEqual([2, 1]);
    expect(sheetsToWarm(idx, 0, 1, 1)).toEqual([0]);
  });
});
