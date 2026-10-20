// src/render.ts: this launch's switches come from AuroraRender.kt's constants; what the
// server or the developer setting says is stored (once, only when it changed) for the
// next launch; a QA override decides the next launch when there is one.

type Saved = [string, string, string];
const load = (constants: Record<string, unknown> | null) => {
  const saved: Saved[] = [];
  let mod!: typeof import('../../src/render');
  jest.isolateModules(() => {
    // the isolated registry has its own react-native stub: the module goes on THAT one
    const nm = require('react-native').NativeModules as Record<string, unknown>;
    if (constants) nm.AuroraRender = {...constants, save: (...a: Saved) => saved.push(a), jsRingClaimed: () => {}};
    else delete nm.AuroraRender;
    mod = require('../../src/render');
  });
  return {mod, saved};
};

test('no native module (an older APK): everything off, nothing stored', () => {
  const {mod, saved} = load(null);
  expect(Object.values(mod.nativeOn).some(Boolean)).toBe(false);
  expect(Object.values(mod.fixOn).some(Boolean)).toBe(false);
  expect(mod.renderLetters).toBe('-');
  expect(mod.renderFixCode).toBe('');
  mod.applyServerRender({recommended: true});
  expect(saved).toEqual([]);
});

test('this launch: what the constants say, and nothing more', () => {
  const {mod} = load({on: {card: true, row: true, cull: true, pool: true}, letters: 'CR', fixTag: 'cull+pool', source: 'saved'});
  expect(mod.nativeOn).toEqual({focusable: false, card: true, row: true, hero: false, rail: false});
  expect(mod.fixOn).toEqual({cardlayer: false, cull: true, shadowcache: false, unstuff: false, unstuffq: false, pool: true, keyrate: false, cardtext: false, ringshare: false, herotext: false});
  expect(mod.renderLetters).toBe('CR');
  expect(mod.renderFixCode).toBe('cp');
  expect(mod.renderSource).toBe('saved');
});

const PRESET = 'focusable,card,row,hero,rail,cardlayer,cull,shadowcache,unstuff,pool,keyrate,cardtext,ringshare,herotext';
test('the server’s say is stored for the next launch, once; the same answer writes nothing', () => {
  const {mod, saved} = load({on: {}, server: '', local: ''});
  // at startup: the release default, stored for the next launch (nothing said = the preset)
  expect(saved).toEqual([[PRESET, '{}', '{}']]);
  mod.applyServerRender({recommended: true, pool: false, nonsense: 1});
  expect(saved[1]).toEqual(['focusable,card,row,hero,rail,cardlayer,cull,shadowcache,unstuff,keyrate,cardtext,ringshare,herotext', '{"recommended":true,"pool":false}', '{}']);
  mod.applyServerRender({pool: false, recommended: true});
  expect(saved.length).toBe(2);
  // an answer without the section: nothing said, the release default again
  mod.applyServerRender(undefined);
  expect(saved[2]).toEqual([PRESET, '{}', '{}']);
  // the emergency lever
  mod.applyServerRender({recommended: false});
  expect(saved[3]).toEqual(['', '{"recommended":false}', '{}']);
  expect(mod.activeRender()).toEqual(new Set()); // this launch is untouched
});

test('the developer setting wins, and is kept beside the server’s', () => {
  const {mod, saved} = load({on: {}, server: '{"recommended":true}', local: ''});
  expect(mod.nextRender()).toEqual({on: new Set(PRESET.split(',')), qa: false});
  mod.setLocalRender({recommended: false, card: true});
  expect(saved.pop()).toEqual(['card', '{"recommended":true}', '{"recommended":false,"card":true}']);
  expect(mod.localRender()).toEqual({recommended: false, card: true});
});

test('a QA override decides the next launch', () => {
  const {mod} = load({on: {}, server: '{"recommended":true}', local: '', nextQa: true, nextQaSet: 'card,cull'});
  expect(mod.nextRender()).toEqual({on: new Set(['card', 'cull']), qa: true});
});
