#!/usr/bin/env node
// Expected values for the JVM tests of the native animation drivers
// (android/app/src/main/java/com/auroratv/ui/anim, tested by
// android/app/src/test/java/com/auroratv/ui/anim/AnimMathTest.kt).
//
// What comes straight from React Native's own JavaScript (transpiled from
// node_modules/react-native/Libraries/Animated and executed here):
//   - bezier.js            → the easing samples (Easing.bezier(0.2,0.7,0.2,1) and others)
//   - SpringConfig.js      → tension/friction and bounciness/speed → stiffness/damping
//   - TimingAnimation.js   → the pre-sampled `frames` array
//                            (__getNativeAnimationConfig, re-stated below: 4 lines)
// What the native drivers do per frame is NOT in the JS (the JS drivers differ: the
// JS timing evaluates the easing per frame; the spring snaps to `toValue` at rest in
// both drivers); it is re-stated here from the bytecode of react-android 0.86.0-2's
// FrameBasedAnimationDriver / SpringAnimation (see the Kotlin ports' headers), with
// the SpringAnimation.js closed-form formulas — the same formulas the Kotlin
// driver carries — so the Kotlin can be checked step by step.
//
//   node tools/gen-anim-fixtures.js   → android/app/src/test/resources/anim-fixtures.json
'use strict';
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const RN = path.join(__dirname, '..', 'node_modules', 'react-native', 'Libraries', 'Animated');

function load(rel) {
  const file = path.join(RN, rel);
  const {code} = babel.transformFileSync(file, {
    babelrc: false,
    configFile: false,
    presets: ['module:@react-native/babel-preset'],
  });
  const m = {exports: {}};
  new Function('module', 'exports', 'require', code)(m, m.exports, name => {
    if (name === 'invariant') return (c, msg) => { if (!c) throw new Error(msg); };
    throw new Error(`unexpected require ${name} from ${rel}`);
  });
  return m.exports;
}

const bezier = load('bezier.js').default;
const SpringConfig = load('SpringConfig.js');

// TimingAnimation.__getNativeAnimationConfig (TimingAnimation.js:95-110)
function timingFrames(duration, easing) {
  const frameDuration = 1000.0 / 60.0;
  const frames = [];
  const numFrames = Math.round(duration / frameDuration);
  for (let frame = 0; frame < numFrames; frame++) frames.push(easing(frame / numFrames));
  frames.push(easing(1));
  return frames;
}

// FrameBasedAnimationDriver.runAnimationStep (bytecode): long-division ms, ROUNDED index.
function runTiming(frames, from, to, frameTimesNanos) {
  let start = -1n;
  let fromValue = from;
  let value = from;
  let finished = false;
  const out = [];
  for (const tn of frameTimesNanos) {
    const t = BigInt(tn);
    if (start < 0n) {
      start = t;
      fromValue = value;
    }
    const ms = Number((t - start) / 1000000n);
    const idx = Math.round(ms / (1000 / 60));
    if (!finished) {
      if (idx >= frames.length - 1) {
        value = to;
        finished = true;
      } else {
        value = fromValue + frames[idx] * (to - fromValue);
      }
    }
    out.push(value);
    if (finished) break;
  }
  return out;
}

// SpringAnimation.runAnimationStep + advance (bytecode), with the closed form of
// SpringAnimation.js:284-319 (identical expressions).
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
    // advance
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
      // SpringAnimation.kt `advance`: "if the spring was considered within a resting
      // threshold … it's now snapped to its end value" (node_modules/react-native/
      // ReactAndroid/…/animated/SpringAnimation.kt). The first version of this file
      // left it un-snapped; the box shows RN's own run ending on exactly 1.000000.
      if (atRest() && stiffness > 0) {
        startValue = endValue;
        position = endValue;
        velocity = 0;
      }
    }
    lastTime = ms;
    out.push(position);
    if (atRest()) break;
  }
  return out;
}

const NS60 = 16666667n; // one 60 Hz frame, as Choreographer reports it on a 60 Hz panel
const NS50 = 20000000n;
const times = (n, step, start = 1234567890123n) => Array.from({length: n}, (_, i) => (start + BigInt(i) * step).toString());
// a jittered run: 60 Hz with +/- up to 4 ms of delivery jitter, plus one 70 ms stall (the 64 ms cap)
const jitter = (n, start = 987654321000n) => {
  const out = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    out.push(t.toString());
    const j = BigInt(((i * 7919) % 9) - 4) * 1000000n;
    t += (i === 12 ? 70000000n : NS60 + j);
  }
  return out;
};

const ease = bezier(0.2, 0.7, 0.2, 1);
const easeInOutSin = x => (1 - Math.cos(Math.PI * x)) / 2;

const fx = {
  bezier: [
    {x1: 0.2, y1: 0.7, x2: 0.2, y2: 1, samples: Array.from({length: 101}, (_, i) => [i / 100, ease(i / 100)])},
    {x1: 0.42, y1: 0, x2: 1, y2: 1, samples: Array.from({length: 51}, (_, i) => [i / 50, bezier(0.42, 0, 1, 1)(i / 50)])},
    {x1: 0.25, y1: 0.1, x2: 0.25, y2: 1, samples: Array.from({length: 51}, (_, i) => [i / 50, bezier(0.25, 0.1, 0.25, 1)(i / 50)])},
  ],
  timingFrames: {
    'bezier160': timingFrames(160, ease),
    'bezier280': timingFrames(280, ease),
    'sin8000': timingFrames(8000, easeInOutSin),
    'linear800': timingFrames(800, x => x),
  },
  springConfig: {
    tension180friction14: SpringConfig.fromOrigamiTensionAndFriction(180, 14),
    tension40friction7: SpringConfig.fromOrigamiTensionAndFriction(40, 7),
    bounciness0speed12: SpringConfig.fromBouncinessAndSpeed(0, 12),
    bounciness8speed12: SpringConfig.fromBouncinessAndSpeed(8, 12),
  },
  timingRuns: [],
  springRuns: [],
};

const frames160 = fx.timingFrames.bezier160;
for (const [name, ft] of [['60hz', times(40, NS60)], ['50hz', times(40, NS50)], ['jitter', jitter(40)]]) {
  fx.timingRuns.push({name: `bezier160-${name}-0to1`, frames: 'bezier160', from: 0, to: 1, frameTimesNanos: ft, values: runTiming(frames160, 0, 1, ft)});
  fx.timingRuns.push({name: `bezier160-${name}-1to0`, frames: 'bezier160', from: 1, to: 0, frameTimesNanos: ft, values: runTiming(frames160, 1, 0, ft)});
}
// a retarget: a 0→1 timing stopped after 4 frames, a 1→0 one started from its value
{
  const ft = times(40, NS60);
  const first = runTiming(frames160, 0, 1, ft.slice(0, 4));
  const second = runTiming(frames160, first[first.length - 1], 0, ft.slice(4));
  fx.timingRuns.push({name: 'bezier160-retarget', frames: 'bezier160', from: 0, to: 1, retargetAfter: 4, retargetTo: 0, frameTimesNanos: ft, values: first.concat(second)});
}

const focusSpring = {...fx.springConfig.tension180friction14, mass: 1};
const slideSpring = {...fx.springConfig.bounciness0speed12, mass: 1};
for (const [name, ft] of [['60hz', times(120, NS60)], ['50hz', times(120, NS50)], ['jitter', jitter(120)]]) {
  fx.springRuns.push({name: `focus-${name}-0to1`, ...focusSpring, from: 0, to: 1, frameTimesNanos: ft, values: runSpring(focusSpring, 0, 1, ft)});
  fx.springRuns.push({name: `focus-${name}-1to0`, ...focusSpring, from: 1, to: 0, frameTimesNanos: ft, values: runSpring(focusSpring, 1, 0, ft)});
  fx.springRuns.push({name: `slide-${name}`, ...slideSpring, from: 0, to: -260, frameTimesNanos: ft, values: runSpring(slideSpring, 0, -260, ft)});
}
{
  const ft = times(120, NS60);
  const first = runSpring(focusSpring, 0, 1, ft.slice(0, 5));
  const second = runSpring(focusSpring, first[first.length - 1], 0, ft.slice(5));
  fx.springRuns.push({name: 'focus-retarget', ...focusSpring, from: 0, to: 1, retargetAfter: 5, retargetTo: 0, frameTimesNanos: ft, values: first.concat(second)});
}

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources', 'anim-fixtures.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(fx, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 1) + '\n');
console.log(`wrote ${out}: ${fx.timingRuns.length} timing runs, ${fx.springRuns.length} spring runs`);
console.log('spring configs', JSON.stringify(fx.springConfig));
console.log('160 ms frames', JSON.stringify(frames160));
