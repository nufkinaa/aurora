// Settings that follow the person: the rules (personPrefs.ts) and the
// keeping-in-step around them (personSync.ts) — the one-time move from the
// box, what wins, offline, a server too old to store a key, a change made on
// another device.
import {
  afterPush,
  changePerson,
  DEVICE_KEYS,
  emptyRecord,
  PERSON_DEFAULTS,
  PERSON_KEYS,
  readPerson,
  readRecord,
  resolvePerson,
  seedFromBox,
} from '../../src/personPrefs';

// (AsyncStorage is a Map here: __tests__/logic/async-storage-stub.js)
const store: Map<string, string> = require('./async-storage-stub').__store;

import {api} from '../../src/api';
import {
  _personInternals,
  enterPerson,
  leavePerson,
  onPersonPrefs,
  personNow,
  refreshPerson,
  setPersonPref,
} from '../../src/personSync';
import {loadPrefs, PREFS_DEFAULTS, savePrefs} from '../../src/storage';
import {clearProfileCaches} from '../../src/profileScope';

// ------------------------------------------------------------------ the rules
describe('which settings are whose', () => {
  test('the person-level keys and the device-level keys do not overlap, and every one is a real setting', () => {
    expect(PERSON_KEYS.sort()).toEqual([
      'autoplayNext', 'dialogueBoost', 'nightMode', 'smartCleanup', 'smartDownloads',
      'subBg', 'subColor', 'subLang', 'subOpacity', 'subPos', 'subSize', 'subWeight', 'subsDefault', 'usageStats',
    ]);
    for (const k of DEVICE_KEYS) expect(PERSON_KEYS as string[]).not.toContain(k);
    for (const k of [...PERSON_KEYS, ...DEVICE_KEYS]) expect(PREFS_DEFAULTS).toHaveProperty(k);
    // the defaults the two clients share
    expect(PERSON_DEFAULTS).toEqual({
      autoplayNext: true, subsDefault: true, subLang: 'any', usageStats: true, smartDownloads: true, smartCleanup: true,
      // [player-options] 2026-10-19
      nightMode: false, dialogueBoost: false,
      subSize: 'M', subColor: 'white', subBg: 'box', subOpacity: 75, subWeight: 'bold', subPos: 'lower',
    });
  });

  test('only values of the right kind are read off a profile', () => {
    expect(readPerson({autoplayNext: false, subsDefault: 'no', subLang: 'ru', usageStats: 0, cueSize: 'L', subPick: 'he'})).toEqual({
      autoplayNext: false,
      subLang: 'ru',
    });
    expect(readPerson({subLang: 'fr'})).toEqual({});
    expect(readPerson(null)).toEqual({});
  });
});

describe('the one-time move from the box', () => {
  test("the box's real choices become the person's; a value that is only the default is not a choice", () => {
    const box = {...PREFS_DEFAULTS, autoplayNext: false, subLang: 'he', usageStats: false, subsDefault: true, cueSize: 'L'};
    // (the box's old subtitle size moves too, as the person's subSize — 2026-10-19)
    expect(seedFromBox(box)).toEqual({v: {autoplayNext: false, subLang: 'he', usageStats: false, subSize: 'L'}, dirty: [], gen: 2});
  });

  test('…only where the profile has none: what the profile already says wins', () => {
    const rec = seedFromBox({...PREFS_DEFAULTS, autoplayNext: false, subLang: 'he', usageStats: false});
    const r = resolvePerson({subLang: 'ru', usageStats: true}, rec);
    expect(r.effective).toMatchObject({autoplayNext: false, subLang: 'ru', usageStats: true});
    expect(r.push).toEqual({autoplayNext: false}); // the one thing the profile lacked
    expect(r.rec.v).toEqual({autoplayNext: false, subLang: 'ru', usageStats: true});
  });

  test('a box that never changed anything offers nothing', () => {
    const r = resolvePerson({}, seedFromBox({...PREFS_DEFAULTS}));
    expect(r.effective).toEqual(PERSON_DEFAULTS);
    expect(r.push).toEqual({});
  });
});

describe('what wins', () => {
  test('the profile over what the box remembers', () => {
    const r = resolvePerson({autoplayNext: true}, {v: {autoplayNext: false}, dirty: []});
    expect(r.effective.autoplayNext).toBe(true);
    expect(r.push).toEqual({});
    expect(r.rec.v.autoplayNext).toBe(true);
  });

  test('a change made here and not yet delivered over the profile — and it is sent again', () => {
    const rec = changePerson({v: {subLang: 'he'}, dirty: []}, 'subLang', 'en');
    const r = resolvePerson({subLang: 'he'}, rec);
    expect(r.effective.subLang).toBe('en');
    expect(r.push).toEqual({subLang: 'en'});
  });

  test('offline: what the box remembers holds, nothing is sent, nothing is lost', () => {
    const rec = changePerson({v: {usageStats: false}, dirty: []}, 'autoplayNext', false);
    const r = resolvePerson(null, rec);
    expect(r.effective).toMatchObject({usageStats: false, autoplayNext: false});
    expect(r.push).toEqual({});
    expect(r.rec).toEqual(rec);
  });

  test('nothing anywhere is the default', () => {
    expect(resolvePerson({}, emptyRecord()).effective).toEqual(PERSON_DEFAULTS);
    expect(resolvePerson(null, emptyRecord()).effective).toEqual(PERSON_DEFAULTS);
  });
});

describe('a write and its answer', () => {
  test('delivered: no longer owed', () => {
    const rec = changePerson(emptyRecord(), 'autoplayNext', false);
    expect(afterPush(rec, {autoplayNext: false}, {autoplayNext: false})).toEqual({v: {autoplayNext: false}, dirty: [], gen: 2});
  });

  test('changed again while the write was on its way: still owed', () => {
    let rec = changePerson(emptyRecord(), 'subLang', 'he');
    rec = changePerson(rec, 'subLang', 'ru'); // pressed again before the first answer
    expect(afterPush(rec, {subLang: 'he'}, {subLang: 'he'})).toEqual({v: {subLang: 'ru'}, dirty: ['subLang'], gen: 2});
  });

  test('a server too old to store the key: the box keeps its value, and stops re-sending it as a change', () => {
    const rec = changePerson(emptyRecord(), 'autoplayNext', false);
    const after = afterPush(rec, {autoplayNext: false}, {}); // the answer does not carry it
    expect(after).toEqual({v: {autoplayNext: false}, dirty: [], gen: 2});
    // …and it still applies on this TV
    expect(resolvePerson({}, after).effective.autoplayNext).toBe(false);
  });

  test('a stored record that was tampered with or half-written is read safely', () => {
    expect(readRecord({v: {subLang: 'xx', autoplayNext: false}, dirty: ['subLang', 'autoplayNext', 'nope']})).toEqual({
      v: {autoplayNext: false},
      dirty: ['autoplayNext'],
      gen: 1, // written before 2026-10-19: the subtitle look's move is still to come
    });
    expect(readRecord('junk')).toBeNull();
  });
});

// -------------------------------------------------------------- keeping in step
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>(r => setTimeout(() => r(), 0));
};
const profile = (prefs: Record<string, unknown>) => ({id: 'p1', name: 'Elia', prefs} as never);

describe('personSync', () => {
  let profiles: jest.SpyInstance;
  let update: jest.SpyInstance;
  let server: Record<string, unknown>;
  let storesKeys: string[];
  beforeEach(() => {
    store.clear();
    _personInternals.reset();
    server = {};
    storesKeys = [
      'autoplayNext', 'subsDefault', 'subLang', 'usageStats', 'smartDownloads', 'smartCleanup',
      'nightMode', 'dialogueBoost', 'subSize', 'subColor', 'subBg', 'subOpacity', 'subWeight', 'subPos',
    ];
    profiles = jest.spyOn(api, 'profiles').mockImplementation(async () => [profile({...server})]);
    update = jest.spyOn(api, 'updateProfile').mockImplementation(async (_id: string, fields: {prefs: Record<string, unknown>}) => {
      for (const [k, v] of Object.entries(fields.prefs)) if (storesKeys.includes(k)) server[k] = v;
      return profile({...server});
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test("first time on this box: the box's choice goes to a profile that has none, once", async () => {
    store.set('aurora.prefs', JSON.stringify({...PREFS_DEFAULTS, autoplayNext: false, usageStats: false, cueSize: 'L'}));
    enterPerson('p1');
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    // (the box's old subtitle size goes along, as the person's subSize)
    expect(update.mock.calls[0][1]).toEqual({prefs: {autoplayNext: false, usageStats: false, subSize: 'L'}});
    expect(server).toEqual({autoplayNext: false, usageStats: false, subSize: 'L'});
    expect(personNow()).toMatchObject({autoplayNext: false, usageStats: false});
    // and never again: the profile has them now
    await refreshPerson();
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('…but a profile that already chose keeps its choice, and this TV follows it', async () => {
    store.set('aurora.prefs', JSON.stringify({...PREFS_DEFAULTS, subLang: 'he', autoplayNext: false}));
    server = {subLang: 'ru', autoplayNext: true};
    enterPerson('p1');
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(personNow()).toMatchObject({subLang: 'ru', autoplayNext: true});
    // what every reader gets: the person's values over the box's
    const prefs = await loadPrefs();
    expect(prefs.subLang).toBe('ru');
    expect(prefs.autoplayNext).toBe(true);
  });

  test('a second person on the same box gets the same one-time move, not the first person’s settings', async () => {
    store.set('aurora.prefs', JSON.stringify({...PREFS_DEFAULTS, subLang: 'he'}));
    enterPerson('p1');
    await flush();
    setPersonPref('subLang', 'ru'); // p1 changes theirs
    await flush();
    leavePerson();
    profiles.mockImplementation(async () => [{id: 'p2', name: 'Kid', prefs: {}} as never]);
    update.mockImplementation(async () => ({id: 'p2', name: 'Kid', prefs: {subLang: 'he'}} as never));
    enterPerson('p2');
    await flush();
    expect(personNow()?.subLang).toBe('he'); // the box's old value, not p1's "ru"
    expect(update.mock.calls[update.mock.calls.length - 1]).toEqual(['p2', {prefs: {subLang: 'he'}}]);
  });

  test('a change made here is applied at once, written to the profile, and kept off the box-wide blob', async () => {
    enterPerson('p1');
    await flush();
    const seen: boolean[] = [];
    onPersonPrefs(p => seen.push(p.autoplayNext));
    setPersonPref('autoplayNext', false);
    expect(personNow()?.autoplayNext).toBe(false); // at once, before any answer
    await flush();
    expect(server).toEqual({autoplayNext: false});
    expect(seen).toEqual([false]);
    // a device-level save does not leak the person's value into the box's blob
    await savePrefs({...(await loadPrefs()), cueSize: 'L'});
    const blob = JSON.parse(store.get('aurora.prefs') as string);
    expect(blob.cueSize).toBe('L');
    expect(blob.autoplayNext).toBe(true); // the box's own (legacy) value, untouched
  });

  test('offline: the change holds on this TV and is delivered when the server is back', async () => {
    enterPerson('p1');
    await flush();
    profiles.mockRejectedValue(new Error('down'));
    update.mockRejectedValue(new Error('down'));
    setPersonPref('subsDefault', false);
    await flush();
    expect(personNow()?.subsDefault).toBe(false);
    expect(server).toEqual({});
    // a restart, still offline: remembered
    _personInternals.reset();
    enterPerson('p1');
    await flush();
    expect(personNow()?.subsDefault).toBe(false);
    // the server is back
    profiles.mockImplementation(async () => [profile({...server})]);
    update.mockImplementation(async (_id: string, fields: {prefs: Record<string, unknown>}) => {
      Object.assign(server, fields.prefs);
      return profile({...server});
    });
    await refreshPerson();
    await flush();
    expect(server).toEqual({subsDefault: false});
    expect(_personInternals.record()).toEqual({v: {subsDefault: false}, dirty: [], gen: 2});
  });

  test('an older server (stores the old keys only): the setting still works here and is not re-sent on every refresh', async () => {
    storesKeys = ['smartDownloads', 'smartCleanup', 'usageStats', 'subLang'];
    enterPerson('p1');
    await flush();
    setPersonPref('autoplayNext', false);
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(server).toEqual({}); // the server dropped it
    expect(personNow()?.autoplayNext).toBe(false); // this TV keeps it
    await refreshPerson();
    await flush();
    expect(update).toHaveBeenCalledTimes(2); // offered once more this run…
    await refreshPerson();
    await refreshPerson();
    await flush();
    expect(update).toHaveBeenCalledTimes(2); // …and then left alone
    expect(personNow()?.autoplayNext).toBe(false);
  });

  test('changed on another device: the next read brings it here and tells the listeners', async () => {
    enterPerson('p1');
    await flush();
    const seen: string[] = [];
    onPersonPrefs(p => seen.push(`${p.subLang}/${p.usageStats}`));
    server = {subLang: 'ru', usageStats: false}; // the website wrote these
    await refreshPerson(); // what `profile_updated`, a return to the front and opening Settings do
    expect(seen).toEqual(['ru/false']);
    expect((await loadPrefs()).usageStats).toBe(false);
    expect(update).not.toHaveBeenCalled();
    // nothing changed: nobody is told again
    await refreshPerson();
    expect(seen).toHaveLength(1);
  });

  test('leaving the profile (the registry every profile switch runs) takes its settings off', async () => {
    server = {autoplayNext: false};
    enterPerson('p1');
    await flush();
    expect((await loadPrefs()).autoplayNext).toBe(false);
    clearProfileCaches();
    expect(personNow()).toBeNull();
    expect((await loadPrefs()).autoplayNext).toBe(true); // the box's own again
  });
});

// ------------------------------------------------- player options (2026-10-19)
import {upgradeRecord, MOVE_GEN, styleOf} from '../../src/personPrefs';
import {
  cueBottomFor,
  cueLook,
  nextChoice,
  readStyle,
  styleFromDevice,
  styleLabel,
  SUB_STYLE_CHOICES,
  SUB_STYLE_DEFAULTS,
  SUB_STYLE_KEYS,
  CUE_PX,
  OUTLINE_OFFSETS,
} from '../../src/subStyle';
import {fxReason, AUDIO_FX_NAMES, AUDIO_FX_DEFAULTS} from '../../src/audioFx';

describe('player options: the person carries them', () => {
  test('night mode, dialogue boost and the six subtitle choices are read off a profile — only real values', () => {
    expect(
      readPerson({nightMode: true, dialogueBoost: 'yes', subSize: 'XL', subColor: 'pink', subBg: 'outline', subOpacity: 50, subWeight: 'normal', subPos: 'raised'}),
    ).toEqual({nightMode: true, subSize: 'XL', subBg: 'outline', subOpacity: 50, subWeight: 'normal', subPos: 'raised'});
    expect(readPerson({subOpacity: '50', subSize: 'xl'})).toEqual({});
    expect(styleOf({subColor: 'yellow'})).toEqual({...SUB_STYLE_DEFAULTS, subColor: 'yellow'});
  });

  test('THE MOVE, for a person this box already knew (a record from before): the old size and plate join them once', () => {
    const old = readRecord({v: {autoplayNext: false}, dirty: []})!; // gen 1
    const box = {...PREFS_DEFAULTS, cueSize: 'S', cueBackground: false};
    const up = upgradeRecord(old, box);
    expect(up).toEqual({v: {autoplayNext: false, subSize: 'S', subBg: 'shadow'}, dirty: [], gen: MOVE_GEN});
    // …once: an upgraded record is left alone, even if the box changes
    expect(upgradeRecord(up, {...box, cueSize: 'L'})).toBe(up);
    // what the person already has wins over the box
    const mine = readRecord({v: {subSize: 'XL'}, dirty: []})!;
    expect(upgradeRecord(mine, box).v).toEqual({subSize: 'XL', subBg: 'shadow'});
    // a box that never changed them offers nothing
    expect(upgradeRecord(old, {...PREFS_DEFAULTS}).v).toEqual({autoplayNext: false});
  });

  test('…and a profile that already has a look keeps it: the moved values are not sent over it', () => {
    const rec = upgradeRecord(readRecord({v: {}, dirty: []})!, {...PREFS_DEFAULTS, cueSize: 'L', cueBackground: false});
    const r = resolvePerson({subSize: 'M', subColor: 'yellow'}, rec);
    expect(r.effective).toMatchObject({subSize: 'M', subColor: 'yellow', subBg: 'shadow'});
    expect(r.push).toEqual({subBg: 'shadow'}); // the one thing the profile lacked
  });

  test('a look chosen on this TV is the person\'s: remembered, owed, and sent', () => {
    let rec = changePerson(emptyRecord(), 'subColor', 'cyan');
    rec = changePerson(rec, 'nightMode', true);
    const r = resolvePerson({subColor: 'white'}, rec);
    expect(r.effective).toMatchObject({subColor: 'cyan', nightMode: true});
    expect(r.push).toEqual({subColor: 'cyan', nightMode: true});
  });

  test('personSync: a record from before the update gets the box\'s old look, and offers it to the profile', async () => {
    store.clear();
    _personInternals.reset();
    const server: Record<string, unknown> = {};
    jest.spyOn(api, 'profiles').mockImplementation(async () => [profile({...server})]);
    const update = jest.spyOn(api, 'updateProfile').mockImplementation(async (_id: string, fields: {prefs: Record<string, unknown>}) => {
      Object.assign(server, fields.prefs);
      return profile({...server});
    });
    store.set('aurora.prefs', JSON.stringify({...PREFS_DEFAULTS, cueSize: 'L', cueBackground: false}));
    store.set('aurora.person.p1', JSON.stringify({v: {autoplayNext: false}, dirty: []})); // written by 5.3.0
    enterPerson('p1');
    await flush();
    expect(personNow()).toMatchObject({subSize: 'L', subBg: 'shadow', autoplayNext: false});
    expect(update).toHaveBeenCalled();
    expect(server).toMatchObject({subSize: 'L', subBg: 'shadow'});
    expect(JSON.parse(store.get('aurora.person.p1') as string).gen).toBe(MOVE_GEN);
    jest.restoreAllMocks();
  });
});

describe('the subtitle look (subStyle.ts)', () => {
  test('the table: four sizes, four colours, four backgrounds, four opacities, two weights, two positions', () => {
    expect(SUB_STYLE_KEYS).toEqual(['subSize', 'subColor', 'subBg', 'subOpacity', 'subWeight', 'subPos']);
    expect(SUB_STYLE_CHOICES.subSize).toEqual(['S', 'M', 'L', 'XL']);
    expect(SUB_STYLE_CHOICES.subBg).toEqual(['none', 'shadow', 'outline', 'box']);
    expect(Object.keys(CUE_PX)).toEqual(['S', 'M', 'L', 'XL']);
    expect(CUE_PX.XL).toBeGreaterThan(CUE_PX.L);
  });

  test('a press steps through the choices and wraps', () => {
    expect(nextChoice('subSize', 'XL')).toBe('S');
    expect(nextChoice('subBg', 'box')).toBe('none');
    expect(nextChoice('subOpacity', 75)).toBe(100);
    expect(styleLabel('subOpacity', {subOpacity: 25})).toBe('25%');
    expect(styleLabel('subColor', {})).toBe('White');
  });

  test('what each background draws', () => {
    expect(cueLook({subBg: 'box', subOpacity: 50})).toMatchObject({backgroundColor: 'rgba(0,0,0,0.5)', shadow: false, outline: false});
    expect(cueLook({subBg: 'shadow'})).toMatchObject({backgroundColor: undefined, shadow: true, outline: false});
    expect(cueLook({subBg: 'outline'})).toMatchObject({backgroundColor: undefined, shadow: false, outline: true});
    expect(cueLook({subBg: 'none'})).toMatchObject({backgroundColor: undefined, shadow: false, outline: false});
    expect(cueLook({subColor: 'yellow', subWeight: 'normal'})).toMatchObject({color: '#ffe14d', fontWeight: '400'});
    expect(OUTLINE_OFFSETS).toHaveLength(8);
  });

  test("the box's old choices: the TV's old 'off' was a shadow, the site's bare text", () => {
    expect(styleFromDevice({cueSize: 'M', cueBackground: true})).toEqual({});
    expect(styleFromDevice({cueSize: 'S', cueBackground: false}, 'tv')).toEqual({subSize: 'S', subBg: 'shadow'});
    expect(styleFromDevice({cueBackground: false}, 'web')).toEqual({subBg: 'none'});
    expect(readStyle({subSize: 'huge'})).toEqual(SUB_STYLE_DEFAULTS);
  });

  test('raised: at least a fifth of the screen up — and the lift above the bar still wins when it is higher', () => {
    expect(cueBottomFor('lower', 48, 540)).toBe(48);
    expect(cueBottomFor('raised', 48, 540)).toBe(108);
    expect(cueBottomFor('raised', 150, 540)).toBe(150); // the bar is up: above it, as before
  });
});

describe('night mode and dialogue boost (audioFx.ts)', () => {
  test('the names and the defaults are the site\'s', () => {
    expect(AUDIO_FX_NAMES).toEqual({nightMode: 'Night mode', dialogueBoost: 'Dialogue boost'});
    expect(AUDIO_FX_DEFAULTS).toEqual({nightMode: false, dialogueBoost: false});
  });

  test('when they cannot apply, one line says why', () => {
    const ok = {supported: true, sdk: 30, passthrough: false, offload: false, channels: 2, active: true, error: null};
    expect(fxReason(ok)).toBeNull();
    expect(fxReason({...ok, passthrough: true})).toMatch(/passthrough/);
    expect(fxReason({...ok, offload: true})).toMatch(/audio path/);
    expect(fxReason({...ok, sdk: 26, supported: false})).toBe('Needs Android 9 or later.');
    expect(fxReason({...ok, supported: false, error: 'RuntimeException'})).toMatch(/doesn't allow/);
    expect(fxReason(null)).toMatch(/can't change the sound/);
  });
});
