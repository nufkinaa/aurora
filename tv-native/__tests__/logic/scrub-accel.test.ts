// Moving the point on the timeline with the remote (src/playback/scrubAccel.ts):
// taps, the hold's glide, release, the one seek after a pause, BACK, the
// marker staying put after the seek.
import {
  COMMIT_PAUSE_MS,
  HOLD_FIRST_STEP_S,
  HOLD_SAFETY_MS,
  HOLD_START_SPEED,
  holdDistance,
  holdSpeed,
  holdVmax,
  scrubClosed,
  scrubCommitDue,
  scrubCommitTarget,
  scrubHoldStart,
  scrubInterrupt,
  scrubRelease,
  scrubShown,
  scrubTap,
  scrubTick,
  settleHolds,
  SETTLE_MAX_MS,
  TAP_STEP_S,
} from '../../src/playback/scrubAccel';

const D = 3000; // a 50-minute episode: vmax = 3000 / 25 = 120 s/s
const at = (now: number, position = 100, duration = D) => ({now, position, duration});

describe('taps', () => {
  test('each tap is 10 s, at once, and never escalates inside a session', () => {
    let s = scrubClosed();
    s = scrubTap(s, 1, at(0));
    expect(s.open).toBe(true);
    expect(s.origin).toBe(100);
    expect(scrubShown(s, 0)).toBe(110);
    for (let i = 1; i < 8; i++) s = scrubTap(s, 1, at(i * 100, 999)); // the player's position no longer matters
    expect(scrubShown(s, 800)).toBe(100 + 8 * TAP_STEP_S);
  });

  test('clamped at 0 and at the last second', () => {
    expect(scrubShown(scrubTap(scrubClosed(), -1, at(0, 4)), 0)).toBe(0);
    expect(scrubShown(scrubTap(scrubClosed(), 1, at(0, D - 3)), 0)).toBe(D - 1);
  });

  test('unknown length: no upper bound', () => {
    expect(scrubShown(scrubTap(scrubClosed(), 1, at(0, 50, 0)), 0)).toBe(60);
  });
});

describe('the hold', () => {
  test('top speed: the length / 25, within 60…300 s/s', () => {
    expect(holdVmax(D)).toBe(120);
    expect(holdVmax(600)).toBe(60);
    expect(holdVmax(4 * 3600)).toBe(300);
    expect(holdVmax(0)).toBe(60);
  });

  test('the speed eases from 15 s/s to vmax over 2.5 s (smoothstep)', () => {
    expect(holdSpeed(0, 120)).toBe(HOLD_START_SPEED);
    expect(holdSpeed(1, 120)).toBeCloseTo(51.96, 2);
    expect(holdSpeed(2.5, 120)).toBe(120);
    expect(holdSpeed(5, 120)).toBe(120);
  });

  test('the distance is the exact integral of the speed', () => {
    expect(holdDistance(0, 120)).toBe(0);
    expect(holdDistance(1, 120)).toBeCloseTo(28.44, 2);
    expect(holdDistance(2.5, 120)).toBeCloseTo(168.75, 6);
    expect(holdDistance(5, 120)).toBeCloseTo(468.75, 6);
    // its slope is the speed, everywhere
    for (const t of [0.3, 1, 2, 2.4, 3, 6]) {
      const h = 1e-4;
      expect((holdDistance(t + h, 120) - holdDistance(t - h, 120)) / (2 * h)).toBeCloseTo(holdSpeed(t, 120), 2);
    }
  });

  test('the press that became a hold counts as one tap, then the marker glides', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    expect(scrubShown(s, 1000)).toBe(100 + HOLD_FIRST_STEP_S);
    expect(scrubShown(s, 2000)).toBeCloseTo(110 + 28.44, 2);
    expect(scrubShown(s, 3500)).toBeCloseTo(110 + 168.75, 6);
    expect(scrubShown(s, 6000)).toBeCloseTo(110 + 468.75, 6);
    // a second "it is held" for the same hold changes nothing
    s = scrubHoldStart(s, 1, at(2000, 555));
    expect(scrubShown(s, 3500)).toBeCloseTo(278.75, 6);
  });

  test('backwards too, and it stops at 0', () => {
    const s = scrubHoldStart(scrubClosed(), -1, at(0, 200));
    expect(scrubShown(s, 0)).toBe(190);
    expect(scrubShown(s, 1000)).toBeCloseTo(190 - 28.44, 2);
    expect(scrubShown(s, 5000)).toBe(0);
  });

  test('at the end it waits on the last second', () => {
    const s = scrubHoldStart(scrubClosed(), 1, at(0, D - 100));
    expect(scrubShown(s, 10000)).toBe(D - 1);
  });

  test('release stops at once and takes back a quarter second of the speed it had', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    s = scrubRelease(s, 3500); // 2.5 s in: 120 s/s → 30 s back
    expect(s.hold).toBeNull();
    expect(scrubShown(s, 3500)).toBeCloseTo(278.75 - 30, 6);
    // and stays there: the clock no longer moves it
    expect(scrubShown(s, 9000)).toBeCloseTo(248.75, 6);
  });

  test('a short hold is never pulled back behind its first step', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(0));
    s = scrubRelease(s, 100);
    expect(scrubShown(s, 100)).toBe(110);
    let b = scrubHoldStart(scrubClosed(), -1, at(0));
    b = scrubRelease(b, 100);
    expect(scrubShown(b, 100)).toBe(90);
  });

  test('a release run past the end stays at the end', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(0, D - 50));
    s = scrubRelease(s, 8000);
    expect(scrubShown(s, 8000)).toBe(D - 1);
  });

  test('a safety stop when no release comes within 20 s', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(0, 0, 100000)); // vmax 300
    s = scrubTick(s, HOLD_SAFETY_MS - 1);
    expect(s.hold).not.toBeNull();
    s = scrubTick(s, HOLD_SAFETY_MS + 50);
    expect(s.hold).toBeNull();
    expect(scrubShown(s, HOLD_SAFETY_MS + 50)).toBeCloseTo(10 + holdDistance(20, 300), 6);
    expect(scrubCommitDue(s, HOLD_SAFETY_MS + 50 + COMMIT_PAUSE_MS)).toBe(true);
  });

  test('another key during a glide stops it where it is (no pullback)', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    s = scrubInterrupt(s, 3500);
    expect(s.hold).toBeNull();
    expect(scrubShown(s, 3500)).toBeCloseTo(278.75, 6);
  });
});

describe('the other way', () => {
  test('a tap back after a hold corrects by 10 s from where it stopped', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    s = scrubRelease(s, 3500);
    s = scrubTap(s, -1, at(3700));
    expect(scrubShown(s, 3700)).toBeCloseTo(238.75, 6);
  });

  test('a hold the other way starts a fresh, slow glide', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    s = scrubRelease(s, 3500); // 248.75
    s = scrubHoldStart(s, -1, at(4000));
    expect(scrubShown(s, 4000)).toBeCloseTo(238.75, 6);
    expect(scrubShown(s, 5000)).toBeCloseTo(238.75 - 28.44, 2);
  });

  test('a tap during a glide (its release lost) stops it, then steps', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(1000));
    s = scrubTap(s, -1, at(3500));
    expect(s.hold).toBeNull();
    expect(scrubShown(s, 3500)).toBeCloseTo(268.75, 6);
  });
});

describe('the one seek', () => {
  test('700 ms after the last input, and taps inside the pause extend the session', () => {
    let s = scrubTap(scrubClosed(), 1, at(0));
    expect(scrubCommitDue(s, COMMIT_PAUSE_MS - 1)).toBe(false);
    s = scrubTap(s, 1, at(500));
    expect(scrubCommitDue(s, COMMIT_PAUSE_MS)).toBe(false); // extended
    expect(scrubCommitDue(s, 500 + COMMIT_PAUSE_MS - 1)).toBe(false);
    expect(scrubCommitDue(s, 500 + COMMIT_PAUSE_MS)).toBe(true);
    expect(scrubCommitTarget(s, 1200)).toBe(120);
  });

  test('never while gliding; the pause starts at the release', () => {
    let s = scrubHoldStart(scrubClosed(), 1, at(0));
    expect(scrubCommitDue(s, 5000)).toBe(false);
    s = scrubRelease(s, 5000);
    expect(scrubCommitDue(s, 5000 + COMMIT_PAUSE_MS - 1)).toBe(false);
    expect(scrubCommitDue(s, 5000 + COMMIT_PAUSE_MS)).toBe(true);
  });

  test('OK during a glide seeks where the marker is', () => {
    const s = scrubHoldStart(scrubClosed(), 1, at(1000));
    expect(scrubCommitTarget(s, 3500)).toBeCloseTo(278.75, 6);
  });

  test('nothing to seek when no session is open (BACK = drop the session, back to the origin)', () => {
    expect(scrubCommitTarget(scrubClosed(), 0)).toBeNull();
    expect(scrubShown(scrubClosed(), 0)).toBeNull();
    const s = scrubTap(scrubTap(scrubClosed(), 1, at(0)), 1, at(100));
    expect(s.origin).toBe(100);
  });
});

describe('after the seek', () => {
  test('the marker stays on the target until the player is near it, or 2.5 s passed', () => {
    const st = {target: 500, at: 0};
    expect(settleHolds(st, 100, 300)).toBe(true); // still the old spot
    expect(settleHolds(st, 498.5, 300)).toBe(false); // there
    expect(settleHolds(st, 100, SETTLE_MAX_MS)).toBe(false); // gave up waiting
    expect(settleHolds(null, 100, 0)).toBe(false);
  });
});
