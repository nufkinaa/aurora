// artPath: which pictures go through the server's sized-art proxy.
// Episode stills (episodes.metahub.space) do — but only against a server
// that says it proxies that host; an older one would answer 403.
import {artPath, artSrc, resolveServer, setBaseUrl, SERVER_CANDIDATES} from '../../src/api';

const STILL = 'https://episodes.metahub.space/tt0903747/1/1/w780.jpg';
const POSTER = 'https://images.metahub.space/poster/small/tt0903747/img';

const serverSays = (byUrl: Record<string, unknown | null>) => {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (u: string) => {
    const base = u.replace(/\/api\/ping$/, '');
    const body = byUrl[base];
    if (body == null) throw new Error('unreachable');
    return {ok: true, json: async () => body};
  });
};
// the first address tried, and the one tried when it does not answer
const [FIRST, SECOND] = SERVER_CANDIDATES.map(u => u.replace(/\/+$/, ''));

beforeEach(() => setBaseUrl('http://tv.test'));

test('the hosts every server proxies are sized, whatever the server says', async () => {
  serverSays({[FIRST]: {ok: true, authMode: 'open'}});
  await resolveServer();
  expect(artPath(POSTER, 256)).toBe(`/img/ext?u=${encodeURIComponent(POSTER)}&w=256`);
});

test('an older server (no imgHosts): the episode still is NOT sent through the proxy', async () => {
  serverSays({[FIRST]: {ok: true, authMode: 'open', imgBlur: true}});
  await resolveServer();
  expect(artPath(STILL, 448)).toBeNull();
  expect(artSrc(STILL, 190)).toEqual({src: {uri: STILL}, sized: false});
});

test('a server that lists the host: the still is asked for at the drawn width', async () => {
  serverSays({[FIRST]: {ok: true, authMode: 'open', imgBlur: true, imgHosts: ['episodes.metahub.space']}});
  await resolveServer();
  expect(artPath(STILL, 448)).toBe(`/img/ext?u=${encodeURIComponent(STILL)}&w=448`);
  const s = artSrc(STILL, 190);
  expect(s.sized).toBe(true);
  expect(s.src?.uri).toBe(`http://tv.test/img/ext?u=${encodeURIComponent(STILL)}&w=448`);
});

test('a host the app does not know is never proxied because a server named it', async () => {
  serverSays({[FIRST]: {ok: true, imgHosts: ['evil.example', 'episodes.metahub.space', 7]}});
  await resolveServer();
  expect(artPath('https://evil.example/x.jpg', 448)).toBeNull();
  expect(artPath(STILL, 448)).not.toBeNull();
});

test('the answer is the chosen server’s: the first address down, an older second one in use', async () => {
  // first a run on a new server at the first address…
  serverSays({[FIRST]: {ok: true, imgHosts: ['episodes.metahub.space']}});
  expect(await resolveServer()).toBe(FIRST);
  expect(artPath(STILL, 448)).not.toBeNull();
  // …then one where only the (older) second one answers
  serverSays({[FIRST]: null, [SECOND]: {ok: true, authMode: 'closed'}});
  expect(await resolveServer()).toBe(SECOND);
  expect(artPath(STILL, 448)).toBeNull();
});

test('http, another port, a look-alike host: never', async () => {
  serverSays({[FIRST]: {ok: true, imgHosts: ['episodes.metahub.space']}});
  await resolveServer();
  expect(artPath('http://episodes.metahub.space/a.jpg', 448)).toBeNull();
  expect(artPath('https://episodes.metahub.space.evil.example/a.jpg', 448)).toBeNull();
  expect(artPath('https://episodes.metahub.space:8443/a.jpg', 448)).toBeNull();
});
