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
// (elia: perf first, "1-2 lines is fine"): each frozen band rides four
// layered native-driver sines — vertical drift, sideways sway, a slow TILT
// (the rotation is what reads as the curtain folding), and the site's
// presence pulse as opacity. Different periods per motion per band, so the
// composite never visibly repeats. Measured: same ~0% jank as a bare rail.
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
};

// Baked personalities (values hand-picked from the site's makeBand ranges).
// The hero is the wide always-there curtain; the two others are slimmer and
// pulse in and out around it without ever fully vanishing.
const BANDS: Band[] = [
  {hero: true, meander: 0.0034, mAmp: 0.19, curlF: 0.010, thick: 0.36, sMin: 0.72, sVar: 0.28, xOff: -0.02, phase: 1.3, alpha: 0.95, seed: 40},
  {hero: false, meander: 0.0029, mAmp: 0.17, curlF: 0.012, thick: 0.24, sMin: 0.6, sVar: 0.4, xOff: 0.07, phase: 4.0, alpha: 0.75, seed: 110},
];

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

// An endless there-and-back on a native-driver value.
const breathe = (v: Animated.Value, dur: number, delay = 0) =>
  Animated.loop(
    Animated.sequence([
      Animated.timing(v, {
        toValue: 1,
        duration: dur,
        delay,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
        isInteraction: false,
      }),
      Animated.timing(v, {
        toValue: 0,
        duration: dur,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
        isInteraction: false,
      }),
    ]),
  );

function BandView({band, w, h}: {band: Band; w: number; h: number}) {
  // This band's one frozen shape, computed once per mount.
  const ribbons = useMemo(() => bandRibbons(band, band.seed, w, h), [band, w, h]);
  // Openings differ only in WHERE each motion starts, never in the lanes.
  const drift = useRef(new Animated.Value(Math.random())).current;
  const sway = useRef(new Animated.Value(Math.random())).current;
  const tilt = useRef(new Animated.Value(Math.random())).current;
  const pres = useRef(new Animated.Value(band.hero ? 1 : Math.random())).current;

  useEffect(() => {
    const anims = [
      breathe(drift, rand(4800, 6800)),
      breathe(sway, rand(3200, 4600)),
      breathe(tilt, rand(4000, 6000), rand(0, 800)),
      breathe(pres, band.hero ? rand(4000, 6000) : rand(3000, 5000), band.hero ? 0 : rand(0, 1200)),
    ];
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [drift, sway, tilt, pres, band.hero]);

  return (
    <Animated.View
      renderToHardwareTextureAndroid
      style={[
        styles.fill,
        {
          opacity: pres.interpolate({
            // Nobody fully vanishes — bands swelling and thinning in place
            // keeps the sky recognisable between glances.
            inputRange: [0, 1],
            outputRange: band.hero ? [0.7, 1] : [0.3, 0.9],
          }),
          transform: [
            {translateY: drift.interpolate({inputRange: [0, 1], outputRange: [-18, 18]})},
            {translateX: sway.interpolate({inputRange: [0, 1], outputRange: [-9, 9]})},
            // The tilt is the fold: a tall curtain leaning ±2° sweeps its
            // tips ~20px sideways, which the eye reads as the drape
            // regathering — the closest a rigid texture gets to morphing.
            {rotate: tilt.interpolate({inputRange: [0, 1], outputRange: ['-2.2deg', '2.2deg']})},
            {scaleY: drift.interpolate({inputRange: [0, 1], outputRange: [1.04, 0.98]})},
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
