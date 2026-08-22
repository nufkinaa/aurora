// `.skeleton` (base.css:116-124) — the shimmer that holds a grid's shape while
// it loads, and `.grid-skel` (screens.css:526-529), which is one poster cell.
//
// The CSS sweeps a 200%-wide background from 0 to -200% over 1.4s. Here the
// gradient is a real child that translates, because RN has no background-position
// to animate; same width, same distance, same duration.
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import theme from '../theme';
import {CARD_W, CARD_H} from './Card';

const {radius} = theme;

// 100deg is 10 degrees off a straight left-to-right sweep.
const TILT = 0.176;

export default function Skeleton({
  width = CARD_W,
  height = CARD_H,
  round = radius.m,
}: {
  width?: number;
  height?: number;
  round?: number;
}) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(x, {
        toValue: 1,
        duration: 1400,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View style={[styles.box, {width, height, borderRadius: round}]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            width: width * 2,
            transform: [
              {
                translateX: x.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -width * 2],
                }),
              },
            ],
          },
        ]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="skel" x1="0" y1="0" x2="1" y2={TILT}>
              <Stop offset="0.2" stopColor="#ffffff" stopOpacity="0.05" />
              <Stop offset="0.25" stopColor="#ffffff" stopOpacity="0.1" />
              <Stop offset="0.3" stopColor="#ffffff" stopOpacity="0.05" />
              <Stop offset="0.7" stopColor="#ffffff" stopOpacity="0.05" />
              <Stop offset="0.75" stopColor="#ffffff" stopOpacity="0.1" />
              <Stop offset="0.8" stopColor="#ffffff" stopOpacity="0.05" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#skel)" />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.05)'},
});
