// Moving the point on the timeline with the remote (TV): taps for small steps,
// a HOLD that glides and speeds up, one seek at the end. PURE — no React, no
// React Native: the logic tests drive it with a fake clock (Player.tsx wires it).
//
// What the remote gives JS (react-native-tvos ReactAndroidHWInputDeviceHelper,
// key-downs off): a tap arrives as 'left'/'right' when the key comes UP; a key
// held past ~300 ms (after Android's first key repeat, ~0.5 s in) arrives ONCE
// as 'longLeft'/'longRight' with eventKeyAction 0, and once more with action 1
// when it is let go — nothing in between, no plain 'right' after it. So a hold
// is "moving from the long-press event until its release", and the motion is
// made here, on a clock, not out of key repeats.
//
// A SESSION is open from the first tap or hold until the seek is made:
//   - a tap moves the marker TAP_STEP_S at once, never escalating inside a
//     session (fine-tuning stays easy);
//   - a hold moves it continuously, from HOLD_START_SPEED up to vmax over
//     HOLD_RAMP_S (smoothstep); release stops it at once and takes back the
//     viewer's reaction time (RELEASE_REACTION_S of the speed it had);
//   - COMMIT_PAUSE_MS after the last input, ONE seek to the marker; any tap or
//     hold inside that pause keeps the session going (no seek in between);
//   - OK seeks at once, BACK cancels (Player.tsx).
// Every number below is a tunable; the device pass may change them.

/** One tap inside a session: this many content seconds, every time. */
export const TAP_STEP_S = 10;
/** The press that turned into a hold counts as one tap: it moves this much at
 *  once (a hold never moves less than a tap), then the glide starts. */
export const HOLD_FIRST_STEP_S = TAP_STEP_S;
/** The glide's speed when it starts (content seconds per real second). */
export const HOLD_START_SPEED = 15;
/** Its top speed: the title's length / this (a whole film in ~25 s at full
 *  speed), kept within [HOLD_VMAX_MIN, HOLD_VMAX_MAX]. */
export const HOLD_VMAX_PER_LENGTH = 25;
export const HOLD_VMAX_MIN = 60;
export const HOLD_VMAX_MAX = 300;
/** How long the glide takes to reach top speed (smoothstep ease). */
export const HOLD_RAMP_S = 2.5;
/** On release the marker comes back this much of the speed it had — the time
 *  between seeing the right picture and the thumb letting go… */
export const RELEASE_REACTION_S = 0.25;
/** …at most this many content seconds, and never behind where the hold began. */
export const RELEASE_PULLBACK_MAX_S = 45;
/** The quiet after the last input before the one seek is made. */
export const COMMIT_PAUSE_MS = 700;
/** A hold with no release after this long stops by itself (a lost key-up). */
export const HOLD_SAFETY_MS = 20000;
/** After the seek the marker stays on the target until the player reports a
 *  position this close to it… */
export const SETTLE_NEAR_S = 3;
/** …or this long has passed. */
export const SETTLE_MAX_MS = 2500;
/** How often the player redraws a glide (~30 a second). */
export const SCRUB_TICK_MS = 33;

export type Hold = {
  dir: 1 | -1;
  /** when the long press arrived (ms) */
  at: number;
  /** where the glide starts (content s), the first step included */
  from: number;
  vmax: number;
};

export type ScrubSession = {
  open: boolean;
  /** the real position when the session opened (BACK goes back to it) */
  origin: number;
  /** where the marker is (while gliding: where the glide was last stopped) */
  target: number;
  duration: number;
  hold: Hold | null;
  lastInputAt: number;
};

export type ScrubCtx = {now: number; position: number; duration: number};

export const scrubClosed = (): ScrubSession => ({open: false, origin: 0, target: 0, duration: 0, hold: null, lastInputAt: 0});

// seekTo() clamps a seek to [0, total − 1] (a seek onto the very end ends the
// film); unknown length: no upper bound.
const limitOf = (duration: number) => (duration > 0 ? duration - 1 : Infinity);
const clampT = (t: number, duration: number) => Math.max(0, Math.min(limitOf(duration), t));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const smoothstep = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/** The glide's top speed for a title this long (s). */
export const holdVmax = (duration: number) =>
  Math.max(HOLD_VMAX_MIN, Math.min(HOLD_VMAX_MAX, (duration > 0 ? duration : 0) / HOLD_VMAX_PER_LENGTH));

/** The glide's speed `elapsed` seconds in. */
export const holdSpeed = (elapsed: number, vmax: number) =>
  HOLD_START_SPEED + (vmax - HOLD_START_SPEED) * smoothstep(elapsed / HOLD_RAMP_S);

/** How far the glide has gone `elapsed` seconds in: the exact integral of
 *  holdSpeed, so the marker is where it should be whatever the frame rate. */
export const holdDistance = (elapsed: number, vmax: number) => {
  const t = Math.max(0, elapsed);
  const R = HOLD_RAMP_S;
  // ∫ smoothstep(τ/R) dτ from 0 to t: R(u³ − u⁴/2) while ramping, then R/2 + (t − R)
  const u = Math.min(1, t / R);
  const ramp = t <= R ? R * (u * u * u - (u * u * u * u) / 2) : R / 2 + (t - R);
  return HOLD_START_SPEED * t + (vmax - HOLD_START_SPEED) * ramp;
};

const opened = (s: ScrubSession, c: ScrubCtx): ScrubSession =>
  s.open
    ? {...s, duration: c.duration > 0 ? c.duration : s.duration}
    : {open: true, origin: c.position, target: clampT(c.position, c.duration), duration: c.duration, hold: null, lastInputAt: c.now};

const glideAt = (h: Hold, now: number) => h.from + h.dir * holdDistance((now - h.at) / 1000, h.vmax);

/** Stop a glide at `now`; `pullback`: a real release (the reaction time comes off). */
const stopHold = (s: ScrubSession, now: number, pullback: boolean): ScrubSession => {
  const h = s.hold;
  if (!h) return s;
  const el = Math.max(0, (now - h.at) / 1000);
  let t = glideAt(h, now);
  if (pullback) {
    const back = Math.min(RELEASE_PULLBACK_MAX_S, holdSpeed(el, h.vmax) * RELEASE_REACTION_S);
    t = h.dir > 0 ? Math.max(h.from, t - back) : Math.min(h.from, t + back);
  }
  return {...s, hold: null, target: clampT(t, s.duration)};
};

/** A tap (left −1 / right +1): one small step, at once. */
export const scrubTap = (s: ScrubSession, dir: 1 | -1, c: ScrubCtx): ScrubSession => {
  let n = opened(s, c);
  // a tap while gliding (its release was lost): stop where it is, then step
  if (n.hold) n = stopHold(n, c.now, false);
  return {...n, target: clampT(n.target + dir * TAP_STEP_S, n.duration), lastInputAt: c.now};
};

/** The long press arrived: the glide starts (a first step, then motion). */
export const scrubHoldStart = (s: ScrubSession, dir: 1 | -1, c: ScrubCtx): ScrubSession => {
  let n = opened(s, c);
  if (n.hold && n.hold.dir === dir) return {...n, lastInputAt: c.now}; // the same hold, said twice
  if (n.hold) n = stopHold(n, c.now, false); // the other way: a fresh glide from here
  const from = clampT(n.target + dir * HOLD_FIRST_STEP_S, n.duration);
  return {...n, hold: {dir, at: c.now, from, vmax: holdVmax(n.duration)}, target: from, lastInputAt: c.now};
};

/** The key of the hold came up: stop now, minus the reaction time. */
export const scrubRelease = (s: ScrubSession, now: number): ScrubSession => {
  if (!s.open) return s;
  if (!s.hold) return {...s, lastInputAt: now};
  return {...stopHold(s, now, true), lastInputAt: now};
};

/** Another key came during a glide (its release was lost): stop where it is. */
export const scrubInterrupt = (s: ScrubSession, now: number): ScrubSession =>
  s.open && s.hold ? {...stopHold(s, now, false), lastInputAt: now} : s;

/** A frame of the clock: a glide past HOLD_SAFETY_MS stops by itself (where
 *  it was at that moment); the pause before the seek starts then. */
export const scrubTick = (s: ScrubSession, now: number): ScrubSession => {
  if (!s.open || !s.hold) return s;
  if (now - s.hold.at < HOLD_SAFETY_MS) return s;
  return {...stopHold(s, s.hold.at + HOLD_SAFETY_MS, false), lastInputAt: now};
};

/** Where the marker is drawn now (null: no session). */
export const scrubShown = (s: ScrubSession, now: number): number | null => {
  if (!s.open) return null;
  return s.hold ? clampT(glideAt(s.hold, now), s.duration) : s.target;
};

/** Time for the one seek: open, not gliding, quiet for COMMIT_PAUSE_MS. */
export const scrubCommitDue = (s: ScrubSession, now: number): boolean =>
  s.open && !s.hold && now - s.lastInputAt >= COMMIT_PAUSE_MS;

/** The seek to make now (OK, or the pause ran out): where the marker is. */
export const scrubCommitTarget = (s: ScrubSession, now: number): number | null => {
  if (!s.open) return null;
  return s.hold ? stopHold(s, now, false).target : s.target;
};

/** After the seek: keep the marker on the target while the player still
 *  reports somewhere else (the old spot, mid-seek) — no jump back and forth. */
export type Settle = {target: number; at: number} | null;
export const settleHolds = (st: Settle, reported: number, now: number): boolean =>
  !!st && now - st.at < SETTLE_MAX_MS && Math.abs(reported - st.target) > SETTLE_NEAR_S;
