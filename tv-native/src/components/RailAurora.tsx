// Aurora curtains for the nav rail — js/aurora.js from the website, turned
// 90°: the bands flow DOWN the panel, meandering across its width, and sit on
// a layer below the buttons. Same personality system as the site (1–3 bands,
// random meander/curls/swell/presence, so no two openings look alike), with
// the tempo turned up — the rail is only open for seconds, so the sky has to
// be alive immediately.
//
// HOW IT ANIMATES — and why not like the website. The site repaints a canvas
// per frame. The first TV port did the same through react-native-svg (new
// path data ~12x/s), and gfxinfo on the Streamer showed what that costs:
// every update was a 50–60ms raster — 84% janky frames with the rail just
// sitting open, against Home's 7% baseline. Path morphing is simply not
// affordable on this GPU.
//
// So the shapes are FROZEN and the motion is composition. Each band's ribbon
// stack is generated once per opening (at a random moment of its personal
// clock, so every opening gets a different sky) and rendered to one static
// Svg, pinned as a hardware texture. What moves are Animated transforms on
// the band's wrapper — a slow vertical drift, a sideways sway, a scale
// breathe, and the site's presence cycle as an opacity pulse — all on the
// NATIVE driver: no JS ticks, no re-renders, no re-rasters, just the GPU
// compositing three textures. Three bands on different clocks folding over
// each other still read as living curtains; only the tight in-band curl
// morphing is lost, and at 240px wide nobody can tell.
//
// The whole layer is pointerEvents="none" and holds no focusables; NavRail
// mounts it inside the panel, so it exists only while the panel does.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, View, StyleSheet} from 'react-native';
import Svg, {Defs, LinearGradient, Path, Rect, Stop} from 'react-native-svg';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// One band's personality — the site's makeBand with the axis swapped
// (meander/curl frequencies run along y, amplitudes across the width).
type Band = {
  hero: boolean;
  meander: number;
  mAmp: number;
  curlF: number;
  thick: number;
  sMin: number;
  sVar: number;
  xOff: number;
  phase: number;
  alpha: number;
  seed: number; // the frozen moment of this band's clock
};

const makeBand = (hero = false): Band => ({
  hero,
  meander: rand(0.0026, 0.0044),
  mAmp: rand(0.15, 0.22),
  curlF: rand(0.008, 0.013),
  thick: rand(0.18, 0.28),
  sMin: hero ? 0.72 : 0.6,
  sVar: hero ? 0.28 : 0.4,
  xOff: rand(-0.05, 0.05),
  phase: rand(0, Math.PI * 2),
  alpha: hero ? rand(0.85, 1.0) : rand(0.65, 0.85),
  seed: rand(0, 200),
});

// Sample points along the drop. The slowest wave is ~1800px, the tightest
// curl ~500px — 14 samples over ~1100px renders smooth at rail widths.
const SAMPLES = 14;

type Ribbon = {d: string; opacity: number; color: string};

// The cross-section as concentric ribbons: [width factor, centerline offset
// (in thicknesses; the glow leans off one side like the site's veil), color,
// opacity factor]. Painted widest first — SVG has no cheap blur, so the
// canvas ramp's falloff is faked with a graduated stack whose edges land
// close enough together that the eye reads one glowing band, not stripes.
const LAYERS: Array<[number, number, string, number]> = [
  [2.4, 0.14, '#1ea87c', 0.045], // the long diffuse veil…
  [1.5, 0.07, '#2cc98b', 0.09],
  [0.85, 0.0, '#3ce996', 0.16], // …the band body…
  [0.34, -0.05, '#a4ffd0', 0.42], // …and the bright core
];
// The hero band alone gets the site's blue-violet fringe on its far side.
const FRINGE: [number, number, string, number] = [0.7, -0.5, '#6ea0ff', 0.08];

// One frozen sky for one band: the site's per-column math, sampled at the
// band's seed moment and turned into closed ribbon paths.
function bandRibbons(b: Band, W: number, H: number): Ribbon[] {
  const t = b.seed;
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
    const endTaper = Math.sqrt(1 - u * u); // soft only at the actual ends
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
    ths.push(W * b.thick * swell * (0.5 + 0.5 * endTaper));
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

// An endless there-and-back on a native-driver value: the building block for
// every motion here. Random durations per band keep the three bands' clocks
// from ever locking into step.
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
  const ribbons = useMemo(() => bandRibbons(band, w, h), [band, w, h]);
  const drift = useRef(new Animated.Value(Math.random())).current;
  const sway = useRef(new Animated.Value(Math.random())).current;
  const pres = useRef(new Animated.Value(band.hero ? 1 : Math.random())).current;

  useEffect(() => {
    // The site's clocks run minutes; these run seconds (elia: "faster than
    // on the website") — the fold, the sway and the come-and-go all happen
    // while the viewer is actually looking.
    const anims = [
      breathe(drift, rand(4500, 7000)),
      breathe(sway, rand(3000, 5000)),
      breathe(pres, band.hero ? rand(3500, 5500) : rand(2500, 4500), band.hero ? 0 : rand(0, 1500)),
    ];
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [drift, sway, pres, band.hero]);

  return (
    <Animated.View
      renderToHardwareTextureAndroid
      style={[
        styles.fill,
        {
          opacity: pres.interpolate({
            // The hero band never drops below a healthy glow — the panel
            // always holds at least one real aurora (site behavior).
            inputRange: [0, 1],
            outputRange: band.hero ? [0.55, 1] : [0.1, 0.95],
          }),
          transform: [
            {translateY: drift.interpolate({inputRange: [0, 1], outputRange: [-34, 34]})},
            {translateX: sway.interpolate({inputRange: [0, 1], outputRange: [-13, 13]})},
            {scaleY: drift.interpolate({inputRange: [0, 1], outputRange: [1.06, 0.97]})},
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
  // Fresh personalities on every opening, like the site gets per page load.
  const bands = useMemo(() => [makeBand(true), makeBand(), makeBand()], []);
  // The panel is full-height; measure once and build the sky to fit.
  const [height, setHeight] = useState(0);
  return (
    <View
      pointerEvents="none"
      style={styles.clip}
      onLayout={e => setHeight(Math.round(e.nativeEvent.layout.height))}>
      {height > 0 ? bands.map((b, i) => <BandView key={i} band={b} w={width} h={height} />) : null}
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
