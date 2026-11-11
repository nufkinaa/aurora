// "Save it to this device as soon as it is on the server" on the phone (docs/offline-wishes.md):
// the rules (src/phone/offline/wishRules.ts) and the profile-switch guard of the store
// (src/phone/offline/wishes.ts) — the next profile's wishes are never read during a switch,
// and an answer for the last profile that lands after it is thrown away.
import type {OfflineWish} from '../../src/api';
import {scopeChoices, wishBody, wishFor, wishLead, wishLook, wishMadeText, wishMessage, wishName, wishOn, wishesToSave} from '../../src/phone/offline/wishRules';
import {noLink, awayWords} from '../../src/phone/offline/reach';

const W = (o: Partial<OfflineWish>): OfflineWish => ({id: 'w1', deviceId: 'tv-dev', scope: 'title', type: 'movie', imdbId: 'tt1', quality: '720', state: 'waiting', ...o});

describe('which wish covers a title', () => {
  const list = [
    W({id: 'film', imdbId: 'tt1'}),
    W({id: 'ep', type: 'show', imdbId: 'tt2', season: 2, episode: 5}),
    W({id: 'season', type: 'show', imdbId: 'tt3', scope: 'season', season: 1}),
    W({id: 'show', type: 'show', imdbId: 'tt4', scope: 'show', season: null}),
    W({id: 'child', type: 'show', imdbId: 'tt3', season: 1, episode: 2, parentId: 'season', state: 'ready'}),
  ];
  test('a film, an episode, a season, a whole show', () => {
    expect(wishFor(list, {type: 'movie', imdbId: 'tt1'})?.id).toBe('film');
    expect(wishFor(list, {type: 'show', imdbId: 'tt2', season: 2, episode: 5})?.id).toBe('ep');
    expect(wishFor(list, {type: 'show', imdbId: 'tt2', season: 2, episode: 6})).toBeNull();
    expect(wishFor(list, {type: 'show', imdbId: 'tt3', season: 1, episode: 9})?.id).toBe('season');
    expect(wishFor(list, {type: 'show', imdbId: 'tt4', season: 7, episode: 1})?.id).toBe('show');
    expect(wishFor(list, {type: 'movie', imdbId: ''})).toBeNull();
  });
  test('a failed one is offered again', () => {
    expect(wishOn(W({state: 'failed'}))).toBe(false);
    expect(wishOn(W({}))).toBe(true);
    expect(wishOn(null)).toBe(false);
  });
});

describe('the body the server takes', () => {
  const dev = {id: 'tv-abc12345', name: 'Pixel 9'};
  test('an episode, a season, a show', () => {
    expect(wishBody({type: 'show', imdbId: 'tt2', season: 2, episode: 5, title: 'Ep', showTitle: 'Show', jobId: 'j1'}, '720', dev, true)).toEqual({
      deviceId: 'tv-abc12345', deviceName: 'Pixel 9', scope: 'title', type: 'show', imdbId: 'tt2', jobId: 'j1', season: 2, episode: 5, title: 'Ep', showTitle: 'Show', quality: '720', hevc: true,
    });
    const season = wishBody({type: 'show', imdbId: 'tt2', scope: 'season', season: 2, episode: 5}, '480', dev, false);
    expect(season.scope).toBe('season');
    expect(season).not.toHaveProperty('episode');
    const show = wishBody({type: 'show', imdbId: 'tt2', scope: 'show', season: 2, episode: 5}, '480', dev, false);
    expect(show).not.toHaveProperty('season');
    expect(show).not.toHaveProperty('episode');
  });
});

describe('the words (the website’s)', () => {
  test('rows', () => {
    expect(wishLook(W({}))).toEqual({tone: 'wait', head: "Waiting for the server's copy", line: 'It is saved here by itself when it arrives'});
    expect(wishLook(W({scope: 'season', season: 2})).head).toBe('Every new episode of season 2');
    expect(wishLook(W({scope: 'show'}))).toEqual({tone: 'wait', head: 'Every new episode', line: "Waiting for the server's copy — each one is saved here by itself as it arrives"});
    expect(wishLook(W({state: 'failed', error: 'The download was cancelled — there is nothing to save.'}))).toEqual({tone: 'bad', head: "Won't arrive", line: 'The download was cancelled — there is nothing to save.'});
    expect(wishLook(W({state: 'ready', copy: {state: 'working'}, note: null})).head).toBe('Arrived — the server is preparing it');
    expect(wishLook(W({state: 'ready', copy: {state: 'ready'}})).head).toBe('Arrived — saving here next');
  });
  test('names', () => {
    expect(wishName(W({title: 'Film'}))).toBe('Film');
    expect(wishName(W({type: 'show', showTitle: 'Show', season: 2, episode: 5}))).toBe('Show · S2 E5');
    expect(wishName(W({type: 'show', scope: 'season', showTitle: 'Show', season: 2}))).toBe('Show · S2');
    expect(wishName(W({type: 'show', scope: 'show', showTitle: 'Show'}))).toBe('Show');
  });
  test('the sheet and the toast', () => {
    expect(wishLead({type: 'movie', imdbId: 'tt1'}, 'Film')).toMatch(/^“Film” isn't on the server yet\. It will be saved inside Aurora on this device as soon as it arrives/);
    expect(wishMadeText({type: 'show', imdbId: 'tt1', scope: 'season', season: 3}, 'x')).toBe('Every new episode of season 3 will be saved to this device as it arrives');
    expect(wishMadeText({type: 'movie', imdbId: 'tt1'}, 'Film')).toBe('“Film” will be saved to this device when it arrives');
    expect(scopeChoices({type: 'show', imdbId: 'tt1', season: 3, episode: 1}).map(c => c.label)).toEqual(['And every new episode of season 3', 'And every new episode of this show']);
    expect(scopeChoices({type: 'movie', imdbId: 'tt1'})).toEqual([]);
  });
});

describe('acting on them', () => {
  test('ready ones with a library item, not on their way here, not being saved', () => {
    const list = [W({id: 'a', state: 'ready', libraryId: 'L1'}), W({id: 'b', state: 'ready', libraryId: 'L2'}), W({id: 'c', state: 'waiting'}), W({id: 'd', state: 'ready', libraryId: null}), W({id: 'e', state: 'ready', libraryId: 'L3'})];
    const here = (id: string) => (id === 'L2' ? ('moving' as const) : null);
    expect(wishesToSave(list, here, new Set(['e'])).map(w => w.id)).toEqual(['a']);
  });
  test('the socket: only this device’s', () => {
    const w = W({deviceId: 'me'});
    expect(wishMessage({type: 'offline_wish', wish: w}, 'me')).toEqual({kind: 'upsert', wish: w});
    expect(wishMessage({type: 'offline_wish', wish: W({deviceId: 'other'})}, 'me')).toBeNull();
    expect(wishMessage({type: 'offline_wish_removed', id: 'x', deviceId: 'me'}, 'me')).toEqual({kind: 'remove', id: 'x'});
    expect(wishMessage({type: 'offline_wish_removed', id: 'x', deviceId: 'other'}, 'me')).toBeNull();
    expect(wishMessage(null, 'me')).toBeNull();
  });
});

describe('a profile switch never reads the next profile’s wishes before it is in', () => {
  // the store, with the server and the device stubbed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const apiMod = require('../../src/api');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const identity = require('../../src/remote/identity');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const scope = require('../../src/profileScope');
  let asked: string[] = [];
  let hold: ((v: {wishes: OfflineWish[]}) => void) | null = null;
  beforeAll(() => {
    identity.loadDevice = async () => ({id: 'tv-me000001', name: 'Phone'});
  });
  beforeEach(() => {
    asked = [];
    hold = null;
    apiMod.api.offlineWishes = (pid: string) => {
      asked.push(pid);
      return new Promise(r => (hold = r));
    };
  });
  test('no profile in (the wall, mid-switch): nothing is asked', async () => {
    const w = require('../../src/phone/offline/wishes');
    apiMod.setActiveProfile('p1');
    expect(await w.syncWishes()).toBe(0); // not armed yet
    expect(asked).toEqual([]);
  });
  test('an answer for the last profile that lands after the switch is dropped', async () => {
    const w = require('../../src/phone/offline/wishes');
    apiMod.setActiveProfile('p1');
    const stop = w.armWishes('p1');
    await new Promise<void>(r => setTimeout(r, 0));
    expect(asked).toEqual(['p1']);
    // the switch: the profile's caches go (AppRoot's clearProfileCaches), the screens unmount
    scope.clearProfileCaches();
    stop();
    apiMod.setActiveProfile(null);
    hold!({wishes: [W({id: 'p1-wish', deviceId: 'tv-me000001', profileId: 'p1'})]});
    await new Promise<void>(r => setTimeout(r, 0));
    expect(w.listWishes()).toEqual([]);
    // the next profile, once it is in
    apiMod.setActiveProfile('p2');
    const stop2 = w.armWishes('p2');
    await new Promise<void>(r => setTimeout(r, 0));
    expect(asked).toEqual(['p1', 'p2']);
    hold!({wishes: [W({id: 'p2-wish', deviceId: 'tv-me000001', profileId: 'p2'})]});
    await new Promise<void>(r => setTimeout(r, 10));
    expect(w.listWishes().map((x: OfflineWish) => x.id)).toEqual(['p2-wish']);
    stop2();
  });
});

describe('no connection: the calm line', () => {
  test('only after a few seconds closed; a reconnect never flashes it', () => {
    expect(noLink(0, 1000, 2000, false)).toBe(false);
    expect(noLink(0, 1000, 5000, false)).toBe(true);
    expect(noLink(4000, 1000, 6000, false)).toBe(false);
    expect(noLink(0, 1000, 9000, true)).toBe(false);
  });
  test('the words', () => {
    expect(awayWords('line')).toBe('No connection');
    expect(awayWords('server')).toBe("Can't reach Aurora");
  });
});
