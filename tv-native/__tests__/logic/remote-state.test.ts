// What the TV tells the server it is doing, and how often (src/remote/state.ts):
// a change that matters at once; every second while a remote screen watches;
// otherwise the position at most every IDLE_MS.
import {buildState, coarseOf, createReporter, IDLE_MS, POLL_MS} from '../../src/remote/state';
import type {NowState, RemoteState} from '../../src/remote/protocol';

const film = (o: Partial<NowState> = {}): NowState => ({
  id: 'm1',
  title: 'Dune',
  showTitle: null,
  epTitle: null,
  season: null,
  episode: null,
  poster: null,
  backdrop: null,
  duration: 6000,
  position: 0,
  paused: false,
  buffering: false,
  canSeek: true,
  hasNext: false,
  nextLabel: null,
  subs: [],
  sub: null,
  audios: [],
  audio: null,
  subDelay: 0,
  ...o,
});

const rig = () => {
  let t = 1_000_000;
  let tick: (() => void) | null = null;
  let state: RemoteState = buildState({screen: 'Home', appState: 'active', now: null, volume: null});
  const sent: {at: number; s: RemoteState}[] = [];
  const r = createReporter({
    getState: () => state,
    send: s => {
      sent.push({at: t, s});
      return true;
    },
    now: () => t,
    setInterval: fn => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  const advance = (ms: number) => {
    const end = t + ms;
    while (t + POLL_MS <= end) {
      t += POLL_MS;
      tick?.();
    }
    t = end;
  };
  return {
    r,
    sent,
    advance,
    set: (s: Partial<RemoteState>) => (state = {...state, ...s}),
    setNow: (n: Partial<NowState>) => (state = {...state, now: {...(state.now || film()), ...n}}),
    hasTimer: () => !!tick,
  };
};

test('coarse: what every remote hears about — not the position', () => {
  const a = buildState({screen: 'Player', appState: 'active', now: film({position: 10}), volume: {supported: true, level: 0.5, muted: false, scope: 'system'}});
  expect(coarseOf(a)).toBe(coarseOf({...a, now: film({position: 500})}));
  expect(coarseOf(a)).not.toBe(coarseOf({...a, now: film({paused: true})}));
  expect(coarseOf(a)).not.toBe(coarseOf({...a, now: film({sub: 'English'})}));
  expect(coarseOf(a)).not.toBe(coarseOf({...a, appState: 'background'}));
  expect(coarseOf(a)).not.toBe(coarseOf({...a, screen: 'Home'}));
  // a volume step of one twentieth is a change; less is not
  expect(coarseOf(a)).toBe(coarseOf({...a, volume: {...a.volume!, level: 0.51}}));
  expect(coarseOf(a)).not.toBe(coarseOf({...a, volume: {...a.volume!, level: 0.6}}));
  expect(coarseOf(null)).toBe('');
});

test('not watched: a change that matters goes at once; the position at most every IDLE_MS', () => {
  const {r, sent, advance, set, setNow} = rig();
  r.start();
  advance(POLL_MS); // the first look says it
  expect(sent).toHaveLength(1);
  set({screen: 'Player'});
  setNow({position: 1});
  advance(POLL_MS);
  expect(sent).toHaveLength(2); // another screen, a title: at once
  // playing: only the position moves
  for (let i = 2; i < 20; i++) {
    setNow({position: i});
    advance(POLL_MS);
  }
  const playing = sent.slice(2);
  expect(playing.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < playing.length; i++) expect(playing[i].at - playing[i - 1].at).toBeGreaterThanOrEqual(IDLE_MS);
  // pause: at once
  const before = sent.length;
  setNow({paused: true});
  r.changed();
  expect(sent).toHaveLength(before + 1);
  expect(sent[sent.length - 1].s.now!.paused).toBe(true);
  // nothing changes: nothing is said
  const quiet = sent.length;
  advance(IDLE_MS * 3);
  expect(sent).toHaveLength(quiet);
});

test('watched: every second, changed or not, and the moment the watch starts', () => {
  const {r, sent, advance, setNow} = rig();
  r.start();
  advance(POLL_MS);
  const n0 = sent.length;
  r.setWatch(true);
  expect(sent).toHaveLength(n0 + 1); // at once, for the screen that just opened
  advance(5 * POLL_MS);
  expect(sent).toHaveLength(n0 + 6);
  setNow({position: 42});
  r.changed(); // a seek from the phone: at once while watched
  expect(sent[sent.length - 1].s.now!.position).toBe(42);
  // the remote screen closes: back to the slow cadence
  r.setWatch(false);
  const n1 = sent.length;
  advance(5 * POLL_MS);
  expect(sent).toHaveLength(n1);
});

test('a send that did not go (socket closed) is tried again on the next look', () => {
  let t = 0;
  let up = false;
  const sent: RemoteState[] = [];
  let tick: () => void = () => {};
  const r = createReporter({
    getState: () => buildState({screen: 'Home', appState: 'active', now: null, volume: null}),
    send: s => (up ? (sent.push(s), true) : false),
    now: () => t,
    setInterval: fn => ((tick = fn), 1),
    clearInterval: () => {},
  });
  r.start();
  t += POLL_MS;
  tick();
  expect(sent).toHaveLength(0);
  up = true;
  t += POLL_MS;
  tick();
  expect(sent).toHaveLength(1);
});

test('an announce carries the state: the reporter does not say it again', () => {
  const {r, sent, advance} = rig();
  r.start();
  r.sent(buildState({screen: 'Home', appState: 'active', now: null, volume: null}));
  advance(3 * POLL_MS);
  expect(sent).toHaveLength(0);
});

test('stop: no timer, and the next start says everything again', () => {
  const {r, sent, advance, hasTimer} = rig();
  r.start();
  advance(POLL_MS);
  r.stop();
  expect(hasTimer()).toBe(false);
  r.start();
  advance(POLL_MS);
  expect(sent).toHaveLength(2);
});
