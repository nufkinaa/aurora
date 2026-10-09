// Shared by tools/gen-home-fixtures.js and tools/gen-rail-fixtures.js: reading constants
// out of the TS sources, executing a pure TS module or one of React Native's own Animated
// files on plain node, and the native animation drivers re-stated step by step.
//
// The three drivers are the ones tools/gen-anim-fixtures.js states (and
// android/.../ui/anim/AnimMathTest.kt holds the Kotlin ports to): they are copied here
// unchanged so these generators feed them the app's own targets.
'use strict';
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RN_ANIMATED = path.join(ROOT, 'node_modules', 'react-native', 'Libraries', 'Animated');

const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

function num(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot find ${what}`);
  return Number(m[1]);
}
/** The expression must still be in the source, verbatim (whitespace runs collapsed). */
function must(src, text, what, file) {
  const flat = s => s.replace(/\s+/g, ' ');
  if (!flat(src).includes(flat(text))) throw new Error(`${file} no longer contains ${what}: ${text}`);
}

function exec(file, onRequire) {
  const {code} = babel.transformFileSync(file, {babelrc: false, configFile: false, presets: ['module:@react-native/babel-preset']});
  const m = {exports: {}};
  new Function('module', 'exports', 'require', code)(m, m.exports, onRequire);
  return m.exports;
}
/** A src/*.ts module with no imports, executed. */
const loadPure = rel =>
  exec(path.join(SRC, rel), name => {
    throw new Error(`${rel} must not import anything (${name})`);
  });
/** One of react-native/Libraries/Animated's files, executed. */
const loadAnimated = rel =>
  exec(path.join(RN_ANIMATED, rel), name => {
    if (name === 'invariant') {
      return (c, msg) => {
        if (!c) throw new Error(msg);
      };
    }
    // Easing.js asks for its sibling lazily (`require('./bezier')` inside Easing.bezier)
    if (name.startsWith('./')) return loadAnimated(name.slice(2) + '.js');
    throw new Error(`unexpected require ${name} from ${rel}`);
  });

const same = (a, b, what) => {
  if (!Object.is(a, b) && a !== b) throw new Error(`${what}: ${a} vs ${b}`);
};

/** A PNG the native views decode themselves must be the very file the JS `require`s. */
function sameFile(assetRel, resRel) {
  const a = fs.readFileSync(path.join(SRC, 'assets', assetRel));
  const bPath = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', resRel);
  if (!fs.existsSync(bPath) || !a.equals(fs.readFileSync(bPath))) {
    throw new Error(`android res ${resRel} is not a byte-for-byte copy of src/assets/${assetRel} — copy it again`);
  }
}

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

// InterpolationAnimatedNode (react-android 0.86.0-2): findRangeIndex + interpolate with
// extrapolate 'clamp' on both sides — what a native-driven `.interpolate()` evaluates.
function interpolateClamp(value, input, output) {
  let index = 1;
  for (; index < input.length - 1; index++) if (input[index] >= value) break;
  const i = index - 1;
  const [inMin, inMax, outMin, outMax] = [input[i], input[i + 1], output[i], output[i + 1]];
  let result = value;
  if (result < inMin) result = inMin;
  if (result > inMax) result = inMax;
  if (outMin === outMax) return outMin;
  if (inMin === inMax) return value <= inMin ? outMin : outMax;
  return outMin + ((outMax - outMin) * (result - inMin)) / (inMax - inMin);
}

/** motion.ts SLIDE_SPRING through SpringConfig.js (as gen-row-fixtures.js does). */
function slideSpring() {
  if (!/SLIDE_SPRING = \{speed: 12, bounciness: 0\}/.test(read('motion.ts'))) throw new Error('motion.ts SLIDE_SPRING changed');
  const cfg = exec(path.join(RN_ANIMATED, 'SpringConfig.js'), () => {
    throw new Error('unexpected require');
  });
  return {...cfg.fromBouncinessAndSpeed(0, 12), mass: 1};
}

/** HWUI's per-op alpha: `(uint8_t) paintAlpha * (float) viewAlpha`, truncated. */
const alpha8 = (alpha, base = 255) => Math.max(0, Math.min(255, Math.trunc(Math.fround(base * Math.fround(alpha)))));

function writeFixture(name, fx) {
  const out = path.join(ROOT, 'android', 'app', 'src', 'test', 'resources', name);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(fx, null, 1) + '\n');
  return out;
}

module.exports = {
  read, num, must, loadPure, loadAnimated, same, sameFile, timingFrames, runTiming, runSpring, interpolateClamp, slideSpring, alpha8, writeFixture,
};
