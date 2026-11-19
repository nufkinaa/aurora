// The rim of a real-glass pane (theme.ts "Real glass"): a 1 dp ring that is dim
// on top, brighter down its sides and lit along its foot, and the glint — one
// small light on the left shoulder with a fainter answer on the right foot,
// tinted in Aurora's violet-magenta and mint (the website's masked ring,
// glass.css --rg-fresnel + --rg-arc / --rg-arc-s). No light along the top.
//
// A still drawing: one small <Svg> laid over the pane's own box, a rounded
// outline stroked once per light. Nothing is animated, nothing is read from
// behind the pane, and NOTHING IS MEASURED: the height is always given, and a
// pane whose width is not known (the hero's glass pill, the player's Next
// pill) is drawn in percentages — so the rim is there in the pane's first
// frame. It goes FIRST inside the pane (what the pane holds is drawn over it)
// and only on the chrome — the tab bar, the round buttons, the hero's glass
// pill, the player's buttons — never on a card, a row or a sheet's button.
import React, {memo} from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Defs, LinearGradient, RadialGradient, Rect, Stop} from 'react-native-svg';
import {RG_ARCS, RG_ARCS_S, RG_CALM, RG_FRESNEL} from '../theme';

type Props = {
  /** the pane's height (always known) */
  h: number;
  /** the pane's width when it is known (a round button, the tab bar). Left out: the pane must be a
   *  pill that clips what it holds (overflow: 'hidden') — the ring is then a 2 dp outline on the
   *  pane's very edge, whose outer half the pane cuts away */
  w?: number;
  /** small round things (42–56 dp): the glint that lights nothing above the middle */
  small?: boolean;
  /** one of many side by side (a title's action circles): the whole ring quieter */
  calm?: boolean;
};

function GlassRim({w, h, small, calm}: Props) {
  const arcs = small ? RG_ARCS_S : RG_ARCS;
  const known = w != null;
  const rad = known ? Math.min(h / 2, (w as number) / 2) : h / 2;
  // known width: a 1 dp outline that stays inside the box (half its width in from the edge);
  // unknown: the box's own outline, 2 dp, the outer half clipped by the pane
  const box = known
    ? {x: 0.5, y: 0.5, width: (w as number) - 1, height: h - 1, rx: Math.max(0, rad - 0.5), ry: Math.max(0, rad - 0.5), strokeWidth: 1}
    : {x: 0, y: 0, width: '100%', height: h, rx: rad, ry: rad, strokeWidth: 2};
  // where a light sits: a number when the width is known, a percentage of it when not
  const cx = (a: {fx: number; dx: number}) => (known ? a.fx * (w as number) + a.dx : a.fx === 0 ? a.dx : `${a.fx * 100}%`);
  return (
    <View style={[StyleSheet.absoluteFill, calm && s.calm]} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <Svg width={known ? w : '100%'} height={h}>
        <Defs>
          <LinearGradient id="rgf" gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={h}>
            {RG_FRESNEL.map(([at, c, a]) => (
              <Stop key={at} offset={at} stopColor={`rgb(${c})`} stopOpacity={a} />
            ))}
          </LinearGradient>
          {arcs.map((a, i) => (
            <RadialGradient key={i} id={`rg${i}`} gradientUnits="userSpaceOnUse" cx={cx(a)} cy={a.fy * h} fx={cx(a)} fy={a.fy * h} r={a.r}>
              <Stop offset={0} stopColor={`rgb(${a.c})`} stopOpacity={a.a} />
              <Stop offset={1} stopColor={`rgb(${a.c})`} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        <Rect {...box} fill="none" stroke="url(#rgf)" />
        {/* (last-to-first: the first light ends on top, as the website's first layer) */}
        {arcs
          .map((_, i) => i)
          .reverse()
          .map(i => (
            <Rect key={i} {...box} fill="none" stroke={`url(#rg${i})`} />
          ))}
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  calm: {opacity: RG_CALM},
});

export default memo(GlassRim);
