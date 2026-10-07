// How much this box can take.
//
// Android TV hardware runs from a current Google TV Streamer down to boxes
// with a 2016 chip and 2 GB of memory. The app is the same on all of them,
// but one thing in it is a luxury that a weak box pays for in smoothness
// everywhere else: trailers on Home's billboard (a YouTube player in a
// WebView). On a box that can't spare them they stand down — the still
// backdrop is the same picture, just not moving — and everything a viewer
// actually does (browse, focus, play) keeps its full quality. (The nav
// rail's moving aurora used to be the second; it is a still hue now.)
//
// "Can't spare them" is decided twice:
//   1. up front, by age: Android 9 (API 28) and older are the generation
//      of boxes this was measured slow on;
//   2. by measurement, once Home has settled: 150 frames are timed, and if
//      the slowest tenth of them took longer than 40 ms (under 25 fps) the
//      box is struggling as it is, and the luxuries go for this session.
// Nothing is stored: a box is judged fresh every launch, so an update that
// makes it faster is noticed.
import {Platform} from 'react-native';

let lite = typeof Platform.Version === 'number' && Platform.Version <= 28;
let measuring = false;

export const isLite = () => lite;

/** Time ~150 frames once (a few seconds); mark the session lite if they are slow. */
export function measureOnce() {
  if (measuring || lite) return;
  measuring = true;
  const deltas: number[] = [];
  let last = 0;
  const tick = (t: number) => {
    if (last) deltas.push(t - last);
    last = t;
    if (deltas.length < 150) {
      requestAnimationFrame(tick);
      return;
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
    if (p90 > 40) lite = true;
  };
  requestAnimationFrame(tick);
}
