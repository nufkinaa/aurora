// The one sign for "this device" (docs/offline-look.md §3 — the website's offlineUi.js mark,
// drawn natively): a ring with an arrow landing on a line. Saved is a solid mint disc with the
// arrow in dark ink (not a tick: a tick already means "watched"); saving fills the ring in
// mint; waiting for the connection fills it in amber; paused wears a pause sign; waiting for
// the server's copy is an amber dashed ring; "didn't save" a red ring with "!".
// Decoration only: whatever carries it says the state in words.
import React, {useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, View} from 'react-native';
import Svg, {Circle, G, Path} from 'react-native-svg';
import type {MarkState} from './rules';

export const MINT = '#6ee7b7';
export const AMBER = '#f5c542';
export const RED = '#ff7a7a';
export const INK = '#0b0c14';

const GLYPH = {
  arrow: 'M10.9 5.7h2.2v5.2h2.8L12 15.7l-3.9-4.8h2.8zM7.6 17h8.8v1.7H7.6z',
  pause: 'M8.7 7.7h2.3v8.6H8.7zM13 7.7h2.3v8.6H13z',
  bang: 'M10.9 6.3h2.2v7.3h-2.2zM10.9 15.5h2.2v2.2h-2.2z',
};
const R = 9.6;
const LEN = 2 * Math.PI * R;

/** How much of the ring is drawn, 0..100 (the site's arcOf). */
export const arcOf = (st: MarkState, pct: number) =>
  st === 'saving' || st === 'retrying' || st === 'paused' ? Math.max(4, Math.round(Math.max(0, Math.min(1, pct)) * 100)) : st === 'preparing' ? 26 : 0;

const useCalm = () => {
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(v => setCalm(!!v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', v => setCalm(!!v));
    return () => sub?.remove?.();
  }, []);
  return calm;
};

export default function Mark({state, pct = 0, size = 20, color = '#e9ecf4', landed = false}: {state: MarkState; pct?: number; size?: number; color?: string; landed?: boolean}) {
  const calm = useCalm();
  const spin = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  // getting ready: a quarter of the ring turns once every 1.1 s (stands still under reduced motion)
  useEffect(() => {
    if (state !== 'preparing' || calm) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(spin, {toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true}));
    loop.start();
    return () => loop.stop();
  }, [state, calm, spin]);
  // a save lands: the mark swells once (0.6 → 1.34 → 1 in 620 ms) and one mint ring leaves it
  useEffect(() => {
    if (!landed || calm) return;
    pop.setValue(0.6);
    ring.setValue(0);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(pop, {toValue: 1.34, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}),
        Animated.timing(pop, {toValue: 1, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true}),
      ]),
      Animated.timing(ring, {toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true}),
    ]).start();
  }, [landed, calm, pop, ring]);

  const saved = state === 'saved';
  const glyph = state === 'paused' ? GLYPH.pause : state === 'failed' ? GLYPH.bang : GLYPH.arrow;
  const a = arcOf(state, pct);
  const arcColor = state === 'retrying' || state === 'paused' ? AMBER : state === 'preparing' ? color : MINT;
  const trackColor = state === 'failed' ? RED : state === 'waiting' ? AMBER : color;
  const trackOpacity = state === 'failed' || state === 'waiting' ? 1 : state === 'none' ? 0.6 : a > 0 || state === 'preparing' || state === 'queued' ? 0.28 : 0.42;
  const dash = state === 'queued' ? '2.2 3.83' : state === 'waiting' ? '4.6 2.94' : undefined;
  return (
    <View style={{width: size, height: size}} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
      {landed && !calm ? (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: MINT,
            opacity: ring.interpolate({inputRange: [0, 1], outputRange: [0.8, 0]}),
            transform: [{scale: ring.interpolate({inputRange: [0, 1], outputRange: [1, 1 + 24 / size]})}],
          }}
        />
      ) : null}
      <Animated.View style={{width: size, height: size, transform: [{scale: pop}]}}>
        <Svg width={size} height={size} viewBox="0 0 24 24">
          {saved ? <Circle cx={12} cy={12} r={11} fill={MINT} /> : null}
          {!saved ? <Circle cx={12} cy={12} r={R} fill="none" stroke={trackColor} strokeOpacity={trackOpacity} strokeWidth={1.8} strokeDasharray={dash} strokeLinecap="round" /> : null}
          {a > 0 && state !== 'preparing' ? (
            <Circle cx={12} cy={12} r={R} fill="none" stroke={arcColor} strokeWidth={2.3} strokeLinecap="round" strokeDasharray={`${(a / 100) * LEN} ${LEN}`} transform="rotate(-90 12 12)" />
          ) : null}
          <Path d={glyph} fill={saved ? INK : state === 'failed' ? RED : color} />
        </Svg>
        {state === 'preparing' ? (
          <Animated.View style={{position: 'absolute', left: 0, top: 0, width: size, height: size, transform: [{rotate: spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}]}}>
            <Svg width={size} height={size} viewBox="0 0 24 24">
              <G>
                <Circle cx={12} cy={12} r={R} fill="none" stroke={color} strokeWidth={2.3} strokeLinecap="round" strokeDasharray={`${0.26 * LEN} ${LEN}`} transform="rotate(-90 12 12)" />
              </G>
            </Svg>
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
}
