#!/usr/bin/env node
// Expected values for the JVM tests of the native row's arithmetic
// (android/app/src/main/java/com/auroratv/ui/row/RowMath.kt, tested by
// android/app/src/test/java/com/auroratv/ui/row/RowMathTest.kt).
//
// Where the numbers come from:
//   - the constants (LEAD, VISIBLE_AHEAD/BEHIND, WINDOW_SLACK, the card widths,
//     spacing.md / contentLeft) are READ out of src/components/Row.tsx,
//     Card.tsx and theme.ts — the JS reference row, not a copy of it;
//   - the four rules are Row.tsx's inline expressions, re-stated below as
//     `ref.*`. Each one is checked to still be present, verbatim, in Row.tsx,
//     so the fixture cannot quietly outlive the code it describes;
//   - src/rowMath.ts (what the native row's JS wrapper uses) is transpiled and
//     executed here and must agree with `ref.*` on every case, or nothing is
//     written;
//   - the slide journeys are RN's native SpringAnimation as
//     tools/gen-anim-fixtures.js states it (the function is copied from there),
//     fed the targets above and retargeted the way AuroraRowView does.
//
//   node tools/gen-row-fixtures.js   → android/app/src/test/resources/row-fixtures.json
'use strict';
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const rowSrc = read('components/Row.tsx');
const cardSrc = read('components/Card.tsx');
const themeSrc = read('theme.ts');

function num(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot find ${what}`);
  return Number(m[1]);
}
function must(src, text, what) {
  if (!src.includes(text)) throw new Error(`Row.tsx no longer contains ${what}: ${text}`);
}

// ---- the JS reference row's constants and rules ------------------------------------
const K = {
  lead: num(rowSrc, /\nconst LEAD = (\d+);/, 'LEAD'),
  ahead: num(rowSrc, /\nconst VISIBLE_AHEAD = (\d+);/, 'VISIBLE_AHEAD'),
  behind: num(rowSrc, /\nconst VISIBLE_BEHIND = (\d+);/, 'VISIBLE_BEHIND'),
  slack: num(rowSrc, /\nconst WINDOW_SLACK = (\d+);/, 'WINDOW_SLACK'),
  cardW: num(cardSrc, /\bCARD_W = (\d+)/, 'CARD_W'),
  frameW: num(cardSrc, /\bFRAME_W = (\d+)/, 'FRAME_W'),
  gap: num(themeSrc, /\bmd: (\d+)/, 'spacing.md'),
  contentLeft: num(themeSrc, /\bcontentLeft: (\d+)/, 'spacing.contentLeft'),
};
must(rowSrc, 'const step = (wide ? FRAME_W : CARD_W) + spacing.md;', 'the step');
must(rowSrc, 'tx.to(-Math.max(0, (index - LEAD) * step));', 'the slide target');
must(rowSrc, 'Math.abs(index - prev) >= WINDOW_SLACK ? index : prev', 'the anchor rule');
must(rowSrc, 'const from = Math.max(0, anchor - VISIBLE_BEHIND);', 'the window start');
must(rowSrc, 'const to = Math.min(items.length, anchor + VISIBLE_AHEAD + 1);', 'the window end');
must(rowSrc, 'left: spacing.contentLeft + index * step', 'the slot position');

const ref = {
  slideTarget: (index, step) => -Math.max(0, (index - K.lead) * step),
  nextAnchor: (prev, index) => (Math.abs(index - prev) >= K.slack ? index : prev),
  from: anchor => Math.max(0, anchor - K.behind),
  to: (anchor, n) => Math.min(n, anchor + K.ahead + 1),
  slotLeft: (index, step) => K.contentLeft + index * step,
};
const steps = {poster: K.cardW + K.gap, frame: K.frameW + K.gap};

// ---- src/rowMath.ts, executed ----------------------------------------------------------
const rowMath = (() => {
  const file = path.join(SRC, 'rowMath.ts');
  const {code} = babel.transformFileSync(file, {babelrc: false, configFile: false, presets: ['module:@react-native/babel-preset']});
  const m = {exports: {}};
  new Function('module', 'exports', 'require', code)(m, m.exports, name => {
    throw new Error(`rowMath.ts must not import anything (${name})`);
  });
  return m.exports;
})();
const same = (a, b, what) => {
  if (!Object.is(a, b) && a !== b) throw new Error(`src/rowMath.ts disagrees with Row.tsx on ${what}: ${a} vs ${b}`);
};
same(rowMath.LEAD, K.lead, 'LEAD');
same(rowMath.VISIBLE_AHEAD, K.ahead, 'VISIBLE_AHEAD');
same(rowMath.VISIBLE_BEHIND, K.behind, 'VISIBLE_BEHIND');
same(rowMath.WINDOW_SLACK, K.slack, 'WINDOW_SLACK');

// ---- cases ---------------------------------------------------------------------------
const fx = {constants: {...K, steps}, slideTargets: [], windowWalks: [], indexOfLeft: [], slideRuns: []};

for (const [shape, step] of Object.entries(steps)) {
  for (let index = 0; index <= 60; index++) {
    const target = ref.slideTarget(index, step);
    same(rowMath.slideTarget(index, step), target, `slideTarget(${index}, ${step})`);
    fx.slideTargets.push({shape, index, step, target: target + 0}); // + 0: -0 → 0 for JSON
  }
}

// Focus walks: the anchor is state, so each walk is replayed from anchor 0 (a fresh row).
const walks = {
  'hold-right': n => Array.from({length: n}, (_, i) => i),
  'right-then-left': n => [...Array.from({length: n}, (_, i) => i), ...Array.from({length: n}, (_, i) => n - 1 - i)],
  'dither-at-the-slack': () => [0, 1, 2, 3, 2, 3, 4, 5, 6, 5, 4, 3, 2, 3, 6, 7, 8, 9, 8, 9, 10, 12, 9, 6, 3, 0],
  'jumps': n => [0, n - 1, 0, Math.floor(n / 2), 1, n - 2, 2, 5, 8, 11].filter(i => i >= 0 && i < n),
};
for (const count of [1, 2, 4, 9, 16, 40]) {
  for (const [name, make] of Object.entries(walks)) {
    const seq = make(count).filter(i => i < count);
    let anchor = 0;
    let anchorB = 0;
    const out = [];
    for (const index of seq) {
      anchor = ref.nextAnchor(anchor, index);
      anchorB = rowMath.nextAnchor(anchorB, index);
      same(anchorB, anchor, `nextAnchor in ${name}/${count}`);
      const w = rowMath.windowRange(anchor, count);
      same(w.from, ref.from(anchor), `window.from in ${name}/${count}`);
      same(w.to, ref.to(anchor, count), `window.to in ${name}/${count}`);
      out.push([index, anchor, ref.from(anchor), ref.to(anchor, count)]);
    }
    fx.windowWalks.push({name: `${name}-${count}`, count, steps: out});
  }
}

// The slot's left edge as the native view reads it: Yoga rounds the dp position to the
// pixel grid (half up on the scaled value), the view divides by the density again. With
// the card a few dp off its slot's edge either way (a flattened slot), and counts that
// clamp.
const yogaPx = (dp, density) => Math.floor(dp * density + 0.5);
for (const density of [1, 1.5, 2, 3]) {
  for (const [shape, step] of Object.entries(steps)) {
    for (const index of [0, 1, 2, 5, 13, 39]) {
      for (const off of [-3, 0, 3]) {
        const left = yogaPx(ref.slotLeft(index, step) + off, density) / density;
        const got = rowMath.indexOfLeft(left, K.contentLeft, step, 40);
        same(got, index, `indexOfLeft(${left}) @${density}`);
        fx.indexOfLeft.push({shape, density, left, contentLeft: K.contentLeft, step, count: 40, index});
      }
    }
  }
}
// outside the shelf: clamped
for (const [left, count, index] of [[-500, 40, 0], [0, 40, 0], [84 + 138 * 45, 40, 39], [84 + 138 * 45, 0, 45], [84 + 138 * 3, 2, 1]]) {
  same(rowMath.indexOfLeft(left, K.contentLeft, steps.poster, count), index, `indexOfLeft clamp ${left}/${count}`);
  fx.indexOfLeft.push({shape: 'poster', density: 1, left, contentLeft: K.contentLeft, step: steps.poster, count, index});
}

// ---- the slide: RN's native SpringAnimation (copied from tools/gen-anim-fixtures.js) ----
function runSpring(cfg, from, to, frameTimesNanos) {
  const {stiffness, damping, mass = 1, initialVelocity = 0, restSpeedThreshold = 0.001, restDisplacementThreshold = 0.001} = cfg;
  let position = from;
  let velocity = initialVelocity;
  let startValue = from;
  const endValue = to;
  let lastTime = 0;
  let started = false;
  let timeAcc = 0;
  const atRest = () => Math.abs(velocity) <= restSpeedThreshold && (Math.abs(endValue - position) <= restDisplacementThreshold || stiffness === 0);
  const out = [];
  for (const tn of frameTimesNanos) {
    const ms = Number(BigInt(tn) / 1000000n);
    if (!started) {
      position = from;
      startValue = position;
      lastTime = ms;
      timeAcc = 0;
      started = true;
    }
    if (!atRest()) {
      let dt = (ms - lastTime) / 1000;
      if (dt > 0.064) dt = 0.064;
      timeAcc += dt;
      const c = damping, m = mass, k = stiffness, v0 = -initialVelocity;
      const zeta = c / (2 * Math.sqrt(k * m));
      const omega0 = Math.sqrt(k / m);
      const omega1 = omega0 * Math.sqrt(1.0 - zeta * zeta);
      const x0 = endValue - startValue;
      const t = timeAcc;
      if (zeta < 1) {
        const envelope = Math.exp(-zeta * omega0 * t);
        position = endValue - envelope * (((v0 + zeta * omega0 * x0) / omega1) * Math.sin(omega1 * t) + x0 * Math.cos(omega1 * t));
        velocity =
          zeta * omega0 * envelope * ((Math.sin(omega1 * t) * (v0 + zeta * omega0 * x0)) / omega1 + x0 * Math.cos(omega1 * t)) -
          envelope * (Math.cos(omega1 * t) * (v0 + zeta * omega0 * x0) - omega1 * x0 * Math.sin(omega1 * t));
      } else {
        const envelope = Math.exp(-omega0 * t);
        position = endValue - envelope * (x0 + (v0 + omega0 * x0) * t);
        velocity = envelope * (v0 * (t * omega0 - 1) + t * x0 * (omega0 * omega0));
      }
    }
    lastTime = ms;
    out.push(position);
    if (atRest()) break;
  }
  return out;
}

// SpringConfig.js, executed (as gen-anim-fixtures.js does): motion.ts SLIDE_SPRING.
const slide = (() => {
  const file = path.join(__dirname, '..', 'node_modules', 'react-native', 'Libraries', 'Animated', 'SpringConfig.js');
  const {code} = babel.transformFileSync(file, {babelrc: false, configFile: false, presets: ['module:@react-native/babel-preset']});
  const m = {exports: {}};
  new Function('module', 'exports', 'require', code)(m, m.exports, () => {
    throw new Error('unexpected require');
  });
  if (!/SLIDE_SPRING = \{speed: 12, bounciness: 0\}/.test(read('motion.ts'))) throw new Error('motion.ts SLIDE_SPRING changed');
  return {...m.exports.fromBouncinessAndSpeed(0, 12), mass: 1};
})();
fx.slideSpring = slide;

// A journey: focus lands on `focus[k].index` at frame `focus[k].frame`; every landing
// replaces the driver, which starts from the value the previous frame drew (velocity 0).
// The value at a landing's own frame is therefore the value before it — the driver's
// first step is t = 0.
function journey(name, step, frameNs, nFrames, focus, start = 1234567890123n) {
  const ft = Array.from({length: nFrames}, (_, i) => (start + BigInt(i) * frameNs).toString());
  const values = [];
  let value = 0;
  for (let k = 0; k < focus.length; k++) {
    const begin = focus[k].frame;
    const end = k + 1 < focus.length ? focus[k + 1].frame : nFrames;
    const seg = runSpring(slide, value, ref.slideTarget(focus[k].index, step), ft.slice(begin, end));
    // between a driver finishing and the next landing nothing steps: no values
    for (const v of seg) values.push(v);
    value = seg[seg.length - 1];
    focus[k].steps = seg.length;
  }
  fx.slideRuns.push({name, step, frameTimesNanos: ft, focus, values});
}
const NS60 = 16666667n;
const NS50 = 20000000n;
// one press, card 1 → 2: the first slide ("lead" in states/row.json)
journey('lead-60hz', steps.poster, NS60, 120, [{frame: 0, index: 2}]);
// card 0 → 1: target 0 from 0 — one step, flat
journey('offset-1-60hz', steps.poster, NS60, 20, [{frame: 0, index: 1}]);
// states/row.json hold-right-12: 12 presses 50 ms apart = every 3 frames at 60 Hz
journey('hold-right-12-60hz', steps.poster, NS60, 200, Array.from({length: 12}, (_, i) => ({frame: i * 3, index: i + 1})));
// the same hold on a 50 Hz panel mode: 2.5 frames per press → alternating 2 and 3
journey('hold-right-12-50hz', steps.poster, NS50, 200, Array.from({length: 12}, (_, i) => ({frame: Math.floor(i * 2.5), index: i + 1})));
// a reversal mid-flight on the frame shelf
journey('frame-right-right-left', steps.frame, NS60, 200, [{frame: 0, index: 2}, {frame: 4, index: 3}, {frame: 9, index: 2}, {frame: 11, index: 1}]);

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources', 'row-fixtures.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(fx, null, 1) + '\n');
console.log(`wrote ${out}: ${fx.slideTargets.length} targets, ${fx.windowWalks.length} walks, ${fx.indexOfLeft.length} lefts, ${fx.slideRuns.length} slide runs`);
console.log('constants', JSON.stringify(fx.constants), 'spring', JSON.stringify(slide));
