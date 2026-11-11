// Aurora Play — a constellation: stars lit one after the other, a line drawn
// to each as it lights. The stars are the baked star, tinted; a line is a
// thin turned View (constellation.ts `lineBox`). ONE value lights them all,
// each star in its own window of it — a sky of twelve stars costs one
// animation, on the native driver.
//
// Calm: the whole sky is there at once.
import React, {useEffect, useMemo} from 'react';
import {Animated, StyleProp, View, ViewStyle} from 'react-native';
import {LINEAR, tween, useValue} from './anim';
import {lineBox, SkyPoint} from './constellation';
import {STAR_SRC} from './Star';
import {PLAY, T} from './tokens';

const POP = 420; // one star's own arrival (ms)

export default function SkyLines({
  points,
  lines,
  width,
  height,
  scale = 1,
  step = T.starStep,
  delay = 0,
  run = 1,
  calm = false,
  color = '#f4fff9',
  goldAt = -1,
  starSize = 4.2,
  style,
}: {
  points: SkyPoint[];
  lines: [number, number][];
  width: number; // the box the points were laid out in
  height: number;
  scale?: number; // drawn bigger or smaller than laid out
  step?: number; // ms between one star and the next
  delay?: number;
  run?: number; // lights again whenever this changes
  calm?: boolean;
  color?: string;
  goldAt?: number; // one star in gold (the brightest of a year)
  starSize?: number; // a star's size is its `r` times this
  style?: StyleProp<ViewStyle>;
}) {
  const t = useValue(calm ? 1 : 0);
  const n = points.length;
  const total = Math.max(1, (n - 1) * step + POP);
  useEffect(() => {
    if (calm || !n) {
      t.setValue(1);
      return;
    }
    t.setValue(0);
    const a = tween(t, 1, total, {delay, easing: LINEAR});
    a.start();
    return () => a.stop();
  }, [run, calm, n, total, delay, t]);
  // each star's window of the one value
  const win = useMemo(
    () =>
      points.map((_, i) => {
        const a = (i * step) / total;
        const b = Math.min(1, (i * step + POP) / total);
        const mid = a + (b - a) * 0.55;
        return {a, mid, b: Math.max(b, mid + 0.0001)};
      }),
    [points, step, total],
  );
  if (!n) return null;
  return (
    <View style={[{width: width * scale, height: height * scale}, style]} pointerEvents="none">
      {lines.map(([ia, ib], k) => {
        const pa = points[ia];
        const pb = points[ib];
        if (!pa || !pb) return null;
        const box = lineBox(pa, pb);
        const len = box.len * scale;
        // a line appears as its later star lights
        const w = win[Math.max(ia, ib)];
        return (
          <Animated.View
            key={`l${k}`}
            style={{
              position: 'absolute',
              left: box.cx * scale - len / 2,
              top: box.cy * scale - 0.75,
              width: len,
              height: 1.5,
              borderRadius: 1,
              backgroundColor: 'rgba(214,206,255,0.42)',
              opacity: calm ? 1 : t.interpolate({inputRange: [w.a, w.b], outputRange: [0, 1], extrapolate: 'clamp'}),
              transform: [{rotate: `${box.deg.toFixed(1)}deg`}],
            }}
          />
        );
      })}
      {points.map((p, i) => {
        const size = Math.round(p.r * starSize * (i === goldAt ? 1.5 : 1) * Math.max(0.8, Math.min(1.6, scale)));
        const w = win[i];
        return (
          <Animated.Image
            key={`s${i}`}
            source={STAR_SRC}
            fadeDuration={0}
            style={{
              position: 'absolute',
              left: p.x * scale - size / 2,
              top: p.y * scale - size / 2,
              width: size,
              height: size,
              tintColor: i === goldAt ? PLAY.gold : color,
              opacity: calm ? 1 : t.interpolate({inputRange: [w.a, w.mid], outputRange: [0, 1], extrapolate: 'clamp'}),
              transform: calm
                ? []
                : [{scale: t.interpolate({inputRange: [w.a, w.mid, w.b], outputRange: [0.2, 1.35, 1], extrapolate: 'clamp'})}],
            }}
          />
        );
      })}
    </View>
  );
}
