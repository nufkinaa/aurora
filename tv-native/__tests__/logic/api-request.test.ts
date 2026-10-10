// request(): what a screen is told when the answer is not what was asked for.
import {api, ApiError, onPasswordResetRequired, onSigninRequired, setBaseUrl, setSession, setToken} from '../../src/api';
import {queue, resetXhr, sent} from './fake-xhr';

beforeEach(() => {
  resetXhr();
  setBaseUrl('http://tv.test');
});

test('a 200 that is not JSON is an ApiError with a readable message, not a SyntaxError', async () => {
  queue({status: 200, body: '<!doctype html><title>Welcome to the hotel Wi-Fi</title>'});
  const e = await api.profiles().then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(0);
  expect((e as ApiError).message).toBe('The server sent an answer the app could not read');
});

test('an empty 200 is the same error (it was a rejection before, too)', async () => {
  queue({status: 200, body: ''});
  await expect(api.profiles()).rejects.toMatchObject({status: 0});
});

test('a JSON answer is handed over as before', async () => {
  queue({status: 200, body: '[{"id":"p1","name":"Elia"}]'});
  await expect(api.profiles()).resolves.toEqual([{id: 'p1', name: 'Elia'}]);
});

test("an error status still carries the server's own words", async () => {
  queue({status: 429, body: '{"error":"too many attempts"}'});
  await expect(api.profiles()).rejects.toMatchObject({status: 429, message: 'too many attempts'});
});

test('an error status with a page for a body falls back to the status line', async () => {
  queue({status: 502, body: '<html>Bad gateway</html>'});
  await expect(api.profiles()).rejects.toMatchObject({status: 502, message: '502 /api/profiles'});
});

// ---- the forced reset and the admin's sign-out (server 1.6.91, lib/resetgate.js)
describe('a refused credential', () => {
  const heard: string[] = [];
  let now = 1_000_000;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    heard.length = 0;
    now += 10_000; // past the once-per-burst window of the test before
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    onSigninRequired(o => heard.push(o.signedOut ? 'signin:signedOut' : 'signin'));
    onPasswordResetRequired(id => heard.push(`reset:${id}`));
  });
  afterEach(() => {
    clock.mockRestore();
    onSigninRequired(null);
    onPasswordResetRequired(null);
    setSession(null);
    setToken(null);
  });

  test('a must-reset refusal is read as a RESET, never as "sign in again" (it says both)', async () => {
    queue({status: 401, body: JSON.stringify({error: 'A new password is needed', signinRequired: true, passwordResetRequired: true, profileId: 'p1'})});
    const e = (await api.library().then(
      () => null,
      (err: unknown) => err,
    )) as ApiError;
    expect(e.status).toBe(401);
    expect(e.passwordResetRequired).toBe(true);
    expect(e.signinRequired).toBeUndefined();
    // the sign-in hook did not fire: it would have thrown the credentials away
    expect(heard).toEqual(['reset:p1']);
  });

  test('a credential the admin ended says so: signedOut rides to the app', async () => {
    queue({status: 401, body: JSON.stringify({error: 'You were signed out — sign in again.', signinRequired: true, signedOut: true})});
    const e = (await api.library(true).then(
      () => null,
      (err: unknown) => err,
    )) as ApiError;
    expect(e.signinRequired).toBe(true);
    expect(e.signedOut).toBe(true);
    expect(heard).toEqual(['signin:signedOut']);
  });

  test('the wall of a closed house is the plain one', async () => {
    queue({status: 401, body: JSON.stringify({error: 'sign in first', signinRequired: true})});
    await expect(api.library(true)).rejects.toMatchObject({signinRequired: true});
    expect(heard).toEqual(['signin']);
  });

  test('saving the new password: sent with the restricted credentials, and the fresh ones come back', async () => {
    setSession('restricted-session');
    setToken('restricted-token');
    queue({status: 200, body: JSON.stringify({ok: true, token: 'fresh-token', session: 'fresh-session', passwordReset: 'done'})});
    const r = await api.setPassword('p1', 'new-pass', 'old-pass');
    expect(r).toMatchObject({token: 'fresh-token', session: 'fresh-session', passwordReset: 'done'});
    const req = sent[sent.length - 1];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://tv.test/api/profiles/p1/password');
    expect(req.headers['X-Session']).toBe('restricted-session');
    expect(req.headers['X-Profile-Token']).toBe('restricted-token');
  });

  test('a refused save carries the status and the server’s code', async () => {
    queue({status: 400, body: JSON.stringify({error: 'that is the old password — pick a different one', code: 'same'})});
    await expect(api.setPassword('p1', 'same', 'same')).rejects.toMatchObject({status: 400, code: 'same'});
    queue({status: 401, body: JSON.stringify({error: 'wrong password'})});
    await expect(api.setPassword('p1', 'new-pass', 'nope')).rejects.toMatchObject({status: 401, message: 'wrong password'});
    // (a wrong current password is not a sign-out)
    expect(heard).toEqual([]);
  });

  test('/api/me for a must-reset session names who has to pick the password', async () => {
    queue({status: 200, body: JSON.stringify({authMode: 'closed', user: null, passwordResetRequired: true, resetProfile: {id: 'p1', name: 'Elia'}})});
    const who = await api.me();
    expect(who.user).toBeNull();
    expect(who.passwordResetRequired).toBe(true);
    expect(who.resetProfile).toMatchObject({id: 'p1', name: 'Elia'});
  });
});
