// The new-password screen's rules (src/newPassword.ts): the forced reset and,
// [auth-round], a Google-only profile's first password ("Set a password").
import {newPasswordMode, saveRefusal} from '../../src/newPassword';

test('a TV that just saw the password never asks for it again', () => {
  expect(newPasswordMode('old-one', undefined)).toEqual({mode: 'forced', askCurrent: false});
  expect(newPasswordMode('', {passwordSetup: true})).toEqual({mode: 'forced', askCurrent: false});
});

test('after QR pairing or Google: /api/me says which screen it is', () => {
  expect(newPasswordMode(null, undefined)).toEqual({mode: 'loading', askCurrent: false});
  // a Google-only profile has no password to ask for
  expect(newPasswordMode(null, {passwordSetup: true})).toEqual({mode: 'setup', askCurrent: false});
  expect(newPasswordMode(null, {})).toEqual({mode: 'forced', askCurrent: true});
  // /api/me could not be had: the forced reset, asking (the server decides anyway)
  expect(newPasswordMode(null, null)).toEqual({mode: 'forced', askCurrent: true});
});

test('a refused save, by what the server said, next to its field', () => {
  expect(saveRefusal({status: 401, message: 'wrong password'})).toEqual({field: 'current', words: "That isn't your current password."});
  expect(saveRefusal({status: 400, code: 'same', message: 'x'})).toEqual({field: 'newPassword', words: 'That is the old password. Pick a different one.'});
  expect(saveRefusal({status: 400, code: 'short', message: 'x', field: 'newPassword'})).toEqual({field: 'newPassword', words: 'Use at least 4 characters.'});
  expect(saveRefusal({status: 400, message: 'pick a new password — this profile cannot go without one right now'}).words).toBe(
    'Pick a new password — this profile cannot go without one right now.',
  );
  expect(saveRefusal({status: 429, retryAfter: 60}).words).toBe('Too many tries. Wait 1 minute, then try again.');
  expect(saveRefusal({status: 0, message: 'Cannot reach server'}).words).toBe("Can't reach Aurora. Check your connection and try again.");
  expect(saveRefusal({status: 500, message: ''}).words).toBe("That didn't work. Try again.");
});
