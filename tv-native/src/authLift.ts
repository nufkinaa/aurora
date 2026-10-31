// [auth-round] How far the sign-in panel lifts so the field being typed into
// clears the TV's on-screen keyboard (screens/authKit.tsx AuthShell). PURE.
//
// Gboard for TV (the Mi TV, 2026-10-31) floats its keys over the bottom of
// the screen from 55.5% of its height down and does not resize the window.
// A field whose box ends below KEYBOARD_TOP lifts by the difference; a field
// above it lifts nothing. All figures in window units (measureInWindow),
// turned into the canvas's units by `scale` (canvas.tsx).
export const KEYBOARD_TOP = 0.53; // a little above Gboard's top edge, for air
export const TOP_FLOOR = 0.05; // a lifted field never goes above this

export function liftFor(o: {top: number; height: number; windowHeight: number; scale?: number; lifted?: number}): number {
  const scale = o.scale && o.scale > 0 ? o.scale : 1;
  const lifted = o.lifted || 0;
  // where the box sits with the panel at rest
  const restTop = o.top + lifted * scale;
  const restBottom = restTop + o.height;
  const need = (restBottom - o.windowHeight * KEYBOARD_TOP) / scale;
  if (need <= 0) return 0;
  const room = (restTop - o.windowHeight * TOP_FLOOR) / scale;
  return Math.max(0, Math.round(Math.min(need, room)));
}
