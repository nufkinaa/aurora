// What this TV tells the server it is doing (`device_state`), and how often —
// PURE over a clock, timers and a send function (__tests__/logic/remote-state.test.ts).
//
// THE CADENCE (src/lib/devices.js, the protocol):
//   - a change that matters — another title, paused, buffering, a track, the
//     volume (the server's own `coarse`) — at once;
//   - every second while the server says a remote screen watches this TV
//     (`remote_watch` on), so the phone's scrubber moves;
//   - otherwise only the position moves, and that is said at most every
//     IDLE_MS (a remote that opens later starts from a fresh position).
import type {NowState, RemoteState, VolumeState} from './protocol';

export const WATCH_MS = 1000;
export const POLL_MS = 1000;
export const IDLE_MS = 8000;

/** The server's `coarse` (devices.js), on this side: what every remote hears about. */
export const coarseOf = (s: RemoteState | null): string => {
  if (!s) return '';
  const n = s.now;
  return JSON.stringify([
    s.screen,
    s.appState,
    n ? [n.id, n.paused, n.buffering, n.hasNext, n.sub, n.audio, n.subs.length, n.audios.length, Math.round(n.duration), n.subDelay] : null,
    s.volume ? [s.volume.supported, s.volume.muted, s.volume.level == null ? null : Math.round(s.volume.level * 20)] : null,
  ]);
};

/** One state, from its parts. */
export const buildState = (o: {
  screen: string | null;
  appState: 'active' | 'background';
  now: NowState | null;
  volume: VolumeState | null;
}): RemoteState => ({
  screen: o.screen || null,
  appState: o.appState === 'background' ? 'background' : 'active',
  now: o.now,
  volume: o.volume,
});

export type Reporter = {
  start: () => void;
  stop: () => void;
  setWatch: (on: boolean) => void;
  watching: () => boolean;
  /** something may have changed: look now (sends only if it did) */
  changed: () => void;
  /** say it now, whatever it is (an announce just went, a reconnect) */
  sent: (s: RemoteState) => void;
};

export function createReporter(o: {
  getState: () => RemoteState;
  send: (s: RemoteState) => boolean;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}): Reporter {
  const now = o.now || (() => Date.now());
  const setI = o.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearI = o.clearInterval || (t => clearInterval(t as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  let watch = false;
  let lastCoarse = '';
  let lastFull = '';
  let lastAt = 0;

  const record = (s: RemoteState, full: string) => {
    lastCoarse = coarseOf(s);
    lastFull = full;
    lastAt = now();
  };
  // 'tick': the timer; 'change': someone said something may have changed;
  // 'force': say it whatever it is (a remote screen just opened on this TV)
  const look = (why: 'tick' | 'change' | 'force') => {
    const fromTick = why === 'tick';
    let s: RemoteState;
    try {
      s = o.getState();
    } catch {
      return;
    }
    const full = JSON.stringify(s);
    const coarse = coarseOf(s);
    const t = now();
    let due: boolean;
    if (why === 'force' || coarse !== lastCoarse) due = true;
    else if (full === lastFull) due = watch && fromTick && t - lastAt >= WATCH_MS - 50;
    else if (watch) due = !fromTick || t - lastAt >= WATCH_MS - 50;
    else due = t - lastAt >= IDLE_MS;
    if (!due) return;
    if (o.send(s)) record(s, full);
  };
  return {
    start: () => {
      if (timer) return;
      timer = setI(() => look('tick'), POLL_MS);
    },
    stop: () => {
      if (timer) clearI(timer);
      timer = null;
      lastCoarse = '';
      lastFull = '';
      lastAt = 0;
    },
    setWatch: on => {
      watch = !!on;
      if (watch) look('force');
    },
    watching: () => watch,
    changed: () => look('change'),
    sent: s => record(s, JSON.stringify(s)),
  };
}
