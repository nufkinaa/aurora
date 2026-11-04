// What this device really PLAYED (docs/watch-time.md). The player ticks it on
// every timeupdate with where the film is and whether it is playing; it adds
// the stretches where the position moved forward at about the speed the
// clock allows — not paused, not seeking, not stalled — divided by the
// playback speed, so 10 minutes at 2x are 10 minutes of someone's time. A
// jump (a seek, a new stream landing), a stall (no timeupdate for seconds) or
// a sleeping laptop (the clock moved, the film did not) adds nothing.
//
// Each activity report takes what played since the last one (`take`); the
// server holds every report to its own clock as well (src/lib/watchtime.js),
// so this is the honest measure and the server the referee.
//
// The same rules as tv-native/src/watchClock.ts (the TV and phone players).
export const MAX_STEP_SEC = 5; // ticks further apart than this are a stall or a sleep
const SPEED_SLACK = 1.5;
const POS_SLACK_SEC = 0.5;

export const createWatchClock = ({ now = () => performance.now() } = {}) => {
  let lastPos = null;
  let lastAt = 0;
  let unsent = 0;
  let total = 0;
  return {
    // pos: content seconds; playing: really playing (not paused, not seeking,
    // has data); rate: the playback speed
    tick(pos, { playing = false, rate = 1 } = {}) {
      const t = now();
      if (typeof pos !== "number" || !isFinite(pos)) return;
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
    // a seek or a new source: the next tick starts a fresh stretch
    reset() { lastPos = null; },
    // what played since the last take, in seconds (one decimal)
    take() {
      const v = Math.floor(unsent * 10) / 10;
      unsent -= v;
      return v;
    },
    get total() { return total; },
  };
};
