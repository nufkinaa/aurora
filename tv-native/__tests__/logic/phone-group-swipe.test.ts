// "What do we watch tonight?" on the phone: what a finger on the card means,
// and this phone's own answers until the server has them (phone/groupSwipe.ts).
import {answer, BUTTONS, forget, GLYPH, groupVerdict, LABEL, mineOf, noAnswers, settle, stampLevels, undo, withMine} from '../../src/phone/groupSwipe';
import {stepOf, unanswered, WORDS} from '../../src/groupPick';
import type {GroupSession} from '../../src/groupPick';

const session = (o: Partial<GroupSession> = {}): GroupSession => ({
  code: 'ABCD',
  rev: 1,
  phase: 'swiping',
  round: 1,
  now: 0,
  createdAt: 0,
  expiresAt: 0,
  settings: {kind: 'movie', mood: 'any', length: 'any', limitSec: 180},
  host: null,
  you: {id: 'me|1', profileId: 'me', role: 'voter', host: false},
  members: [],
  voters: 1,
  added: [],
  deck: [
    {key: 'a', title: 'A', type: 'movie', lib: true},
    {key: 'b', title: 'B', type: 'movie', lib: false},
    {key: 'c', title: 'C', type: 'show', lib: false},
  ],
  mine: {},
  deadline: null,
  limitSec: 180,
  ...o,
});

test('a drag: right yes, left no, up maybe; short or sideways-up drags go back', () => {
  expect(groupVerdict({dx: 140, dy: 10})).toBe('yes');
  expect(groupVerdict({dx: -140, dy: -20})).toBe('no');
  expect(groupVerdict({dx: 10, dy: -130})).toBe('maybe');
  expect(groupVerdict({dx: 40, dy: 5})).toBe(null);
  expect(groupVerdict({dx: 40, dy: 0, vx: 1.2})).toBe('yes'); // a flick
  expect(groupVerdict({dx: 10, dy: 130})).toBe(null); // down means nothing
  expect(groupVerdict({dx: 200, dy: 0}, true)).toBe(null); // the system took the touch
});

test('the stamps follow the drag; the words are the shared ones', () => {
  expect(stampLevels(55, 0)).toEqual({yes: 0.5, no: 0, maybe: 0});
  expect(stampLevels(-220, 0).no).toBe(1);
  expect(stampLevels(0, -100).maybe).toBe(1);
  expect(stampLevels(80, -100).maybe).toBe(0); // only nearly straight up
  expect(BUTTONS).toEqual(['no', 'maybe', 'yes']);
  expect(LABEL).toEqual({yes: WORDS.yes, maybe: WORDS.maybe, no: WORDS.no});
  expect(GLYPH).toEqual({yes: '✓', maybe: '?', no: '✕'});
});

test('an answer moves on at once, and a slow copy from before it cannot bring the card back', () => {
  const s = session();
  let a = settle(noAnswers(), s);
  a = answer(a, 'a', 'yes');
  expect(unanswered(withMine(s, a)).map(c => c.key)).toEqual(['b', 'c']);
  // a poll that left before the vote: still without it
  a = settle(a, session({rev: 2}));
  expect(a.local).toEqual({a: 'yes'});
  expect(unanswered(withMine(session({rev: 2}), a))[0].key).toBe('b');
  // the server has it now: nothing left to hold
  a = settle(a, session({rev: 3, mine: {a: 'yes'}}));
  expect(a.local).toEqual({});
  expect(a.history).toEqual(['a']);
});

test("Undo takes back this phone's last answer (null to the server), never another device's", () => {
  const s = session({mine: {a: 'yes'}});
  let a = answer(settle(noAnswers(), s), 'b', 'maybe');
  const u = undo(a);
  expect(u && u.key).toBe('b');
  a = u!.next;
  expect(mineOf(s, a)).toEqual({a: 'yes'});
  // 'a' was answered on another device (it is not in this phone's history): not this phone's to undo
  expect(undo(a)).toBe(null);
});

test('the last answer: waiting at once; Undo brings back swiping', () => {
  const s = session({mine: {a: 'yes', b: 'no'}});
  let a = answer(settle(noAnswers(), s), 'c', 'no');
  expect(stepOf(withMine(s, a))).toBe('waiting');
  a = undo(a)!.next;
  expect(stepOf(withMine(s, a))).toBe('swipe');
});

test('a vote that never reached the server is forgotten; a new round starts clean', () => {
  const s = session();
  let a = answer(answer(settle(noAnswers(), s), 'a', 'yes'), 'b', 'no');
  a = forget(a, 'b');
  expect(a.local).toEqual({a: 'yes'});
  expect(a.history).toEqual(['a']);
  const next = settle(a, session({round: 2, rev: 9}));
  expect(next).toEqual(noAnswers('ABCD', 2));
  // another session: nothing carried over
  expect(withMine(session({code: 'WXYZ'}), a).mine).toEqual({});
});
