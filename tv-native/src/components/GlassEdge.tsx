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
// Why pictures: measured on the Mi TV, opening the player's menu went from
// 14 ms a frame at the median to 23 ms with three blurred shadow layers and
// five gradients on the menu (and from 2.3 % to 6.5 % of frames late). The box
// draws each of those again on every frame while the pane is up. A picture is a
// texture it only composites (tools/gen_glass_edge.py has the numbers).
//
// Put it FIRST inside the pane, so the pane's words lie over the light. The
// pane must not clip (no overflow: 'hidden') and must be at least 68 dp wide
// and 82 dp tall (the corner pictures would overlap under that). `border` is
// the pane's own border width: an absolute child is placed from the inside of
// the border. Radius 24 is a sheet that stands on the screen's foot: no foot
// corners and no foot run, the sides run down to the pane's last line (its
// border is 0 there).
import React from 'react';
import {Image, StyleSheet, View} from 'react-native';

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

export default function GlassEdge({radius, border = 1}: {radius: keyof typeof CORNERS; border?: number}) {
  const c = CORNERS[radius];
  const out = -(M + border);
  if (!c.foot) {
    return (
      <View pointerEvents="none" style={[styles.box, {top: out, left: out, right: out, bottom: 0}]}>
        <Image source={c.top} fadeDuration={0} style={styles.tl} />
        <Image source={c.top} fadeDuration={0} style={styles.tr} />
        <Image source={RUN_TOP} resizeMode="stretch" fadeDuration={0} style={styles.top} />
        <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={[styles.left, styles.toFoot]} />
        <Image source={RUN_SIDE} resizeMode="stretch" fadeDuration={0} style={[styles.right, styles.toFoot]} />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[styles.box, {top: out, left: out, right: out, bottom: out}]}>
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
