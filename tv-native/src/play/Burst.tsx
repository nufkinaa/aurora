// Aurora Play — the reward: a meteor burst.
//
// The website paints 42 meteors on a canvas, frame by frame. Here a burst is
// 16 small pictures (the baked meteor, tinted, turned to its heading), each
// moved and faded by interpolations of ONE value that runs once, 0 -> 1, on
// the native driver: no JS per frame, no canvas, and the views are gone when
// it ends.
//
// One reward per flow is the caller's rule; this component only promises that
// a burst is fired once per change of `fire`, never under calm, and that
// nothing is left mounted or running afterwards.
import React, {useEffect, useMemo, useState} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {tween, useValue} from './anim';
import {flight, meteors} from './meteors';
import {BURST_COLORS, T} from './tokens';

export const METEOR_SRC = require('../assets/play-meteor.png');
const GLOW_SRC = require('../assets/play-glow.png');

// the baked meteor: 128 x 16, its head 8 px from the right end
const M_W = 128;
const M_H = 16;
const M_HEAD = 8;

export default function Burst({
  fire,
  x,
  y,
  reach = 520,
  count = 16,
  calm = false,
  seed = 7,
}: {
  fire: number; // a burst is given each time this number goes up (0 = none yet)
  x: number; // the centre, in the parent's own box
  y: number;
  reach?: number; // the "diagonal" a meteor's speed is counted in (dp)
  count?: number; // 16 for the reward, fewer for a smaller one
  calm?: boolean;
  seed?: number;
}) {
  const t = useValue(0);
  const [live, setLive] = useState(0);
  useEffect(() => {
    if (!fire || calm) return;
    setLive(fire);
    t.setValue(0);
    const run = tween(t, 1, T.burst, {easing: (k: number) => k});
    run.start(({finished}) => {
      if (finished) setLive(0);
    });
    return () => run.stop();
  }, [fire, calm, t]);
  const parts = useMemo(() => {
    if (!live) return [];
    return meteors(count, seed + live).map(m => {
      const f = flight(m, reach, T.burst / 1000);
      const scale = 0.5 + (m.size / 3.4) * 0.6; // 0.7 .. 1.1
      const len = Math.max(0.35, Math.min(1.2, (m.tail * reach) / M_W));
      return {m, f, scale, len};
    });
  }, [live, count, seed, reach]);
  if (!live) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* the flash at the centre: a soft light that swells and goes */}
      <Animated.Image
        source={GLOW_SRC}
        fadeDuration={0}
        style={{
          position: 'absolute',
          left: x - 110,
          top: y - 110,
          width: 220,
          height: 220,
          tintColor: BURST_COLORS[0],
          opacity: t.interpolate({inputRange: [0, 0.06, 0.4, 1], outputRange: [0, 0.7, 0, 0]}),
          transform: [{scale: t.interpolate({inputRange: [0, 0.4, 1], outputRange: [0.5, 1.5, 1.5]})}],
        }}
      />
      {parts.map(({m, f, scale, len}, i) => (
        // One view per meteor. It is turned and sized about its HEAD (the
        // transform's origin), and the head is what travels from the centre.
        <Animated.Image
          key={i}
          source={METEOR_SRC}
          fadeDuration={0}
          style={{
            position: 'absolute',
            left: x - (M_W - M_HEAD),
            top: y - M_H / 2,
            width: M_W,
            height: M_H,
            tintColor: BURST_COLORS[m.color % BURST_COLORS.length],
            opacity: t.interpolate({inputRange: f.input, outputRange: f.alpha}),
            transformOrigin: `${M_W - M_HEAD}px ${M_H / 2}px`,
            transform: [
              {translateX: t.interpolate({inputRange: f.input, outputRange: f.dx})},
              {translateY: t.interpolate({inputRange: f.input, outputRange: f.dy})},
              {rotate: `${Math.round((m.angle * 180) / Math.PI)}deg`},
              {scaleX: +(len * scale).toFixed(2)},
              {scaleY: +scale.toFixed(2)},
            ],
          }}
        />
      ))}
    </View>
  );
}
