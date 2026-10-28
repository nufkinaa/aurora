// What a finger means on the phone's player — PURE (no React Native), tested.
//
//   tap                      the controls come or go
//   double tap, left third   back 10 s (taps in a row keep going: the TV's
//   double tap, right third  forward 10 s   accelerating skip, SKIP_STEPS)
//   drag sideways            scrub: a whole screen's width is SEEK_SPAN_S
//   drag up / down, left     brightness (this window only)
//   drag up / down, right    volume (the media stream)
//   pinch                    fill the screen / fit the picture
//
// A drag is read as sideways or up-down by its first DECIDE_PX of travel, and
// keeps that meaning until the finger lifts (a scrub that wanders vertically
// is still a scrub).
export const DECIDE_PX = 14;
export const DOUBLE_TAP_MS = 260;
export const TAP_SLOP_PX = 10;
/** A full-width sideways drag moves this many seconds (scaled down for short films). */
export const SEEK_SPAN_S = 240;
/** A drag of this share of the screen's height moves brightness / volume end to end. */
export const LEVEL_SPAN = 0.7;
export const PINCH_FILL = 1.12;
export const PINCH_FIT = 0.9;

export type Zone = 'left' | 'middle' | 'right';
export type DragKind = 'seek' | 'brightness' | 'volume';

export const zoneOf = (x: number, width: number): Zone => (x < width / 3 ? 'left' : x > (width * 2) / 3 ? 'right' : 'middle');

/** Which drag this is, once it has travelled far enough to say (null: not yet). */
export function decideDrag(dx: number, dy: number, startX: number, width: number): DragKind | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < DECIDE_PX) return null;
  if (ax >= ay) return 'seek';
  return startX < width / 2 ? 'brightness' : 'volume';
}

/** Where a sideways drag of dx (px) from `from` (s) lands, clamped to the film. */
export function seekTarget(from: number, dx: number, width: number, duration: number): number {
  const span = duration > 0 ? Math.min(SEEK_SPAN_S, Math.max(30, duration * 0.5)) : SEEK_SPAN_S;
  const to = from + (dx / Math.max(1, width)) * span;
  const end = duration > 0 ? Math.max(0, duration - 1) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(end, to));
}

/** A level (0..1) moved by a vertical drag of dy (px; up is negative, and up is more). */
export function levelAfter(from: number, dy: number, height: number): number {
  const v = from - dy / Math.max(1, height * LEVEL_SPAN);
  return Math.max(0, Math.min(1, v));
}

/** Pinch: 'fill' when the fingers spread past PINCH_FILL, 'fit' when they close past PINCH_FIT. */
export function pinchVerdict(startDist: number, nowDist: number): 'fill' | 'fit' | null {
  if (!(startDist > 0)) return null;
  const r = nowDist / startDist;
  return r >= PINCH_FILL ? 'fill' : r <= PINCH_FIT ? 'fit' : null;
}

/** "+1:20" / "−0:45": how far a scrub has gone. */
export function deltaLabel(sec: number): string {
  const sign = sec < 0 ? '−' : '+';
  const a = Math.round(Math.abs(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  return `${sign}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}
