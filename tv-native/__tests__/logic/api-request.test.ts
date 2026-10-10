// request(): what a screen is told when the answer is not what was asked for.
import {api, ApiError, setBaseUrl} from '../../src/api';
import {queue, resetXhr} from './fake-xhr';

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
