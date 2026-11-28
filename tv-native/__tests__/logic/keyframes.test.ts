// Landing a resume on a keyframe (playback/keyframes.ts; streaming round 2).
import {nearestKey, readKeys, resumeOnKey, RESUME_BACK_S, RESUME_FWD_S, seekOnKey} from '../../src/playback/keyframes';
import {applyTuning, TUNING_DEFAULTS} from '../../src/playback/tuning';

// the HEVC rig clip's real keyframes around 100 s (ffprobe)
const KEYS = [0.072, 5.077, 6.244, 8.33, 10.582, 14.044, 80.569, 90.996, 101.423, 103.133, 107.804, 115.645];

describe('the server answer', () => {
  test('a list of ascending times', () => {
    expect(readKeys({v: 1, keys: [0, 4.2, 9.9]})).toEqual([0, 4.2, 9.9]);
  });
  test('anything else is no list', () => {
    expect(readKeys(null)).toBeNull();
    expect(readKeys({v: 1, keys: null})).toBeNull();
    expect(readKeys({v: 2, keys: [0, 1]})).toBeNull();
    expect(readKeys({v: 1, keys: [0]})).toBeNull();
    expect(readKeys({v: 1, keys: [0, 5, 3]})).toBeNull();
    expect(readKeys({v: 1, keys: [0, 'x']})).toBeNull();
    expect(readKeys({v: 1, keys: [-1, 2]})).toBeNull();
  });
});

describe('a resume', () => {
  test('lands on the keyframe closest to its point inside the leeway', () => {
    // saved at 100 -> resumePoint 96: 101.423 is 5.4 s on (too far), 90.996 is 5.0 back (too far) -> as it was
    expect(resumeOnKey(96, KEYS)).toBe(96);
    // saved at 104 -> resume 100: 101.423 is 1.4 s on, inside +3.5
    expect(resumeOnKey(100, KEYS)).toBe(101.423);
    // resume 93: 90.996 is 2.0 back
    expect(resumeOnKey(93, KEYS)).toBe(90.996);
    // resume 104: 103.133 (0.9 back) beats 101.423 and 107.804
    expect(resumeOnKey(104, KEYS)).toBe(103.133);
  });
  test('never past half a second short of where the viewer stopped, never more than 8 s before it', () => {
    for (let saved = 15; saved < 120; saved += 0.25) {
      const at = Math.floor(saved) - 4;
      const k = resumeOnKey(at, KEYS);
      expect(k).toBeLessThanOrEqual(at + RESUME_FWD_S);
      expect(k).toBeGreaterThanOrEqual(at - RESUME_BACK_S);
      expect(k).toBeLessThanOrEqual(saved - 0.5);
    }
  });
  test('no list, no resume: unchanged', () => {
    expect(resumeOnKey(100, null)).toBe(100);
    expect(resumeOnKey(0, KEYS)).toBe(0);
  });
});

describe('a seek', () => {
  test('exactly where it was sent unless the tuning allows a snap', () => {
    expect(seekOnKey(101.3, KEYS, 0)).toBe(101.3);
    expect(seekOnKey(101.3, KEYS, 1.5)).toBe(101.423);
    expect(seekOnKey(97, KEYS, 1.5)).toBe(97); // nothing within 1.5 s
  });
  test('nearestKey: a tie goes to the earlier keyframe', () => {
    expect(nearestKey([10, 20], 15, 5, 5)).toBe(10);
  });
});

describe('the tuning', () => {
  test('a resume on a keyframe by default; seeks exact by default', () => {
    expect(TUNING_DEFAULTS.resumeOnKey).toBe(true);
    expect(TUNING_DEFAULTS.seekSnapMs).toBe(0);
  });
  test('the server may turn either', () => {
    const t = applyTuning({resumeOnKey: false, seekSnapMs: 1500});
    expect(t.resumeOnKey).toBe(false);
    expect(t.seekSnapMs).toBe(1500);
    expect(applyTuning({seekSnapMs: 9000}).seekSnapMs).toBe(0);
    expect(applyTuning({resumeOnKey: 'no'}).resumeOnKey).toBe(true);
  });
});
