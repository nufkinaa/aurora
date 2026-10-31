// [auth-round] The TV's sign-in / request / reset rules (src/authFlow.ts),
// in the round's shared words (docs/auth-round.md section 2).
import {
  WORDS,
  adminWord,
  codeProblems,
  firstProblem,
  googleNext,
  hasProblems,
  newPasswordProblems,
  normalizeCode,
  refusalWords,
  requestProblems,
  resetBack,
  resetStatusNext,
  resetWays,
  sentence,
  signinBack,
  signinProblems,
  suggestedName,
} from '../../src/authFlow';
import {passwordStrength, tooManyWords} from '../../src/passRules';

test('sign in: each empty field says what to do, in place', () => {
  expect(signinProblems('', '')).toEqual({identifier: 'Enter your username or email.', password: 'Enter your password.'});
  expect(signinProblems('  ', 'x')).toEqual({identifier: 'Enter your username or email.'});
  expect(signinProblems('tess', '')).toEqual({password: 'Enter your password.'});
  expect(hasProblems(signinProblems('tess', 'abcd'))).toBe(false);
});

test('a wrong sign-in reads the same whatever was wrong (no account is given away)', () => {
  for (const status of [400, 401, 403]) {
    expect(refusalWords({status, message: 'wrong username or password'}, 'signin')).toEqual({
      field: 'password',
      words: "That username and password don't match. Check them, or reset your password.",
    });
  }
});

test('too many tries carries the wait; no answer is the connection words', () => {
  expect(refusalWords({status: 429, message: 'slow down', retryAfter: 600}, 'signin').words).toBe(
    'Too many tries. Wait 10 minutes, then try again.',
  );
  expect(refusalWords({status: 429}, 'resetCode').words).toBe(tooManyWords(undefined));
  expect(refusalWords({status: 0, message: 'Network request failed'}, 'request')).toEqual({
    field: null,
    words: "Can't reach Aurora. Check your connection and try again.",
  });
  expect(refusalWords(null, 'signin').words).toBe(WORDS.offline);
});

test('a refusal with a field lands next to that field, as a sentence', () => {
  expect(refusalWords({status: 400, message: 'that username is taken', field: 'username', code: 'taken'}, 'request')).toEqual({
    field: 'username',
    words: 'That username is taken.',
  });
  // the request form calls its password field "password"
  expect(refusalWords({status: 400, message: 'x', field: 'newPassword', code: 'short'}, 'request')).toEqual({
    field: 'password',
    words: 'Use at least 4 characters.',
  });
  expect(refusalWords({status: 400, message: 'x', code: 'mismatch'}, 'resetComplete')).toEqual({
    field: 'confirm',
    words: "The passwords don't match.",
  });
  expect(refusalWords({status: 400, message: 'x', code: 'same'}, 'newPassword')).toEqual({
    field: 'newPassword',
    words: 'That is the old password. Pick a different one.',
  });
  // a status line (no words from the server) is never shown
  expect(refusalWords({status: 500, message: '500 /api/auth/signup'}, 'request').words).toBe("That didn't work. Try again.");
});

test('reset code refusals: wrong, expired, used - each says what to do next', () => {
  expect(refusalWords({status: 400, code: 'wrong', message: 'no'}, 'resetCode', 'Elia')).toEqual({
    field: 'code',
    words: "That code doesn't match. Check it, or ask Elia for a new one.",
  });
  expect(refusalWords({status: 410, code: 'expired', message: 'gone'}, 'resetCode', 'Elia')).toEqual({
    field: 'code',
    words: 'That code has expired. Ask Elia for a new one.',
  });
  expect(refusalWords({status: 410, code: 'used', message: 'gone'}, 'resetCode', 'Elia').words).toBe(
    'That code was already used. Ask Elia for a new one.',
  );
  expect(refusalWords({status: 410, code: 'expired'}, 'resetComplete').field).toBeNull();
  expect(refusalWords({status: 410}, 'resetComplete').words).toBe('This reset has expired. Start again from Forgot password.');
});

test('request access: name, username, password twice; email only checked when given', () => {
  expect(requestProblems({name: '', username: 'a', email: 'nope', password: 'abc', confirm: ''})).toEqual({
    name: 'Enter your name.',
    username: 'Use at least 2 letters or numbers.',
    email: "That email doesn't look right.",
    password: 'Use at least 4 characters.',
  });
  expect(requestProblems({name: 'Tess', username: 'tess', email: '', password: 'abcd', confirm: 'abce'})).toEqual({
    confirm: "The passwords don't match.",
  });
  expect(hasProblems(requestProblems({name: 'Tess', username: 'tess', email: 't@x.io', password: 'abcd', confirm: 'abcd'}))).toBe(false);
});

test('Google sign-up still needs a password (ask #2), but no username', () => {
  expect(requestProblems({name: 'Tess', password: '', confirm: '', google: true})).toEqual({password: 'Use at least 4 characters.'});
  expect(requestProblems({name: 'Tess', password: 'abcd', confirm: 'abcx', google: true})).toEqual({confirm: "The passwords don't match."});
  expect(hasProblems(requestProblems({name: 'Tess', password: 'abcd', confirm: 'abcd', google: true}))).toBe(false);
});

test('new password: the rule first, then the match; the current one only when asked', () => {
  expect(newPasswordProblems({fresh: 'abc', again: 'abc'})).toEqual({newPassword: 'Use at least 4 characters.'});
  expect(newPasswordProblems({fresh: 'abcd', again: 'abc'})).toEqual({confirm: "The passwords don't match."});
  expect(newPasswordProblems({fresh: 'abcd', again: 'abcd', askCurrent: true, current: ''})).toEqual({
    current: 'Enter your current password.',
  });
  expect(newPasswordProblems({fresh: 'abcd', again: 'abcd', askCurrent: false})).toEqual({});
});

test('focus goes to the first field with something to say, in the form order', () => {
  expect(firstProblem({password: 'x', name: 'y'}, ['name', 'username', 'password'])).toBe('name');
  expect(firstProblem({confirm: 'x'}, ['newPassword', 'confirm'])).toBe('confirm');
  expect(firstProblem({}, ['name'])).toBeNull();
});

test('reset codes are compared without spaces, dashes or case', () => {
  expect(normalizeCode(' ab12-cd34 ')).toBe('AB12CD34');
  expect(codeProblems('', '')).toEqual({identifier: 'Enter your username or email.', code: 'Enter the reset code.'});
  expect(codeProblems('tess', '--')).toEqual({code: 'Enter the reset code.'});
});

test('the ways to reset: admin and code always; Google and email when offered', () => {
  expect(resetWays({google: false, email: false, admin: true})).toEqual(['admin', 'code']);
  expect(resetWays({google: true, email: true, admin: true})).toEqual(['google', 'admin', 'code', 'email']);
  expect(resetWays(null)).toEqual(['admin', 'code']);
});

test('Back goes one step back, never out of the app from a sub-step', () => {
  expect(signinBack('signin')).toBeNull();
  expect(signinBack('request')).toBe('signin');
  expect(signinBack('forgot')).toBe('signin');
  expect(signinBack('google')).toBe('signin');
  expect(resetBack('choose')).toBeNull();
  expect(resetBack('admin')).toBe('choose');
  expect(resetBack('adminWait')).toBe('admin');
  expect(resetBack('code')).toBe('choose');
  expect(resetBack('code', 'adminWait')).toBe('adminWait');
  expect(resetBack('emailSent')).toBe('email');
  expect(resetBack('newPassword')).toBe('choose');
});

test('waiting for the admin: keep waiting, carry on with the token, or stop with words', () => {
  expect(resetStatusNext({status: 'pending'})).toEqual({next: 'wait'});
  expect(resetStatusNext(null)).toEqual({next: 'wait'});
  // approved without a token is not something to act on
  expect(resetStatusNext({status: 'approved'})).toEqual({next: 'wait'});
  expect(resetStatusNext({status: 'approved', token: 't1'})).toEqual({next: 'approved', token: 't1'});
  const d = resetStatusNext({status: 'declined'});
  expect(d.next).toBe('stop');
  if (d.next === 'stop') expect(d.words('Elia')).toBe('Elia said no to this request. Talk to Elia, or try another way.');
  const x = resetStatusNext({status: 'expired'});
  if (x.next === 'stop') expect(x.words('Elia')).toBe('This request has expired. Send a new one.');
});

test("Google's answer, by why it was asked", () => {
  expect(googleNext({pending: true}, 'p', 'signin')).toEqual({next: 'wait'});
  expect(googleNext({profile: {id: 'a'}, profileToken: 't', session: 's'}, 'p', 'signin')).toEqual({next: 'signedIn'});
  expect(googleNext({signup: {email: 'g@x.io', name: 'Gee'}}, 'p1', 'signin')).toEqual({
    next: 'signup',
    pollId: 'p1',
    email: 'g@x.io',
    name: 'Gee',
  });
  expect(googleNext({reset: {token: 'rt', name: 'Tess'}}, 'p', 'reset')).toEqual({next: 'reset', token: 'rt', name: 'Tess'});
  // a reset with no linked profile never turns into a sign-up
  expect(googleNext({signup: {email: 'g@x.io'}}, 'p', 'reset').next).toBe('error');
  expect(googleNext({}, 'p', 'signin')).toEqual({next: 'error', words: "Google didn't finish. Try again."});
});

test('words: the admin as a subject, server sentences tidied, a suggested name', () => {
  expect(adminWord('')).toBe('the admin');
  expect(adminWord(' Elia ')).toBe('Elia');
  // the server's default name starts a sentence with a capital, and stays small inside one
  expect(WORDS.requestLine('the admin')).toBe("The admin approves new people. Once you're approved, sign in with the details you set here.");
  expect(WORDS.askSentLine('the admin')).toBe(
    'Keep this screen open. When the admin approves, you can choose a new password here. You can also ask the admin for a reset code.',
  );
  expect(WORDS.askAdmin('the admin')).toBe('Ask the admin');
  expect(WORDS.forcedLine('the admin')).toBe('The admin asked for a new password on this profile.');
  expect(sentence('that email is already in use')).toBe('That email is already in use.');
  expect(sentence('Done!')).toBe('Done!');
  expect(suggestedName('', 'tess.tv@example.com')).toBe('tess.tv');
  expect(suggestedName('A very long Google display name here', null)).toHaveLength(24);
  expect(WORDS.requestLine('Elia')).toBe("Elia approves new people. Once you're approved, sign in with the details you set here.");
  expect(WORDS.askSentLine('Elia')).toContain('Keep this screen open.');
});

test('the strength hint is a hint: shown labels are the contract words', () => {
  expect(passwordStrength('ab').label).toBe('Too short');
  expect(passwordStrength('password').label).toBe('Weak');
  expect(['Okay', 'Good', 'Strong']).toContain(passwordStrength('Blue-Kettle-91').label);
});
