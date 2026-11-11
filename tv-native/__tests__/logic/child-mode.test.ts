// Children mode (2026-11-11, src/childMode.ts): the words the TV and the phone
// share with the website, and how a server answer, a socket word or an
// answer's audience becomes "the account changed".
import {ageWords, childModeChanged, fromAudience, fromWord, keepsLine, limitOf, onChildModeChanged, toastFor, validCode, WORDS, AGES} from '../../src/childMode';
import {moreEntries} from '../../src/phone/moreItems';

test('the ages and their words are the website’s', () => {
  expect([...AGES]).toEqual([0, 7, 12, 16]);
  expect(AGES.map(ageWords)).toEqual(['All ages', '7+', '12+', '16+']);
  expect(keepsLine(0)).toBe('Only titles rated for all ages.');
  expect(keepsLine(12)).toBe('Only titles rated 12+ and under.');
  expect(WORDS.enterToLeave).toBe('Enter the passcode to leave Children mode');
  expect(WORDS.who).toBe('Who is watching?');
});

test('a passcode is 4 to 6 digits', () => {
  for (const ok of ['1234', '000000', '98765']) expect(validCode(ok)).toBe(true);
  for (const no of ['', '123', '1234567', '12a4', ' 1234']) expect(validCode(no)).toBe(false);
});

test('the toast every device shows', () => {
  expect(toastFor(null, 7)).toEqual(['Children mode is on — 7+', '🧸']);
  expect(toastFor(7, 0)).toEqual(['Children mode — All ages', '🧸']);
  expect(toastFor(12, null)).toEqual(['Children mode is off', '✅']);
  expect(toastFor(12, null, 'You choose a new passcode next time.')).toEqual(['Children mode is off. You choose a new passcode next time.', '✅']);
  expect(toastFor(7, 7)).toBeNull();
});

test('the socket’s word counts only for the account this app is in', () => {
  expect(fromWord({type: 'child_mode', profileId: 'mum', childMode: {maxAge: 7}}, 'mum')).toEqual({profileId: 'mum', kids: {maxAge: 7}});
  expect(fromWord({type: 'child_mode', profileId: 'mum', childMode: null}, 'mum')).toEqual({profileId: 'mum', kids: null});
  expect(fromWord({type: 'child_mode', profileId: 'dad', childMode: {maxAge: 7}}, 'mum')).toBeNull();
  expect(fromWord({type: 'child_mode', profileId: 'mum', childMode: {maxAge: 7}}, null)).toBeNull();
});

test('an answer’s audience, and a profile from the server, say the limit', () => {
  expect(fromAudience('kids:12')).toEqual({maxAge: 12});
  expect(fromAudience('all')).toBeNull();
  expect(limitOf({childMode: {maxAge: 0}})).toEqual({maxAge: 0});
  expect(limitOf({kids: {maxAge: 7}})).toEqual({maxAge: 7}); // a server from before children mode
  expect(limitOf({kids: null, childMode: null})).toBeNull();
  expect(limitOf(null)).toBeNull();
});

test('a change reaches every listener, and a listener can leave', () => {
  const got: unknown[] = [];
  const off = onChildModeChanged(c => got.push(c));
  childModeChanged({profileId: 'mum', kids: {maxAge: 7}});
  off();
  childModeChanged({profileId: 'mum', kids: null});
  expect(got).toEqual([{profileId: 'mum', kids: {maxAge: 7}}]);
});

test('More while Children mode is on: its line reads Leave, and no downloads or signing a TV in', () => {
  const on = moreEntries({ai: true, kids: true});
  expect(on.find(e => e.key === 'children')?.label).toBe('Leave Children mode');
  expect(on.some(e => e.key === 'downloads' || e.key === 'saved' || e.key === 'pair')).toBe(false);
  const off = moreEntries({ai: true});
  expect(off.find(e => e.key === 'children')).toMatchObject({label: 'Children mode', uiId: 'more.children', icon: 'child'});
  expect(off.some(e => e.key === 'downloads')).toBe(true);
});
