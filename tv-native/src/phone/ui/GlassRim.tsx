// The rim of a real-glass pane (theme.ts "Real glass"): the one even hairline
// all round, and the light the rim catches — a short arc on the left shoulder
// and its answer on the right foot, each white in the middle and breaking into
// a warm end and a cool end (the website's masked ring, glass.css --rg-arc).
//
// A still drawing: one small <Svg> laid over the pane's own box, a rounded
// outline stroked once per light. Nothing is animated and nothing is read from
// behind the pane. It goes FIRST inside the pane (what the pane holds is drawn
// over it) and only on the chrome — the tab bar, the round buttons, the glass
// pill, the player's buttons — never on a card or a row.
import React, {memo, useState} from 'react';
import {LayoutChangeEvent, StyleSheet, View} from 'react-native';
import Svg, {Defs, RadialGradient, Rect, Stop} from 'react-native-svg';
import {RG, RG_ARC_FULL_H, RG_ARC_THIN, RG_ARCS} from '../theme';

type Props = {
  /** the pane's size when it is known (a round button, the tab bar): drawn at once; otherwise measured */
  w?: number;
  h?: number;
  /** the pane's corner radius; a pill / a circle when left out */
  r?: number;
  /** small round things: the fainter hairline */
  thin?: boolean;
};

// (the arcs are drawn last-to-first: the first of RG_ARCS ends on top, as the website's first layer)
const ORDER = RG_ARCS.map((_, i) => i).reverse();

function Ring({w, h, r, thin}: {w: number; h: number; r?: number; thin?: boolean}) {
  const rad = Math.min(r == null ? h / 2 : r, w / 2, h / 2);
  // a small pane: the lights reach less far (and are fainter on the thin ones), so its top stays unlit
  const reach = Math.min(1, h / RG_ARC_FULL_H);
  const dim = thin ? RG_ARC_THIN : 1;
  // an outline that stays inside the box: half its width in from the edge
  const box = (sw: number) => ({x: sw / 2, y: sw / 2, width: w - sw, height: h - sw, rx: Math.max(0, rad - sw / 2), ry: Math.max(0, rad - sw / 2), fill: 'none', strokeWidth: sw});
  return (
    <Svg width={w} height={h}>
      <Defs>
        {RG_ARCS.map((a, i) => (
          <RadialGradient key={i} id={`rg${i}`} gradientUnits="userSpaceOnUse" cx={a.fx * w + a.dx} cy={a.fy * h + a.dy} fx={a.fx * w + a.dx} fy={a.fy * h + a.dy} r={a.r * reach}>
            <Stop offset={0} stopColor={`rgb(${a.c})`} stopOpacity={a.a * dim} />
            <Stop offset={1} stopColor={`rgb(${a.c})`} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      <Rect {...box(1)} stroke={thin ? RG.lineThin : RG.line} />
      {ORDER.map(i => (
        <Rect key={i} {...box(RG.ring)} stroke={`url(#rg${i})`} />
      ))}
    </Svg>
  );
}

function GlassRim({w, h, r, thin}: Props) {
  const [size, setSize] = useState<{w: number; h: number} | null>(null);
  const known = w != null && h != null;
  const onLayout = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setSize(was => (was && was.w === width && was.h === height ? was : {w: width, h: height}));
  };
  const W = known ? (w as number) : size?.w || 0;
  const H = known ? (h as number) : size?.h || 0;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" importantForAccessibility="no-hide-descendants" onLayout={known ? undefined : onLayout}>
      {W > 0 && H > 0 ? <Ring w={W} h={H} r={r} thin={thin} /> : null}
    </View>
  );
}

export default memo(GlassRim);
