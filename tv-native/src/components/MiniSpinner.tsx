// `.mini-spinner` (screens.css:1377-1385) — an 18px ring with one bright quarter,
// one turn every 0.8s. P18 fixes icon boxes at x1.0, so it is 18dp here too.
import React, {useEffect, useRef} from 'react';
import {Animated, Easing} from 'react-native';
import theme from '../theme';

const {colors} = theme;

export default function MiniSpinner({size = 18}: {size?: number}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 800,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [t]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.2)',
        borderTopColor: colors.white,
        transform: [
          {rotate: t.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})},
        ],
      }}
    />
  );
}
