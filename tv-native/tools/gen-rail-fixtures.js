#!/usr/bin/env node
// Expected values for the JVM tests of the native rail's drawing arithmetic
// (android/app/src/main/java/com/auroratv/ui/rail/RailMath.kt, tested by
// android/app/src/test/java/com/auroratv/ui/rail/RailMathTest.kt).
//
// Where the numbers come from:
//   - every constant (widths, the slide's duration and easing, the hue loops' durations,
//     the eight hue interpolations, the glows' boxes and tints, the body / edge / scrim /
//     feather colours and stops, the freeze phase) is READ out of
//     src/components/NavRail.tsx, theme.ts and qa.ts — the JS reference, not a copy;
//   - the structure the native view reproduces (which value drives what, the layer order,
//     the body drawn twice) is checked to still be present, verbatim, in NavRail.tsx, so
//     the fixture cannot quietly outlive the code it describes;
//   - colours go through React Native's own @react-native/normalize-colors, and SVG stop
//     opacities through react-native-svg's rule (`Math.round(stopOpacity * 255)`);
//   - easings are React Native's own Easing.js / bezier.js, executed; the timing frames
//     its TimingAnimation pre-sampling; the slide runs RN's native timing driver as
//     tools/fixture-lib.js states it;
//   - the CSS gradient line is React Native's LinearGradient.kt `endPointsFromAngle`,
//     re-stated here in doubles and cross-checked against the CSS definition
//     (length = |w sin a| + |h cos a| through the box's centre);
//   - res/drawable-nodpi/aurora_glow.png must be src/assets/glow.png, byte for byte.
//
//   node tools/gen-rail-fixtures.js   → android/app/src/test/resources/rail-fixtures.json
'use strict';
const L = require('./fixture-lib');
const normalizeColor = require('@react-native/normalize-colors');

const railSrc = L.read('components/NavRail.tsx');
const themeSrc = L.read('theme.ts');
const qaSrc = L.read('qa.ts');
const N = 'NavRail.tsx';

/** A CSS colour → the signed ARGB int Android takes. */
const argb = css => {
  const rgba = normalizeColor(css);
  if (rgba == null) throw new Error(`not a colour: ${css}`);
  return (((rgba & 0xff) << 24) | (rgba >>> 8)) | 0;
};
/** react-native-svg: extractGradient.ts folds stopOpacity in as Math.round(o * 255); Brush.java then rounds alpha * 1. */
const svgStop = (css, stopOpacity) => {
  const rgb = argb(css) & 0x00ffffff;
  return ((Math.round(Math.round(stopOpacity * 255) * 1) << 24) | rgb) | 0;
};
const two = (re, what) => {
  const m = railSrc.match(re);
  if (!m) throw new Error(`cannot find ${what} in ${N}`);
  return [Number(m[1]), Number(m[2])];
};
const hue = (block, prop, driver) =>
  two(
    new RegExp(`${block}[\\s\\S]*?${prop}: ${driver}\\.interpolate\\(\\{inputRange: \\[0, 1\\], outputRange: \\[(-?[\\d.]+), (-?[\\d.]+)\\]\\}\\)`),
    `${block} ${prop}`,
  );
/** 'linear-gradient(165deg, rgba(…) 0%, …)' → {angle, colors[], stops[]} */
const cssGradient = (re, what) => {
  const m = railSrc.match(re);
  if (!m) throw new Error(`cannot find ${what} in ${N}`);
  const g = m[1];
  const angle = Number(g.match(/linear-gradient\((-?[\d.]+)deg/)[1]);
  const colors = [];
  const stops = [];
  for (const s of g.matchAll(/(rgba?\([^)]*\))\s+([\d.]+)%/g)) {
    colors.push(argb(s[1]));
    stops.push(Number(s[2]) / 100);
  }
  if (colors.length < 2) throw new Error(`no stops in ${what}`);
  return {angle, colors, stops};
};
/** <Stop offset="…" stopColor="…" stopOpacity="…" /> inside the gradient with this id */
const svgGradient = id => {
  const m = railSrc.match(new RegExp(`<LinearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">([\\s\\S]*?)</LinearGradient>`));
  if (!m) throw new Error(`cannot find the horizontal SVG gradient ${id} in ${N}`);
  const colors = [];
  const stops = [];
  for (const s of m[1].matchAll(/<Stop offset="([\d.]+)" stopColor="(#[0-9a-fA-F]+)" stopOpacity="([\d.]+)" \/>/g)) {
    stops.push(Number(s[1]));
    colors.push(svgStop(s[2], Number(s[3])));
  }
  if (colors.length < 2) throw new Error(`no stops in ${id}`);
  return {colors, stops};
};

// ---- constants -------------------------------------------------------------------------
const K = {
  rail: L.num(themeSrc, /\bnav = \{ ?rail: (\d+), railOpen: \d+ ?\}/, 'nav.rail'),
  railOpen: L.num(themeSrc, /\bnav = \{ ?rail: \d+, railOpen: (\d+) ?\}/, 'nav.railOpen'),
  feather: L.num(railSrc, /\nconst FEATHER = (\d+);/, 'FEATHER'),
  med: L.num(themeSrc, /\bmed: (\d+)/, 'motion.med'),
  hueAMs: L.num(railSrc, /runLoop\(a, run\(a, (\d+)\)\)/, "loop a's duration"),
  hueBMs: L.num(railSrc, /runLoop\(b, run\(b, (\d+)\)\)/, "loop b's duration"),
  frozenPhase: L.num(qaSrc, /\nexport const FROZEN_PHASE = ([\d.]+);/, 'FROZEN_PHASE'),
  bodyColor: argb(railSrc.match(/panelBody: \{[\s\S]*?backgroundColor: '(#[0-9a-fA-F]+)'/)[1]),
  edgeK: L.num(railSrc, /huesEdge: \{[\s\S]*?width: Math\.round\(nav\.railOpen \* ([\d.]+)\)/, "huesEdge's width"),
};
K.panel = K.railOpen + K.feather;
K.edge = Math.round(K.railOpen * K.edgeK);
const ease = themeSrc.match(/\bease: \[([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\] as const/);
if (!ease) throw new Error('cannot find focus.ease in theme.ts');
K.ease = ease.slice(1, 5).map(Number);

const violetBox = railSrc.match(/hueViolet: \{position: 'absolute', top: (-?\d+), left: (-?\d+), width: (\d+), height: (\d+), tintColor: '(#[0-9a-fA-F]+)'\}/);
const greenBox = railSrc.match(/hueGreen: \{position: 'absolute', bottom: (-?\d+), left: (-?\d+), width: (\d+), height: (\d+), tintColor: '(#[0-9a-fA-F]+)'\}/);
if (!violetBox || !greenBox) throw new Error(`the glows' boxes changed in ${N}`);
if (violetBox[3] !== violetBox[4] || greenBox[3] !== greenBox[4]) throw new Error('a glow is no longer square');
const H = {
  violet: {
    top: Number(violetBox[1]), left: Number(violetBox[2]), size: Number(violetBox[3]), tint: argb(violetBox[5]),
    alpha: hue('styles\\.hueViolet', 'opacity', 'a'),
    tx: hue('styles\\.hueViolet', '\\{translateX', 'a'),
    ty: hue('styles\\.hueViolet', '\\{translateY', 'b'),
    scale: hue('styles\\.hueViolet', '\\{scale', 'a'),
  },
  green: {
    bottom: Number(greenBox[1]), left: Number(greenBox[2]), size: Number(greenBox[3]), tint: argb(greenBox[5]),
    alpha: hue('styles\\.hueGreen', 'opacity', 'b'),
    tx: hue('styles\\.hueGreen', '\\{translateX', 'b'),
    ty: hue('styles\\.hueGreen', '\\{translateY', 'a'),
    scale: hue('styles\\.hueGreen', '\\{scale', 'b'),
  },
};
const G = {
  body: cssGradient(/panelBody: \{[\s\S]*?experimental_backgroundImage:\s*'(linear-gradient\([^']+\))'/, "panelBody's gradient"),
  edge: cssGradient(/huesEdge: \{[\s\S]*?experimental_backgroundImage:\s*'(linear-gradient\([^']+\))'/, "huesEdge's gradient"),
  scrim: svgGradient('railScrim'),
  feather: svgGradient('railFeather'),
};

// ---- the structure the native view reproduces ---------------------------------------------
L.must(railSrc, "const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));", 'the easing', N);
L.must(railSrc, 'toValue: 0, duration: motion.med, easing: EASE, useNativeDriver: true,', "close()'s timing", N);
L.must(railSrc, 'toValue: 1, duration: motion.med, easing: EASE, useNativeDriver: true,', "the open effect's timing", N);
L.must(railSrc, '}).start(() => { closingRef.current = false; setClosing(false); setOpen(false); });', "close()'s callback", N);
L.must(railSrc, 'setOpen(false); slide.setValue(0);', 'instantClose', N);
L.must(railSrc, 'style={[styles.strip, {opacity: slide.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}', "the strip's opacity", N);
L.must(railSrc, '{transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [-(nav.railOpen + FEATHER), 0]})}]},', "the panel's translateX", N);
L.must(railSrc, '<View style={styles.panelBody} />', 'the first body', N);
L.must(railSrc, '<Animated.View pointerEvents="none" style={[styles.panelBody, {opacity: slide}]}> <RailHues /> </Animated.View> <Svg pointerEvents="none" style={styles.panelFeather} width={FEATHER} height="100%">', 'the second body, the hues in it, then the feather', N);
L.must(railSrc, '<Rect x="0" y="0" width={FEATHER} height="100%" fill="url(#railFeather)" />', "the feather's rect", N);
L.must(railSrc, '<Rect x="0" y="0" width={width} height="100%" fill="url(#railScrim)" />', "the scrim's rect", N);
L.must(railSrc, '<Scrim width={nav.rail} />', 'the scrim over the whole strip', N);
L.must(railSrc, 'if (isLite()) return;', 'the lite gate', N);
L.must(railSrc, 'Animated.timing(v, {toValue: 1, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false}), Animated.timing(v, {toValue: 0, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false}),', 'the loop legs', N);
L.must(railSrc, 'hues: {position: \'absolute\', top: 0, left: 0, bottom: 0, width: nav.railOpen},', 'the hues box', N);
L.must(railSrc, 'huesEdge: { position: \'absolute\', top: 0, right: 0, bottom: 0,', "the edge's place", N);
L.must(railSrc, "panelFeather: { position: 'absolute', top: 0, bottom: 0, left: nav.railOpen, width: FEATHER, },", "the feather's place", N);
L.must(railSrc, "overflow: 'hidden',", "the body's clip", N);
L.must(qaSrc, 'value.setValue(FROZEN_PHASE);', "runLoop's freeze", 'qa.ts');
L.sameFile('glow.png', 'drawable-nodpi/aurora_glow.png');

// ---- easings, from React Native's own JS -----------------------------------------------
const EasingModule = L.loadAnimated('Easing.js');
const Easing = EasingModule.default || EasingModule;
const bezier = L.loadAnimated('bezier.js').default;
const sinInOut = Easing.inOut(Easing.sin);
const slideFrames = L.timingFrames(K.med, bezier(...K.ease));
const hueAFrames = L.timingFrames(K.hueAMs, sinInOut);
const hueBFrames = L.timingFrames(K.hueBMs, sinInOut);

const fx = {constants: K, hues: H, gradients: G, slide: {frames: slideFrames, runs: []}, sinInOut: [], hueFrames: {}, glows: [], gradientLines: [], px: []};

// ---- the slide: open and close, and what rides it -----------------------------------------
const lerp = (v, from, to) => L.interpolateClamp(v, [0, 1], [from, to]);
function slideRun(name, from, to, frameNs, nFrames, start = 555000111222n) {
  const ft = Array.from({length: nFrames}, (_, i) => (start + BigInt(i) * frameNs).toString());
  const values = L.runTiming(slideFrames, from, to, ft);
  fx.slide.runs.push({
    name, from, to,
    frameTimesNanos: ft.slice(0, values.length),
    // [slide, the panel's translateX (dp), the strip's opacity, the second body's 8-bit alpha]
    steps: values.map(v => [v, lerp(v, -K.panel, 0), lerp(v, 1, 0), L.alpha8(v)]),
  });
}
slideRun('open-60hz', 0, 1, 16666667n, 40);
slideRun('close-60hz', 1, 0, 16666667n, 40);
slideRun('open-50hz', 0, 1, 20000000n, 40);
// close() while the open slide is half way: the new timing starts from the value on screen
slideRun('close-from-half', slideFrames[6], 0, 16666667n, 40);

// ---- the hue loops -------------------------------------------------------------------------
for (let i = 0; i <= 200; i++) fx.sinInOut.push([i / 200, sinInOut(i / 200)]);
const sampled = frames => ({count: frames.length, samples: frames.map((v, i) => [i, v]).filter(([i]) => i % 16 === 0 || i >= frames.length - 3)});
fx.hueFrames.a = sampled(hueAFrames);
fx.hueFrames.b = sampled(hueBFrames);

const glowAt = (a, b) => ({
  violet: {alpha: lerp(a, ...H.violet.alpha), tx: lerp(a, ...H.violet.tx), ty: lerp(b, ...H.violet.ty), scale: lerp(a, ...H.violet.scale)},
  green: {alpha: lerp(b, ...H.green.alpha), tx: lerp(b, ...H.green.tx), ty: lerp(a, ...H.green.ty), scale: lerp(b, ...H.green.scale)},
});
const phases = [[0, 0], [1, 1], [K.frozenPhase, K.frozenPhase], [0.5, 0.25], [1, 0], [0, 1], [hueAFrames[100], hueBFrames[100]], [hueAFrames[333], hueBFrames[333]]];
for (const [a, b] of phases) {
  const g = glowAt(a, b);
  // the paint alpha HWUI leaves: the image's own opacity first, then the body's `slide`
  const paint = slide => ({slide, violet: L.alpha8(slide, L.alpha8(g.violet.alpha)), green: L.alpha8(slide, L.alpha8(g.green.alpha))});
  fx.glows.push({a, b, ...g, paints: [1, 0.5, slideFrames[3], 0].map(paint)});
}

// ---- the CSS gradient line (LinearGradient.kt endPointsFromAngle) ----------------------------
function gradientLine(angle, width, height) {
  let a = angle % 360;
  if (a < 0) a += 360;
  if (a === 0) return [0, height, 0, 0];
  if (a === 90) return [0, 0, width, 0];
  if (a === 180) return [0, 0, 0, height];
  if (a === 270) return [width, 0, 0, 0];
  const slope = Math.tan(((90 - a) * Math.PI) / 180);
  const perpendicularSlope = -1 / slope;
  const halfHeight = height / 2;
  const halfWidth = width / 2;
  const corner = a < 90 ? [halfWidth, halfHeight] : a < 180 ? [halfWidth, -halfHeight] : a < 270 ? [-halfWidth, -halfHeight] : [-halfWidth, halfHeight];
  const c = corner[1] - perpendicularSlope * corner[0];
  const endX = c / (slope - perpendicularSlope);
  const endY = perpendicularSlope * endX + c;
  return [halfWidth - endX, halfHeight + endY, halfWidth + endX, halfHeight - endY];
}
const sizes = [[480, 1080], [360, 1080], [240, 540], [720, 2160], [240, 1080], [120, 540]];
for (const angle of [G.body.angle, G.edge.angle, 0, 45, 180, 200, 270, 315, -15, 525]) {
  for (const [w, h] of sizes) {
    const line = gradientLine(angle, w, h);
    // the CSS definition: through the centre, |w sin a| + |h cos a| long, pointing along the angle
    const rad = (angle * Math.PI) / 180;
    const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const got = Math.hypot(line[2] - line[0], line[3] - line[1]);
    if (Math.abs(got - len) > 1e-6 * len) throw new Error(`gradient line ${angle}deg ${w}x${h}: ${got} long, CSS says ${len}`);
    // (the four axis-aligned angles run along an edge of the box instead: the same picture)
    if (((angle % 360) + 360) % 90 !== 0 && Math.abs((line[0] + line[2]) / 2 - w / 2) > 1e-6 || ((angle % 360) + 360) % 90 !== 0 && Math.abs((line[1] + line[3]) / 2 - h / 2) > 1e-6) throw new Error('gradient line is off centre');
    fx.gradientLines.push({angle, width: w, height: h, line});
  }
}

// ---- Yoga's pixel grid for the boxes the view places itself -----------------------------------
for (const density of [1, 1.5, 2, 3]) {
  for (const dp of [K.railOpen, K.railOpen - K.edge, K.panel, H.violet.left, H.violet.top, H.violet.left + H.violet.size, H.violet.top + H.violet.size, H.green.left, 540 - H.green.bottom - H.green.size, 540 - H.green.bottom, 0.5, -0.5, 1 / 3]) {
    fx.px.push({dp, density, px: Math.floor(dp * density + 0.5)});
  }
}

const out = L.writeFixture('rail-fixtures.json', fx);
console.log(`wrote ${out}: ${fx.slide.runs.length} slide runs, ${fx.glows.length} glow phases, ${fx.gradientLines.length} gradient lines`);
console.log('constants', JSON.stringify(K));
console.log('hues', JSON.stringify(H));
console.log('gradients', JSON.stringify(G));
