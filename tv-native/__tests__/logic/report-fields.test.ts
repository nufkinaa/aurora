// What a report says about the client (reportFields.ts), and what the person is told
// when another version ended without them (replaceLogic.ts replaceEndedToast).
import {clientFields} from '../../src/reportFields';
import {replaceEndedToast, replaceRowText} from '../../src/replaceLogic';

const env = {tvVersion: '5.8.3', phoneVersion: '1.0.3', release: '9', model: 'MIBOX3', online: true, errors: ['x']};

test('the TV: kind and version, the shape every report has', () => {
  expect(clientFields({...env, phone: false})).toEqual({
    look: 'tv',
    viewport: 'tv',
    ua: 'Aurora TV 5.8.3 · Android 9 · MIBOX3',
    version: '5.8.3',
    online: true,
    errors: ['x'],
  });
});

test('the phone', () => {
  const c = clientFields({...env, phone: true, model: null, online: false});
  expect(c.look).toBe('phone');
  expect(c.version).toBe('1.0.3');
  expect(c.ua).toBe('Aurora for Android 1.0.3 · Android 9 · phone');
  expect(c.online).toBe(false);
});

test('a replacement that ended without the person is said, once; their own cancel is not', () => {
  const j = {mine: true, title: 'Film', replaces: {libraryId: 'x'}};
  expect(replaceEndedToast({...j, status: 'error', error: 'no peers'})).toBe('The other version of “Film” failed — your copy stays. Open “Problem with this copy?” to pick the next one.');
  expect(replaceEndedToast({...j, status: 'canceled', canceledBy: 'admin'})).toBe('The admin cancelled the other version of “Film” — your copy stays.');
  expect(replaceEndedToast({...j, status: 'declined'})).toBe('The admin said no to the other version of “Film” — your copy stays.');
  expect(replaceEndedToast({...j, status: 'canceled', canceledBy: 'self'})).toBeNull();
  expect(replaceEndedToast({...j, status: 'done'})).toBeNull();
  expect(replaceEndedToast({...j, status: 'downloading'})).toBeNull();
  expect(replaceEndedToast({...j, mine: false, status: 'error'})).toBeNull();
  expect(replaceEndedToast({mine: true, status: 'error'})).toBeNull();
});

test('a source row: its language and the last try are on it', () => {
  const r = replaceRowText({quality: '1080p', release: 'Film.ENGLISH', langFit: 'right', langLabel: 'English'});
  expect(r.tags).toEqual(['English']);
  const t = replaceRowText({quality: '1080p', release: 'Film.BONE', tried: {status: 'canceled', label: 'Tried here: cancelled'}});
  expect(t.warn).toBe('Tried here: cancelled');
  const b = replaceRowText({quality: '1080p', release: 'Film.X', badHere: {reason: 'language', label: 'Wrong language'}, tried: {label: 'Tried here: cancelled'}});
  expect(b.warn).toBe('Reported here: Wrong language');
});
