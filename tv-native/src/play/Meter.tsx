// Aurora Play — the aurora ribbon: how far along a round is (Taste), how much
// time is left (Pick together), how far a person's hand is played (a seat).
//
// The fill is the baked ribbon picture, REVEALED and not squeezed: a rounded
// window slides in from the left and the picture inside slides the other way,
// so the colours stay where they are and the leading end stays round. Two
// translates on the native driver; no width is animated, nothing is laid out.
//
// Four star pips can stand on it (the quarters of a round): a lit one is
// near-white, the last one is bigger and gold — the round is won.
import React, {useEffect, useRef} from 'react';
import {Animated, Image, StyleSheet, View} from 'react-native';
import {SPRING, tween, useValue} from './anim';
import {STAR_SRC} from './Star';
import {PLAY, T} from './tokens';

export const RIBBON_SRC = require('../assets/play-ribbon.png');

function Pip({on, last, calm, x, h}: {on: boolean; last: boolean; calm: boolean; x: number; h: number}) {
  const size = last ? 22 : 17;
  const pop = useValue(on ? 1 : 0);
  const was = useRef(on);
  useEffect(() => {
    if (on === was.current) return;
    was.current = on;
    if (!on || calm) {
      pop.setValue(on ? 1 : 0);
      return;
    }
    pop.setValue(0);
    tween(pop, 1, T.pip, {easing: SPRING}).start();
  }, [on, calm, pop]);
  const at = {position: 'absolute' as const, left: x - size / 2, top: (h - size) / 2, width: size, height: size};
  return (
    <>
      {/* the unlit star: always there, so a pip never changes the row's size */}
      <Image source={STAR_SRC} fadeDuration={0} style={[at, {tintColor: PLAY.night1}, styles.rim]} />
      <Image source={STAR_SRC} fadeDuration={0} style={[at, {tintColor: 'rgba(232,228,255,0.34)'}]} />
      <Animated.Image
        source={STAR_SRC}
        fadeDuration={0}
        style={[
          at,
          {
            tintColor: last ? PLAY.gold : '#f4fff9',
            opacity: pop.interpolate({inputRange: [0, 0.3, 1], outputRange: [0, 1, 1]}),
            transform: [{scale: pop.interpolate({inputRange: [0, 1], outputRange: [0.4, 1]})}],
          },
        ]}
      />
    </>
  );
}

export default function Meter({
  value,
  width,
  height = 8,
  lit,
  calm = false,
  ms = T.ribbon,
  steady = false,
  tint,
}: {
  value: number; // 0..1
  width: number;
  height?: number;
  lit?: number; // how many of the four pips are lit; leave out for a ribbon without pips
  calm?: boolean;
  ms?: number;
  steady?: boolean; // a clock: moves at an even pace instead of easing
  tint?: string; // a plain colour instead of the aurora (a seat that is done)
}) {
  const to = Math.max(0, Math.min(1, Number(value) || 0));
  const p = useValue(to);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (calm) {
      p.setValue(to);
      return;
    }
    const run = tween(p, to, ms, steady ? {easing: (t: number) => t} : undefined);
    run.start();
    return () => run.stop();
  }, [to, calm, ms, steady, p]);
  const pips = lit != null;
  const boxH = pips ? 24 : height;
  const top = (boxH - height) / 2;
  return (
    <View style={{width, height: boxH}}>
      <View style={[styles.track, {top, width, height, borderRadius: height / 2}]}>
        <Animated.View
          style={[
            styles.window,
            {
              width,
              height,
              borderRadius: height / 2,
              transform: [{translateX: p.interpolate({inputRange: [0, 1], outputRange: [-width, 0]})}],
            },
          ]}>
          {tint ? (
            <View style={{width, height, backgroundColor: tint}} />
          ) : (
            <Animated.Image
              source={RIBBON_SRC}
              resizeMode="stretch"
              fadeDuration={0}
              style={{
                width,
                height,
                transform: [{translateX: p.interpolate({inputRange: [0, 1], outputRange: [width, 0]})}],
              }}
            />
          )}
        </Animated.View>
      </View>
      {pips
        ? [1, 2, 3, 4].map(k => (
            <Pip key={k} on={(lit as number) >= k} last={k === 4} calm={calm} x={k === 4 ? width - 9 : (width * k) / 4} h={boxH} />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {position: 'absolute', left: 0, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.11)'},
  window: {overflow: 'hidden'},
  // the dark edge round a pip, so it reads on the bright ribbon: the same star, a little bigger
  rim: {transform: [{scale: 1.32}]},
});
