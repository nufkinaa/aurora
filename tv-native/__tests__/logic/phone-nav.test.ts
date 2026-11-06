// The phone's navigation (docs/android-phone/NAV.md): the tab bar's words always fit,
// and the More sheet holds the agreed places in the agreed order and words.
import {BAR_PAD, BASE_FONT, fitTabs, GAP, guessWidth, ICON_W, MIN_FONT, PAD_MAX, PAD_MIN, slotWidths, tabSlots} from '../../src/phone/ui/tabFit';
import {moreEntries} from '../../src/phone/moreItems';

const fs = require('fs');
const path = require('path');

// widths of the bar's words at 12.16 dp bold, as a Pixel at font scale 1 measures them
// (Home · Movies · Shows · My List · More), and scaled for a bigger font
const WORDS = [35, 44, 41, 48, 34];
const at = (k: number) => WORDS.map(w => Math.ceil(w * k));
const barOf = (screen: number) => screen - 24; // TAB_SIDE each side

describe('the tab bar fits its words (ui/tabFit.ts)', () => {
  test('a roomy phone: the words at their full size, the full room each side', () => {
    expect(fitTabs(barOf(411), WORDS)).toEqual({font: BASE_FONT, pad: PAD_MAX, moreIcon: false, fits: true});
  });
  test('360 dp: still the full size, a little less room each side', () => {
    const f = fitTabs(barOf(360), WORDS);
    expect(f.font).toBe(BASE_FONT);
    expect(f.moreIcon).toBe(false);
    expect(f.pad).toBeLessThan(PAD_MAX);
  });
  test('320 dp with the largest font: smaller words (never under 10.5 as drawn), every word still a word or More an icon', () => {
    const f = fitTabs(barOf(320), at(1.2), 1.2);
    expect(f.fits).toBe(true);
    expect(f.font * 1.2).toBeGreaterThanOrEqual(MIN_FONT - 0.02);
    expect(f.font).toBeLessThan(BASE_FONT);
  });
  test('when the words cannot shrink enough, More turns into the icon first', () => {
    const f = fitTabs(250, at(1.2), 1.2);
    expect(f.moreIcon).toBe(true);
  });
  test('whatever it picks, the slots add up to the bar and each word has its room', () => {
    for (const screen of [320, 340, 360, 393, 411, 480]) {
      for (const k of [1, 1.15, 1.2]) {
        const words = at(k);
        const f = fitTabs(barOf(screen), words, k);
        const slots = tabSlots(barOf(screen), words, f);
        const n = slots.length;
        const total = slots.reduce((a, b) => a + b, 0) + (n - 1) * GAP + 2 * BAR_PAD;
        expect(Math.abs(total - barOf(screen))).toBeLessThan(0.01);
        const shown = f.moreIcon ? words.slice(0, -1) : words;
        shown.forEach((w, i) => expect(slots[i]).toBeGreaterThanOrEqual(w * (f.font / BASE_FONT) + 2 * PAD_MIN - 0.01));
        expect(slots[n - 1]).toBeGreaterThanOrEqual(ICON_W - 0.01); // Search
        if (f.fits) expect(f.font * k).toBeGreaterThanOrEqual(MIN_FONT - 0.02);
      }
    }
  });
  test('equal shares (the site’s flex: 1), a slot that needs more takes it', () => {
    expect(slotWidths(300, [40, 40, 40])).toEqual([100, 100, 100]);
    const w = slotWidths(200, [120, 20, 20]);
    expect(w[0]).toBe(120);
    expect(w[1]).toBe(40);
    expect(w[2]).toBe(40);
  });
  test('a first guess before measuring is in the right range', () => {
    expect(guessWidth('My List')).toBeGreaterThan(40);
    expect(guessWidth('My List', 1.2)).toBeGreaterThan(guessWidth('My List'));
  });
});

describe('the More sheet (moreItems.ts) is docs/android-phone/NAV.md §2', () => {
  // the table's rows: | # | phone words | website words | opens | uiId |
  const doc: string = fs.readFileSync(path.join(__dirname, '../../../docs/android-phone/NAV.md'), 'utf8');
  const rows = (from: string, to: string): string[][] =>
    doc
      .slice(doc.indexOf(from), doc.indexOf(to, doc.indexOf(from) + from.length))
      .split(/\r?\n/)
      .filter((l: string) => /^\|\s*\d+\s*\|/.test(l))
      .map((l: string) => l.split('|').map((c: string) => c.trim()));
  const places = rows('## 2. The More sheet', 'Then, under a hairline');
  const actions = rows('Then, under a hairline', 'Rules:');

  test('the places, in order and in the words of the phone column, with their ids', () => {
    const got = moreEntries({ai: true}).filter(e => e.group === 'places');
    expect(got.map(e => e.label)).toEqual(places.map(r => r[2]));
    expect(got.map(e => e.uiId)).toEqual(places.map(r => r[5].replace(/`/g, '')));
    expect(got.length).toBe(10);
  });
  test('the three actions under the hairline', () => {
    const got = moreEntries({ai: true}).filter(e => e.group === 'actions');
    expect(got.map(e => e.label)).toEqual(actions.map(r => r[2]));
    expect(got.map(e => e.uiId)).toEqual(actions.map(r => r[4].replace(/`/g, '')));
  });
  test('AI pick is listed only when the server has AI', () => {
    expect(moreEntries({ai: false}).some(e => e.key === 'pick')).toBe(false);
    expect(moreEntries({ai: true}).some(e => e.key === 'pick')).toBe(true);
  });
  test('every place the brief names is in it (nothing on the phone is out of reach)', () => {
    const keys = moreEntries({ai: true}).map(e => e.key);
    for (const k of ['new', 'saved', 'downloads', 'remote', 'household', 'wrapped', 'taste', 'pick', 'settings', 'apps'] as const) expect(keys).toContain(k);
  });
});
