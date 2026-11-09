// Franchise order on the TV and the phone (src/franchiseRules.ts): the action
// each entry of the franchise page offers, the title page's `save` press, and
// the end card of a film — when it counts down, which buttons, its words, and
// when it is asked for, shown and taken back.
import {
  autoSaveStep,
  AutoSaveFacts,
  endWindow,
  entryAction,
  entryArt,
  entryItem,
  entryNumber,
  entryStateWord,
  entryTags,
  firstFocusIndex,
  franchiseEndStep,
  FR_WORDS,
  isImdbId,
  nextLine,
  planFranchiseEnd,
  readFranchiseNext,
  showOrderSwitch,
} from '../../src/franchiseRules';
import {AUTO_PLAY_GIVE_UP_MS} from '../../src/playBest';
import {STILL_WATCHING_AFTER, UPNEXT_COUNTDOWN_SEC} from '../../src/playerRules';
import type {FranchiseEntry, FranchiseNext} from '../../src/api';

declare const __dirname: string;

const entry = (o: Partial<FranchiseEntry> = {}): FranchiseEntry => ({
  imdbId: 'tt0800369',
  type: 'movie',
  title: 'Thor',
  year: 2011,
  poster: 'https://img/thor.jpg',
  cover: null,
  optional: false,
  onServer: null,
  position: 4,
  state: null,
  ...o,
});
const next = (o: Partial<FranchiseEntry> = {}): FranchiseNext => ({
  franchise: {id: 'mcu', name: 'Marvel Cinematic Universe', the: true},
  kicker: 'Next in the Marvel Cinematic Universe',
  order: 'release',
  position: 4,
  total: 34,
  entry: entry(o),
});
const end = (n: FranchiseNext, o: Partial<{autoplayPref: boolean; inParty: boolean; guest: boolean; autoRun: number}> = {}) =>
  planFranchiseEnd({next: n, autoplayPref: true, inParty: false, guest: false, autoRun: 0, ...o});

describe('the franchise page: one action per entry', () => {
  test('on the server: Play for a film, Open for a show', () => {
    expect(entryAction(entry({onServer: {id: 'lib1', type: 'movie'}}))).toEqual({kind: 'play', label: 'Play'});
    expect(entryAction(entry({type: 'show', onServer: {id: 'lib2', type: 'show'}}))).toEqual({kind: 'open', label: 'Open'});
  });
  test('not on the server: Save & watch for a film, Choose episode for a show', () => {
    expect(entryAction(entry())).toEqual({kind: 'save', label: 'Save & watch'});
    expect(entryAction(entry({type: 'show'}))).toEqual({kind: 'choose', label: 'Choose episode'});
  });
  test('tags, state words and the number', () => {
    expect(entryTags(entry())).toEqual([]);
    expect(entryTags(entry({optional: true, type: 'show'}))).toEqual(['Optional', 'Series']);
    expect(entryStateWord(entry({state: 'watched'}))).toBe('Watched');
    expect(entryStateWord(entry({state: 'started'}))).toBe('Started');
    expect(entryStateWord(entry({state: null}))).toBeNull();
    expect(entryNumber(entry({position: 12}))).toBe('12');
    expect(entryNumber(entry({position: null, optional: true}))).toBeNull();
  });
  test('the entry as the card its title page opens', () => {
    const lib = entryItem(entry({onServer: {id: 'lib1', type: 'movie'}}));
    expect(lib).toMatchObject({id: 'lib1', type: 'movie', imdbId: 'tt0800369', title: 'Thor'});
    expect(lib.source).toBeUndefined(); // a library card: Detail reads /api/item
    const st = entryItem(entry({type: 'show'}));
    expect(st).toMatchObject({id: '', type: 'show', source: 'stream', imdbId: 'tt0800369'});
  });
  test("the entry's picture: the household's cover first, as the website draws it", () => {
    // a film on the server: its library cover (franchise.js `e.cover || e.poster`), not the catalogue poster
    const owned = entry({onServer: {id: 'lib1', type: 'movie'}, cover: '/img/abc123', poster: 'https://images.metahub.space/poster/small/tt0800369/img'});
    expect(entryArt(owned)).toBe('/img/abc123');
    expect(entryItem(owned).cover).toBe('/img/abc123');
    // not on the server: the server sends the poster as the cover too; either way the poster
    expect(entryArt(entry({cover: null}))).toBe('https://img/thor.jpg');
    expect(entryArt(entry({cover: null, poster: null}))).toBeNull();
  });
  test('both franchise pages draw entryArt and read again on return (the TV and the phone)', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['../../src/screens/Franchise.tsx', '../../src/phone/screens/Franchise.tsx']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      expect(src).toContain('artSrc(entryArt(e), THUMB_W)');
      expect(src).not.toMatch(/e\.poster \|\| e\.cover/);
      // read again on every return to the page (a film played from it is Started / Watched
      // when Back lands here), as the website does; a failed re-read keeps the page
      expect(src).toContain('if (!isFocused) return;');
      expect(src).toMatch(/\}, \[id, profileId, want, reload, isFocused\]\);/);
      expect(src).toContain('if (!have.current) setError(FR_WORDS.loadError);');
    }
  });
  test('focus starts on the first main entry not watched', () => {
    expect(firstFocusIndex([{state: 'watched', optional: false}, {state: null, optional: true}, {state: 'started', optional: false}])).toBe(2);
    expect(firstFocusIndex([{state: 'watched', optional: false}])).toBe(0);
    expect(firstFocusIndex([])).toBe(0);
  });
  test('the order switch only when there is a choice', () => {
    expect(showOrderSwitch([{id: 'release'}])).toBe(false);
    expect(showOrderSwitch([{id: 'release'}, {id: 'story'}])).toBe(true);
    expect(showOrderSwitch(null)).toBe(false);
  });
  test('the website words', () => {
    expect(FR_WORDS.action).toBe('Watch in order');
    expect(FR_WORDS.row).toBe('Continue the franchise');
    expect(FR_WORDS.loadError).toBe("Couldn't load this franchise right now.");
    expect(isImdbId('tt0800369')).toBe(true);
    expect(isImdbId('lib-123')).toBe(false);
    expect(isImdbId(null)).toBe(false);
  });
});

describe('the title page presses Save & watch once (`save`)', () => {
  const ready: AutoSaveFacts = {save: true, type: 'movie', torrentsKnown: true, torrentsOff: false, libraryKnown: true, owned: false, jobsKnown: true, onItsWay: false, best: true, elapsed: 1000};
  test('presses once everything is known and there is a best source', () => {
    expect(autoSaveStep(ready)).toBe('press');
  });
  test('waits while anything is unknown, then gives up', () => {
    expect(autoSaveStep({...ready, best: null})).toBe('wait');
    expect(autoSaveStep({...ready, jobsKnown: false})).toBe('wait');
    expect(autoSaveStep({...ready, libraryKnown: false})).toBe('wait');
    expect(autoSaveStep({...ready, torrentsKnown: false})).toBe('wait');
    expect(autoSaveStep({...ready, best: null, elapsed: AUTO_PLAY_GIVE_UP_MS})).toBe('drop');
  });
  test('never for anything else: no param, a show, on disk, on its way, no best source, torrents off', () => {
    expect(autoSaveStep({...ready, save: false})).toBe('drop');
    expect(autoSaveStep({...ready, type: 'show'})).toBe('drop');
    expect(autoSaveStep({...ready, owned: true})).toBe('drop');
    expect(autoSaveStep({...ready, onItsWay: true})).toBe('drop');
    expect(autoSaveStep({...ready, best: false})).toBe('drop');
    expect(autoSaveStep({...ready, torrentsOff: true})).toBe('drop');
  });
});

describe('the end of a film', () => {
  const lib = {onServer: {id: 'lib9', type: 'movie' as const}};
  test('the line and the kicker are the server words', () => {
    const p = end(next(lib));
    expect(p.kicker).toBe('Next in the Marvel Cinematic Universe');
    expect(p.line).toBe('Thor · 4 of 34');
    expect(nextLine({position: 12, total: 34, entry: {title: 'Iron Man 3'}})).toBe('Iron Man 3 · 12 of 34');
  });
  test('a countdown only for a film on the server, autoplay on, not a guest', () => {
    expect(end(next(lib))).toMatchObject({primary: 'play', primaryLabel: 'Play now', countdown: UPNEXT_COUNTDOWN_SEC});
    expect(end(next(lib), {autoplayPref: false}).countdown).toBeNull();
    expect(end(next(lib), {inParty: true, guest: true}).countdown).toBeNull();
    // a party's host keeps the countdown
    expect(end(next(lib), {inParty: true, guest: false}).countdown).toBe(UPNEXT_COUNTDOWN_SEC);
  });
  test('"Still watching?": after the run, nothing starts by itself (never counted in a party)', () => {
    expect(end(next(lib), {autoRun: STILL_WATCHING_AFTER}).countdown).toBeNull();
    expect(end(next(lib), {autoRun: STILL_WATCHING_AFTER - 1}).countdown).toBe(UPNEXT_COUNTDOWN_SEC);
    expect(end(next(lib), {autoRun: STILL_WATCHING_AFTER, inParty: true}).countdown).toBe(UPNEXT_COUNTDOWN_SEC);
  });
  test('not on the server: Save & watch, no countdown', () => {
    expect(end(next())).toMatchObject({primary: 'save', primaryLabel: 'Save & watch', countdown: null});
  });
  test('a show next: its title page, no countdown', () => {
    expect(end(next({type: 'show'}))).toMatchObject({primary: 'choose', primaryLabel: 'Choose episode', countdown: null});
    expect(end(next({type: 'show', onServer: {id: 's1', type: 'show'}}))).toMatchObject({primary: 'open', primaryLabel: 'Open', countdown: null});

  });
  test('the answer read: a usable next or null', () => {
    expect(readFranchiseNext({next: next()})).toMatchObject({position: 4, total: 34});
    expect(readFranchiseNext({next: null})).toBeNull();
    expect(readFranchiseNext(null)).toBeNull();
    expect(readFranchiseNext({next: {kicker: 'x', position: 1, total: 2}})).toBeNull(); // no entry
    expect(readFranchiseNext({error: 'nope'})).toBeNull();
  });

  describe('asked, shown and taken back (Up next moment)', () => {
    const D = 7200; // a two-hour film: the window is Up next's 90 s cap
    const W = endWindow(D, null);
    const at = (content: number, o: Partial<{asked: boolean; shown: boolean; paused: boolean; creditsStart: number | null}> = {}) =>
      franchiseEndStep({content, duration: D, creditsStart: null, asked: false, shown: false, paused: false, ...o});
    test('the window is the credits when known, else the runtime-scaled one', () => {
      expect(W).toBe(90);
      expect(endWindow(D, 6600)).toBe(600);
      expect(endWindow(D, D - 2)).toBe(90); // credits in the last 5 s: not believed
    });
    test('asks once, a minute before the window', () => {
      expect(at(D - W - 120)).toBe('hold');
      expect(at(D - W - 30)).toBe('ask');
      expect(at(D - W - 30, {asked: true})).toBe('hold');
    });
    test('shows in the window — not while paused', () => {
      expect(at(D - W + 1, {asked: true})).toBe('show');
      expect(at(D - W + 1, {asked: true, paused: true})).toBe('hold');
    });
    test('seeking back out of the window by more than 15 s retracts it', () => {
      expect(at(D - W - 10, {asked: true, shown: true})).toBe('hold');
      expect(at(D - W - 20, {asked: true, shown: true})).toBe('retract');
    });
    test('nothing before the film plays or without a length', () => {
      expect(franchiseEndStep({content: 0, duration: D, creditsStart: null, asked: false, shown: false, paused: false})).toBe('hold');
      expect(franchiseEndStep({content: 100, duration: 0, creditsStart: null, asked: false, shown: false, paused: false})).toBe('hold');
    });
  });
});

// The server's control list (src/lib/tel/controls-vocab.js) is held to the ids
// written on `uiId` lines (test/tel-contract.test.js): TV = src/ but phone/,
// phone = src/phone + src/playback. Each franchise id is where it must be.
describe('the analytics ids are written where the controls are', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '../../src');
  const tagged = (files: string[]) => {
    const ids = new Set<string>();
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/)) {
        if (!/uiId/.test(line)) continue;
        for (const m of line.matchAll(/["']([a-z]+(?:\.[a-z]+)+)["']/g)) ids.add(m[1]);
      }
    }
    return ids;
  };
  const END = ['player.franchise.play', 'player.franchise.save', 'player.franchise.open', 'player.franchise.dismiss'];
  const PAGE = ['detail.franchise', 'franchise.order', 'franchise.entry', 'franchise.play', 'franchise.save'];
  test('the TV', () => {
    const ids = tagged(['components/FranchiseLine.tsx', 'screens/Franchise.tsx', 'playback/FranchiseEnd.tsx']);
    for (const id of [...PAGE, ...END]) expect({id, tagged: ids.has(id)}).toEqual({id, tagged: true});
  });
  test('the phone', () => {
    const ids = tagged(['phone/ui/FranchiseLine.tsx', 'phone/screens/Franchise.tsx', 'playback/FranchiseEnd.tsx']);
    for (const id of [...PAGE, ...END]) expect({id, tagged: ids.has(id)}).toEqual({id, tagged: true});
  });
});
