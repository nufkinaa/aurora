#!/usr/bin/env node
// Expected values for the JVM tests of Home's native column and billboard arithmetic
// (android/app/src/main/java/com/auroratv/ui/home/HomeMath.kt + ui/anim/Interpolation.kt,
// tested by android/app/src/test/java/com/auroratv/ui/home/HomeMathTest.kt).
//
// Where the numbers come from:
//   - the constants (REST / SCROLLED dims, the fade's 0.9 / 0.3 of heroH, the 260 ms
//     rest fade, pageY, heroH's 0.66, motion.med, the easing) are READ out of
//     src/screens/Home.tsx and theme.ts — the JS reference, not a copy of it;
//   - the rules are Home.tsx's inline expressions, re-stated below as `ref.*`. Each one
//     is checked to still be present, verbatim, in Home.tsx, so the fixture cannot
//     quietly outlive the code it describes;
//   - src/homeMath.ts (what Home.tsx's native path uses) is transpiled and executed here
//     and must agree with `ref.*` on every case, or nothing is written;
//   - the `atTop` timing's frames are React Native's own bezier.js through
//     TimingAnimation's pre-sampling; the journeys are RN's native drivers as
//     tools/fixture-lib.js states them, fed the targets above and restarted the way
//     AuroraSlideColumnView / AuroraHeroArtView do;
//   - res/drawable-nodpi/aurora_hero_scrim.png must be src/assets/hero-scrim.png, byte
//     for byte.
//
//   node tools/gen-home-fixtures.js   → android/app/src/test/resources/home-fixtures.json
'use strict';
const L = require('./fixture-lib');

const homeSrc = L.read('screens/Home.tsx');
const themeSrc = L.read('theme.ts');
const H = 'Home.tsx';

// ---- the JS reference's constants and rules ------------------------------------------
const K = {
  restBlur: L.num(homeSrc, /\nconst REST = \{blur: (\d+), dim: [\d.]+\};/, 'REST.blur'),
  restDim: L.num(homeSrc, /\nconst REST = \{blur: \d+, dim: ([\d.]+)\};/, 'REST.dim'),
  scrolledBlur: L.num(homeSrc, /\nconst SCROLLED = \{blur: (\d+), dim: [\d.]+\};/, 'SCROLLED.blur'),
  scrolledDim: L.num(homeSrc, /\nconst SCROLLED = \{blur: \d+, dim: ([\d.]+)\};/, 'SCROLLED.dim'),
  fadeOutK: L.num(homeSrc, /inputRange: \[-Math\.round\(heroH \* ([\d.]+)\), -Math\.round\(heroH \* [\d.]+\), 0\]/, 'the fade-out stop'),
  fadeInK: L.num(homeSrc, /inputRange: \[-Math\.round\(heroH \* [\d.]+\), -Math\.round\(heroH \* ([\d.]+)\), 0\]/, 'the fade-in stop'),
  restFadeMs: L.num(homeSrc, /blurRadius=\{art\.rest\.deviceBlur\}\s+fadeDuration=\{(\d+)\}/, "the rest layer's fadeDuration"),
  pageY: L.num(themeSrc, /\bpageY: (\d+)/, 'spacing.pageY'),
  heroHK: L.num(themeSrc, /\bheroH: Math\.round\(height \* ([\d.]+)\)/, 'heroH'),
  med: L.num(themeSrc, /\bmed: (\d+)/, 'motion.med'),
};
L.must(homeSrc, 'const EASE = Easing.bezier(0.2, 0.7, 0.2, 1);', 'the easing', H);
L.must(homeSrc, 'toValue: next ? 1 : 0, duration: motion.med, easing: EASE, useNativeDriver: true,', "setTop's timing", H);
L.must(homeSrc, 'if (next === isTop.current) return;', "setTop's guard", H);
L.must(homeSrc, 'const max = Math.max(0, colH.current - height);', "toRow's clamp", H);
L.must(homeSrc, 'ty.to(-Math.min(Math.max(0, y - spacing.pageY), max));', "toRow's target", H);
L.must(homeSrc, 'if (y == null) return;', "toRow's unmeasured row", H);
L.must(homeSrc, 'ty.to(0);', "toHero's target", H);
L.must(homeSrc, "outputRange: [0, 1, 1], extrapolate: 'clamp',", "the art fade's output", H);
L.must(homeSrc, 'const dim = atTop.interpolate({inputRange: [0, 1], outputRange: [SCROLLED.dim, REST.dim]});', 'the dim', H);
L.must(homeSrc, 'opacity: atTop.interpolate({inputRange: [0, 1], outputRange: [1, 0]})', "the scrolled layer's opacity", H);
L.must(homeSrc, '{children} <Animated.View style={[styles.artDim, {opacity: dim}]} /> <Image source={HERO_SCRIM} style={styles.artScrim} resizeMode="stretch" fadeDuration={0} />', 'the layer order (children, dim, scrim)', H);
L.sameFile('hero-scrim.png', 'drawable-nodpi/aurora_hero_scrim.png');

const ref = {
  rowTarget: (y, colH, height) => -Math.min(Math.max(0, y - K.pageY), Math.max(0, colH - height)),
  fadeStops: heroH => [-Math.round(heroH * K.fadeOutK), -Math.round(heroH * K.fadeInK), 0],
  artFade: (offset, heroH) => L.interpolateClamp(offset, ref.fadeStops(heroH), [0, 1, 1]),
  dim: atTop => L.interpolateClamp(atTop, [0, 1], [K.scrolledDim, K.restDim]),
  scrolledAlpha: atTop => L.interpolateClamp(atTop, [0, 1], [1, 0]),
  heroH: height => Math.round(height * K.heroHK),
};

// ---- src/homeMath.ts, executed ---------------------------------------------------------
const hm = L.loadPure('homeMath.ts');
const close = (a, b, what) => {
  if (Math.abs(a - b) > 1e-12) throw new Error(`src/homeMath.ts disagrees with Home.tsx on ${what}: ${a} vs ${b}`);
};

const fx = {constants: K, markers: [], rowTargets: [], columns: [], artFade: [], atTop: {}, alpha8: [], journeys: []};

// markers: the nativeIDs homeMath.ts writes, and strings that are not markers
fx.markers.push({id: hm.COL_TOP_ID, marker: -1});
for (const i of [0, 1, 2, 9, 10, 37, 120]) fx.markers.push({id: hm.colRowId(i), marker: i});
for (const id of ['', 'aurora-col-row-', 'aurora-col-row-x', 'aurora-col-row--1', 'aurora-col-row-1.5', 'aurora-col', 'row-3', 'hero', 'aurora-col-row-12345678']) {
  fx.markers.push({id, marker: -2});
}
fx.noTarget = hm.NO_TARGET;

// targets: window heights 540 and 720 dp, columns shorter than, equal to and taller than the window
for (const height of [540, 720]) {
  for (const colH of [0, 300, height, height + 1, 1200, 2913.5, 6000]) {
    for (const y of [0, 10, K.pageY, K.pageY + 0.5, 356, 603, 850.5, 1097, 2500, 5900]) {
      const target = ref.rowTarget(y, colH, height) + 0;
      close(hm.rowTarget(y, colH, height, K.pageY), target, `rowTarget(${y}, ${colH}, ${height})`);
      fx.rowTargets.push({y, colH, height, pageY: K.pageY, target});
    }
  }
}

// whole columns as Home.tsx hands them over: holes for rows not measured yet
const columns = [
  {name: 'four-shelves-540', height: 540, colH: 1371, rowY: [356, 603, 850, 1097]},
  {name: 'a-hole', height: 540, colH: 1371, rowY: [356, undefined, 850, 1097]},
  {name: 'short-column', height: 540, colH: 500, rowY: [356]},
  {name: 'ten-shelves-720', height: 720, colH: 3000.5, rowY: [475, 722, 969, 1216, 1463, 1710, 1957, 2204, 2451, 2698]},
  {name: 'empty', height: 540, colH: 0, rowY: []},
];
for (const c of columns) {
  const targets = hm.columnTargets(c.rowY, c.colH, c.height, K.pageY);
  c.rowY.forEach((y, i) => {
    if (y == null) L.same(targets[i], hm.NO_TARGET, `columnTargets hole in ${c.name}`);
    else close(targets[i], ref.rowTarget(y, c.colH, c.height) + 0, `columnTargets[${i}] in ${c.name}`);
  });
  // what a focus landing selects: marker → the offset, or null for "no slide"
  const picks = [[-1, 0]];
  for (let i = 0; i < c.rowY.length + 2; i++) picks.push([i, i < c.rowY.length && c.rowY[i] != null ? targets[i] : null]);
  picks.push([-2, null]);
  fx.columns.push({name: c.name, targets, picks});
}

// the art fade against the column's offset
for (const height of [540, 720, 1080]) {
  const heroH = ref.heroH(height);
  const [fadeOutAt, fadeInAt] = ref.fadeStops(heroH);
  const s = hm.artFadeStops(heroH);
  L.same(s.fadeOutAt, fadeOutAt, 'artFadeStops.fadeOutAt');
  L.same(s.fadeInAt, fadeInAt, 'artFadeStops.fadeInAt');
  const offsets = [50, 0, -0.001, fadeInAt + 1, fadeInAt, fadeInAt - 0.001, fadeInAt - 1, (fadeInAt + fadeOutAt) / 2, fadeOutAt + 1, fadeOutAt + 0.001, fadeOutAt, fadeOutAt - 1, -5000];
  for (let o = 0; o >= fadeOutAt - 20; o -= 7.3) offsets.push(o);
  const samples = offsets.map(offset => {
    const alpha = ref.artFade(offset, heroH);
    close(hm.artFadeAt(offset, heroH), alpha, `artFadeAt(${offset}, ${heroH})`);
    return [offset, alpha];
  });
  fx.artFade.push({height, heroH, fadeOutAt, fadeInAt, samples});
}

// atTop: 280 ms on bezier(0.2, 0.7, 0.2, 1), and what rides it
const bezier = L.loadAnimated('bezier.js').default;
const atTopFrames = L.timingFrames(K.med, bezier(0.2, 0.7, 0.2, 1));
fx.atTop.frames = atTopFrames;
fx.atTop.samples = [0, 1, 0.5, 0.25, ...atTopFrames].map(v => ({atTop: v, dim: ref.dim(v), scrolledAlpha: ref.scrolledAlpha(v)}));

// HWUI's 8-bit alpha for a view alpha over a paint at 255 (and over an already-reduced one)
for (const a of [0, 1, K.restDim, K.scrolledDim, 0.5, 0.999, 1 / 255, 0.26, 0.46, 0.37 * 0.2 + 0.26, 2, -1]) fx.alpha8.push({alpha: a, base: 255, value: L.alpha8(a)});
for (const [a, base] of [[0.5, 114], [0.25, 107], [0.999, 255], [0.37, 84]]) fx.alpha8.push({alpha: a, base, value: L.alpha8(a, base)});

// ---- journeys: the column's spring and the art that follows it ---------------------------
// focus[k] = {frame, marker}: Android moved focus into that marked child at that frame.
// Every landing replaces the spring (from the value the last frame drew, velocity 0) when
// the marker has a target; a change of top/shelves restarts the atTop timing from its value.
const slide = L.slideSpring();
fx.slideSpring = slide;
function journey(name, column, height, frameNs, nFrames, focus, start = 987654321098n) {
  const c = fx.columns.find(x => x.name === column);
  const heroH = ref.heroH(height);
  const ft = Array.from({length: nFrames}, (_, i) => (start + BigInt(i) * frameNs).toString());
  const pick = marker => (c.picks.find(p => p[0] === marker) || [marker, null])[1];
  // per frame: [ty, artAlpha, atTop] — null where that driver did not step
  const frames = ft.map(() => [null, null, null]);
  let value = 0;
  let atTop = 1;
  let top = true;
  let springFrom = -1;
  let springTo = 0;
  let timingFrom = -1;
  let timingTo = 1;
  const flushSpring = until => {
    if (springFrom < 0) return;
    const seg = L.runSpring(slide, value, springTo, ft.slice(springFrom, until));
    seg.forEach((v, i) => {
      frames[springFrom + i][0] = v;
      frames[springFrom + i][1] = ref.artFade(v, heroH);
    });
    value = seg[seg.length - 1];
    springFrom = -1;
  };
  const flushTiming = until => {
    if (timingFrom < 0) return;
    const seg = L.runTiming(atTopFrames, atTop, timingTo, ft.slice(timingFrom, until));
    seg.forEach((v, i) => (frames[timingFrom + i][2] = v));
    atTop = seg[seg.length - 1];
    timingFrom = -1;
  };
  for (const f of focus) {
    if (f.marker === -2) continue;
    const nextTop = f.marker === -1;
    if (nextTop !== top) {
      flushTiming(f.frame);
      top = nextTop;
      timingFrom = f.frame;
      timingTo = top ? 1 : 0;
    }
    const to = pick(f.marker);
    if (to != null) {
      flushSpring(f.frame);
      springFrom = f.frame;
      springTo = to;
    }
  }
  flushSpring(nFrames);
  flushTiming(nFrames);
  fx.journeys.push({name, column, height, heroH, fadeOutAt: ref.fadeStops(heroH)[0], fadeInAt: ref.fadeStops(heroH)[1], frameTimesNanos: ft, focus, frames, rest: {ty: value, atTop}});
}
const NS60 = 16666667n;
const NS50 = 20000000n;
// states/hero.json "scrolled": DOWN from Play
journey('scrolled-60hz', 'four-shelves-540', 540, NS60, 120, [{frame: 0, marker: 0}]);
// "scrolled-back": DOWN, 900 ms, UP
journey('scrolled-back-60hz', 'four-shelves-540', 540, NS60, 200, [{frame: 0, marker: 0}, {frame: 54, marker: -1}]);
// a held DOWN through the shelves (every 3 frames), the last one clamped to the column's end
journey('hold-down-60hz', 'four-shelves-540', 540, NS60, 200, [0, 1, 2, 3].map((m, i) => ({frame: i * 3, marker: m})));
// the same on a 50 Hz panel mode, then straight back up mid-flight
journey('down-down-up-50hz', 'four-shelves-540', 540, NS50, 200, [{frame: 0, marker: 0}, {frame: 2, marker: 1}, {frame: 6, marker: -1}]);
// moving along one shelf: each card restarts the spring toward the value it rests at
journey('same-row-60hz', 'four-shelves-540', 540, NS60, 80, [{frame: 0, marker: 1}, {frame: 40, marker: 1}, {frame: 44, marker: 1}]);
// focus into a shelf that is not measured yet: atTop turns, the column stays; then a measured one
journey('hole-60hz', 'a-hole', 540, NS60, 120, [{frame: 0, marker: 1}, {frame: 30, marker: 2}]);
// a tall column on a 720 dp canvas
journey('ten-shelves-60hz', 'ten-shelves-720', 720, NS60, 260, [{frame: 0, marker: 0}, {frame: 5, marker: 4}, {frame: 9, marker: 9}, {frame: 120, marker: -1}]);

const out = L.writeFixture('home-fixtures.json', fx);
console.log(`wrote ${out}: ${fx.rowTargets.length} targets, ${fx.columns.length} columns, ${fx.artFade.length} fades, ${fx.journeys.length} journeys`);
console.log('constants', JSON.stringify(K), 'spring', JSON.stringify(slide));
