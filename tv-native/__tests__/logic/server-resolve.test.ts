// resolveServer (src/api.ts) on top of pickServer: the real ping, a faked
// network and jest's clock. What is checked here is what pickServer cannot
// see — that only the CHOSEN server's answer about itself is applied.
import {getAuthMode, resolveServer, serverCanBlur, SERVER_CANDIDATES} from '../../src/api';

const [FIRST, SECOND] = SERVER_CANDIDATES.map(u => u.replace(/\/+$/, ''));

type Reply = {after: number; body: unknown} | null; // null: never answers
const network = (byUrl: Record<string, Reply>) => {
  const asked: string[] = [];
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((u: string) => {
    const base = u.replace(/\/api\/ping$/, '');
    asked.push(base);
    const r = byUrl[base];
    if (!r) return new Promise(() => {});
    return new Promise(resolve => setTimeout(() => resolve({ok: true, json: async () => r.body}), r.after));
  });
  return asked;
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const run = async () => {
  const p = resolveServer();
  await jest.advanceTimersByTimeAsync(20000);
  return p;
};

test('the first address answers: it is the server, and the second is not asked', async () => {
  const asked = network({
    [FIRST]: {after: 300, body: {ok: true, authMode: 'closed', imgBlur: true}},
    [SECOND]: {after: 10, body: {ok: true, authMode: 'open'}},
  });
  expect(await run()).toBe(FIRST);
  expect(asked).toEqual([FIRST]);
  expect(getAuthMode()).toBe('closed');
  expect(serverCanBlur()).toBe(true);
});

test('the first address is silent: the second becomes the server, with ITS sign-in mode', async () => {
  const asked = network({[FIRST]: null, [SECOND]: {after: 10, body: {ok: true, authMode: 'open'}}});
  expect(await run()).toBe(SECOND);
  expect(asked).toEqual([FIRST, FIRST, SECOND]);
  expect(getAuthMode()).toBe('open');
  expect(serverCanBlur()).toBe(false);
});

test('an answer that arrives after its address was given up on changes nothing', async () => {
  // the first address answers at 6 s — after both of its tries timed out and
  // the second address had been chosen
  network({
    [FIRST]: {after: 6000, body: {ok: true, authMode: 'closed', imgBlur: true}},
    [SECOND]: {after: 10, body: {ok: true, authMode: 'open', imgBlur: false}},
  });
  expect(await run()).toBe(SECOND); // (run() lets the late answer land too)
  expect(getAuthMode()).toBe('open');
  expect(serverCanBlur()).toBe(false);
});

test('neither answers: null', async () => {
  network({[FIRST]: null, [SECOND]: null});
  expect(await run()).toBeNull();
});
