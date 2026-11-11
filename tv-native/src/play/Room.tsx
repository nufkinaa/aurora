// Aurora Play — the room: the deeper sky a play screen stands in.
//
// One opaque baked picture (tools/gen_play_kit.py: the night, the aurora's two
// curtains, a still field of stars) drawn over the app's own background, and
// five stars that twinkle. A twinkle is one star brightening and fading
// (0.9 s) every few seconds: between two of them the screen draws nothing at
// all. Calm, or not the screen in front: no twinkles.
import React, {useEffect, useRef} from 'react';
import {Animated, Image, StyleSheet, View} from 'react-native';
import {tween, useTimers} from './anim';

export const ROOM_SRC = require('../assets/play-room.png');
export const GLOW_SRC = require('../assets/play-glow.png');

// where the five are, as parts of the screen (clear of the middle, where the cards are)
const SPOTS: [number, number, number][] = [
  [0.07, 0.2, 9],
  [0.9, 0.12, 11],
  [0.31, 0.07, 8],
  [0.95, 0.62, 9],
  [0.04, 0.72, 10],
];

export default function Room({on = true, calm = false}: {on?: boolean; calm?: boolean}) {
  const lights = useRef(SPOTS.map(() => new Animated.Value(0))).current;
  const timers = useTimers();
  useEffect(() => {
    if (!on || calm) return;
    let k = 0;
    let stop = () => {};
    let running: Animated.CompositeAnimation | null = null;
    const next = () => {
      const v = lights[k % lights.length];
      k += 2; // (not the neighbour: the eye should not follow a pattern)
      v.setValue(0);
      running = Animated.sequence([tween(v, 1, 380), tween(v, 0, 520)]);
      running.start();
      stop = timers.after(2600 + ((k * 700) % 1900), next);
    };
    stop = timers.after(1200, next);
    return () => {
      stop();
      running?.stop();
      for (const v of lights) v.setValue(0);
    };
  }, [on, calm, lights, timers]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image source={ROOM_SRC} style={styles.fill} resizeMode="stretch" fadeDuration={0} />
      {calm
        ? null
        : SPOTS.map(([x, y, size], i) => (
            <Animated.Image
              key={i}
              source={GLOW_SRC}
              fadeDuration={0}
              style={{
                position: 'absolute',
                left: `${x * 100}%`,
                top: `${y * 100}%`,
                width: size,
                height: size,
                opacity: lights[i],
              }}
            />
          ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {position: 'absolute', left: 0, top: 0, width: '100%', height: '100%'},
});
