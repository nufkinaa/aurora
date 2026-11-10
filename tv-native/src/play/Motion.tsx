// Aurora Play — the small moves: something arrives (Pop), words come up
// (Rise), a card turns over (Flip), a line pops over the card and leaves
// (Pill). Each is one value on the native driver; under calm each is simply
// in its finished state.
import React, {useEffect, useState} from 'react';
import {Animated, StyleProp, StyleSheet, Text, View, ViewStyle} from 'react-native';
import {EASE, EASE_IN, SPRING, tween, useTimers, useValue} from './anim';
import {Star} from './Star';
import {PLAY, T} from './tokens';

// 0 -> 1 once when mounted, and again whenever `run` changes.
export const useEnter = (
  run: unknown,
  {ms = 300, delay = 0, easing = EASE, calm = false}: {ms?: number; delay?: number; easing?: (t: number) => number; calm?: boolean} = {},
) => {
  const v = useValue(calm ? 1 : 0);
  useEffect(() => {
    if (calm) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const a = tween(v, 1, ms, {delay, easing});
    a.start();
    return () => a.stop();
  }, [run, calm, ms, delay, easing, v]);
  return v;
};

// Arrives with a small overshoot: a seat, a star, a prize.
export function Pop({
  children,
  run,
  delay = 0,
  ms = 420,
  from = 0.6,
  calm = false,
  style,
}: {
  children?: React.ReactNode;
  run?: unknown;
  delay?: number;
  ms?: number;
  from?: number;
  calm?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const v = useEnter(run, {ms, delay, easing: SPRING, calm});
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({inputRange: [0, 0.35, 1], outputRange: [0, 1, 1], extrapolate: 'clamp'}),
          transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [from, 1]})}],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

// Comes up into place: the lines of a prize, one after the other (`i`).
export function Rise({
  children,
  run,
  i = 0,
  delay = 0,
  ms = T.words,
  dy = 12,
  calm = false,
  style,
}: {
  children?: React.ReactNode;
  run?: unknown;
  i?: number;
  delay?: number;
  ms?: number;
  dy?: number;
  calm?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const v = useEnter(run, {ms, delay: delay + i * T.wordsStep, calm});
  return (
    <Animated.View
      style={[style, {opacity: v, transform: [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [dy, 0]})}]}]}>
      {children}
    </Animated.View>
  );
}

// A card that turns over. Two faces in the same box; the first turns away to
// its edge, the second turns in from its edge — never both visible, so it
// needs no back-face trick.
export function Flip({
  flipped,
  front,
  back,
  width,
  height,
  ms = 600,
  delay = 0,
  calm = false,
  style,
}: {
  flipped: boolean;
  front: React.ReactNode;
  back: React.ReactNode;
  width: number;
  height: number;
  ms?: number;
  delay?: number;
  calm?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const v = useValue(flipped ? 1 : 0);
  useEffect(() => {
    const to = flipped ? 1 : 0;
    if (calm) {
      v.setValue(to);
      return;
    }
    const a = tween(v, to, ms, {delay, easing: EASE});
    a.start();
    return () => a.stop();
  }, [flipped, calm, ms, delay, v]);
  const face = {position: 'absolute' as const, left: 0, top: 0, width, height};
  return (
    <View style={[{width, height}, style]}>
      <Animated.View
        style={[
          face,
          {
            opacity: v.interpolate({inputRange: [0, 0.499, 0.5, 1], outputRange: [1, 1, 0, 0]}),
            transform: [{perspective: 900}, {rotateY: v.interpolate({inputRange: [0, 0.5, 1], outputRange: ['0deg', '90deg', '90deg']})}],
          },
        ]}>
        {front}
      </Animated.View>
      <Animated.View
        style={[
          face,
          {
            opacity: v.interpolate({inputRange: [0, 0.499, 0.5, 1], outputRange: [0, 0, 1, 1]}),
            transform: [{perspective: 900}, {rotateY: v.interpolate({inputRange: [0, 0.5, 1], outputRange: ['-90deg', '-90deg', '0deg']})}],
          },
        ]}>
        {back}
      </Animated.View>
    </View>
  );
}

// A remark that pops in, holds and leaves ("A pattern is showing: Comedy").
// `say.n` tells one remark from the next; the same remark is never replayed.
// Calm: it is there, still, for the same time.
export function Pill({say, calm = false, style}: {say: {text: string; n: number} | null; calm?: boolean; style?: StyleProp<ViewStyle>}) {
  const [shown, setShown] = useState<{text: string; n: number} | null>(null);
  const inV = useValue(0);
  const outV = useValue(0);
  const timers = useTimers();
  const n = say ? say.n : 0;
  const text = say ? say.text : '';
  useEffect(() => {
    if (!n || !text) {
      setShown(null);
      return;
    }
    setShown({text, n});
    const off = timers.after(T.pillIn + T.pillHold + T.pillOut, () => setShown(null));
    outV.setValue(0);
    if (calm) {
      inV.setValue(1);
      return off;
    }
    inV.setValue(0);
    const a = tween(inV, 1, T.pillIn, {easing: SPRING});
    const b = tween(outV, 1, T.pillOut, {delay: T.pillIn + T.pillHold, easing: EASE_IN});
    a.start();
    b.start();
    return () => {
      off();
      a.stop();
      b.stop();
    };
    // (the remark's number is its identity; the words come with it)
  }, [n, text, calm, inV, outV, timers]);
  if (!shown) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        style,
        {
          opacity: outV.interpolate({inputRange: [0, 1], outputRange: [1, 0]}),
          transform: [{translateY: outV.interpolate({inputRange: [0, 1], outputRange: [0, -8]})}],
        },
      ]}>
      <Animated.View
        style={[
          styles.pill,
          {
            opacity: inV.interpolate({inputRange: [0, 0.4, 1], outputRange: [0, 1, 1], extrapolate: 'clamp'}),
            transform: [{scale: inV.interpolate({inputRange: [0, 1], outputRange: [0.7, 1]})}],
          },
        ]}>
        <Star size={14} color={PLAY.gold} />
        <Text style={styles.pillText} numberOfLines={1}>
          {shown.text}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: PLAY.pill,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  pillText: {color: PLAY.ink, fontSize: 15, lineHeight: 21, fontWeight: '800', includeFontPadding: false},
});
