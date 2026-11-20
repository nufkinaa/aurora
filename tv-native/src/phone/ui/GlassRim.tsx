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
// frame. It goes FIRST inside the pane (what the pane holds is drawn over it).
// The chrome wears it (the tab bar, the round buttons, the hero's glass pill,
// the player's buttons) and, since the full glass (2026-11-20), every glass
// surface that stands alone: the search field, a sheet, a toast, the profile
// menu, the Remote's panes, a pane in the page. Never a row, a card or a chip
// that comes many to a screen (theme.ts: those draw the look as border colours).
// A pane that keeps a border (so nothing moves) has it made transparent and the
// ring drawn on it (`edge`).
import React, {memo} from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Defs, LinearGradient, RadialGradient, Rect, Stop} from 'react-native-svg';
import {RG_ARCS, RG_ARCS_S, RG_CALM, RG_FRESNEL} from '../theme';

type Props = {
  /** the pane's height. Left out (a sheet, a menu, a toast, a pane of words): drawn in percentages of
   *  the pane's box, as an unknown width is - so the pane must clip what it holds too (overflow:
   *  'hidden'): the ring is a 2 dp outline on the box's very edge, whose outer half the pane cuts away */
  h?: number;
  /** the pane's width when it is known (a round button, the tab bar). Left out: the pane must be a
   *  pill that clips what it holds (overflow: 'hidden') — the ring is then a 2 dp outline on the
   *  pane's very edge, whose outer half the pane cuts away */
  w?: number;
  /** small round things (42–56 dp): the glint that lights nothing above the middle */
  small?: boolean;
  /** one of many side by side (a title's action circles): the whole ring quieter */
  calm?: boolean;
  /** the pane's corner radius, when it is not a pill or a circle (a sheet, a menu, a toast, a pane) */
  r?: number;
  /** the pane keeps its border (its width, so nothing moves) and the ring is drawn ON it: the
   *  border's width, the drawing laid over the pane's whole box, border included (w and h are then
   *  the pane's outer size) */
  edge?: number;
  /** the pane has no foot on screen (a sheet standing on the screen's lower edge): the ring runs on
   *  past the pane's bottom, where the pane cuts it away - no lit line along the screen's edge */
  footless?: boolean;
};

function GlassRim({w, h, small, calm, r, edge, footless}: Props) {
  const arcs = small ? RG_ARCS_S : RG_ARCS;
  const known = w != null && h != null;
  const rad = r != null ? r : known ? Math.min((h as number) / 2, (w as number) / 2) : h != null ? h / 2 : 0;
  // both known: a 1 dp outline that stays inside the box (half its width in from the edge);
  // otherwise the box's own outline, 2 dp, the outer half cut away by the drawing's bounds
  const box = known
    ? {x: 0.5, y: 0.5, width: (w as number) - 1, height: (h as number) - 1, rx: Math.max(0, rad - 0.5), ry: Math.max(0, rad - 0.5), strokeWidth: 1}
    : {x: 0, y: 0, width: w != null ? w : '100%', height: h != null ? h : '100%', rx: rad, ry: rad, strokeWidth: 2};
  // where a light sits: a number when the size is known, a percentage of it when not
  const cx = (a: {fx: number; dx: number}) => (w != null ? a.fx * w + a.dx : a.fx === 0 ? a.dx : `${a.fx * 100}%`);
  const cy = (a: {fy: number}) => (h != null ? a.fy * h : `${a.fy * 100}%`);
  const e = edge || 0;
  const at = edge || footless ? {position: 'absolute' as const, left: -e, top: -e, right: -e, bottom: footless ? -(e + 24) : -e} : StyleSheet.absoluteFill;
  return (
    <View style={[at, calm && s.calm]} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <Svg width={w != null ? w : '100%'} height={h != null ? h : '100%'}>
        <Defs>
          {/* (a known height: in dp, as the chrome's always were; not known: the box's own height) */}
          <LinearGradient id="rgf" gradientUnits={h != null ? 'userSpaceOnUse' : 'objectBoundingBox'} x1={0} y1={0} x2={0} y2={h != null ? h : 1}>
            {RG_FRESNEL.map(([at, c, a]) => (
              <Stop key={at} offset={at} stopColor={`rgb(${c})`} stopOpacity={a} />
            ))}
          </LinearGradient>
          {arcs.map((a, i) => (
            <RadialGradient key={i} id={`rg${i}`} gradientUnits="userSpaceOnUse" cx={cx(a)} cy={cy(a)} fx={cx(a)} fy={cy(a)} r={a.r}>
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
