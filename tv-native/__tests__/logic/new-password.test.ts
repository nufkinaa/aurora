// The forced reset's own checks (screens/NewPassword.tsx), in the site's words.
import {newPasswordProblem, saveRefusal} from '../../src/newPassword';

test('what stops a save, in order', () => {
  expect(newPasswordProblem({askCurrent: true, current: '', fresh: 'abcd', again: 'abcd'})).toBe('Your current password first.');
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abc', again: 'abc'})).toBe('At least 4 characters.');
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abcd', again: 'abce'})).toBe("They don't match.");
});

test('a TV that already holds the typed password does not ask for it again', () => {
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abcd', again: 'abcd'})).toBeNull();
  expect(newPasswordProblem({askCurrent: true, current: 'old', fresh: 'abcd', again: 'abcd'})).toBeNull();
});

test('a refused save, by what the server said (POST /api/profiles/:id/password)', () => {
  expect(saveRefusal(401, undefined, 'wrong password')).toBe('That is not the current password.');
  expect(saveRefusal(400, 'same', 'that is the old password — pick a different one')).toBe('That is the old password — pick a different one.');
  // "needed" and the length rule come with words written for the viewer
  expect(saveRefusal(400, 'needed', 'pick a new password — this profile cannot go without one right now')).toBe('pick a new password — this profile cannot go without one right now');
  expect(saveRefusal(400, undefined, 'Passwords need at least 4 characters.')).toBe('Passwords need at least 4 characters.');
  expect(saveRefusal(429, undefined, 'too many attempts — try again in a few minutes')).toBe('Too many attempts — try again in a few minutes.');
  expect(saveRefusal(0, undefined, 'Cannot reach server')).toBe("Couldn't reach the server. Try again.");
  expect(saveRefusal(500, undefined, '')).toBe("Couldn't save it. Try again.");
});
