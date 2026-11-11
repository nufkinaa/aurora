// Aurora Play — a number that arrives: each digit is a wheel that rolls up to
// its value, the leading one lands first, the units last (count.ts has the
// plan). A wheel is a clipped column of digits moved by one translate on the
// native driver. Anything that is not a digit stands still.
//
// Calm: the number is simply there.
import React, {useEffect, useMemo, useRef} from 'react';
import {Animated, StyleSheet, Text, TextStyle, View} from 'react-native';
import {EASE, tween} from './anim';
import {wheelMs, wheelPlan} from './count';
import {PLAY} from './tokens';

export default function Odometer({
  text,
  size = 64,
  color = PLAY.gold,
  weight = '900',
  ms = 900,
  delay = 0,
  calm = false,
  run = 1,
  accessibilityLabel,
}: {
  text: string | number;
  size?: number;
  color?: string;
  weight?: TextStyle['fontWeight'];
  ms?: number;
  delay?: number;
  calm?: boolean;
  run?: number; // rolls again whenever this changes
  accessibilityLabel?: string;
}) {
  const str = String(text);
  // one lap less than the website: a column is real Text nodes here, and the
  // units wheel of a three-digit number is long enough at one lap
  const plan = useMemo(() => wheelPlan(str, 1), [str]);
  const digits = plan.filter(w => 'digit' in w).length;
  const values = useRef<Animated.Value[]>([]);
  while (values.current.length < digits) values.current.push(new Animated.Value(0));
  const h = Math.round(size * 1.12);
  const w = Math.round(size * 0.6);
  const face: TextStyle = {fontSize: size, lineHeight: h, height: h, color, fontWeight: weight, includeFontPadding: false, textAlign: 'center'};
  useEffect(() => {
    if (calm) return;
    const runs = values.current.slice(0, digits).map((v, k) => {
      v.setValue(0);
      return tween(v, 1, wheelMs(ms, k, digits), {delay, easing: EASE});
    });
    const all = Animated.parallel(runs, {stopTogether: false});
    all.start();
    return () => all.stop();
  }, [str, run, calm, ms, delay, digits]);
  if (calm) {
    return (
      <Text style={[face, styles.plain]} accessibilityLabel={accessibilityLabel}>
        {str}
      </Text>
    );
  }
  let k = 0;
  return (
    <View style={styles.row} accessible accessibilityLabel={accessibilityLabel || str}>
      {plan.map((wheel, i) => {
        if (!('digit' in wheel)) {
          return (
            <Text key={i} style={[face, styles.plain]}>
              {wheel.char}
            </Text>
          );
        }
        const v = values.current[k++];
        return (
          <View key={i} style={{width: w, height: h, overflow: 'hidden'}}>
            <Animated.View style={{transform: [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [0, -wheel.steps * h]})}]}}>
              {Array.from({length: wheel.steps + 1}, (_, n) => (
                <Text key={n} style={[face, {width: w}]}>
                  {n % 10}
                </Text>
              ))}
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'flex-end'},
  plain: {height: undefined, textAlign: 'left'},
});
