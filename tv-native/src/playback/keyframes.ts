// Landing on a keyframe (streaming round 2, docs/qa/streaming-round-2/tv.md).
//
// ExoPlayer seeks EXACTLY: to show second t of a file it decodes, unseen,
// every frame from the keyframe before t. On the Mi TV that costs about 0.1 s
// per second of film — measured from a fast source, the seek committed: 1.30 s
// to a point 10.3 s past a keyframe, 0.11 s to the keyframe itself — and the
// household's films have keyframes up to ~10 s apart. A resume paid it on
// every start (HEVC film resumed at 100 s, the keyframe at 91 s: 2.4 s to the
// picture against 1.3 s from 0:00).
//
// A RESUME is "a few seconds before where you stopped" (episodeRules.ts
// resumePoint: the saved second, 4 s back). Inside that leeway any second is
// as good as another, so it lands on a keyframe when one is near: the closest
// to the resume point within RESUME_BACK_S before it and RESUME_FWD_S after
// it — never later than half a second before the saved position (nothing the
// viewer has not seen is skipped), never more than 8 s before it. No keyframe
// there (or no list): the resume point as it always was.
//
// A SEEK (the scrubber, a skip, the phone) lands exactly where it was sent —
// unless the server's tuning says otherwise (`seekSnapS`, off by default:
// that one moves where a seek lands, which is elia's to decide).
//
// Pure: Player.tsx fetches the list (api.keyframes, the server's
// lib/tvkeys.js) and calls these.

/** A resume may land this much before its point… */
export const RESUME_BACK_S = 4;
/** …or this much after it (the point is 4 s before the saved second, so this
 *  stays half a second short of where the viewer stopped). */
export const RESUME_FWD_S = 3.5;
/** The start waits this long for the list, at most: a server slower than this
 *  starts the resume where it always did (the list helps the next start). */
export const KEYS_WAIT_MS = 400;

/** PURE: a server answer -> ascending keyframe times, or null. */
export const readKeys = (answer: unknown): number[] | null => {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as {v?: unknown; keys?: unknown};
  if (Number(a.v) !== 1 || !Array.isArray(a.keys) || a.keys.length < 2) return null;
  const out: number[] = [];
  for (const k of a.keys) {
    if (typeof k !== 'number' || !isFinite(k) || k < 0) return null;
    if (out.length && k <= out[out.length - 1]) return null; // must ascend
    out.push(k);
  }
  return out;
};

/** PURE: the keyframe closest to `t` within [t - back, t + fwd]; on a tie the
 *  earlier one. null when there is none. */
export const nearestKey = (keys: number[] | null, t: number, back: number, fwd: number): number | null => {
  if (!keys || !keys.length || !isFinite(t)) return null;
  // first key >= t - back (binary search)
  let lo = 0;
  let hi = keys.length;
  const from = t - back;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  for (let i = lo; i < keys.length && keys[i] <= t + fwd; i++) {
    if (best == null || Math.abs(keys[i] - t) < Math.abs(best - t)) best = keys[i];
  }
  return best;
};

/** PURE: where a resume starts — on a keyframe inside the leeway, else `at`. */
export const resumeOnKey = (at: number, keys: number[] | null): number => {
  if (!(at > 0)) return at;
  const k = nearestKey(keys, at, RESUME_BACK_S, RESUME_FWD_S);
  return k != null && k > 0 ? k : at;
};

/** PURE: where a seek lands — on a keyframe within `snapS` of the target when
 *  the tuning allows it (snapS > 0), else exactly the target. */
export const seekOnKey = (target: number, keys: number[] | null, snapS: number): number => {
  if (!(snapS > 0)) return target;
  const k = nearestKey(keys, target, snapS, snapS);
  return k != null ? k : target;
};
