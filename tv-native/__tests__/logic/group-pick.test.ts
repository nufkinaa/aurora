// "What do we watch tonight?" — the apps' pure half (src/groupPick.ts): the
// steps, the lines, the code rules; and the website's copy
// (public/js/groupwords.js) held to it word for word and rule for rule.
import * as fs from 'fs';
import * as path from 'path';
import * as G from '../../src/groupPick';
import type {GroupSession} from '../../src/groupPick';

const web = (() => {
  const text = fs.readFileSync(path.join(__dirname, '../../../public/js/groupwords.js'), 'utf8');
  const names = [...text.matchAll(/^export const (\w+)/gm)].map(m => m[1]);
  // eslint-disable-next-line no-new-func
  return new Function(`${text.replace(/^export /gm, '')}\nreturn {${names.join(', ')}};`)() as typeof G;
})();

const member = (o: Partial<G.GroupMember>): G.GroupMember => ({
  id: 'x|d', profileId: 'x', name: 'X', role: 'voter', app: 'phone', host: false, away: false, answered: 0, done: false, ...o,
});
const session = (o: Partial<GroupSession> = {}): GroupSession => ({
  code: 'ABCD', rev: 3, phase: 'swiping', round: 1, now: 1000000, createdAt: 0, expiresAt: 0,
  settings: {kind: 'movie', mood: 'any', length: 'any', limitSec: 180},
  host: {id: 'tv|1', name: 'Elia', profileId: 'elia'},
  you: {id: 'dana|1', profileId: 'dana', role: 'voter', host: false},
  members: [
    member({id: 'elia|tv', profileId: 'elia', name: 'Elia', role: 'screen', app: 'tv', host: true}),
    member({id: 'dana|1', profileId: 'dana', name: 'Dana', answered: 2, done: true}),
    member({id: 'avi|1', profileId: 'avi', name: 'Avi', answered: 1}),
  ],
  voters: 2, added: [],
  deck: [
    {key: 'a', title: 'A', type: 'movie', lib: true},
    {key: 'b', title: 'B', type: 'movie', lib: false},
  ],
  mine: {a: 'yes'}, deadline: 1000000 + 151000, limitSec: 180,
  ...o,
});

test('the website says exactly the same words', () => {
  expect(web.WORDS).toEqual(G.WORDS);
  expect(web.TUTORIAL).toEqual(G.TUTORIAL);
  expect(G.TUTORIAL).toHaveLength(4);
  for (const k of Object.keys(G)) if (typeof (G as Record<string, unknown>)[k] === 'function') expect(typeof (web as Record<string, unknown>)[k]).toBe('function');
});

test('time left, from the server clock', () => {
  const s = session();
  for (const g of [G, web]) {
    expect(g.timeLeft(s)).toBe('2:31 left');
    expect(g.timeLeft(s, 146000)).toBe('0:05 left');
    expect(g.timeLeft(s, 200000)).toBe("Time's up");
    expect(g.timeLeft({deadline: null, now: 0})).toBe('');
    expect(g.secondsLeft(s, 1000)).toBe(150);
  }
});

test('the lines: who is in, who is done, a card, who has seen it', () => {
  const s = session();
  for (const g of [G, web]) {
    expect(g.progressLine(s)).toBe('1 of 2 done');
    expect(g.joinedLine(s)).toBe('Dana and Avi are in');
    expect(g.joinedLine({members: [s.members[0]]})).toBe(G.WORDS.waiting);
    expect(g.joinedLine({members: [s.members[1]]})).toBe('Dana is in');
    expect(g.joinedLine({members: [...s.members, member({profileId: 'ben', name: 'Ben'})]})).toBe('3 people are in');
    expect(g.cardMeta({year: 2021, runtime: 108, genres: ['Comedy', 'Drama', 'Crime'], type: 'movie'})).toBe('2021 · 1 h 48 · Comedy · Drama');
    expect(g.cardMeta({year: 2019, runtime: 120, type: 'movie'})).toBe('2019 · 2 h');
    expect(g.cardMeta({year: 2019, runtime: 45, type: 'movie'})).toBe('2019 · 45 min');
    expect(g.cardMeta({type: 'show'})).toBe('Series');
    expect(g.cardMeta({type: 'show', runtime: 30})).toBe('30 min episodes');
    expect(g.seenLine(['Dana'])).toBe('Dana has seen it');
    expect(g.seenLine(['Dana', 'Avi'])).toBe('Dana and Avi have seen it');
    expect(g.seenLine(['A', 'B', 'C'])).toBe('3 of you have seen it');
    expect(g.seenLine([])).toBe('');
    expect(g.addedLine('Ben')).toBe('Added by Ben');
    expect(g.limitLabel(180)).toBe('3 min');
  }
});

test('one chip per person: the person on their phone, not the TV they started it on', () => {
  const s = session({
    members: [
      member({id: 'elia|tv', profileId: 'elia', name: 'Elia', role: 'screen', app: 'tv', host: true}),
      member({id: 'elia|ph', profileId: 'elia', name: 'Elia', role: 'voter'}),
      member({id: 'dana|1', profileId: 'dana', name: 'Dana'}),
    ],
  });
  for (const g of [G, web]) {
    const p = g.peopleOf(s);
    expect(p.map(m => m.id)).toEqual(['elia|ph', 'dana|1']);
  }
});

test('which step a member is on', () => {
  for (const g of [G, web]) {
    expect(g.stepOf(session())).toBe('swipe');
    expect(g.stepOf(session({mine: {a: 'yes', b: 'no'}}))).toBe('waiting');
    expect(g.stepOf(session({you: {id: 'tv', profileId: 'elia', role: 'screen', host: true}}))).toBe('waiting');
    expect(g.stepOf(session({phase: 'lobby'}))).toBe('lobby');
    expect(g.stepOf(session({phase: 'result'}))).toBe('result');
    expect(g.stepOf(session({phase: 'chosen'}))).toBe('chosen');
    expect(g.stepOf(session({phase: 'ended'}))).toBe('ended');
    expect(g.unanswered(session()).map(c => c.key)).toEqual(['b']);
  }
});

test('the pick on screen, and whether there is something else', () => {
  const pick = (key: string) => ({key, why: 'w', yes: 1, maybe: 0, no: 0, missing: 0, of: 1, everyone: true, card: {key, title: key, type: 'movie' as const, lib: true}});
  const s = session({phase: 'result', result: {method: 'everyone', index: 0, at: 0, why: 'done', picks: [pick('a'), pick('b')]}});
  for (const g of [G, web]) {
    expect(g.currentPick(s)?.key).toBe('a');
    expect(g.hasNextPick(s)).toBe(true);
    const s2 = {...s, result: {...s.result!, index: 1}};
    expect(g.currentPick(s2)?.key).toBe('b');
    expect(g.hasNextPick(s2)).toBe(false);
    expect(g.currentPick({...s, result: {...s.result!, picks: []}})).toBe(null);
  }
});

test('codes and the QR address', () => {
  for (const g of [G, web]) {
    expect(g.tidyCode(' ab-c d9 ')).toBe('ABCD');
    expect(g.codeOk('AB2C')).toBe(true);
    expect(g.codeOk('AB1C')).toBe(false); // no 1 / I / 0 / O
    expect(g.codeOk('ABC')).toBe(false);
    expect(g.joinUrl('https://nufurora.com/', 'AB2C')).toBe('https://nufurora.com/#/group/AB2C');
    expect(g.hostOf('http://192.168.1.5:4000/')).toBe('192.168.1.5:4000');
  }
});

test('an older answer never replaces a newer one', () => {
  for (const g of [G, web]) {
    expect(g.newer(null, session())).toBe(true);
    expect(g.newer(session({rev: 5}), session({rev: 4}))).toBe(false);
    expect(g.newer(session({rev: 5}), session({rev: 5}))).toBe(true);
    expect(g.newer(session({rev: 5}), session({code: 'ZZZZ', rev: 1}))).toBe(true);
    expect(g.newer(session(), null)).toBe(false);
  }
});
