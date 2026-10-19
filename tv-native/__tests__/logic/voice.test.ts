// Voice search on the TV (voice.ts): one listening, driven by a fake
// recogniser that behaves as AuroraVoice (VoiceModule.kt) does — the
// permission dialog, a TV with no recogniser, a service that will not serve
// another app (the system overlay instead), partial and final words, the mic
// pressed again, Back, a listening that never ends — and the remote's key.
import {createVoice, GRACE_MS, LISTEN_MAX_MS, NativeVoiceEvent, onVoiceKey, PermissionAnswer, searchLinkQuery, VoiceDeps, VoiceNative} from '../../src/voice';
import {VoiceState, voiceMessage} from '../../src/voiceLogic';

type Call = [string, ...unknown[]];
const fake = (opts: {
  avail?: Partial<{recognizer: boolean; intent: boolean; locale: string}> | null;
  granted?: boolean;
  answer?: PermissionAnswer;
}) => {
  const calls: Call[] = [];
  let listener: ((e: NativeVoiceEvent) => void) | null = null;
  const timers: {fn: () => void; ms: number; live: boolean}[] = [];
  const native: VoiceNative = {
    availability: async () => {
      calls.push(['availability']);
      if (opts.avail === null) throw new Error('no module');
      return {recognizer: true, intent: true, locale: 'en-US', ...(opts.avail || {})};
    },
    start: (lang, session) => calls.push(['start', lang, session]),
    startIntent: (lang, session) => calls.push(['startIntent', lang, session]),
    stop: () => calls.push(['stop']),
    cancel: () => calls.push(['cancel']),
  };
  const deps: VoiceDeps = {
    native,
    check: async () => {
      calls.push(['check']);
      return !!opts.granted;
    },
    ask: async () => {
      calls.push(['ask']);
      return opts.answer || 'granted';
    },
    subscribe: fn => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    setTimer: (fn, ms) => {
      const t = {fn, ms, live: true};
      timers.push(t);
      return t;
    },
    clearTimer: t => {
      (t as {live: boolean}).live = false;
    },
  };
  const states: VoiceState[] = [];
  const v = createVoice(deps, s => states.push(s));
  // what the recogniser says, for the session it was started with (or another)
  const say = (e: Omit<NativeVoiceEvent, 'session'>, session?: number) => {
    const started = [...calls].reverse().find(c => c[0] === 'start' || c[0] === 'startIntent');
    listener?.({session: session ?? (started ? (started[2] as number) : -1), ...e} as NativeVoiceEvent);
  };
  const runTimers = () => {
    const due = timers.filter(t => t.live);
    for (const t of due) {
      t.live = false;
      t.fn();
    }
    return due.map(t => t.ms);
  };
  return {v, calls, say, states, runTimers, names: () => calls.map(c => c[0])};
};
const flush = () => new Promise<void>(r => setImmediate(() => r()));

describe('a voice search on the TV', () => {
  test('permission already given: listening, words as they come, the final words', async () => {
    const f = fake({granted: true});
    await f.v.start('he');
    expect(f.names()).toEqual(['availability', 'check', 'start']);
    expect(f.calls[2]).toEqual(['start', 'he-IL', 1]);
    expect(f.v.state().phase).toBe('starting');
    f.say({type: 'ready'});
    expect(f.v.state().phase).toBe('listening');
    expect(voiceMessage(f.v.state(), 'tv')).toBe('Listening in Hebrew… say a title');
    f.say({type: 'level', level: 0.7});
    expect(f.v.level()).toBeCloseTo(0.7);
    f.say({type: 'partial', text: 'פאו'});
    f.say({type: 'partial', text: 'פאודה'});
    expect(f.v.state().interim).toBe('פאודה');
    f.say({type: 'final', text: 'פאודה'});
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'פאודה'});
    expect(f.v.level()).toBe(0);
    f.v.done();
    expect(f.v.state().phase).toBe('idle');
    // (ready, the level, two partials)
    expect(f.states.map(s => s.phase)).toEqual(['starting', 'listening', 'listening', 'listening', 'listening', 'heard', 'idle']);
  });

  test('the first time: Android asks; yes starts listening', async () => {
    const f = fake({granted: false, answer: 'granted'});
    await f.v.start('en');
    expect(f.names()).toEqual(['availability', 'check', 'ask', 'start']);
    expect(f.calls[3]).toEqual(['start', 'en-US', 1]);
  });

  test('permission refused: a message, nothing starts; refused for good: where to turn it on', async () => {
    let f = fake({granted: false, answer: 'denied'});
    await f.v.start('en');
    expect(f.names()).toEqual(['availability', 'check', 'ask']);
    expect(f.v.state()).toMatchObject({phase: 'error', error: 'denied'});
    expect(voiceMessage(f.v.state(), 'tv')).toMatch(/isn't allowed to use the microphone/);
    f = fake({granted: false, answer: 'never_ask_again'});
    await f.v.start('en');
    expect(f.v.state().error).toBe('blocked');
    expect(voiceMessage(f.v.state(), 'tv')).toMatch(/Settings → Apps → Aurora → Permissions/);
  });

  test('no recogniser at all: a clear message, no permission asked', async () => {
    const f = fake({avail: {recognizer: false, intent: false}});
    await f.v.start('en');
    expect(f.names()).toEqual(['availability']);
    expect(f.v.state()).toMatchObject({phase: 'error', error: 'unavailable'});
    expect(voiceMessage(f.v.state(), 'tv')).toBe('This TV has no speech recognition. Install or update the Google app to search by voice.');
    // and an app without the native module
    const g = createVoice(
      {native: null, check: async () => true, ask: async () => 'granted', subscribe: () => () => {}},
      () => {},
    );
    await g.start('en');
    expect(g.state().error).toBe('unavailable');
    // the module failing to answer is the same
    const h = fake({avail: null});
    await h.v.start('en');
    expect(h.v.state().error).toBe('unavailable');
  });

  test('no recognition service, but the system overlay: the overlay hears (no permission of ours needed)', async () => {
    const f = fake({avail: {recognizer: false, intent: true}});
    await f.v.start('he');
    expect(f.names()).toEqual(['availability', 'startIntent']);
    expect(f.v.viaOverlay()).toBe(true);
    f.say({type: 'ready'});
    f.say({type: 'final', text: 'shtisel'});
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'shtisel'});
    // the overlay closed with Back
    await f.v.start('he');
    f.say({type: 'ready'});
    f.say({type: 'error', code: 'cancelled'});
    expect(f.v.state().phase).toBe('idle');
  });

  test("a service that will not serve us (ERROR_CLIENT before it was ready): the overlay instead, once", async () => {
    const f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'error', code: 5});
    expect(f.names()).toEqual(['availability', 'check', 'start', 'startIntent']);
    expect(f.calls[3]).toEqual(['startIntent', 'en-US', 1]);
    expect(f.v.state().phase).toBe('starting');
    // the overlay failing too is the answer
    f.say({type: 'error', code: 5});
    expect(f.v.state()).toMatchObject({phase: 'error', error: 'failed'});
    // a service that was READY and then failed is not "refusing": no overlay
    const g = fake({granted: true});
    await g.v.start('en');
    g.say({type: 'ready'});
    g.say({type: 'error', code: 2});
    expect(g.names()).not.toContain('startIntent');
    expect(g.v.state().error).toBe('network');
  });

  test('nothing heard / nothing understood; Android ending with NO_MATCH after showing words keeps them', async () => {
    let f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.say({type: 'error', code: 6});
    expect(f.v.state().error).toBe('no-speech');
    f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.say({type: 'partial', text: 'the office'});
    f.say({type: 'error', code: 7});
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'the office'});
  });

  test('the mic pressed again: what has been heard is the answer at once; nothing yet: the service is asked to finish', async () => {
    let f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.say({type: 'partial', text: 'dune part'});
    f.v.stop();
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'dune part'});
    expect(f.names()).toContain('cancel');
    // what the service still says afterwards is not news
    f.say({type: 'final', text: 'dune part two'}, 1);
    expect(f.v.state().text).toBe('dune part');
    f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.v.stop();
    expect(f.names()).toEqual(['availability', 'check', 'start', 'stop']);
    f.say({type: 'final', text: 'arrival'});
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'arrival'});
  });

  test('Back (cancel): quiet, nothing searched, a late word ignored', async () => {
    const f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.say({type: 'partial', text: 'brea'});
    f.v.cancel();
    expect(f.v.state()).toMatchObject({phase: 'idle', interim: '', text: ''});
    expect(f.names()).toContain('cancel');
    f.say({type: 'final', text: 'breaking bad'}, 1);
    expect(f.v.state().phase).toBe('idle');
    // cancel at rest does nothing
    const n = f.calls.length;
    f.v.cancel();
    expect(f.calls.length).toBe(n);
  });

  test('a second start replaces the first (the language switch): the old session goes quiet', async () => {
    const f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    await f.v.start('he');
    expect(f.calls.filter(c => c[0] === 'start')).toEqual([
      ['start', 'en-US', 1],
      ['start', 'he-IL', 2],
    ]);
    f.say({type: 'final', text: 'old'}, 1);
    expect(f.v.state()).toMatchObject({phase: 'starting', lang: 'he'});
    f.say({type: 'final', text: 'פאודה'}, 2);
    expect(f.v.state()).toMatchObject({phase: 'heard', text: 'פאודה', lang: 'he'});
  });

  test('a cancel while Android is still asking for permission wins', async () => {
    let release: (a: PermissionAnswer) => void = () => {};
    const states: VoiceState[] = [];
    const calls: string[] = [];
    const v = createVoice(
      {
        native: {
          availability: async () => ({recognizer: true, intent: true}),
          start: () => calls.push('start'),
          startIntent: () => calls.push('startIntent'),
          stop: () => {},
          cancel: () => calls.push('cancel'),
        },
        check: async () => false,
        ask: () => new Promise<PermissionAnswer>(r => (release = r)),
        subscribe: () => () => {},
      },
      s => states.push(s),
    );
    const started = v.start('en');
    await flush();
    v.cancel();
    release('granted');
    await started;
    expect(calls).not.toContain('start');
    expect(calls).not.toContain('startIntent');
    expect(v.state().phase).toBe('idle');
    v.dispose();
  });

  test('a listening that never ends: asked to finish at 20 s, let go after the grace', async () => {
    const f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    expect(f.runTimers()).toEqual([LISTEN_MAX_MS]);
    expect(f.names()).toContain('stop');
    expect(f.runTimers()).toEqual([GRACE_MS]);
    expect(f.v.state()).toMatchObject({phase: 'error', error: 'no-speech'});
    // with words on screen at 20 s, those words are the answer
    const g = fake({granted: true});
    await g.v.start('en');
    g.say({type: 'partial', text: 'severance'});
    g.runTimers();
    expect(g.v.state()).toMatchObject({phase: 'heard', text: 'severance'});
  });

  test('dispose: the screen left while listening stops the recogniser', async () => {
    const f = fake({granted: true});
    await f.v.start('en');
    f.say({type: 'ready'});
    f.v.dispose();
    expect(f.names()).toContain('cancel');
  });
});

describe("the remote's search / voice key", () => {
  test('on Search: starts listening there; elsewhere: opens Search listening; on the player: nothing', () => {
    const seen: string[] = [];
    const here = () => seen.push('here');
    const open = () => seen.push('open');
    expect(onVoiceKey('Search', here, open)).toBe('started');
    expect(onVoiceKey('Home', here, open)).toBe('opened');
    expect(onVoiceKey('Detail', null, open)).toBe('opened');
    expect(onVoiceKey('Search', null, open)).toBe('opened');
    expect(onVoiceKey('Player', here, open)).toBe('ignored');
    expect(seen).toEqual(['here', 'open', 'open', 'open']);
  });
});

describe("the TV's own search (SearchProvider / ACTION_SEARCH → aurora://search)", () => {
  test('the words of a search link; every other link is not one', () => {
    expect(searchLinkQuery('aurora://search?q=breaking%20bad')).toBe('breaking bad');
    expect(searchLinkQuery('aurora://search?q=%D7%A4%D7%90%D7%95%D7%93%D7%94')).toBe('פאודה');
    expect(searchLinkQuery('aurora://search?q=the+office')).toBe('the office');
    expect(searchLinkQuery('aurora://search')).toBe('');
    expect(searchLinkQuery('aurora://search?q=%E0%A4%A')).toBe('');
    expect(searchLinkQuery('aurora://open?a=detail&d=%7B%7D')).toBeNull();
    expect(searchLinkQuery(null)).toBeNull();
    expect(searchLinkQuery('aurora://search?q=' + 'x'.repeat(200))!.length).toBe(80);
  });
});
