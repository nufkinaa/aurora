// docs/operations.md, "What a client should do" — the rules, one by one
// (src/serverManners.ts), and the places that apply them: api.ts (429, the
// kept library list, one Home read at a time, the goodbye).
import {
  afterClaim,
  BUSY_TRIES,
  claimFirst,
  createRefresher,
  libraryRefreshDelay,
  nextReconnectStep,
  reconnectWait,
  restartWait,
  retryAfterMs,
  tooManyWait,
  whenRoom,
} from '../../src/serverManners';
import {api, setBaseUrl} from '../../src/api';
import {clearProfileCaches} from '../../src/profileScope';
import {queue, resetXhr, sent} from './fake-xhr';

describe('Retry-After', () => {
  test('seconds become milliseconds, within the cap; anything else is the fallback', () => {
    expect(retryAfterMs('2', 5000, 5000)).toBe(2000);
    expect(retryAfterMs('0', 5000, 5000)).toBe(0);
    expect(retryAfterMs('60', 5000, 5000)).toBe(5000);
    expect(retryAfterMs(null, 4000, 5000)).toBe(4000);
    expect(retryAfterMs('', 4000, 5000)).toBe(4000);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', 4000, 5000)).toBe(4000);
    expect(retryAfterMs('-3', 4000, 5000)).toBe(4000);
  });
});

describe('429', () => {
  test('a read waits Retry-After plus a random 0–1.5 s, twice at most', () => {
    expect(tooManyWait('GET', 0, '2', () => 0)).toBe(2000);
    expect(tooManyWait(undefined, 1, '2', () => 0.999)).toBe(3499);
    expect(tooManyWait('GET', 2, '2', () => 0)).toBeNull();
  });
  test('a write is never asked again (a sign-in limiter’s 429 is the answer)', () => {
    expect(tooManyWait('POST', 0, '2')).toBeNull();
    expect(tooManyWait('put', 0, '2')).toBeNull();
  });
  test('no Retry-After, or one measured in minutes, is the answer too', () => {
    expect(tooManyWait('GET', 0, null)).toBeNull();
    expect(tooManyWait('GET', 0, '600')).toBeNull();
    expect(tooManyWait('GET', 0, 'soon')).toBeNull();
  });
});

describe('the library changed', () => {
  test('Home on screen: within 0–0.3 s; otherwise 0.5–5 s', () => {
    expect(libraryRefreshDelay(true, () => 0)).toBe(0);
    expect(libraryRefreshDelay(true, () => 1)).toBe(300);
    expect(libraryRefreshDelay(false, () => 0)).toBe(500);
    expect(libraryRefreshDelay(false, () => 1)).toBe(5000);
  });

  const rig = (o: {home?: boolean; held?: boolean; rnd?: number} = {}) => {
    const s = {home: !!o.home, held: !!o.held, delivered: 0, waits: [] as number[]};
    let pending: null | (() => void) = null;
    const r = createRefresher({
      setTimeout: (fn, ms) => {
        s.waits.push(ms);
        pending = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {
        pending = null;
      },
      rnd: () => o.rnd ?? 0.5,
      homeOnScreen: () => s.home,
      held: () => s.held,
      deliver: () => {
        s.delivered += 1;
      },
    });
    const tick = () => {
      const fn = pending;
      pending = null;
      fn?.();
    };
    return {r, s, tick, hasTimer: () => !!pending};
  };

  test('however many messages arrive while one refresh is pending, there is one refresh', () => {
    const {r, s, tick} = rig();
    for (let i = 0; i < 20; i++) r.changed();
    expect(s.waits).toEqual([2750]);
    tick();
    expect(s.delivered).toBe(1);
    // a later change is a new refresh
    r.changed();
    tick();
    expect(s.delivered).toBe(2);
  });

  test('the wait is the short one when Home is the screen being looked at', () => {
    const {r, s} = rig({home: true, rnd: 1});
    r.changed();
    expect(s.waits).toEqual([300]);
  });

  test('while a film plays nothing is scheduled; leaving the player owes one refresh, after the usual wait', () => {
    const {r, s, tick, hasTimer} = rig({held: true});
    r.changed();
    r.changed();
    expect(hasTimer()).toBe(false);
    expect(s.delivered).toBe(0);
    s.held = false;
    r.release();
    expect(s.waits).toHaveLength(1);
    tick();
    expect(s.delivered).toBe(1);
    // nothing more is owed
    r.release();
    expect(hasTimer()).toBe(false);
  });

  test('a film started while a refresh was pending: it is not delivered behind the player, and is owed', () => {
    const {r, s, tick} = rig();
    r.changed();
    s.held = true;
    tick();
    expect(s.delivered).toBe(0);
    expect(r.state()).toEqual({pending: false, stale: true});
    s.held = false;
    r.release();
    tick();
    expect(s.delivered).toBe(1);
  });

  test('release with nothing owed, or while still held, does nothing; cancel forgets everything', () => {
    const {r, s, hasTimer} = rig({held: true});
    r.release();
    expect(hasTimer()).toBe(false);
    r.changed();
    r.release(); // still held
    expect(hasTimer()).toBe(false);
    r.cancel();
    s.held = false;
    r.release();
    expect(hasTimer()).toBe(false);
    expect(s.delivered).toBe(0);
  });
});

describe('the socket', () => {
  test('a reconnect waits between half of the step and all of it; the step doubles to 30 s', () => {
    expect(reconnectWait(1000, () => 0)).toBe(500);
    expect(reconnectWait(1000, () => 1)).toBe(1000);
    expect(reconnectWait(30000, () => 0.5)).toBe(22500);
    let step = 1000;
    const steps = [];
    for (let i = 0; i < 7; i++) steps.push((step = nextReconnectStep(step)));
    expect(steps).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
  test('after server_restarting: what the server asked plus a random 0–3 s', () => {
    expect(restartWait(2000, () => 0)).toBe(2000);
    expect(restartWait(2000, () => 1)).toBe(5000);
    expect(restartWait(undefined, () => 0)).toBe(2000); // closed with 1012, the message never came
    expect(restartWait('soon', () => 0)).toBe(2000);
    expect(restartWait(3600000, () => 0)).toBe(60000); // within reason
  });
});

describe('503 on a stream', () => {
  const run = async (answers: ({status: number; retryAfter?: string | null} | 'throw')[], alive: () => boolean = () => true) => {
    const waits: number[] = [];
    let asks = 0;
    const out = await whenRoom(
      async () => {
        const a = answers[Math.min(asks++, answers.length - 1)];
        if (a === 'throw') throw new Error('line');
        return a;
      },
      {sleep: async ms => void waits.push(ms), alive},
    );
    return {out, waits, asks};
  };

  test('room at once: one request, no wait', async () => {
    const {out, waits, asks} = await run([{status: 200}]);
    expect(out).toEqual({kind: 'answered', status: 200, waited: 0});
    expect(waits).toEqual([]);
    expect(asks).toBe(1);
  });

  test('busy, then room: waits what the server said — 5 s at most — and asks again', async () => {
    const {out, waits, asks} = await run([{status: 503, retryAfter: '2'}, {status: 503, retryAfter: '30'}, {status: 200}]);
    expect(out).toEqual({kind: 'answered', status: 200, waited: 2});
    expect(waits).toEqual([2000, 5000]);
    expect(asks).toBe(3);
  });

  test('busy for good: three waits, four requests, then it stops — never a loop', async () => {
    const {out, waits, asks} = await run([{status: 503}]);
    expect(out).toEqual({kind: 'busy', waited: BUSY_TRIES});
    expect(waits).toEqual([5000, 5000, 5000]); // (no Retry-After: 5 s)
    expect(asks).toBe(4);
  });

  test('an answer that is not "busy" is handed back as it is (the caller’s usual handling)', async () => {
    expect((await run([{status: 404}])).out).toEqual({kind: 'answered', status: 404, waited: 0});
    expect((await run([{status: 503}, {status: 500}])).out).toEqual({kind: 'answered', status: 500, waited: 1});
  });

  test('the request itself failing is not a busy server', async () => {
    expect((await run(['throw'])).out).toEqual({kind: 'failed', waited: 0});
    expect((await run([{status: 503, retryAfter: '1'}, 'throw'])).out).toEqual({kind: 'failed', waited: 1});
  });

  test('the viewer left while waiting: nothing more is asked', async () => {
    let alive = true;
    const waits: number[] = [];
    let asks = 0;
    const out = await whenRoom(
      async () => {
        asks += 1;
        return {status: 503, retryAfter: '1'};
      },
      {
        sleep: async ms => {
          waits.push(ms);
          alive = false;
        },
        alive: () => alive,
      },
    );
    expect(out).toEqual({kind: 'gone', waited: 1});
    expect(asks).toBe(1);
  });
});

// THE START OF AN ENCODE ASKS FIRST (claimFirst / afterClaim): the busy path
// had never been seen working on a TV because ExoPlayer read the refused
// playlist again by itself before the app's wait saw the 503.
describe('a start that asks first', () => {
  test('an encode that has not played asks first; a copy, or a change after something played, does not', () => {
    expect(claimFirst('h264', false)).toBe(true);
    expect(claimFirst('h264-480', false)).toBe(true);
    expect(claimFirst('copy', false)).toBe(false); // never refused: the quicker start stays
    expect(claimFirst('h264', true)).toBe(false);
  });

  test('what the answer means for the player', () => {
    expect(afterClaim({kind: 'answered', status: 200, waited: 0})).toBe('play');
    expect(afterClaim({kind: 'answered', status: 504, waited: 1})).toBe('play'); // not "busy": the player's own read judges
    expect(afterClaim({kind: 'failed', waited: 0})).toBe('play');
    expect(afterClaim({kind: 'busy', waited: BUSY_TRIES})).toBe('busy');
    expect(afterClaim({kind: 'gone', waited: 1})).toBe('none');
  });

  // The start, end to end, as the player runs it (Player.tsx startTranscode
  // → claimStream): a server that is busy twice and then has room. The
  // player — which would retry a 503 by itself — is handed the source only
  // after the claim heard "room", so it never meets the refusal.
  const start = async (answers: number[]) => {
    const log: string[] = [];
    let asks = 0;
    const server = () => answers[Math.min(asks++, answers.length - 1)];
    const v = 'h264';
    const first = claimFirst(v, false);
    let handedAt = -1;
    const hand = () => {
      handedAt = asks;
      log.push(`player: source (the server would answer ${server()})`);
    };
    if (!first) hand();
    const out = await whenRoom(async () => {
      const status = server();
      log.push(`claim: ${status}`);
      return {status, retryAfter: '1'};
    }, {sleep: async () => void log.push('wait'), alive: () => true});
    const next = afterClaim(out);
    if (first && next === 'play') hand();
    return {log, next, handedAt};
  };

  test('busy, busy, room: two waits, then the player gets the source — and its first read finds room', async () => {
    const r = await start([503, 503, 200]);
    expect(r.next).toBe('play');
    expect(r.log).toEqual(['claim: 503', 'wait', 'claim: 503', 'wait', 'claim: 200', 'player: source (the server would answer 200)']);
  });

  test('busy for good: the player is never handed a source the server refuses; the viewer gets the one message', async () => {
    const r = await start([503]);
    expect(r.next).toBe('busy');
    expect(r.handedAt).toBe(-1);
    expect(r.log.filter(l => l.startsWith('claim'))).toHaveLength(1 + BUSY_TRIES);
  });
});

// ---- api.ts ---------------------------------------------------------------
describe('api.ts', () => {
  const lib = (t: string) => JSON.stringify({movies: [{id: 'm1', title: t}], shows: []});
  const home = (t: string) => JSON.stringify({hero: [], rows: [{id: 'continue', title: 'Continue', items: [{id: 'a', title: t}]}]});
  let rnd: jest.SpyInstance;
  beforeEach(() => {
    resetXhr();
    clearProfileCaches();
    setBaseUrl('http://tv.test');
    rnd = jest.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => rnd.mockRestore());

  test('429 + Retry-After on a read: waited out and asked again — the screen gets the answer, not an error', async () => {
    queue({status: 429, body: '{"error":"Too many requests at once"}', retryAfter: '0'}, {status: 200, body: lib('A')});
    const l = await api.library(true);
    expect(l.movies[0].title).toBe('A');
    expect(sent).toHaveLength(2);
  });

  test('429 three times: asked again twice, then the server’s words are the error', async () => {
    const no = {status: 429, body: '{"error":"Too many requests at once"}', retryAfter: '0'};
    queue(no, no, no);
    await expect(api.library(true)).rejects.toMatchObject({status: 429, message: 'Too many requests at once'});
    expect(sent).toHaveLength(3);
  });

  test('429 on a write (a sign-in limiter) is not repeated', async () => {
    queue({status: 429, body: '{"error":"too many attempts"}', retryAfter: '0'});
    await expect(api.playMark('x', {name: 'mount'})).rejects.toMatchObject({status: 429});
    expect(sent).toHaveLength(1);
  });

  test('the library list is asked conditionally, and a 304 is the same object', async () => {
    queue({status: 200, body: lib('A'), etag: '"L1"'}, {status: 304}, {status: 200, body: lib('B'), etag: '"L2"'});
    const a = await api.library(true);
    const b = await api.library(true);
    expect(b).toBe(a);
    expect(sent[0].headers['If-None-Match']).toBeUndefined();
    expect(sent[1].headers['If-None-Match']).toBe('"L1"');
    const c = await api.library(true);
    expect(c.movies[0].title).toBe('B');
    expect(sent[2].headers['If-None-Match']).toBe('"L1"');
  });

  test('a profile change forgets the kept library: the next profile is never asked with the last one’s ETag', async () => {
    queue({status: 200, body: lib('Grown-up'), etag: '"L1"'}, {status: 200, body: lib('Kids'), etag: '"K1"'});
    await api.library(true);
    clearProfileCaches();
    const k = await api.library(true);
    expect(sent[1].headers['If-None-Match']).toBeUndefined();
    expect(k.movies[0].title).toBe('Kids');
  });

  test('never more than one /api/home in flight: a second ask shares the first one’s answer', async () => {
    queue({status: 200, body: home('One'), etag: '"H1"'}, {status: 304});
    const [a, b] = await Promise.all([api.home('p1'), api.home('p1')]);
    expect(sent).toHaveLength(1);
    expect(b).toBe(a);
    // …and once it has landed, the next ask is a request of its own again
    await api.home('p1');
    expect(sent).toHaveLength(2);
  });

  test('the goodbye: one POST to the title’s bye route, and a refusal is nobody’s error', async () => {
    const calls: {url: string; method?: string}[] = [];
    const g = globalThis as unknown as {fetch: unknown};
    const before = g.fetch;
    g.fetch = async (url: string, init: {method?: string}) => {
      calls.push({url, method: init?.method});
      throw new Error('404 on an older server, or no line');
    };
    try {
      await expect(api.playBye('tt 1')).resolves.toBeUndefined();
    } finally {
      g.fetch = before;
    }
    expect(calls).toEqual([{url: 'http://tv.test/stream/transcode/tt%201/jit/bye', method: 'POST'}]);
    expect(sent).toHaveLength(0);
  });
});
