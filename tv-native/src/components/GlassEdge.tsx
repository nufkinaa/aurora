// The edge of a glass pane that can be any size - a sheet, a player menu, the
// genre popup, X-Ray (glass.ts; docs/glass-tv.md): the soft shadow that falls
// outside the pane and the light that sits just inside its rim.
//
// Both are the recipe's - the shadow 0 14 34 black 34 %, 0 3 8 black 22 %,
// 0 1 2 black 22 % and a dark hairline; the light white 22 % -> 0 over 15 dp
// from the top, 7 % over 12 dp from each side, 10 % over 13 dp from the foot -
// but as eight still pictures laid round the pane, not a boxShadow and a stack
// of gradients: a corner picture in each corner (the right ones are the left
// ones mirrored) and a run stretched along each side. The middle is left out.
//
// Why pictures: the box draws a blurred boxShadow and every gradient again on
// each frame while the pane is up; a picture is a texture it only composites
// (the numbers are in docs/glass-tv.md and at the head of glass.ts).
//
// Why ONE native view on the TV (AuroraGlassEdgeView.kt): eight <Image>s in a
// box are nine views to create on the very frame a menu opens. Measured on the
// Mi TV inside ONE app session (the build switched looks by the clock, 28-34
// openings of the player's menu each): that frame took 152 ms with the eight
// <Image>s, 134 ms with this view, 131 ms with no edge at all - and 136 ms
// before the glass. (Never compare that frame across app sessions: the same
// build gives 132-169 ms from one start of the app to the next.) The view
// draws the same eight pictures itself, pixel for pixel. It takes them by
// the names Android gave them as bundled resources; where a picture is not a
// resource (Metro, the sandbox) the eight <Image>s stand in.
//
// Put it FIRST inside the pane, so the pane's words lie over the light. The
// pane must not clip (no overflow: 'hidden') and must be at least 68 dp wide
// and 82 dp tall (the corner pictures would overlap under that). `border` is
// the pane's own border width: an absolute child is placed from the inside of
// the border. Radius 24 is a sheet that stands on the screen's foot: no foot
// corners and no foot run, the sides run down to the pane's last line (its
// border is 0 there).
import React from 'react';
import {Image, Platform, StyleSheet, View} from 'react-native';
import AuroraGlassEdge from '../specs/AuroraGlassEdgeNativeComponent';

// tools/gen_glass_edge.py: MARGIN, C, C_TOP, G
const M = 48;
const C = 34;
const C_TOP = 48;
const G = 16;

const RUN_TOP = require('../assets/glass-edge-run-top.png');
const RUN_FOOT = require('../assets/glass-edge-run-foot.png');
const RUN_SIDE = require('../assets/glass-edge-run-side.png');
const CORNERS = {
  14: {top: require('../assets/glass-edge-r14-top.png'), foot: require('../assets/glass-edge-r14-foot.png')},
  18: {top: require('../assets/glass-edge-r18-top.png'), foot: require('../assets/glass-edge-r18-foot.png')},
  22: {top: require('../assets/glass-edge-r22-top.png'), foot: require('../assets/glass-edge-r22-foot.png')},
  24: {top: require('../assets/glass-edge-r24-top.png'), foot: null},
} as const;

// The name a bundled picture has as an Android resource ('' when it is not one:
// under Metro a picture is an http address, in the sandbox a file).
function res(source: number | null): string {
  if (source == null) return '';
  try {
    const uri = Image.resolveAssetSource(source)?.uri ?? '';
    return /^[a-z0-9_]+$/.test(uri) ? uri : '';
  } catch {
    return '';
  }
}

// Per radius: the five names the native view takes, or null where the pictures
// are not resources. Worked out once, from the bundle - not state.
function names(radius: keyof typeof CORNERS) {
  const c = CORNERS[radius];
  const n = {cornerTop: res(c.top), cornerFoot: res(c.foot), runTop: res(RUN_TOP), runFoot: res(RUN_FOOT), runSide: res(RUN_SIDE)};
  const whole = n.cornerTop && n.runTop && n.runSide && (c.foot ? n.cornerFoot && n.runFoot : true);
  return Platform.OS === 'android' && whole ? n : null;
}
const NAMES = {14: names(14), 18: names(18), 22: names(22), 24: names(24)} as const;

export default function GlassEdge({radius, border = 1}: {radius: keyof typeof CORNERS; border?: number}) {
  const c = CORNERS[radius];
  const out = -(M + border);
  const box = {top: out, left: out, right: out, bottom: c.foot ? out : 0};
  const n = NAMES[radius];
  if (n) {
    return (
      <AuroraGlassEdge
        cornerTop={n.cornerTop}
        cornerFoot={n.cornerFoot}
        runTop={n.runTop}
        runFoot={n.runFoot}
        runSide={n.runSide}
        style={[styles.box, box]}
      />
    );
  }
  if (!c.foot) {
    return (
      <View pointerEvents="none" style={[styles.box, box]}>
        <Image source={c.top} fadeDuration={0} style={styles.tl} />
        <Image source={c.top} fadeDuration={0} style={styles.tr} />
        <Image source={RUN_TOP} resizeMode="stretch" fadeDuration={0} style={styles.top} />
        <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={[styles.left, styles.toFoot]} />
        <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={[styles.right, styles.toFoot]} />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[styles.box, box]}>
      <Image source={c.top} fadeDuration={0} style={styles.tl} />
      <Image source={c.top} fadeDuration={0} style={styles.tr} />
      <Image source={c.foot} fadeDuration={0} style={styles.bl} />
      <Image source={c.foot} fadeDuration={0} style={styles.br} />
      <Image source={RUN_TOP} resizeMode="stretch" fadeDuration={0} style={styles.top} />
      <Image source={RUN_FOOT} resizeMode="stretch" fadeDuration={0} style={styles.foot} />
      <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={styles.left} />
      <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={styles.right} />
    </View>
  );
}

const W = M + C;
const H_TOP = M + C_TOP;
const H_FOOT = M + C;
const REACH = M + G;
const MIRROR = [{scaleX: -1}];

const styles = StyleSheet.create({
  box: {position: 'absolute'},
  tl: {position: 'absolute', left: 0, top: 0, width: W, height: H_TOP},
  tr: {position: 'absolute', right: 0, top: 0, width: W, height: H_TOP, transform: MIRROR},
  bl: {position: 'absolute', left: 0, bottom: 0, width: W, height: H_FOOT},
  br: {position: 'absolute', right: 0, bottom: 0, width: W, height: H_FOOT, transform: MIRROR},
  // width / height undefined: the picture's own size must not fight the two insets
  top: {position: 'absolute', left: W, right: W, top: 0, height: REACH, width: undefined},
  foot: {position: 'absolute', left: W, right: W, bottom: 0, height: REACH, width: undefined},
  left: {position: 'absolute', left: 0, top: H_TOP, bottom: H_FOOT, width: REACH, height: undefined},
  right: {position: 'absolute', right: 0, top: H_TOP, bottom: H_FOOT, width: REACH, height: undefined, transform: MIRROR},
  toFoot: {bottom: 0},
});
