// What this device really PLAYED (docs/watch-time.md) — the TV and phone
// players' twin of the website's public/js/watchclock.js, with the same rules.
// The player ticks it on every progress event (1 Hz) with where the film is
// and whether it is playing; it adds the stretches where the position moved
// forward at about the speed the clock allows — not paused, not seeking, not
// stalled — divided by the playback speed, so 10 minutes at 2x are 10
// minutes of someone's time. A jump (a seek, a new stream landing), a stall
// (no progress for seconds) or a TV that slept (the clock moved, the film did
// not) adds nothing.
//
// Each activity report takes what played since the last one (`take`); the
// server holds every report to its own clock as well (src/lib/watchtime.js).
export const MAX_STEP_SEC = 5;
const SPEED_SLACK = 1.5;
const POS_SLACK_SEC = 0.5;

export type WatchClock = {
  tick(pos: number, o?: {playing?: boolean; rate?: number}): void;
  reset(): void;
  take(): number;
  readonly total: number;
};

export const createWatchClock = (now: () => number = () => Date.now()): WatchClock => {
  let lastPos: number | null = null;
  let lastAt = 0;
  let unsent = 0;
  let total = 0;
  return {
    tick(pos, {playing = false, rate = 1} = {}) {
      const t = now();
      if (typeof pos !== 'number' || !isFinite(pos)) return;
      if (playing && lastPos != null) {
        const dPos = pos - lastPos;
        const dWall = (t - lastAt) / 1000;
        const r = rate > 0 && rate <= 4 ? rate : 1;
        if (dPos > 0 && dWall > 0 && dWall <= MAX_STEP_SEC && dPos <= dWall * r * SPEED_SLACK + POS_SLACK_SEC) {
          const sec = Math.min(dPos / r, dWall + 0.25);
          unsent += sec;
          total += sec;
        }
      }
      lastPos = playing ? pos : null;
      lastAt = t;
    },
    reset() {
      lastPos = null;
    },
    take() {
      const v = Math.floor(unsent * 10) / 10;
      unsent -= v;
      return v;
    },
    get total() {
      return total;
    },
  };
};

/** The player's state, as the server's sessions and the admin's "watching now" read it. */
export type PlayState = 'playing' | 'paused' | 'buffering' | 'ended';
export const playStateOf = (o: {paused: boolean; buffering: boolean; ended?: boolean; progressAgeMs: number; foreground: boolean}): PlayState => {
  if (o.ended) return 'ended';
  if (o.paused) return 'paused';
  // no progress for 3 s: stalled — or, with the app in the background, held
  // still by the system (react-native-video pauses a backgrounded player
  // without telling the JS side)
  if (o.buffering || o.progressAgeMs > 3000) return o.foreground ? 'buffering' : 'paused';
  return 'playing';
};
