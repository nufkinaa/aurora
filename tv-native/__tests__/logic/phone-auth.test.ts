// [auth-round] The phone's sign-in screens: Google's way back into the app, the hand-off kept
// across a cold start, which Google way runs, the forms' checks and the server's refusals in
// the contract's words (docs/auth-round.md), and the ask-the-admin wait.
export {};
declare const __dirname: string;
import {isAuthLink, parseGoogleAuth, parsePhoneLink} from '../../src/phone/linkParse';
import {
  askStep,
  firstProblem,
  googleRefusal,
  googleStep,
  googleWay,
  hasProblems,
  isVerifier,
  newPasswordProblems,
  PENDING_TTL_MS,
  readPending,
  refusalProblem,
  requestBody,
  requestProblems,
  resetWays,
  signInProblems,
  typedResetCode,
  W,
} from '../../src/phone/auth/rules';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE = 'q2Vw8xY_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456A';

describe('Google comes back to the app (aurora-phone://auth/google)', () => {
  test('a code, as the server sends it', () => {
    expect(parseGoogleAuth(`aurora-phone://auth/google?code=${CODE}`)).toEqual({kind: 'googleAuth', code: CODE, error: null});
    expect(parsePhoneLink(`aurora-phone://auth/google?code=${CODE}`)).toEqual({kind: 'googleAuth', code: CODE, error: null});
    expect(parseGoogleAuth(`AURORA-PHONE://auth/google/?code=${CODE}#x`)?.code).toBe(CODE);
  });
  test('an error, in the server’s words (decoded, plus signs as spaces)', () => {
    expect(parseGoogleAuth('aurora-phone://auth/google?error=Google+said+no.')).toEqual({kind: 'googleAuth', code: null, error: 'Google said no.'});
    expect(parseGoogleAuth('aurora-phone://auth/google?error=That%20Google%20account%20is%20blocked.')?.error).toBe('That Google account is blocked.');
  });
  test('an error wins over a code; a code that cannot be one is dropped with words', () => {
    expect(parseGoogleAuth(`aurora-phone://auth/google?code=${CODE}&error=No`)).toEqual({kind: 'googleAuth', code: null, error: 'No'});
    const bad = parseGoogleAuth('aurora-phone://auth/google?code=<script>');
    expect(bad?.code).toBeNull();
    expect(bad?.error).toMatch(/did not finish/);
    expect(parseGoogleAuth('aurora-phone://auth/google')?.code).toBeNull();
  });
  test('control characters never reach the screen; long words are cut', () => {
    const e = parseGoogleAuth(`aurora-phone://auth/google?error=${encodeURIComponent('a\nb\u0007c' + 'x'.repeat(400))}`)?.error || '';
    expect(e).not.toMatch(/[\u0000-\u001f]/);
    expect(e.length).toBeLessThanOrEqual(200);
  });
  test('other app links are not mistaken for it, and it is not a page of the app', () => {
    expect(parseGoogleAuth('aurora-phone://movie/abc')).toBeNull();
    expect(parseGoogleAuth('https://nufurora.com/#/auth/google?code=x')).toBeNull();
    expect(parseGoogleAuth('aurora-phone://auth/googlex?code=' + CODE)).toBeNull();
    expect(parsePhoneLink('aurora-phone://auth/other')).toBeNull();
  });
});

describe('an emailed reset link opens the new-password step (nufurora.com/#/reset/<token>)', () => {
  const T = 'Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3';
  test('on the site, on the server this phone uses, and on the app’s own scheme', () => {
    expect(parsePhoneLink(`https://nufurora.com/#/reset/${T}`)).toEqual({kind: 'resetLink', token: T});
    expect(parsePhoneLink(`https://www.nufurora.com/#/reset/${T}`)).toEqual({kind: 'resetLink', token: T});
    expect(parsePhoneLink(`http://10.0.0.5:4000/#/reset/${T}`, ['nufurora.com', '10.0.0.5:4000'])).toEqual({kind: 'resetLink', token: T});
    expect(parsePhoneLink(`aurora-phone://reset/${T}`)).toEqual({kind: 'resetLink', token: T});
  });
  test('a token that cannot be one, or a stranger’s site: nothing', () => {
    expect(parsePhoneLink('https://nufurora.com/#/reset/short')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/reset/')).toBeNull();
    expect(parsePhoneLink(`https://nufurora.com/#/reset/${'x'.repeat(201)}`)).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/reset/<script>alert(1)</script>xxxxxxxxxx')).toBeNull();
    expect(parsePhoneLink(`https://evil.example/#/reset/${T}`)).toBeNull();
  });
  test('it and Google’s answer belong to the sign-in screens; pages do not', () => {
    expect(isAuthLink(parsePhoneLink(`https://nufurora.com/#/reset/${T}`))).toBe(true);
    expect(isAuthLink(parsePhoneLink(`aurora-phone://auth/google?code=${CODE}`))).toBe(true);
    expect(isAuthLink(parsePhoneLink('https://nufurora.com/#/movie/abc'))).toBe(false);
    expect(isAuthLink(null)).toBe(false);
  });
});

describe('the hand-off kept before the tab opens (a cold start can finish it)', () => {
  const now = 1_800_000_000_000;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const keep = (o: object) => JSON.stringify({verifier, intent: 'signin', startedAt: now - 1000, ...o});
  test('a verifier is 43 base64url characters (32 random bytes)', () => {
    expect(verifier).toHaveLength(43);
    expect(isVerifier(verifier)).toBe(true);
    expect(isVerifier('short')).toBe(false);
    expect(isVerifier(verifier.slice(0, 42) + '=')).toBe(false);
  });
  test('the challenge the server checks: base64url(sha256(verifier)) — RFC 7636’s own example', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(crypto.createHash('sha256').update(v, 'ascii').digest('base64url')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  test('whole and fresh: used', () => {
    expect(readPending(keep({}), now)).toEqual({verifier, intent: 'signin', startedAt: now - 1000});
    for (const intent of ['signin', 'signup', 'reset']) expect(readPending(keep({intent}), now)?.intent).toBe(intent);
  });
  test('ten minutes old, from the future, broken or for something else: never used', () => {
    expect(readPending(keep({startedAt: now - PENDING_TTL_MS - 1}), now)).toBeNull();
    expect(readPending(keep({startedAt: now - PENDING_TTL_MS + 1000}), now)).not.toBeNull();
    expect(readPending(keep({startedAt: now + 5 * 60_000}), now)).toBeNull();
    expect(readPending(keep({intent: 'admin'}), now)).toBeNull();
    expect(readPending(keep({verifier: 'x'}), now)).toBeNull();
    expect(readPending('{not json', now)).toBeNull();
    expect(readPending(null, now)).toBeNull();
  });
});

describe('which Google way runs (the server decides with googleApp)', () => {
  test('the Custom Tab when the server says it can come back; else the code on screen; else none', () => {
    expect(googleWay({googleApp: true, googleDevice: true})).toBe('tab');
    expect(googleWay({googleApp: false, googleDevice: true})).toBe('device');
    expect(googleWay({googleApp: false, googleDevice: false})).toBeNull();
    expect(googleWay({})).toBeNull();
    expect(googleWay(null)).toBeNull();
  });
});

describe('what a finished Google step means', () => {
  test('a linked profile signs in; an unknown account goes on to the request form; reset goes to the new password', () => {
    expect(googleStep({profile: {id: 'p1'}, profileToken: 't', session: 's'}).kind).toBe('signedIn');
    expect(googleStep({signup: {email: 'a@b.c', name: 'Ann'}, pollId: 'P'})).toEqual({kind: 'signup', email: 'a@b.c', name: 'Ann', pollId: 'P'});
    expect(googleStep({reset: {token: 'RT', name: 'Ann'}})).toEqual({kind: 'reset', token: 'RT', name: 'Ann'});
    expect(googleStep({pending: true}).kind).toBe('pending');
    expect(googleStep({}).kind).toBe('unknown');
    expect(googleStep({signup: {email: 'a@b.c'}}).kind).toBe('unknown'); // no proof to send with it
  });
  test('a used or expired hand-off says so plainly', () => {
    expect(googleRefusal({status: 410, code: 'used'})).toBe(W.errGoogleUsed);
    expect(googleRefusal({status: 410, code: 'expired'})).toBe(W.errGoogleLate);
    expect(googleRefusal({status: 400, message: "This sign-in was started on another device."})).toBe('This sign-in was started on another device.');
    expect(googleRefusal({status: 0, message: 'Cannot reach server'})).toBe(W.errOffline);
  });
});

describe('the forms check before they send (contract words, next to the field)', () => {
  test('sign in', () => {
    expect(signInProblems('', '')).toEqual({identifier: W.errIdentifier, password: W.errPassword});
    expect(signInProblems('  ', 'x')).toEqual({identifier: 'Enter your username or email.'});
    expect(hasProblems(signInProblems('dana', 'x'))).toBe(false);
  });
  const f = (o: object = {}) => ({name: 'Dana', username: 'dana', email: '', password: 'abcd', confirm: 'abcd', note: '', ...o});
  test('request access: a password ALWAYS (Google or not), typed twice', () => {
    expect(requestProblems(f({password: '', confirm: ''}))).toEqual({password: 'Use at least 4 characters.'});
    expect(requestProblems(f({password: '', confirm: ''}), true)).toEqual({password: 'Use at least 4 characters.'});
    expect(requestProblems(f({confirm: 'abce'}))).toEqual({confirm: "The passwords don't match."});
    expect(requestProblems(f())).toEqual({});
  });
  test('request access: a name; a username or an email (Google brings the email)', () => {
    expect(requestProblems(f({name: ' '})).name).toBe(W.errName);
    expect(requestProblems(f({username: '', email: ''})).username).toBe(W.errHow);
    expect(requestProblems(f({username: '', email: ''}), true)).toEqual({});
    expect(requestProblems(f({email: 'not-an-email'})).email).toBe(W.errEmail);
    expect(firstProblem(requestProblems(f({name: '', confirm: 'x'})), ['name', 'username', 'email', 'password', 'confirm'])).toBe('name');
  });
  test('the request body: trimmed, the password as typed, the Google proof when there is one', () => {
    expect(requestBody(f({name: ' Dana ', note: ' hi ', password: ' pw1 '}))).toEqual({name: 'Dana', username: 'dana', email: '', password: ' pw1 ', note: 'hi'});
    expect(requestBody(f(), 'POLL').pollId).toBe('POLL');
    expect('pollId' in requestBody(f(), null)).toBe(false);
  });
  test('a new password: the rule, then the match; the current one only when asked for', () => {
    expect(newPasswordProblems({fresh: 'ab', confirm: 'ab'})).toEqual({newPassword: W.errShort});
    expect(newPasswordProblems({fresh: 'abcd', confirm: 'abce'})).toEqual({confirm: W.errMismatch});
    expect(newPasswordProblems({fresh: 'abcd', confirm: 'abcd', askCurrent: true, current: ''})).toEqual({current: W.errCurrent});
    expect(newPasswordProblems({fresh: 'abcd', confirm: 'abcd'})).toEqual({});
  });
});

describe('the server’s refusals, said where they belong', () => {
  test('too many tries: the wait, in minutes', () => {
    expect(refusalProblem({status: 429, retryAfter: 600, message: 'x'})).toEqual({text: 'Too many tries. Wait 10 minutes, then try again.'});
    expect(refusalProblem({status: 429, retryAfter: 30})).toEqual({text: 'Too many tries. Wait 1 minute, then try again.'});
  });
  test('no connection', () => {
    expect(refusalProblem({status: 0, message: 'Cannot reach server'})).toEqual({text: W.errOffline});
  });
  test('a wrong sign-in goes under the password, in the server’s words or the contract’s', () => {
    expect(refusalProblem({status: 401, message: ''}, {wrongField: 'password'})).toEqual({field: 'password', text: W.errWrong});
    expect(refusalProblem({status: 401, message: "That username and password don't match. Check them, or reset your password."}, {wrongField: 'password'}).field).toBe('password');
  });
  test('the server’s field and code put the words next to the right input', () => {
    expect(refusalProblem({status: 400, field: 'username', code: 'taken', message: 'That username is taken'})).toEqual({field: 'username', text: 'That username is taken.'});
    expect(refusalProblem({status: 400, field: 'password', code: 'short', message: ''})).toEqual({field: 'password', text: W.errShort});
    expect(refusalProblem({status: 400, field: 'password', code: 'short'}, {fieldMap: {password: 'newPassword'}}).field).toBe('newPassword');
    expect(refusalProblem({status: 400, code: 'same'})).toEqual({field: 'newPassword', text: W.errSame});
    expect(refusalProblem({status: 500, message: '500 /api/auth/signup'})).toEqual({text: W.failed});
  });
});

describe('password reset', () => {
  test('the ways offered: Google only where it runs here, email only when the server has it on', () => {
    expect(resetWays({google: true, email: false, admin: true}, true)).toEqual({google: true, admin: true, code: true, email: false});
    expect(resetWays({google: true, email: true, admin: true}, false)).toEqual({google: false, admin: true, code: true, email: true});
    expect(resetWays(null, true)).toEqual({google: false, admin: true, code: true, email: false});
  });
  test('the ask-the-admin wait: approved carries on by itself; declined and expired say so', () => {
    expect(askStep({status: 'pending'})).toEqual({kind: 'wait'});
    expect(askStep({status: 'approved', token: 'T', name: 'Dana'})).toEqual({kind: 'approved', token: 'T', name: 'Dana'});
    expect(askStep({status: 'approved'})).toEqual({kind: 'wait'});
    expect(askStep({status: 'declined'})).toEqual({kind: 'declined'});
    expect(askStep({status: 'expired'})).toEqual({kind: 'expired'});
    expect(askStep({status: 'used'})).toEqual({kind: 'expired'});
    expect(askStep(null)).toEqual({kind: 'wait'});
  });
  test('a reset code as typed: capitals, no spaces or dashes', () => {
    expect(typedResetCode('ab12-cd 34')).toBe('AB12CD34');
    expect(typedResetCode('x'.repeat(40)).length).toBe(12);
  });
  test('the words the contract fixes', () => {
    expect(W.forgotTitle).toBe('Reset your password');
    expect(W.wayAdmin('Elia')).toBe('Ask Elia');
    expect(W.askSentLine('Elia')).toBe('Keep this screen open. When Elia approves, you can choose a new password here. You can also ask Elia for a reset code.');
    expect(W.requestLine('the admin')).toBe("The admin approves new people. Once you're approved, sign in with the details you set here.");
    expect(W.elsewhere).toBe('Still signed in on your phone or computer? Change it in Settings there.');
    expect(W.google).toBe('Continue with Google');
    expect(W.googleSignUp).toBe('Sign up with Google');
  });
});

describe('the phone app hands Google to a Custom Tab and gets the answer back', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  test('the manifest routes aurora-phone:// to the one singleTask activity and can see browsers', () => {
    const m = read('android/app/src/phone/AndroidManifest.xml');
    expect(m).toMatch(/android:launchMode="singleTask"/);
    expect(m).toMatch(/<data android:scheme="aurora-phone" \/>/);
    expect(m).toMatch(/android\.support\.customtabs\.action\.CustomTabsService/);
  });
  test('the verifier is made with SecureRandom and the challenge is S256 (PhoneModule.kt)', () => {
    const k = read('android/app/src/main/java/com/auroratv/phone/PhoneModule.kt');
    expect(k).toMatch(/SecureRandom\(\)\.nextBytes\(bytes\)/);
    expect(k).toMatch(/ByteArray\(32\)/);
    expect(k).toMatch(/MessageDigest\.getInstance\("SHA-256"\)/);
    expect(k).toMatch(/URL_SAFE or android\.util\.Base64\.NO_PADDING/);
  });
  test('the version the phone says is the one Gradle builds', () => {
    const g = read('android/app/build.gradle');
    const u = read('src/update.ts');
    const name = /applicationId "com\.aurora\.phone"\s+versionCode (\d+)\s+versionName "([^"]+)"/.exec(g);
    expect(name && name[2]).toBe(/PHONE_APP_VERSION = '([^']+)'/.exec(u)?.[1]);
  });
});
