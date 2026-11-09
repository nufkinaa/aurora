// "What do we watch tonight?" — the TV screen's own small rules
// (src/groupPickTv.ts): which view is up, this box's answers before the server
// says them back, Undo, the countdown, a person's line, where Play goes and
// that the TV starts a chosen title once.
import * as T from '../../src/groupPickTv';
import {WORDS} from '../../src/groupPick';
import type {GroupMember, GroupOptions, GroupSession} from '../../src/groupPick';

const member = (o: Partial<GroupMember>): GroupMember => ({
  id: 'x|d', profileId: 'x', name: 'X', role: 'voter', app: 'phone', host: false, away: false, answered: 0, done: false, ...o,
});
const OPTIONS: GroupOptions = {
  tutorialSeen: true,
  moods: [{id: 'any', label: 'Anything'}, {id: 'funny', label: 'Funny'}],
  lengths: [{id: 'any', label: 'Any length'}, {id: '90', label: 'Under 1 h 30'}],
  kinds: [{id: 'movie', label: 'Films'}, {id: 'both', label: 'Films and series'}, {id: 'show', label: 'Series'}],
  limits: [120, 180, 300],
};
const TV = member({id: 'elia|tv', profileId: 'elia', name: 'Elia', role: 'screen', app: 'tv', host: true});
const session = (o: Partial<GroupSession> = {}): GroupSession => ({
  code: 'ABCD', rev: 3, phase: 'swiping', round: 1, now: 1000000, createdAt: 0, expiresAt: 0,
  settings: {kind: 'movie', mood: 'funny', length: '90', limitSec: 180},
  host: {id: 'elia|tv', name: 'Elia', profileId: 'elia'},
  you: {id: 'elia|tv', profileId: 'elia', role: 'screen', host: true},
  members: [TV, member({id: 'dana|1', profileId: 'dana', name: 'Dana', answered: 2, done: true})],
  voters: 1, added: [],
  deck: [
    {key: 'a', title: 'A', type: 'movie', lib: true, id: 'lib-a'},
    {key: 'b', title: 'B', type: 'movie', lib: false, imdbId: 'tt2'},
  ],
  mine: {}, deadline: 1000000 + 90000, limitSec: 180,
  ...o,
});
const result = (o: Partial<GroupSession> = {}) =>
  session({
    phase: 'result',
    deadline: null,
    result: {
      method: 'best', index: 0, at: 0, why: 'done',
      picks: [
        {key: 'a', why: '2 of 2 said yes', yes: 2, maybe: 0, no: 0, missing: 0, of: 2, everyone: true, card: {key: 'a', title: 'A', type: 'movie', lib: true, id: 'lib-a'}},
        {key: 'b', why: '1 yes, 1 maybe', yes: 1, maybe: 1, no: 0, missing: 0, of: 2, everyone: false, card: {key: 'b', title: 'B', type: 'show', lib: false, imdbId: 'tt2'}},
      ],
    },
    ...o,
  });

test('which view is up', () => {
  const base = {options: OPTIONS, optionsFailed: false, session: null, lost: null, tutorial: false};
  expect(T.viewOf({...base, options: null})).toBe('loading');
  expect(T.viewOf({...base, options: null, optionsFailed: true})).toBe('failed');
  expect(T.viewOf(base)).toBe('start');
  expect(T.viewOf({...base, tutorial: true})).toBe('tutorial');
  expect(T.viewOf({...base, tutorial: true, session: session()})).toBe('tutorial'); // "How it works" over a session
  expect(T.viewOf({...base, session: session({phase: 'lobby', deck: []})})).toBe('lobby');
  expect(T.viewOf({...base, session: session()})).toBe('waiting'); // the TV as the screen
  expect(T.viewOf({...base, session: session({you: {id: 'elia|tv', profileId: 'elia', role: 'voter', host: true}})})).toBe('swipe');
  expect(T.viewOf({...base, session: result()})).toBe('result');
  expect(T.viewOf({...base, session: result({result: {method: 'none', index: 0, at: 0, why: 'time', picks: []}})})).toBe('nomatch');
  expect(T.viewOf({...base, session: session({phase: 'chosen'})})).toBe('chosen');
  expect(T.viewOf({...base, session: session({phase: 'ended', ended: {reason: 'Elia ended it'}})})).toBe('ended');
  expect(T.viewOf({...base, session: session(), lost: 'That code has expired or is not right'})).toBe('ended');
});

test('the start form begins on the defaults; the chosen settings read as one line', () => {
  expect(T.firstSettings(OPTIONS)).toEqual({kind: 'movie', mood: 'any', length: 'any', limitSec: 180});
  expect(T.firstSettings({...OPTIONS, limits: [60, 600]}).limitSec).toBe(60);
  expect(T.firstSettings(null).limitSec).toBe(180);
  expect(T.settingsLine(session().settings, OPTIONS)).toBe('Films · Funny · Under 1 h 30 · 3 min');
  expect(T.settingsLine(session().settings, null)).toBe('3 min');
});

test("this box's answers count before the server says them back, and go once it has", () => {
  const s = session({mine: {a: 'yes'}});
  expect(T.mergeMine(s.mine, {b: 'no'})).toEqual({a: 'yes', b: 'no'});
  expect(T.mergeMine(s.mine, {a: null})).toEqual({}); // Undo, waiting for the server
  expect(T.withMine(s, {})).toBe(s);
  expect(T.withMine(s, {b: 'maybe'}).mine).toEqual({a: 'yes', b: 'maybe'});
  // the server has a: yes → it is settled; b is still on its way
  expect(T.settleLocal(s, {a: 'yes', b: 'no'})).toEqual({b: 'no'});
  // a take-back is settled once the server no longer has it
  expect(T.settleLocal(session({mine: {}}), {a: null})).toEqual({});
  expect(T.settleLocal(s, {a: null})).toEqual({a: null});
  // a new round: a card that left the deck is dropped
  expect(T.settleLocal(session({deck: [{key: 'z', title: 'Z', type: 'movie', lib: false}], mine: {}}), {a: 'yes'})).toEqual({});
});

test('Undo takes back the last card this box answered that still has an answer', () => {
  expect(T.undoTarget(['a', 'b'], {a: 'yes', b: 'no'})).toEqual({key: 'b', history: ['a']});
  expect(T.undoTarget(['a', 'b'], {a: 'yes'})).toEqual({key: 'a', history: []});
  expect(T.undoTarget([], {a: 'yes'})).toEqual({key: null, history: []});
});

test('the countdown: the line and the bar, from the copy on screen', () => {
  const s = session();
  expect(T.countdown(s, 0)).toEqual({text: '1:30 left', frac: 0.5, left: 90});
  expect(T.countdown(s, 60000)).toEqual({text: '0:30 left', frac: 30 / 180, left: 30});
  expect(T.countdown(s, 120000)).toEqual({text: "Time's up", frac: 0, left: 0});
  // one more minute past the limit: the bar is full, not over-full
  expect(T.countdown(session({deadline: 1000000 + 240000}), 0).frac).toBe(1);
  expect(T.countdown(session({deadline: null}), 0)).toEqual({text: '', frac: 0, left: 0});
});

test("a person's chip: started it, screen, away, done; and how far they are", () => {
  expect(T.badgesOf(TV, 'lobby')).toEqual([WORDS.hostBadge, WORDS.screenBadge]);
  expect(T.badgesOf(member({away: true, done: true}), 'swiping')).toEqual([WORDS.awayBadge, WORDS.doneBadge]);
  expect(T.badgesOf(member({done: true}), 'result')).toEqual([]);
  expect(T.personProgress(member({answered: 4}), 20)).toBe('4 of 20');
  expect(T.personProgress(member({answered: 25}), 20)).toBe('20 of 20');
  expect(T.personProgress(member({done: true}), 20)).toBe(WORDS.doneBadge);
  expect(T.personProgress(member({}), 0)).toBe('');
  expect(T.votersOf([TV, member({})]).map(m => m.role)).toEqual(['voter']);
});

test('Something else: the next pick, then back to the first; nothing with one pick', () => {
  const r = result();
  expect(T.nextPick(r)).toEqual({index: 1, label: WORDS.somethingElse});
  expect(T.pickCount(r)).toBe('1 of 2');
  const second = result();
  second.result!.index = 1;
  expect(T.nextPick(second)).toEqual({index: 0, label: WORDS.firstPick});
  expect(T.pickCount(second)).toBe('2 of 2');
  const one = result();
  one.result!.picks = one.result!.picks.slice(0, 1);
  expect(T.nextPick(one)).toBeNull();
  expect(T.pickCount(one)).toBe('');
});

test('Play: a library film plays now; a library series or a catalogue title opens its page', () => {
  const film = {key: 'a', title: 'A', type: 'movie' as const, lib: true, id: 'lib-a', poster: '/img/a'};
  expect(T.routeFor({kind: 'library', id: 'lib-a', type: 'movie'}, film)).toEqual({screen: 'Player', params: {id: 'lib-a', title: 'A'}});
  const show = {key: 's', title: 'S', type: 'show' as const, lib: true, id: 'lib-s', poster: '/img/s', imdbId: 'tt9', year: 2020};
  const toShow = T.routeFor({kind: 'library', id: 'lib-s', type: 'show'}, show);
  expect(toShow).toMatchObject({screen: 'Detail', params: {item: {id: 'lib-s', type: 'show', title: 'S', cover: '/img/s', source: 'downloaded', year: 2020}}});
  const cat = {key: 'tt2', title: 'B', type: 'movie' as const, lib: false, imdbId: 'tt2', poster: 'https://x/p.jpg'};
  expect(T.routeFor({kind: 'discover', imdbId: 'tt2', type: 'movie'}, cat)).toMatchObject({
    screen: 'Detail',
    params: {item: {id: 'tt2', imdbId: 'tt2', type: 'movie', poster: 'https://x/p.jpg', source: 'stream'}},
  });
  expect(T.routeFor(null, cat)).toBeNull();
});

test('the TV starts a chosen title once — as the screen, whoever pressed Play', () => {
  const chosen = session({phase: 'chosen', deadline: null, chosen: {key: 'a', by: 'Dana', card: {key: 'a', title: 'A', type: 'movie', lib: true, id: 'lib-a'}}});
  expect(T.chosenKey(chosen)).toBe('ABCD:1:a');
  expect(T.chosenKey(session())).toBeNull();
  // Dana pressed Play on her phone: the screen starts it
  expect(T.autoStart(chosen, null, null)?.key).toBe('a');
  // … once
  expect(T.autoStart(chosen, null, 'ABCD:1:a')).toBeNull();
  // the TV is a voter and a phone pressed Play, with no screen in the room: not here
  const voterTv = {...chosen, you: {id: 'elia|tv', profileId: 'elia', role: 'voter' as const, host: true}, members: [{...TV, role: 'voter' as const}]};
  expect(T.autoStart(voterTv, null, null)).toBeNull();
  // … unless it was pressed here
  expect(T.autoStart(voterTv, 'a', null)?.key).toBe('a');
  // a voter TV with another screen in the room: that screen plays it
  const otherScreen = {...voterTv, members: [...voterTv.members, member({id: 'web|1', profileId: 'avi', role: 'screen', app: 'web'})]};
  expect(T.autoStart(otherScreen, 'a', null)).toBeNull();
  expect(T.autoStart(session(), null, null)).toBeNull();
});

test('Back asks first only while the session is going', () => {
  expect(T.sessionLive(null, null)).toBe(false);
  expect(T.sessionLive(session({phase: 'lobby'}), null)).toBe(true);
  expect(T.sessionLive(session(), null)).toBe(true);
  expect(T.sessionLive(result(), null)).toBe(true);
  expect(T.sessionLive(session({phase: 'chosen'}), null)).toBe(false);
  expect(T.sessionLive(session({phase: 'ended'}), null)).toBe(false);
  expect(T.sessionLive(session(), 'gone')).toBe(false);
});
