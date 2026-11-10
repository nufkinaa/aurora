// The report trail in the apps (docs/report-trail.md): src/trail.ts (the ring
// and its central hooks), src/reportFields.ts appFacts, src/clientContext.ts
// reportPeek. The rules themselves (trailCore.ts) are run side by side with
// the site's in test/report-trail.test.js.
import {recentRequests, trail, trailKey, trailRequest, trailScreen, trailTake} from '../../src/trail';
import {clearProfileCaches} from '../../src/profileScope';
import {appFacts, originOf} from '../../src/reportFields';
import {trailText} from '../../src/trailCore';

const kinds = () => trailTake().map(e => e.k);

beforeEach(() => clearProfileCaches());

test('another profile: the trail starts over, and says so', () => {
  trail('toast', {m: 'from the last person'});
  clearProfileCaches();
  const out = trailTake();
  expect(out.map(e => [e.k, e.e])).toEqual([['app', 'profile']]);
  expect(recentRequests()).toEqual([]);
});

test('keys: by name, key-downs only, never a focus move', () => {
  trailKey({eventType: 'down', eventKeyAction: 0});
  trailKey({eventType: 'down', eventKeyAction: 1}); // its key-up
  trailKey({eventType: 'down', eventKeyAction: 0});
  trailKey({eventType: 'focus'});
  trailKey({eventType: 'blur'});
  trailKey({eventType: 'select'});
  const keys = trailTake().filter(e => e.k === 'key');
  expect(keys.map(e => [e.key, e.n || 1])).toEqual([
    ['down', 2],
    ['select', 1],
  ]);
});

test('requests: every one timed; the trail gets writes, failures, slow answers and the search run — never a query string', () => {
  trailRequest('GET', '/api/item/abc?profile=p1', 200, 40);
  trailRequest('GET', '/api/item/abc?profile=p1', 500, 40);
  trailRequest('POST', '/api/mylist/abc', 200, 30);
  trailRequest('GET', '/api/library', 200, 2500);
  trailRequest(undefined, '/api/search?v=2&q=the%20bear&commit=1', 200, 90);
  trailRequest('POST', '/api/play-mark/abc', 200, 20); // the app's own reporting: not a step…
  trailRequest('POST', '/api/play-mark/abc', 0, 20); // …unless it fails
  trailRequest('GET', '/api/auth/sessions/9f2c4d1e7a6b5c3d', 200, 15);
  const reqs = trailTake().filter(e => e.k === 'req');
  expect(reqs.map(e => `${e.m} ${e.p} ${e.s}`)).toEqual([
    'GET /api/item/abc 500',
    'POST /api/mylist/abc 200',
    'GET /api/library 200',
    'POST /api/play-mark/abc 0',
  ]);
  expect(trailTake().find(e => e.k === 'search')?.q).toBe('the bear');
  const timed = recentRequests();
  expect(timed.map(r => r.p)).toEqual(['/api/item/abc', '/api/item/abc', '/api/mylist/abc', '/api/library', '/api/search', '/api/auth/sessions/…']);
  expect(JSON.stringify(trailTake())).not.toMatch(/profile=|9f2c4d1e7a6b5c3d|commit/);
});

test('screens: the route name with its kind, and the title id when the screen has one', () => {
  trailScreen('tv', {name: 'Detail', params: {id: 'tt0903747', type: 'show'}});
  trailScreen('phone', {name: 'Browse', params: {kind: 'movie'}});
  trailScreen('tv', undefined);
  const nav = trailTake().filter(e => e.k === 'nav');
  expect(nav.map(e => [e.s, e.id])).toEqual([
    ['tv:detail', 'tt0903747'],
    ['phone:browse/movie', undefined],
  ]);
});

test('sheets and toasts reach the trail from their one place each', () => {
  const {openReport, closeOverlay} = require('../../src/overlay');
  const {showToast} = require('../../src/toast');
  openReport('from the player');
  closeOverlay();
  showToast('Sent — thank you. It landed with the admin.');
  expect(kinds()).toEqual(['app', 'sheet', 'sheet', 'toast']);
  const [, open, closed] = trailTake();
  expect([open.s, open.on, closed.on]).toEqual(['report', true, false]);
});

test('the facts a TV sends: names the site uses, origin only for the server, nothing missing is invented', () => {
  expect(originOf('http://10.0.0.3:4000/some/path?x=1')).toBe('http://10.0.0.3:4000');
  expect(originOf('')).toBeUndefined();
  const f = appFacts({
    phone: false,
    version: '5.9.2',
    build: 224,
    release: '9',
    api: 28,
    brand: 'Xiaomi',
    model: 'MiTV-AXSO0',
    screen: {width: 960, height: 540, scale: 2},
    window: {width: 960, height: 540},
    locale: 'he-IL',
    tz: 'Asia/Jerusalem',
    lowRam: false,
    auth: 'closed',
    signedIn: true,
    server: 'https://nufurora.com/',
    socket: true,
    upMs: 61000,
  });
  expect(f).toEqual({
    app: 'tv',
    v: '5.9.2',
    build: 224,
    os: 'Android 9 (API 28)',
    model: 'Xiaomi MiTV-AXSO0',
    screen: '1920×1080 @2x',
    viewport: '960×540 dp',
    lang: 'he-IL',
    tz: 'Asia/Jerusalem',
    lowRam: false,
    auth: 'closed',
    signedIn: true,
    server: 'https://nufurora.com',
    socket: 'open',
    up: 61,
  });
  expect(appFacts({phone: true, version: '1.1.2'})).toEqual({app: 'phone', v: '1.1.2'});
  expect(trailText({env: f})).toMatch(/system: Android 9 \(API 28\)/);
});
