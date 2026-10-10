// The forced reset's own checks (screens/NewPassword.tsx), in the site's words.
import {newPasswordProblem} from '../../src/newPassword';

test('what stops a save, in order', () => {
  expect(newPasswordProblem({askCurrent: true, current: '', fresh: 'abcd', again: 'abcd'})).toBe('Your current password first.');
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abc', again: 'abc'})).toBe('At least 4 characters.');
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abcd', again: 'abce'})).toBe("They don't match.");
});

test('a TV that already holds the typed password does not ask for it again', () => {
  expect(newPasswordProblem({askCurrent: false, current: '', fresh: 'abcd', again: 'abcd'})).toBeNull();
  expect(newPasswordProblem({askCurrent: true, current: 'old', fresh: 'abcd', again: 'abcd'})).toBeNull();
});
