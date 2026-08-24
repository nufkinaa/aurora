// Aurora curtains for the nav rail — js/aurora.js from the website, turned
// 90°: bands flow DOWN the panel, meandering across its width, on a layer
// below the buttons.
//
// THE SKY IS THE SAME SKY EVERY TIME. The first cut re-rolled every band's
// personality per opening, and the rail read as a different place each visit
// (elia). The three personalities are now baked constants — curated draws
// from the site's makeBand ranges — so the lanes live where you left them;
// only the phase of the motion differs between openings.
//
// HOW IT MOVES — frozen shapes, moving transforms. Two approaches measured
// on the Streamer and rejected:
//   1. Repainting SVG paths per frame (the site's canvas approach):
//      50-60ms per raster, 84% janky.
//   2. Keyframe dissolve — K snapshots per band as stacked hardware-texture
//      layers, crossfaded by one native value: 15 full-height alpha-blended
//      layers was pure fill-rate murder — 85% janky at 350ms a frame.
// What survives is composition-only motion on exactly TWO band textures
// (elia: perf first, "1-2 lines is fine"): each frozen band rides layered
// sines — vertical drift, sideways sway, a TILT (the rotation is what reads
// as the curtain folding), scale breathing, and the site's presence pulse
// as opacity. Measured: same ~0% jank as a bare rail.
//
// EVERY MOTION DERIVES FROM ONE 90s LINEAR MASTER per band, sampled into
// native interpolations — NOT one Animated.loop per motion. A native-driver
// loop restarts through JS every iteration, and eight little loops
// restarting every 3-7s put a visible hitch on screen every couple of
// seconds (elia: "glitching"). The master loops once per 90s, and because
// every sine completes an INTEGER number of cycles across it, the seam has
// identical value and slope — the one restart is mathematically invisible.
//
// The whole layer is pointerEvents="none" and holds no focusables; NavRail
// mounts it inside the panel, so it exists only while the panel does.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, View, StyleSheet} from 'react-native';
import Svg, {Defs, LinearGradient, Path, Rect, Stop} from 'react-native-svg';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

type Band = {
  hero: boolean;
  meander: number; // centerline wander frequency along the drop
  mAmp: number; // how far it slaloms across the rail, in widths
  curlF: number; // the tighter kinks riding on the meander
  thick: number; // body thickness, in widths
  sMin: number; // thickness-swell floor
  sVar: number;
  xOff: number;
  phase: number;
  alpha: number;
  seed: number; // where on its personal clock this band lives
  // Motion: integer cycle counts across the 90s master (period = 90s/k) and
  // amplitudes. Integers are load-bearing — see the header on the seam.
  ky: number; // vertical drift cycles
  kx: number; // sideways sway cycles
  kr: number; // tilt cycles
  ks: number; // scale-breathe cycles
  kp: number; // presence cycles
  ampY: number;
  ampX: number;
  deg: number; // tilt, degrees
  presLo: number;
  presHi: number;
};

// Baked personalities (values hand-picked from the site's makeBand ranges).
// The hero is the wide always-there curtain; the two others are slimmer and
// pulse in and out around it without ever fully vanishing.
// Periods land between 3s and 7.5s — big, couch-visible travel (the +-18px
// first cut read as "sitting"), the two bands drifting on offset clocks so
// there is always relative motion between them.
const BANDS: Band[] = [
  {hero: true, meander: 0.0034, mAmp: 0.19, curlF: 0.010, thick: 0.36, sMin: 0.72, sVar: 0.28, xOff: -0.02, phase: 1.3, alpha: 0.95, seed: 40,
   ky: 18, kx: 26, kr: 21, ks: 15, kp: 16, ampY: 42, ampX: 15, deg: 4.2, presLo: 0.72, presHi: 1},
  {hero: false, meander: 0.0029, mAmp: 0.17, curlF: 0.012, thick: 0.24, sMin: 0.6, sVar: 0.4, xOff: 0.07, phase: 4.0, alpha: 0.75, seed: 110,
   ky: 22, kx: 30, kr: 25, ks: 17, kp: 12, ampY: 55, ampX: 19, deg: 5.2, presLo: 0.28, presHi: 0.9},
];

// One trip of the master. Long enough that its (seam-invisible) restart is
// rare; short enough that the sampled interpolations stay small.
const MASTER_MS = 90000;
// Samples across the master for the sine tables: the fastest motion (k=30)
// still gets 24 points per cycle — smooth at these amplitudes.
const SINE_N = 720;

// Sample points along the drop — enough that the tips resolve smoothly.
const SAMPLES = 18;

type Ribbon = {d: string; opacity: number; color: string};

// The cross-section as concentric ribbons: [width factor, centerline offset
// (in thicknesses; the glow leans off one side like the site's veil), color,
// opacity factor]. SVG has no cheap blur, so the canvas ramp's falloff is a
// graduated stack — seven nested translucent ribbons read as one soft glow.
// (Four read as drawn lines — elia: "too liny".)
const LAYERS: Array<[number, number, string, number]> = [
  [3.0, 0.18, '#17957a', 0.03],
  [2.2, 0.12, '#1ea87c', 0.055],
  [1.6, 0.07, '#2cc98b', 0.085],
  [1.15, 0.03, '#38dd92', 0.12],
  [0.8, 0.0, '#3ce996', 0.16],
  [0.5, -0.03, '#6ef7b0', 0.24],
  [0.26, -0.06, '#a4ffd0', 0.38],
];
// The hero band alone gets the site's blue-violet fringe on its far side.
const FRINGE: [number, number, string, number] = [0.8, -0.5, '#6ea0ff', 0.07];

// One moment of one band's clock, as closed ribbon paths.
function bandRibbons(b: Band, t: number, W: number, H: number): Ribbon[] {
  const center = H * (0.5 + 0.28 * Math.sin(t * 0.05 + b.phase));
  const halfLen = H * (0.62 + 0.18 * Math.sin(t * 0.037 + b.phase * 1.9));
  const s = t * 0.3;
  const curlAmp = 0.1 * Math.max(0, Math.sin(t * 0.19 + b.phase * 2.3));

  const xs: number[] = [];
  const ys: number[] = [];
  const ths: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = -1 + (2 * i) / (SAMPLES - 1);
    const y = center + u * halfLen;
    // The dome shades the band toward its ends — but sqrt alone leaves real
    // thickness AT the tips, which drew a flat cut where the band should die
    // (elia: "their end is flat"). A smoothstep feather over the outer 28%
    // takes the width to an actual point, with zero slope at the very tip.
    const dome = Math.sqrt(1 - u * u);
    const a = Math.abs(u);
    let feather = 1;
    if (a > 0.72) {
      const k = (1 - a) / 0.28;
      feather = k * k * (3 - 2 * k);
    }
    const xC =
      W *
      (0.5 +
        b.xOff +
        b.mAmp *
          Math.sin(
            y * b.meander + s * 0.9 + b.phase + 2.6 * Math.sin(y * b.meander * 0.31 + s * 0.3),
          ) +
        curlAmp * Math.sin(y * b.curlF + s * 1.6 + b.phase * 3));
    const swell = b.sMin + b.sVar * Math.sin(y * 0.0017 + s * 0.7 + b.phase * 1.6);
    xs.push(xC);
    ys.push(y);
    ths.push(W * b.thick * swell * (0.25 + 0.75 * dome) * feather);
  }

  const ribbon = (wf: number, off: number): string => {
    // Down the left edge, back up the right — one closed shape.
    let d = '';
    for (let i = 0; i < SAMPLES; i++) {
      const c = xs[i] + ths[i] * off;
      const w = (ths[i] * wf) / 2;
      d += `${i === 0 ? 'M' : 'L'}${(c - w).toFixed(1)} ${ys[i].toFixed(1)}`;
    }
    for (let i = SAMPLES - 1; i >= 0; i--) {
      const c = xs[i] + ths[i] * off;
      const w = (ths[i] * wf) / 2;
      d += `L${(c + w).toFixed(1)} ${ys[i].toFixed(1)}`;
    }
    return d + 'Z';
  };

  const layers = b.hero ? [FRINGE, ...LAYERS] : LAYERS;
  return layers.map(([wf, off, color, op]) => ({
    d: ribbon(wf, off),
    opacity: Math.min(1, op * b.alpha),
    color,
  }));
}

// A sine of `cycles` full periods across the master's [0,1], sampled into a
// native interpolation. `phase` shifts where in the cycle this opening
// starts; integer `cycles` keeps the loop seam continuous.
function sineOf(
  master: Animated.Value,
  cycles: number,
  phase: number,
  lo: number,
  hi: number,
  unit?: string,
): Animated.AnimatedInterpolation<string | number> {
  const inputRange: number[] = [];
  const values: number[] = [];
  for (let i = 0; i <= SINE_N; i++) {
    const t = i / SINE_N;
    inputRange.push(t);
    values.push(lo + (hi - lo) * (0.5 + 0.5 * Math.sin(2 * Math.PI * cycles * t + phase)));
  }
  return unit
    ? master.interpolate({inputRange, outputRange: values.map(v => v.toFixed(3) + unit)})
    : master.interpolate({inputRange, outputRange: values});
}

function BandView({band, w, h}: {band: Band; w: number; h: number}) {
  // This band's one frozen shape, computed once per mount.
  const ribbons = useMemo(() => bandRibbons(band, band.seed, w, h), [band, w, h]);
  const master = useRef(new Animated.Value(0)).current;
  // Openings differ only in WHERE on the cycle each motion starts (one
  // random phase per mount), never in the lanes.
  const p0 = useRef(rand(0, Math.PI * 2)).current;

  const motion = useMemo(
    () => ({
      ty: sineOf(master, band.ky, p0, -band.ampY, band.ampY),
      tx: sineOf(master, band.kx, p0 * 1.7 + 1, -band.ampX, band.ampX),
      rot: sineOf(master, band.kr, p0 * 2.3 + 2, -band.deg, band.deg, 'deg'),
      sy: sineOf(master, band.ks, p0 * 0.9, 0.94, 1.08),
      sx: sineOf(master, band.ks, p0 * 0.9 + Math.PI, 0.92, 1.1),
      op: sineOf(master, band.kp, p0 * 1.3, band.presLo, band.presHi),
    }),
    [master, band, p0],
  );

  useEffect(() => {
    const a = Animated.loop(
      Animated.timing(master, {
        toValue: 1,
        duration: MASTER_MS,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    a.start();
    return () => a.stop();
  }, [master]);

  return (
    <Animated.View
      renderToHardwareTextureAndroid
      style={[
        styles.fill,
        {
          opacity: motion.op,
          transform: [
            {translateY: motion.ty},
            {translateX: motion.tx},
            // The tilt is the fold: a tall curtain leaning sweeps its tips
            // tens of px sideways, which the eye reads as the drape
            // regathering — the closest a rigid texture gets to morphing.
            {rotate: motion.rot as Animated.AnimatedInterpolation<string>},
            {scaleY: motion.sy},
            {scaleX: motion.sx},
          ],
        },
      ]}>
      <Svg width={w} height={h}>
        {ribbons.map((r, i) => (
          <Path key={i} d={r.d} fill={r.color} fillOpacity={r.opacity} />
        ))}
      </Svg>
    </Animated.View>
  );
}

export default function RailAurora({width}: {width: number}) {
  // The panel is full-height; measure once and build the sky to fit.
  const [height, setHeight] = useState(0);
  return (
    <View
      pointerEvents="none"
      style={styles.clip}
      onLayout={e => setHeight(Math.round(e.nativeEvent.layout.height))}>
      {height > 0 ? BANDS.map((b, i) => <BandView key={i} band={b} w={width} h={height} />) : null}
      {/* Soft vertical edges: rays are born and die gently, never cut off —
          the site's horizontal mask, rotated. The panel is opaque, so painting
          its own color back over the ends is a free mask, drawn ABOVE the
          bands and outside their transforms so the drift never moves it. */}
      {height > 0 ? (
        <Svg width={width} height={height} style={styles.fill}>
          <Defs>
            <LinearGradient id="railAuroraTop" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#0a0b14" stopOpacity="1" />
              <Stop offset="1" stopColor="#0a0b14" stopOpacity="0" />
            </LinearGradient>
            <LinearGradient id="railAuroraBot" x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor="#0a0b14" stopOpacity="1" />
              <Stop offset="1" stopColor="#0a0b14" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={110} fill="url(#railAuroraTop)" />
          <Rect x="0" y={height - 110} width={width} height={110} fill="url(#railAuroraBot)" />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden'},
  fill: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
});
