// What is held in memory for ONE PROFILE is emptied when the profile is left
// (src/profileScope.ts) — and nothing new can be added without saying whose
// it is.
//
// The second half is this file's table. Every variable a module of the app
// keeps at module scope and can change (a `let`, a Map, a Set, an array or an
// object that starts empty) is listed below as one of:
//   PROFILE  it holds something that belongs to the active profile — its
//            module must register a function that drops it
//            (registerProfileCache), which every profile change then runs;
//   DEVICE   it belongs to the box or to the run (a timer, the socket, a
//            picture cache keyed by address…), with the reason.
// A variable that is in the source and not in the table FAILS the test: the
// request cache was keyed by path alone and outlived a profile switch for a
// year because nobody had to ask "whose is this?" when adding it (audit X7).
// (node's own modules, without @types/node)
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');

// file (relative to src/) → the variables in it that belong to the profile
const PROFILE: Record<string, string[]> = {
  'api.ts': ['homeKept', 'memoStore'],
  'artPrefetch.ts': ['wants', 'queue', 'timer'],
  'homeScreen.ts': ['lastNext', 'lastChannel', 'lastConfig', 'lastRows', 'lastProfile', 'lastJobs'],
  'navSection.ts': ['cache', 'cacheAt', 'loading'],
  'party.ts': ['pending'],
  'personSync.ts': ['active', 'asking', 'entering'],
  'prefetch.ts': ['profileId', 'idleTimer', 'idleRest', 'warmedSections', 'dwell'],
  'realtime.ts': ['identity', 'lastActivity'],
  'screens/Pick.tsx': ['last'],
  'trailers.ts': ['resolved', 'prepared'],
  'usage.ts': ['queue', 'profile', 'errors'],
};

// file → variable → why it is NOT a profile's
const DEVICE: Record<string, Record<string, string>> = {
  'api.ts': {
    baseUrl: 'which server',
    token: 'a credential: App.tsx sets and clears it around every profile change',
    session: 'a credential: App.tsx sets and clears it',
    activeProfile: 'the profile itself: App.tsx sets and clears it',
    authMode: 'what the server said about itself',
    signinRequiredCb: "the app's one handler",
    signinFiredAt: 'a debounce stamp',
    resetRequiredCb: "the app's one handler",
    resetFiredAt: 'a debounce stamp',
    pinged: 'what each server address said about itself',
    serverArtHosts: 'what the server said about itself',
    serverBlurs: 'what the server said about itself',
    PROXY_ART_HOSTS: 'a fixed list',
  },
  'artPrefetch.ts': {
    native: 'the native module',
    busy: 'pictures in flight, by address',
    flying: 'a count of requests in flight',
    asked: 'pictures already asked for, by address — a picture is the box’s',
    batch: 'a log counter',
    askedAt: 'a debounce stamp',
  },
  'blur.ts': {
    map: 'placeholders keyed by picture address; the server gates the pictures themselves',
    drawn: 'which pictures this run has drawn, by address',
  },
  'components/Focusable.tsx': {nextId: 'an id counter', ringRegistry: 'mounted focus rings', litRing: 'which ring is lit'},
  'errors.ts': {ring: 'the last errors of this run, for a report', playing: 'set and cleared by the player while it is mounted'},
  'focus.ts': {
    held: 'focus engine',
    heldEdgeLeft: 'focus engine',
    heldEdgeRight: 'focus engine',
    lastFocusMoveAt: 'focus engine',
    seq: 'focus engine',
    pressMoveSeq: 'focus engine',
    keySeq: 'focus engine',
    prevKeySeq: 'focus engine',
    lastKeyEvt: 'focus engine',
    lastKeyAt: 'focus engine',
    ownMoveUntil: 'focus engine',
    fallbacks: 'focus engine (mounted fallbacks)',
    checking: 'focus engine',
    railOpenCount: 'the rail',
    railOpenFns: 'the rail',
    railCloseFns: 'the rail',
    railOpener: 'the rail',
    traps: 'focus engine',
    lastDown: 'key timing',
  },
  'homeScreen.ts': {noticesOn: 'a device-level setting (this TV’s notifications)', initialTaken: 'the launch link, read once a run'},
  'navLock.ts': {lastNav: 'a debounce stamp'},
  'navSection.ts': {newSeen: 'which release this TV has seen', newSubs: 'listeners'},
  'overlay.ts': {current: 'the open sheet (unmounts with the navigator)', subs: 'listeners'},
  'perfTier.ts': {
    lite: 'what this box can do',
    measuring: 'frame monitor',
    lowRamWhy: 'what this box can do',
    perfSent: 'frame monitor',
    perfTimer: 'frame monitor',
    homeWatch: 'frame monitor',
    homeJudged: 'frame monitor',
    pending: 'frame monitor',
    started: 'frame monitor',
  },
  'personSync.ts': {
    offered: 'keyed by profile id: what was already offered to each profile this run',
    subs: 'listeners',
    onProfileRead: 'a callback set once by SessionWiring',
  },
  'profileScope.ts': {clearers: 'the registry itself'},
  'routeTiming.ts': {cur: 'the visit being timed (a usage event; the queue it goes to is the profile’s)', early: 'the same'},
  'realtime.ts': {
    listeners: 'listeners',
    ws: 'the socket: SessionWiring disconnects it when the profile is left',
    wanted: 'the socket',
    halted: 'the socket',
    delay: 'the socket',
    timer: 'the socket',
  },
  'settle.ts': {waiting: 'the at-rest clock', moveFns: 'the at-rest clock', lastMove: 'the at-rest clock', timer: 'the at-rest clock', timerDue: 'the at-rest clock'},
  'storage.ts': {
    person: 'the active person’s settings: personSync.ts owns it and clears it (its own registration)',
    personReady: 'the same',
    updateDismissed: 'which update this TV said "Later" to',
  },
  'toast.ts': {list: 'toasts on screen', nextId: 'an id counter', subs: 'listeners'},
  'trailers.ts': {failedAt: 'what failed on this network', appleFailed: 'what failed on this network'},
  'update.ts': {
    quietPath: 'the app update',
    quietFor: 'the app update',
    quietFetching: 'the app update',
    quietArmed: 'the app update',
    readyInfo: 'the app update',
    readyHandler: 'the app update',
  },
  'usage.ts': {timer: 'the flush timer', enabledFlag: 'follows the active person’s setting (SessionWiring sets it on every entry)'},
};

// A module-scope declaration that can hold state: `let x`, or a const that is
// a Map / Set / WeakMap, or an array or object that starts empty.
const DECL = /^(?:export )?(?:let (\w+)|const (\w+)(?:: [^=\n]+)? = (?:new (?:Map|Set|WeakMap)[<(]|\[\];?\s*(?:\/\/.*)?$|\{\};?\s*(?:\/\/.*)?$))/gm;

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap((e: {name: string; isDirectory: () => boolean}) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'assets' ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

const found: Record<string, string[]> = {};
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const text: string = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const names: string[] = [];
  for (const m of text.matchAll(DECL)) names.push(m[1] || m[2]);
  if (names.length) found[rel] = names;
}

test('every module-scope variable is listed as a profile’s or the box’s', () => {
  const unlisted: string[] = [];
  for (const [file, names] of Object.entries(found)) {
    for (const n of names) {
      const listed = (PROFILE[file] || []).includes(n) || Object.prototype.hasOwnProperty.call(DEVICE[file] || {}, n);
      if (!listed) unlisted.push(`${file}: ${n}`);
    }
  }
  // A failure here means: you added module-scope state. Decide whose it is.
  // If it holds anything read or decided AS the active profile, add it to
  // PROFILE above and drop it in that module's registerProfileCache(); if it
  // is the box's, add it to DEVICE with the reason.
  expect(unlisted).toEqual([]);
});

test('the table names nothing that is no longer there', () => {
  const gone: string[] = [];
  for (const [file, names] of Object.entries(PROFILE)) for (const n of names) if (!(found[file] || []).includes(n)) gone.push(`${file}: ${n}`);
  for (const [file, names] of Object.entries(DEVICE)) for (const n of Object.keys(names)) if (!(found[file] || []).includes(n)) gone.push(`${file}: ${n}`);
  expect(gone).toEqual([]);
});

test('every module that holds a profile’s state registers a function that drops it — and names each variable in it', () => {
  for (const [file, names] of Object.entries(PROFILE)) {
    const text: string = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
    const at = text.indexOf('registerProfileCache(');
    expect({file, registers: at >= 0}).toEqual({file, registers: true});
    // the registration, and any function of this module it hands the work to
    const reg = text.slice(at, text.indexOf('\n});', at) >= 0 && text.indexOf('\n});', at) - at < 600 ? text.indexOf('\n});', at) : at + 200);
    const helpers = [...reg.matchAll(/\b([a-zA-Z]\w+)\s*(?:\(|\)|;|,)/g)].map(m => m[1]);
    let body = reg;
    for (const h of new Set(helpers)) {
      const def = new RegExp(`(?:export )?(?:const ${h} = |function ${h}\\()[\\s\\S]*?\\n\\}`, 'm').exec(text);
      if (def) body += def[0];
    }
    for (const n of names) expect({file, variable: n, dropped: new RegExp(`\\b${n}\\b`).test(body)}).toEqual({file, variable: n, dropped: true});
  }
});

// ------------------------------------------------------------ and it works
import {api, setActiveProfile, setBaseUrl, _memoInternals} from '../../src/api';
import {clearProfileCaches, registeredProfileCaches} from '../../src/profileScope';
import '../../src/prefetch';
import '../../src/trailers';
import '../../src/usage';
import '../../src/party';
import '../../src/personSync';
import {queue, sent, resetXhr} from './fake-xhr';

const ok = (body: unknown) => ({status: 200, body: JSON.stringify(body)});

describe('the request cache', () => {
  beforeEach(() => {
    resetXhr();
    _memoInternals.clear();
    setBaseUrl('http://tv.test');
  });

  test('a list read as one profile is never answered to another (a kids profile within the minute)', async () => {
    setActiveProfile('grownup');
    queue(ok({movies: [{id: 'm18', title: 'Not for kids'}], shows: []}));
    const a = await api.library();
    expect(a.movies).toHaveLength(1);
    // the switch — even if nothing had emptied the store
    setActiveProfile('kid');
    queue(ok({movies: [], shows: []}));
    const b = await api.library();
    expect(b.movies).toHaveLength(0);
    expect(sent).toHaveLength(2);
    // and the kid's own answer is theirs to keep
    await api.library();
    expect(sent).toHaveLength(2);
  });

  test('a profile change empties it: the library list, the first catalogue page, Home’s kept rows', async () => {
    setActiveProfile('grownup');
    queue(ok({movies: [], shows: []}), ok({items: [], page: 0, hasMore: false}), {status: 200, body: JSON.stringify({rows: []}), etag: 'W/"1"'});
    await api.library();
    await api.catalog({type: 'movie', category: 'trending', page: 0});
    await api.home('grownup');
    expect(_memoInternals.keys().length).toBe(2);
    clearProfileCaches();
    expect(_memoInternals.keys()).toEqual([]);
    // Home is asked plainly again — no "If-None-Match" from the last profile's copy
    queue({status: 200, body: JSON.stringify({rows: []}), etag: 'W/"1"'});
    await api.home('grownup');
    expect(sent[sent.length - 1].headers['If-None-Match']).toBeUndefined();
  });
});

test('the modules that hold a profile’s state are all in the registry once loaded', () => {
  for (const name of ['api', 'prefetch', 'trailers', 'usage', 'party', 'personSync', 'realtime']) {
    expect(registeredProfileCaches()).toContain(name);
  }
});

test('one module failing to clear does not stop the others', () => {
  const {registerProfileCache} = require('../../src/profileScope');
  let ran = false;
  registerProfileCache('zz-throws', () => {
    throw new Error('boom');
  });
  registerProfileCache('zz-after', () => {
    ran = true;
  });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  clearProfileCaches();
  log.mockRestore();
  expect(ran).toBe(true);
});
