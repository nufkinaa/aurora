// The Recommend picker's note field and the D-pad (householdRecs.ts notePress,
// RecommendSheet.tsx), and Report a problem opened from the player: focus lands in
// the sheet's field at once (Overlays.tsx ReportSheet, Player.tsx focusSink).
import {NOTE_SAME_PRESS_MS, notePress} from '../../src/householdRecs';

const T = 1_000_000;
describe('which press a key event is', () => {
  it('a held press that brought focus to the field is not the field’s (it used to be thrown on to the faces or Send)', () => {
    // key down at T (focus arrives at T+5), key up 320 ms later; the key before it long ago
    expect(notePress({inField: true, gotAt: T + 5, leftAt: T - 9000, prevKeyAt: T - 4000})).toBe('arrived');
  });
  it('an injected press whose key-up came before its focus event: the next press is made in the field', () => {
    // previous press: key-up at T, the field's focus at T+5; this press 2 s later
    expect(notePress({inField: true, gotAt: T + 5, leftAt: T - 9000, prevKeyAt: T})).toBe('field');
  });
  it('a held press that left the field (Android put focus on Cancel) is the field’s', () => {
    expect(notePress({inField: false, gotAt: T - 9000, leftAt: T + 5, prevKeyAt: T - 4000})).toBe('field');
  });
  it('focus left the field with the PREVIOUS press (its event late): this press is not the field’s', () => {
    // UP from the field: key-up at T, the face's focus a few ms later; then DOWN from the face
    expect(notePress({inField: false, gotAt: T - 9000, leftAt: T + 5, prevKeyAt: T})).toBe('elsewhere');
    // …even when that late focus event took a good while to reach JS (Mi TV: over 80 ms)
    expect(notePress({inField: false, gotAt: T - 9000, leftAt: T + 200, prevKeyAt: T})).toBe('elsewhere');
    expect(NOTE_SAME_PRESS_MS).toBeGreaterThan(5);
    expect(NOTE_SAME_PRESS_MS).toBeLessThan(400); // a press is longer apart than this from the one before it
  });
  it('nothing to do with the field', () => {
    expect(notePress({inField: false, gotAt: 0, leftAt: 0, prevKeyAt: T})).toBe('elsewhere');
  });
});

describe('Report a problem from the player', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f: string): string => fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8').replace(/\r\n/g, '\n');
  it('the field says it holds focus (focus.ts’s rescue then leaves it there)', () => {
    const o = read('components/Overlays.tsx');
    const sheet = o.slice(o.indexOf('function ReportSheet('), o.indexOf('function JoinSheet('));
    expect(sheet).toMatch(/onFocus=\{\(\) => noteFocus\(fieldNode\.current, false\)\}/);
    // …and that it let go (a blur, the sheet closing): focus.ts then rescues focus for the player under it
    expect(sheet).toMatch(/onBlur=\{\(\) => noteFocusLost\(fieldNode\.current\)\}/);
    expect(sheet).toMatch(/useEffect\(\(\) => \(\) => noteFocusLost\(fieldNode\.current\), \[\]\);/);
  });
  it('the player never takes focus back to its scrubber while a sheet is up', () => {
    const p = read('playback/Player.tsx');
    expect(p).toMatch(/if \(controlsRef\.current && !overlayOpen\(\)\) scrubRef\.current\?\.requestTVFocus\?\.\(\);/);
  });
});
