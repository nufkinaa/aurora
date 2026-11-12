// Aurora Wrapped on the TV — the small pieces the chapters are built from.
//
// The same three rules as the rest of the kit (../anim.ts): only transform and
// opacity, on the native driver; calm shows the finished state at once;
// nothing here keeps a timer. A piece that "arrives" is MOUNTED from the
// start, at its place, invisible — so nothing on the page moves when it
// appears — and one value brings it in.
import React, {useEffect, useMemo, useState} from 'react';
import {Animated, Image, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle} from 'react-native';
import {artPath, artPx, imgSrc} from '../../api';
import {EASE, LINEAR, SPRING, tween, useValue} from '../anim';
import {Tile} from '../Cards';
import {RIBBON_SRC} from '../Meter';
import {PLAY} from '../tokens';
import type {SkyLayout} from '../wrappedRules';

// 0 until `on`, then 0 -> 1 once. Calm: 1 the moment it is on.
export const useShow = (
  on: boolean,
  {ms = 320, delay = 0, easing = EASE, calm = false}: {ms?: number; delay?: number; easing?: (t: number) => number; calm?: boolean} = {},
) => {
  const v = useValue(on && calm ? 1 : 0);
  useEffect(() => {
    if (!on) {
      v.setValue(0);
      return;
    }
    if (calm) {
      v.setValue(1);
      return;
    }
    const a = tween(v, 1, ms, {delay, easing});
    a.start();
    return () => a.stop();
  }, [on, calm, ms, delay, easing, v]);
  return v;
};

// Something that arrives: comes up into place (`dy`; negative = drops from
// above), or lands from a little bigger or smaller (`scaleFrom`).
export function Show({
  on,
  calm = false,
  dy = 14,
  ms = 320,
  delay = 0,
  scaleFrom,
  spring = false,
  style,
  children,
}: {
  on: boolean;
  calm?: boolean;
  dy?: number;
  ms?: number;
  delay?: number;
  scaleFrom?: number;
  spring?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const v = useShow(on, {ms, delay, calm, easing: spring ? SPRING : EASE});
  const move = useMemo(
    () => ({
      opacity: v.interpolate({inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp'}),
      transform:
        scaleFrom != null
          ? [{scale: v.interpolate({inputRange: [0, 1], outputRange: [scaleFrom, 1]})}]
          : [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [dy, 0]})}],
    }),
    [v, dy, scaleFrom],
  );
  return <Animated.View style={[style, move]}>{children}</Animated.View>;
}

// The small line over a chapter: "YOUR NUMBER ONE".
export function Eyebrow({children, style}: {children: string; style?: StyleProp<TextStyle>}) {
  return (
    <Text style={[ty.eyebrow, style]} numberOfLines={1}>
      {children.toUpperCase()}
    </Text>
  );
}

// A count on glass: "87 nights".
export function Chip({label, gold = false}: {label: string; gold?: boolean}) {
  return (
    <View style={[styles.chip, gold && styles.chipGold]}>
      <Text style={[styles.chipText, gold && styles.chipTextGold]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// A title's picture, asked at the size it is drawn; without one — or when it
// does not arrive — the kit's tile with the title on it. Never an empty box.
export function Poster({
  poster,
  title,
  width,
  height,
  radius = 14,
  size = 18,
  style,
}: {
  poster: string | null | undefined;
  title: string;
  width: number;
  height: number;
  radius?: number;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [bad, setBad] = useState(false);
  const src = useMemo(() => (poster ? imgSrc(artPath(poster, artPx(width)) || poster) : null), [poster, width]);
  return (
    <View style={[{width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: PLAY.tile}, style]}>
      {src && !bad ? (
        <Image source={src as never} resizeMode="cover" onError={() => setBad(true)} style={{width, height}} accessibilityLabel={title} />
      ) : (
        <Tile title={title} size={size} style={{width, height}} />
      )}
    </View>
  );
}

// ---------- the progress row ----------
const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mixHex = (a: string, b: string, t: number) => {
  const x = hex(a);
  const y = hex(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
};
// the aurora along the row: green -> teal at 45% -> violet (the ribbon's own run)
export const auroraAt = (t: number) =>
  t <= 0.45 ? mixHex(PLAY.green, PLAY.teal, t / 0.45) : mixHex(PLAY.teal, PLAY.violet, (t - 0.45) / 0.55);

// One segment per chapter. Each segment's fill is bound, for good, to its own
// value (0 = empty, 1 = full): the screen sets the past ones to 1, the later
// ones to 0 and runs the current one — nothing is re-rendered while it fills.
export const ProgressRow = React.memo(function ProgressRow({
  values,
  count,
  width,
  label,
}: {
  values: Animated.Value[];
  count: number;
  width: number;
  label?: string;
}) {
  const gap = 5;
  const segW = Math.max(4, (width - gap * (count - 1)) / count);
  return (
    <View style={[styles.progress, {width, gap}]} accessible accessibilityLabel={label}>
      {Array.from({length: count}, (_, i) => (
        <View key={i} testID="wrapped.segment" style={[styles.segment, {width: segW}]}>
          <Animated.View
            style={[
              styles.segmentFill,
              {
                width: segW,
                backgroundColor: auroraAt(count > 1 ? i / (count - 1) : 0),
                transform: [{translateX: values[i].interpolate({inputRange: [0, 1], outputRange: [-segW, 0]})}],
              },
            ]}
          />
        </View>
      ))}
    </View>
  );
});

// ---------- the sky of the year ----------
// Every night watched is a star (wrappedRules skyLayout). The stars are small
// round views, standing in upright strips; ONE value sweeps the sky from the
// first week to the last, each strip appearing in its own window of it — a
// year of stars costs one animation. `dim`: the sky as a backdrop (the streak
// chapter draws its constellation over it).
const STRIPS = 18;
const MAX_STARS = 420;
const PAD = 6; // a strip is wider than its share, so a star on its edge is whole

export const NightSky = React.memo(function NightSky({
  sky,
  width,
  height,
  calm = false,
  dim = false,
  ms = 1500,
  delay = 150,
  from,
  to,
}: {
  sky: SkyLayout;
  width: number;
  height: number;
  calm?: boolean;
  dim?: boolean;
  ms?: number;
  delay?: number;
  from?: string;
  to?: string;
}) {
  const t = useShow(true, {ms, delay, calm, easing: LINEAR});
  const strips = useMemo(() => {
    const all = sky.stars;
    const pick = all.length > MAX_STARS ? Math.ceil(all.length / MAX_STARS) : 1;
    const top = Math.max(1, ...all.map(s => s.m || 0));
    const out: {x: number; y: number; size: number; a: number}[][] = Array.from({length: STRIPS}, () => []);
    all.forEach((s, i) => {
      // a long year is thinned evenly; a night of the streak is never left out
      if (pick > 1 && i % pick && !s.streak) return;
      const k = Math.max(0, Math.min(STRIPS - 1, Math.floor(s.x * STRIPS)));
      const m = Math.sqrt(Math.max(0, s.m || 0) / top); // 0..1, the long nights not too far ahead
      out[k].push({
        x: s.x * width - (k * width) / STRIPS + PAD,
        y: s.y * height,
        size: Math.round((2.6 + m * 3.2) * 2) / 2,
        a: 0.5 + m * 0.5,
      });
    });
    return out;
  }, [sky, width, height]);
  const stripW = width / STRIPS;
  // each strip's window of the sweep: they overlap, so the sky arrives as a wave
  const span = 0.3;
  return (
    <View style={{width}} pointerEvents="none">
      <View style={[{width, height}, dim && styles.skyDim]}>
        {strips.map((stars, k) => {
          if (!stars.length) return null;
          const a = (k / (STRIPS - 1)) * (1 - span);
          return (
            <Animated.View
              key={k}
              style={{
                position: 'absolute',
                left: k * stripW - PAD,
                top: 0,
                width: stripW + PAD * 2,
                height,
                opacity: calm ? 1 : t.interpolate({inputRange: [a, a + span], outputRange: [0, 1], extrapolate: 'clamp'}),
              }}>
              {stars.map((s, i) => (
                <View
                  key={i}
                  style={{
                    position: 'absolute',
                    left: s.x - s.size / 2,
                    top: s.y - s.size / 2,
                    width: s.size,
                    height: s.size,
                    borderRadius: s.size / 2,
                    backgroundColor: '#f4fff9',
                    opacity: s.a,
                  }}
                />
              ))}
            </Animated.View>
          );
        })}
      </View>
      {from || to ? (
        <View style={styles.skyFoot}>
          <Text style={ty.small} numberOfLines={1}>
            {from || ''}
          </Text>
          <View style={styles.skyRule} />
          <Text style={ty.small} numberOfLines={1}>
            {to || ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

// ---------- a bar that grows ----------
// The track is a window; the fill slides in from its left (the kit's Meter
// does the same): no width is animated. The bar is a curve of the chapter's
// one value `v`: at `at[k]` it is `to[k]` full (0..1) — one interpolation a
// layer, straight from the value. The winner's fill is the aurora ribbon,
// held still under the sliding window so its colours stay in place.
export function Bar({
  v,
  at,
  to,
  width,
  height = 22,
  aurora = false,
}: {
  v: Animated.Value;
  at: number[];
  to: number[];
  width: number;
  height?: number;
  aurora?: boolean;
}) {
  const slide = useMemo(() => v.interpolate({inputRange: at, outputRange: to.map(f => -width * (1 - f))}), [v, at, to, width]);
  const back = useMemo(() => v.interpolate({inputRange: at, outputRange: to.map(f => width * (1 - f))}), [v, at, to, width]);
  return (
    <View style={[styles.track, {width, height, borderRadius: height / 2}]}>
      <Animated.View style={{width, height, borderRadius: height / 2, overflow: 'hidden', transform: [{translateX: slide}]}}>
        {aurora ? (
          <Animated.Image source={RIBBON_SRC} resizeMode="stretch" fadeDuration={0} style={{width, height, transform: [{translateX: back}]}} />
        ) : (
          <View style={{width, height, backgroundColor: 'rgba(232,228,255,0.36)'}} />
        )}
      </Animated.View>
    </View>
  );
}

// ---------- columns that grow ----------
// The hours of the day, the days of the week. Each column stands in a window
// as tall as the chart and rises into it from below; ONE value raises them
// all, one after the other (`step` ms apart, `each` ms a column). The peak is
// lit — a second, green column over it — when `lit` says so.
export function Columns({
  values,
  peak,
  on,
  lit,
  calm = false,
  colW,
  gap,
  height,
  each = 500,
  step = 20,
}: {
  values: number[]; // 0..1
  peak: number | null;
  on: boolean;
  lit: boolean;
  calm?: boolean;
  colW: number;
  gap: number;
  height: number;
  each?: number;
  step?: number;
}) {
  const n = values.length;
  const total = each + Math.max(0, n - 1) * step;
  const t = useShow(on, {ms: total, calm, easing: LINEAR});
  const glow = useShow(lit, {ms: 360, calm});
  const cols = useMemo(
    () =>
      values.map((v, i) => {
        const h = Math.max(3, Math.round(v * height));
        const a = (i * step) / total;
        const b = (i * step + each) / total;
        return {
          h,
          // quick at first, settling at the top
          y: t.interpolate({inputRange: [a, a + (b - a) * 0.5, b], outputRange: [h, h * 0.18, 0], extrapolate: 'clamp'}),
        };
      }),
    [values, height, step, each, total, t],
  );
  return (
    <View style={{flexDirection: 'row', alignItems: 'flex-end', gap, height}}>
      {cols.map((c, i) => (
        <View key={i} style={{width: colW, height, overflow: 'hidden', justifyContent: 'flex-end'}}>
          <Animated.View style={[styles.col, {width: colW, height: c.h, borderRadius: Math.min(5, colW / 2), transform: [{translateY: c.y}]}]}>
            {i === peak ? <Animated.View style={[styles.colLit, {borderRadius: Math.min(5, colW / 2), opacity: glow}]} /> : null}
          </Animated.View>
        </View>
      ))}
    </View>
  );
}

// The type sizes of the story, for a room: read from three metres.
export const ty = StyleSheet.create({
  eyebrow: {color: PLAY.green, fontSize: 14, lineHeight: 20, fontWeight: '800', letterSpacing: 2.6, includeFontPadding: false},
  title: {color: PLAY.ink, fontSize: 36, lineHeight: 43, fontWeight: '900', includeFontPadding: false},
  sub: {color: PLAY.ink, fontSize: 26, lineHeight: 33, fontWeight: '800', includeFontPadding: false},
  line: {color: PLAY.inkDim, fontSize: 20, lineHeight: 28, fontWeight: '500'},
  small: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 20, fontWeight: '700'},
  center: {textAlign: 'center'},
});

const styles = StyleSheet.create({
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: PLAY.glassHi,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  chipGold: {backgroundColor: 'rgba(255,209,102,0.1)', borderColor: 'rgba(255,209,102,0.45)'},
  chipText: {color: PLAY.ink, fontSize: 17, lineHeight: 24, fontWeight: '800', fontVariant: ['tabular-nums'], includeFontPadding: false},
  chipTextGold: {color: PLAY.goldHi},
  progress: {flexDirection: 'row', height: 4},
  segment: {height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.17)'},
  segmentFill: {height: 4, borderRadius: 2},
  skyDim: {opacity: 0.38},
  skyFoot: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6},
  skyRule: {flex: 1, height: 1, backgroundColor: PLAY.line},
  track: {overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.09)'},
  col: {backgroundColor: 'rgba(160,131,255,0.55)', overflow: 'hidden'},
  colLit: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: PLAY.green},
});
