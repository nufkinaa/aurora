// The rendering switches (src/renderRules.ts, src/render.ts; docs/qa/native-port/DEVICE-PLAN.md):
// all off unless something turns them on, how the server and the developer setting combine,
// and that the three copies of the key list (TS, Kotlin, the server) agree.
import {
  COMPONENTS,
  cycleTri,
  decodeRender,
  encodeRender,
  FIXES,
  inertBecause,
  KEYS,
  RECOMMENDED,
  RenderKey,
  resolveRender,
  sameSay,
  sanitizeSay,
  triOf,
} from '../../src/renderRules';
import {columnTargets, rowTarget} from '../../src/homeMath';
import {restOffset} from '../../src/homeWindow';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const set = (...k: RenderKey[]) => new Set<RenderKey>(k);

describe('nothing said, nothing on', () => {
  test('no source → every switch off', () => {
    expect(resolveRender({}, {})).toEqual(set());
    for (const raw of [undefined, null, 7, 'recommended', [], [true], {grid: true}, {card: 'yes'}, {card: 1}]) {
      expect(sanitizeSay(raw)).toEqual({});
      expect(resolveRender(sanitizeSay(raw), {})).toEqual(set());
    }
  });
  test('unknown keys are dropped, known booleans kept', () => {
    expect(sanitizeSay({card: true, cull: false, x_hero: true, taglayer: true, recommended: true, grid: true})).toEqual({
      card: true,
      cull: false,
      recommended: true,
    });
  });
});

describe('how the two sources combine', () => {
  test('the preset is the lab’s recommended set, not unstuffq', () => {
    const on = resolveRender({recommended: true}, {});
    expect(on).toEqual(new Set(RECOMMENDED));
    expect(on.has('unstuffq')).toBe(false);
    expect([...on].sort()).toEqual(['card', 'cardlayer', 'cull', 'focusable', 'hero', 'pool', 'rail', 'row', 'shadowcache', 'unstuff']);
  });
  test('an explicit switch wins over the preset at the same level', () => {
    expect(resolveRender({recommended: true, pool: false}, {}).has('pool')).toBe(false);
    expect(resolveRender({recommended: true, unstuffq: true}, {}).has('unstuffq')).toBe(true);
  });
  test('the developer setting wins over the server, switch by switch', () => {
    expect(resolveRender({card: true, row: true}, {card: false})).toEqual(set('row'));
    expect(resolveRender({}, {cull: true})).toEqual(set('cull'));
    // the developer's preset over the server's switches
    expect(resolveRender({card: false}, {recommended: true}).has('card')).toBe(false);
    expect(resolveRender({}, {recommended: true}).has('card')).toBe(true);
    // the developer turning the preset off leaves the server's own switches
    expect(resolveRender({recommended: true, cull: true}, {recommended: false})).toEqual(set('cull'));
  });
  test('stored as a word list in KEYS order, and back', () => {
    const on = resolveRender({recommended: true}, {pool: false});
    const s = encodeRender(on);
    expect(s).toBe('focusable,card,row,hero,rail,cardlayer,cull,shadowcache,unstuff');
    expect(decodeRender(s)).toEqual(on);
    expect(encodeRender(set())).toBe('');
    expect(decodeRender('card,retired,,cull')).toEqual(set('card', 'cull'));
    expect(decodeRender(null)).toEqual(set());
  });
  test('sameSay', () => {
    expect(sameSay({}, {})).toBe(true);
    expect(sameSay({card: true}, {card: true})).toBe(true);
    expect(sameSay({card: true}, {card: false})).toBe(false);
    expect(sameSay({card: true}, {card: true, row: true})).toBe(false);
  });
});

describe('the developer setting’s three positions', () => {
  test('server → on → off → server', () => {
    let say = {};
    expect(triOf(say, 'card')).toBe('server');
    say = cycleTri(say, 'card');
    expect(triOf(say, 'card')).toBe('on');
    say = cycleTri(say, 'card');
    expect(triOf(say, 'card')).toBe('off');
    say = cycleTri(say, 'card');
    expect(triOf(say, 'card')).toBe('server');
    expect(say).toEqual({});
  });
  test('a fix that cannot act is named, never forced', () => {
    expect(inertBecause(set('cardlayer'), 'cardlayer')).toMatch(/focusable/);
    expect(inertBecause(set('cardlayer', 'focusable'), 'cardlayer')).toMatch(/card/);
    expect(inertBecause(set('cardlayer', 'focusable', 'card'), 'cardlayer')).toBeNull();
    expect(inertBecause(set('pool', 'row'), 'pool')).toMatch(/card/);
    expect(inertBecause(set('cull', 'hero'), 'cull')).toBeNull();
    expect(inertBecause(set('unstuff'), 'unstuff')).toMatch(/native/);
    expect(inertBecause(set(), 'pool')).toBeNull();
    expect(inertBecause(new Set(RECOMMENDED), 'pool')).toBeNull();
    // the deeper switches (docs/qa/native-deep/DEVICE-PLAN.md)
    expect(inertBecause(set('cardtext'), 'cardtext')).toMatch(/card/);
    expect(inertBecause(set('cardtext', 'card'), 'cardtext')).toBeNull();
    expect(inertBecause(set('ringshare'), 'ringshare')).toMatch(/focusable/);
    expect(inertBecause(set('ringshare', 'focusable'), 'ringshare')).toBeNull();
    expect(inertBecause(set('keyrate'), 'keyrate')).toBeNull();
    expect(inertBecause(set('herotext'), 'herotext')).toBeNull();
  });

  test('the deeper switches are not in the preset: none has run on a TV', () => {
    for (const k of ['keyrate', 'cardtext', 'ringshare', 'herotext'] as const) {
      expect(RECOMMENDED).not.toContain(k);
      expect(resolveRender({}, {recommended: true}).has(k)).toBe(false);
      expect(resolveRender({[k]: true}, {}).has(k)).toBe(true);
    }
  });
});

describe('the three key lists agree', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const kotlin = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/auroratv/ui/AuroraRender.kt'), 'utf8');
  const words = (src: string, name: string) => {
    const m = new RegExp(`val ${name}[^=]*=\\s*(?:listOf|linkedSetOf)\\(([^)]*)\\)`).exec(src);
    if (!m) throw new Error(`no ${name} in AuroraRender.kt`);
    return [...m[1].matchAll(/"([a-z]+)"/g)].map(x => x[1]);
  };
  test('AuroraRender.kt', () => {
    expect(words(kotlin, 'COMPONENTS')).toEqual([...COMPONENTS]);
    expect(words(kotlin, 'FIXES')).toEqual([...FIXES]);
    expect(words(kotlin, 'RECOMMENDED')).toEqual([...RECOMMENDED]);
  });
  test('the server (src/lib/tvtuning.js RENDER_KEYS)', () => {
    const js = fs.readFileSync(path.join(ROOT, '..', 'src/lib/tvtuning.js'), 'utf8');
    const m = /const RENDER_KEYS = \[([\s\S]*?)\];/.exec(js);
    expect(m).not.toBeNull();
    const keys = [...m![1].matchAll(/"([a-z]+)"/g)].map(x => x[1]);
    expect(keys).toEqual(['recommended', ...KEYS]);
  });
});

describe('the native column’s targets are Home’s own toRow numbers', () => {
  test('rowTarget = -restOffset, holes stay holes', () => {
    for (const [y, colH, h] of [
      [400, 3000, 540],
      [27, 3000, 540],
      [2900, 3000, 540],
      [100, 300, 540],
    ]) {
      expect(rowTarget(y, colH, h, 27)).toBe(-restOffset(y, colH, h, 27) + 0);
    }
    expect(columnTargets([400, undefined, 900], 3000, 540, 27)).toEqual([-373, 1, -873]);
  });
});
