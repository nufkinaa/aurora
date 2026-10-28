// render switch `cardtext` (docs/qa/native-deep/DEVICE-PLAN.md §cardtext): the single-view
// native card draws Card.tsx's words, pills and progress bar itself. Two things must hold
// for it to be the same card:
//  1. what DeepCard hands the native view (textMode, t1..t3, tags, pct, the tile's title)
//     is exactly what JsCard writes as RN children, item by item;
//  2. the `decor` JSON carries Card.tsx's own StyleSheet values (nothing invented), every
//     piece the Kotlin side (ui/card/CardDecor.kt) reads, and the icon path the Kotlin
//     side draws is Icon.tsx's.
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type {HeroItem} from '../../src/api';
import {boxOf, buildDecor, textOf} from '../../src/cardDecor';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Svg: 'Svg',
  Path: 'Path',
  Rect: 'Rect',
  G: 'G',
  Defs: 'Defs',
  LinearGradient: 'LinearGradient',
  Stop: 'Stop',
  Text: 'SvgText',
}));

// the card's own output only: the Focusable is a host that renders its children, then its overlay
jest.mock('../../src/components/Focusable', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (p: {children?: unknown; focusOverlay?: unknown}) =>
      R.createElement('Focusable', null, p.children, p.focusOverlay ? R.createElement('Overlay', null, p.focusOverlay) : null),
  };
});
jest.mock('../../src/overlay', () => ({openPeek: () => {}}));
// React Native's style processors (what Card.tsx hands them is checked below, not their output)
jest.mock('react-native/Libraries/StyleSheet/processBoxShadow', () => ({__esModule: true, default: (s: unknown) => [{offsetX: 0, offsetY: 0, raw: s}]}));
jest.mock('react-native/Libraries/StyleSheet/processBackgroundImage', () => ({__esModule: true, default: (s: unknown) => [{type: 'linear-gradient', raw: s}]}));

type Node = TestRenderer.ReactTestInstance;
const DAY = 24 * 3600 * 1000;

const ITEMS: Record<string, {item: HeroItem; props: Record<string, unknown>}> = {
  poster: {item: {id: 'm1', title: 'Arrival', type: 'movie'} as HeroItem, props: {showKind: true}},
  posterShow: {item: {id: 's1', title: 'Severance', type: 'show'} as HeroItem, props: {showKind: true}},
  fresh: {item: {id: 'm2', title: 'Dune', type: 'movie', addedAt: Date.now() - DAY} as HeroItem, props: {}},
  hebrew: {item: {id: 'm3', title: 'שובר שורות', type: 'movie'} as HeroItem, props: {wide: true}},
  wide: {item: {id: 'm4', title: 'A very long landscape title that will not fit', type: 'movie'} as HeroItem, props: {wide: true}},
  episode: {
    item: {id: 'e1', title: 'Good News About Hell', type: 'episode', showId: 'sev', showTitle: 'Severance', season: 1, episode: 1} as unknown as HeroItem,
    props: {wide: true},
  },
  episodeNoShow: {item: {id: 'e2', title: 'Pilot', type: 'episode', showId: 'x', season: 2, episode: 3} as unknown as HeroItem, props: {wide: true}},
  resume: {
    item: {id: 'm5', title: 'Heat', type: 'movie', progress: {position: 1800, duration: 6000, finished: false}} as unknown as HeroItem,
    props: {wide: true, onRemove: () => {}},
  },
  frame: {
    item: {
      id: 'e3', title: 'The We We Are', type: 'episode', showId: 'sev', showTitle: 'Severance', season: 1, episode: 9,
      progress: {position: 600, duration: 3000, finished: false},
    } as unknown as HeroItem,
    props: {wide: true, frame: true, onRemove: () => {}}, // Row: frame={wide}
  },
  frameFilm: {
    item: {id: 'm6', title: 'Heat', type: 'movie', progress: {position: 100, duration: 6000, finished: false}} as unknown as HeroItem,
    props: {wide: true, frame: true},
  },
  upNext: {item: {id: 'e4', title: 'Half Loop', type: 'episode', showId: 'sev', showTitle: 'Severance', season: 1, episode: 2, upNext: true} as unknown as HeroItem, props: {}},
  // [household] a recommended poster prints its line under the title (the row asks: caption)
  household: {item: {id: 'm7', title: 'Dune', type: 'movie', meta: 'From Dana and Avi'} as HeroItem, props: {showKind: true, caption: true}},
};

// every card has its picture (a card with none is the tile: tested on its own below)
for (const k of Object.keys(ITEMS)) (ITEMS[k].item as {poster?: string}).poster = `https://art.example/${k}.jpg`;

/** Card.tsx loaded with the given switches (render.ts mocked), in a fresh module registry —
 *  with that registry's own React and renderer, so the hooks see one React. */
type Loaded = {Card: React.ComponentType<Record<string, unknown>>; R: typeof React; T: typeof TestRenderer};
function loadCard(card: boolean, cardtext: boolean, before?: () => void): Loaded {
  let out!: Loaded;
  jest.isolateModules(() => {
    before?.();
    jest.doMock('../../src/render', () => ({
      nativeOn: {focusable: false, card, row: false, hero: false, rail: false},
      fixOn: {cardlayer: false, cull: false, shadowcache: false, unstuff: false, unstuffq: false, pool: false, keyrate: false, cardtext, ringshare: false, herotext: false},
      renderOn: () => false,
      tellRingClaimed: () => {},
      registerCardDecor: (j: string) => j,
    }));
    out = {Card: require('../../src/components/Card').default, R: require('react'), T: require('react-test-renderer')};
  });
  return out;
}

// [household] the invisible left-to-right mark and the held-open line (Card.tsx MetaLabel)
const LRM = '‎';
const HOLD = ' ';

const render = (L: Loaded, k: string): TestRenderer.ReactTestRenderer => {
  let r!: TestRenderer.ReactTestRenderer;
  L.T.act(() => {
    r = L.T.create(L.R.createElement(L.Card, {item: ITEMS[k].item, index: 0, onPress: () => {}, ...ITEMS[k].props}));
  });
  return r;
};

const textOfNode = (n: Node): string =>
  n.children.map(c => (typeof c === 'string' ? c : textOfNode(c as Node))).join('');
const styleOf = (n: Node) => Object.assign({}, ...[].concat(n.props.style).flat(9).filter(Boolean));

/** What JsCard draws as RN children: the label lines, NEW, the kind icon, the bar, the ✕. */
function jsSays(r: TestRenderer.ReactTestRenderer) {
  const texts = r.root.findAll(n => (n.type as unknown) === 'Text').map(n => ({text: textOfNode(n), style: styleOf(n)}));
  // Icon.tsx's Svg carries the kind colour as `fill` (the tile's gradient Svg has none)
  const icons = r.root.findAll(n => (n.type as unknown) === 'Svg' && n.props.fill != null);
  const fills = r.root.findAll(n => (n.type as unknown) === 'View' && styleOf(n).backgroundColor === '#8cffbe');
  return {
    lines: texts.filter(t => t.text !== 'NEW' && t.text !== '✕' && t.style.textAlign !== 'center').map(t => t.text),
    hasNew: texts.some(t => t.text === 'NEW'),
    hasX: texts.some(t => t.text === '✕'),
    kind: icons.length ? icons[0].props.fill : null,
    width: fills.length ? styleOf(fills[0]).width : null,
  };
}

/** What DeepCard hands the native views. */
function nativeSays(r: TestRenderer.ReactTestRenderer) {
  const views = r.root.findAll(n => (n.type as unknown) === 'AuroraNative');
  const art = views.find(v => !v.props.brighten)!;
  const focus = views.find(v => v.props.brighten)!;
  const lines = [art.props.t1 ?? '', art.props.t2 ?? '', art.props.t3 ?? ''];
  const mode = (art.props.textMode ?? '') as string;
  const shown =
    mode === 'label' ? [lines[0]] : mode === 'labelEp' ? [lines[0], lines[1]] : mode === 'labelMeta' ? [lines[0], lines[1], lines[2]] : mode === 'frame' ? [lines[0], lines[2]] : mode === 'frameEp' ? [lines[0], lines[1], lines[2]] : [];
  return {
    lines: shown.filter((t, i) => !(mode.startsWith('frame') && i === shown.length - 1 && t === '')),
    hasNew: !!art.props.tagNew,
    hasX: !!focus.props.xGlyph,
    kind: art.props.tagKind || null,
    width: art.props.pct != null && art.props.pct >= 0 ? `${art.props.pct}%` : null,
    art,
    focus,
    views,
    hostTexts: r.root.findAll(n => (n.type as unknown) === 'Text').length,
  };
}

describe('DeepCard says what JsCard draws', () => {
  const JsCard = loadCard(false, false);
  const DeepCard = loadCard(true, true);
  for (const k of Object.keys(ITEMS)) {
    test(k, () => {
      const js = jsSays(render(JsCard, k));
      const nat = nativeSays(render(DeepCard, k));
      expect(nat.lines).toEqual(js.lines);
      expect(nat.hasNew).toBe(js.hasNew);
      expect(nat.hasX).toBe(js.hasX);
      // the kind icon: JsCard's Svg fill is the kind colour; DeepCard names the kind
      expect(nat.kind == null).toBe(js.kind == null);
      expect(nat.width).toEqual(js.width);
      // nothing of the card is an RN Text any more, and exactly two native views draw it
      expect(nat.hostTexts).toBe(0);
      expect(nat.views.length).toBe(2);
      // every one of these cards draws something, so the art carries the decor (Card.tsx's
      // styles as JSON); the focus view carries it only for the ✕
      expect(JSON.parse(nat.art.props.decor).labelText.size).toBe(14);
      expect(nat.focus.props.decor !== undefined).toBe(js.hasX);
      // the tile's title only once the tile shows (these all have a picture)
      expect(nat.art.props.tileTitle).toBeUndefined();
    });
  }
  test('a plain poster (the Movies / Shows grid) hands native exactly what NativeCard does', () => {
    // G1 on the Mi TV (2026-10-17): every card carried the decor JSON twice and a dozen more
    // props although a grid poster draws none of it — pure extra mount work
    const NativeCard = loadCard(true, false);
    const item = {id: 'm9', title: 'Heat', type: 'movie', poster: 'https://art.example/heat.jpg'} as HeroItem;
    const mk = (L: Loaded) => {
      let r!: TestRenderer.ReactTestRenderer;
      L.T.act(() => {
        r = L.T.create(L.R.createElement(L.Card, {item, index: 0, onPress: () => {}}));
      });
      return r.root.findAll(n => (n.type as unknown) === 'AuroraNative').map(n => {
        const {onImageLoaded, onImageFailed, onImageRetry, ...rest} = n.props as Record<string, unknown>;
        return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      });
    };
    expect(mk(DeepCard)).toEqual(mk(NativeCard));
  });
  test('a card with no picture: the tile title (and the decor) at once', () => {
    const r = (() => {
      let x!: TestRenderer.ReactTestRenderer;
      DeepCard.T.act(() => {
        x = DeepCard.T.create(DeepCard.R.createElement(DeepCard.Card, {item: {id: 'q', title: 'No Art', type: 'movie'} as HeroItem, index: 0, onPress: () => {}}));
      });
      return x;
    })();
    const art = r.root.findAll(n => (n.type as unknown) === 'AuroraNative').find(v => !v.props.brighten)!;
    expect(art.props.tile).toBe(true);
    expect(art.props.tileTitle).toBe('No Art');
    expect(typeof art.props.decor).toBe('string');
  });
  test('the tile title arrives when native says the tile shows, and goes when a round asks again', () => {
    const r = render(DeepCard, 'poster');
    const art = () => r.root.findAll(n => (n.type as unknown) === 'AuroraNative').find(v => !v.props.brighten)!;
    const uri = art().props.uri as string;
    expect(art().props.tileTitle).toBeUndefined();
    DeepCard.T.act(() => art().props.onImageFailed({nativeEvent: {uri, error: 'x', tries: 3, tile: true, parked: false}}));
    expect(art().props.tileTitle).toBe('Arrival');
    expect(typeof art().props.decor).toBe('string');
    DeepCard.T.act(() => art().props.onImageRetry({nativeEvent: {uri}}));
    expect(art().props.tileTitle).toBeUndefined();
  });
  test('no decor (a processor failed): the two-layer native card, never a card without words', () => {
    const L = loadCard(true, true, () => {
      jest.doMock('../../src/cardDecor', () => ({
        buildDecor: () => {
          throw new Error('not here');
        },
      }));
    });
    const r = render(L, 'episode');
    expect(r.root.findAll(n => (n.type as unknown) === 'AuroraNative' && n.props.textMode !== undefined)).toHaveLength(0);
    expect(r.root.findAll(n => (n.type as unknown) === 'Text').map(textOfNode)).toEqual(
      expect.arrayContaining(['Severance', 'S1 E1 · Good News About Hell']),
    );
  });
  test('the label paths are all exercised', () => {
    const modes = Object.keys(ITEMS).map(k => nativeSays(render(DeepCard, k)).art.props.textMode ?? '');
    expect(new Set(modes)).toEqual(new Set(['', 'label', 'labelEp', 'labelMeta', 'frame', 'frameEp']));
    // [household] the title, then the line in its two pieces, each drawn left to right (a mark first)
    expect(nativeSays(render(DeepCard, 'household')).lines).toEqual([`${LRM}Dune`, `${LRM}From Dana`, `${LRM}and Avi`]);
    expect(nativeSays(render(DeepCard, 'episodeNoShow')).lines).toEqual(['', 'S2 E3 · Pilot']);
  });
  test('the kind follows the item type', () => {
    expect(nativeSays(render(DeepCard, 'poster')).kind).toBe('film');
    expect(nativeSays(render(DeepCard, 'posterShow')).kind).toBe('series');
  });
});

describe('the decor is Card.tsx’s own styles', () => {
  const p = {
    // a stable mark per colour string (the real one is processColor)
    color: (c: unknown) => (c == null ? null : [...String(c)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)),
    boxShadow: (s: unknown) => [{offsetX: 0, offsetY: 0, blurRadius: 10, color: 1, raw: s}],
    backgroundImage: (s: unknown) => [{type: 'linear-gradient', raw: s}],
  };
  const flatten = (s: unknown) => Object.assign({}, ...[].concat(s as never).flat(9).filter(Boolean));
  const card = fs.readFileSync(path.join(__dirname, '..', '..', 'src/components/Card.tsx'), 'utf8');
  // the StyleSheet as Card.tsx declares it, read back from the source (theme values inlined)
  const theme = require('../../src/theme').default;
  const stylesSrc = /const styles = StyleSheet\.create\((\{[\s\S]*\})\);\s*$/m.exec(card)![1];
  // eslint-disable-next-line no-new-func
  const styles = new Function('colors', 'radius', 'CARD_W', 'CARD_H', 'WIDE_W', 'WIDE_H', 'COMPACT_W', 'COMPACT_H', 'FRAME_W', 'FRAME_H', `return (${stylesSrc});`)(
    theme.colors, theme.radius, 1, 1, 1, 1, 1, 1, 1, 1,
  );
  const d = JSON.parse(buildDecor(styles, flatten, p, {size: 11, film: theme.colors.kindFilm, series: theme.colors.kindSeries}));

  test('label, frame label, tile title', () => {
    expect(d.label).toMatchObject({left: 8, right: 8, bottom: 7});
    expect(d.labelRaised).toMatchObject({left: 8, right: 8, bottom: 14});
    expect(d.labelText).toMatchObject({size: 14, weight: '700', shadow: {dx: 0, dy: 1, r: 6}});
    expect(d.labelSub).toMatchObject({size: 14, weight: '600', shadow: {dx: 0, dy: 1, r: 6}});
    expect(d.frameLabel).toMatchObject({left: 11, right: 11, bottom: 17});
    expect(d.frameTitle).toMatchObject({size: 17, weight: '800', ls: -0.2, lh: 20, shadow: {dy: 1, r: 10}});
    expect(d.frameSub).toMatchObject({size: 13, weight: '600', mt: 1});
    expect(d.frameSub.shadow).toBeUndefined();
    expect(d.frameMeta).toMatchObject({size: 13, weight: '600', mt: 3});
    expect(d.fallbackCentre).toMatchObject({top: 0, left: 0, right: 0, bottom: 0, pt: 10, pr: 10, pb: 10, pl: 10});
    expect(d.fallbackText).toMatchObject({size: 14, weight: '700', align: 'center'});
  });

  test('the pills: NEW wins its own insets, the kind pill sits right', () => {
    expect(d.newPill).toMatchObject({top: 7, left: 7, maxWidth: 81, pt: 1, pb: 1, pl: 5, pr: 5, bw: 1, br: 4});
    expect(d.newText).toMatchObject({size: 11, weight: '900', ls: 1.2});
    expect(d.filmPill).toMatchObject({top: 7, right: 7, pt: 2, pl: 6, bw: 1, br: 5});
    expect(d.filmPill.left).toBeUndefined();
    expect(d.seriesPill.bc).not.toEqual(d.filmPill.bc);
    expect(d.icon.size).toBe(11);
  });

  test('the bar: track, frame track, gradient fill with its glow, the bead', () => {
    expect(d.progress).toMatchObject({left: 8, right: 8, bottom: 6, height: 4, br: 2, clip: true});
    expect(d.progressFrame).toMatchObject({left: 11, right: 11, bottom: 9, height: 3, clip: true});
    expect(d.progressFill.shadow[0].raw).toBe('0 0 10px rgba(140,255,190,0.55)');
    expect(d.progressFill.image[0].raw).toBe('linear-gradient(90deg, #8b7bff, #7fd1e8, #8cffbe)');
    expect(d.progressHead).toMatchObject({right: -3, top: -2, width: 8, height: 8, br: 4});
    expect(d.progressHead.shadow[0].raw).toBe('0 0 8px rgba(255,255,255,0.9)');
    expect(d.remove).toMatchObject({top: 6, right: 6, width: 30, height: 30, br: 15});
    expect(d.removeGlyph).toMatchObject({size: 15, weight: '800'});
  });

  test('every piece is read by the Kotlin side', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'android/app/src/main/java/com/auroratv/ui/card/CardDecor.kt'), 'utf8');
    for (const k of Object.keys(d)) {
      if (k === 'v') continue;
      expect(kt).toContain(`optJSONObject("${k}")`);
    }
    for (const k of Object.keys(textOf({}, p))) expect(kt).toContain(`"${k}"`);
    for (const k of Object.keys(boxOf({}, p))) expect(kt).toContain(`"${k}"`);
  });

  test("the kind glyphs the Kotlin side draws are Icon.tsx's", () => {
    const icon = fs.readFileSync(path.join(__dirname, '..', '..', 'src/components/Icon.tsx'), 'utf8');
    const stamps = fs.readFileSync(path.join(__dirname, '..', '..', 'android/app/src/main/java/com/auroratv/ui/card/CardStamps.kt'), 'utf8');
    const film = /case 'film':\s*return <Path d="([^"]+)"/.exec(icon)![1];
    expect(/const val FILM_D = "([^"]+)"/.exec(stamps)![1]).toBe(film);
    const series = /case 'series':[\s\S]*?<Rect x="2" y="4" width="20" height="13" rx="2" \/>\s*<Rect x="8" y="19" width="8" height="2" rx="1" \/>/.test(icon);
    expect(series).toBe(true);
    expect(stamps).toContain('rect(2.0, 4.0, 20.0, 13.0, 2.0, scale), rect(8.0, 19.0, 8.0, 2.0, 1.0, scale)');
    // the size Card.tsx gives the icon
    expect(card).toMatch(/<Icon\s+name=\{item\.type === 'show' \? 'series' : 'film'\}\s+size=\{11\}/);
  });
});

// [household] the card's line is only drawn where the shelf asks for it, and the
// household row's Show all tile is not a title (no hold-OK sheet, no kind tag)
describe('household cards', () => {
  const mk = (L: Loaded, item: HeroItem, props: Record<string, unknown> = {}) => {
    let r!: TestRenderer.ReactTestRenderer;
    L.T.act(() => {
      r = L.T.create(L.R.createElement(L.Card, {item, index: 0, onPress: () => {}, ...props}));
    });
    return r;
  };
  const dune = {id: 'm8', title: 'Dune', type: 'movie', meta: 'From Dana', poster: 'https://art.example/dune.jpg'} as HeroItem;
  test('a meta line without `caption` changes nothing (every other shelf)', () => {
    const JsCard = loadCard(false, false);
    expect(jsSays(mk(JsCard, dune, {showKind: true})).lines).toEqual([]);
    // one sender: the third line is held open (a no-break space), so every title of the row sits
    // at the same height
    expect(jsSays(mk(JsCard, dune, {showKind: true, caption: true})).lines).toEqual([`${LRM}Dune`, `${LRM}From Dana`, HOLD]);
    const NativeCard = loadCard(true, false);
    expect(jsSays(mk(NativeCard, dune, {caption: true})).lines).toEqual([`${LRM}Dune`, `${LRM}From Dana`, HOLD]);
    const Deep = loadCard(true, true, () => jest.dontMock('../../src/cardDecor'));
    expect(nativeSays(mk(Deep, dune, {caption: true})).lines).toEqual([`${LRM}Dune`, `${LRM}From Dana`, HOLD]);
  });
  test('a recommendation not looked at yet carries NEW (the website’s card), in every implementation', () => {
    const fresh = {...dune, hh: {key: 'tt1', from: [{id: 'd', name: 'Dana', at: 1}], unseen: true}} as HeroItem;
    const seen = {...dune, hh: {key: 'tt1', from: [{id: 'd', name: 'Dana', at: 1}], unseen: false}} as HeroItem;
    for (const L of [loadCard(false, false), loadCard(true, false)]) {
      expect(jsSays(mk(L, fresh, {caption: true})).hasNew).toBe(true);
      expect(jsSays(mk(L, seen, {caption: true})).hasNew).toBe(false);
    }
    // (the no-decor test above leaves its cardDecor mock in the registry)
    const Deep = loadCard(true, true, () => jest.dontMock('../../src/cardDecor'));
    expect(nativeSays(mk(Deep, fresh, {caption: true})).hasNew).toBe(true);
    expect(nativeSays(mk(Deep, seen, {caption: true})).hasNew).toBe(false);
  });
  test('the Show all tile: its own control id, no peek, no kind tag', () => {
    for (const L of [loadCard(false, false), loadCard(true, false), loadCard(true, true, () => jest.dontMock('../../src/cardDecor'))]) {
      const r = mk(L, {id: '__household_all', title: 'Show all recommended', cta: true} as HeroItem, {showKind: true});
      // the Focusable mock itself (a function component) holds the props the card gave it
      const f = r.root.findAll(n => typeof n.type === 'function' && Object.prototype.hasOwnProperty.call(n.props, 'uiId'));
      expect(f.length).toBe(1);
      expect(f[0].props.uiId).toBe('home.hh.all');
      expect(f[0].props.onLongPress).toBeUndefined();
      // no Svg at all (no kind tag; its arrow is a text glyph — an Svg paints on the UI thread)
      const icons = r.root.findAll(n => (n.type as unknown) === 'Svg');
      expect(icons.length).toBe(0);
      expect(r.root.findAll(n => (n.type as unknown) === 'Text').map(textOfNode)).toEqual(['›', 'Show all recommended']);
      const views = r.root.findAll(n => (n.type as unknown) === 'AuroraNative');
      for (const v of views) expect(v.props.tagKind).toBeUndefined();
    }
  });
});
