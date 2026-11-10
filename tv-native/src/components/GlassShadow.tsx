// The soft shadow of a glass pane that can be any size - a sheet, a player
// menu, the genre popup (glass.ts; docs/glass-tv.md).
//
// It is the recipe's shadow (0 14 34 black 34 %, 0 3 8 black 22 %, 0 1 2 black
// 22 %, and a dark hairline just outside the rim), but as eight still pictures
// laid round the pane instead of a boxShadow: a corner picture in each corner
// (the right ones are the left ones mirrored) and a strip stretched along each
// side. The middle is left out - the pane is opaque.
//
// Why not a boxShadow: measured on the Mi TV, three blurred layers on the
// player's menu took opening it from 14 ms to 23 ms a frame at the median and
// from 2.3 % to 6.5 % of frames late - the box blurs them again on every frame
// it draws while the menu is up. A picture is a texture it only composites.
//
// Put it FIRST inside the pane. The pane must not clip (no overflow: 'hidden')
// and must be at least 68 dp wide and 82 dp tall (the corner pictures would
// overlap under that). `border` is the pane's own border width: an absolute
// child is placed from the inside of the border.
import React from 'react';
import {Image, StyleSheet, View} from 'react-native';

// tools/gen_glass_shadow.py: MARGIN, C, C_TOP
const M = 48;
const C = 34;
const C_TOP = 48;

const EDGE_TOP = require('../assets/glass-shadow-edge-top.png');
const EDGE_FOOT = require('../assets/glass-shadow-edge-foot.png');
const EDGE_SIDE = require('../assets/glass-shadow-edge-side.png');
const CORNERS = {
  14: {top: require('../assets/glass-shadow-r14-top.png'), foot: require('../assets/glass-shadow-r14-foot.png')},
  18: {top: require('../assets/glass-shadow-r18-top.png'), foot: require('../assets/glass-shadow-r18-foot.png')},
  22: {top: require('../assets/glass-shadow-r22-top.png'), foot: require('../assets/glass-shadow-r22-foot.png')},
} as const;

export default function GlassShadow({radius, border = 1}: {radius: keyof typeof CORNERS; border?: number}) {
  const c = CORNERS[radius];
  const out = -(M + border);
  return (
    <View pointerEvents="none" style={[styles.box, {top: out, left: out, right: out, bottom: out}]}>
      <Image source={c.top} fadeDuration={0} style={styles.tl} />
      <Image source={c.top} fadeDuration={0} style={styles.tr} />
      <Image source={c.foot} fadeDuration={0} style={styles.bl} />
      <Image source={c.foot} fadeDuration={0} style={styles.br} />
      <Image source={EDGE_TOP} resizeMode="stretch" fadeDuration={0} style={styles.top} />
      <Image source={EDGE_FOOT} resizeMode="stretch" fadeDuration={0} style={styles.foot} />
      <Image source={EDGE_SIDE} resizeMode="stretch" fadeDuration={0} style={styles.left} />
      <Image source={EDGE_SIDE} resizeMode="stretch" fadeDuration={0} style={styles.right} />
    </View>
  );
}

const W = M + C;
const H_TOP = M + C_TOP;
const H_FOOT = M + C;
const MIRROR = [{scaleX: -1}];

const styles = StyleSheet.create({
  box: {position: 'absolute'},
  tl: {position: 'absolute', left: 0, top: 0, width: W, height: H_TOP},
  tr: {position: 'absolute', right: 0, top: 0, width: W, height: H_TOP, transform: MIRROR},
  bl: {position: 'absolute', left: 0, bottom: 0, width: W, height: H_FOOT},
  br: {position: 'absolute', right: 0, bottom: 0, width: W, height: H_FOOT, transform: MIRROR},
  // width / height undefined: the picture's own size must not fight the two insets
  top: {position: 'absolute', left: W, right: W, top: 0, height: M, width: undefined},
  foot: {position: 'absolute', left: W, right: W, bottom: 0, height: M, width: undefined},
  left: {position: 'absolute', left: 0, top: H_TOP, bottom: H_FOOT, width: M, height: undefined},
  right: {position: 'absolute', right: 0, top: H_TOP, bottom: H_FOOT, width: M, height: undefined, transform: MIRROR},
});
